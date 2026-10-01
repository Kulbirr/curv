import type { NextApiRequest, NextApiResponse } from 'next';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { randomUUID } from 'crypto';
import { getClientIp } from '@/lib/api-validation';
import { hitRateLimit } from '@/lib/db/rate-limits';

/**
 * Token metadata hosting.
 *
 * GET  → { configured: boolean } so the launch UI can decide whether to
 *        offer hosted metadata or ask for an external URI.
 * POST → { uri }, uploads the metadata JSON (and optional image) to R2.
 *
 * R2 credentials stay server-side. If R2 is not configured the route
 * returns 503 and the launch flow falls back to a user-supplied URI.
 */

const MAX_JSON_BYTES = 64 * 1024;
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

/**
 * Next.js defaults to a 1MB JSON body limit, which would 413 a legitimate
 * 2MB image upload before our own check runs. A 2MB image base64-encodes
 * to ~2.75MB, so 3MB admits real uploads while still bounding abuse.
 */
export const config = {
  api: { bodyParser: { sizeLimit: '3mb' } },
};

function r2Client(): S3Client | null {
  const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY } = process.env;
  if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY) return null;
  return new S3Client({
    region: 'auto',
    endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: R2_ACCESS_KEY_ID,
      secretAccessKey: R2_SECRET_ACCESS_KEY,
    },
  });
}

function isConfigured(): boolean {
  return r2Client() !== null && !!process.env.R2_BUCKET && !!process.env.R2_PUBLIC_URL;
}

interface MetadataBody {
  name?: unknown;
  symbol?: unknown;
  description?: unknown;
  image?: unknown; // https URL or data URI
}

async function handlePost(req: NextApiRequest, res: NextApiResponse) {
  if (!isConfigured()) {
    return res.status(503).json({ error: 'Metadata hosting is not configured on this server' });
  }
  // One launch uploads one metadata file; bound anonymous uploads so the
  // R2 bucket cannot be used as free storage by a spammer.
  const ip = getClientIp(req);
  const now = Date.now();
  const hit = await hitRateLimit(`metadata:ip:${ip}`, 20, 60 * 60_000, now);
  if (!hit.allowed) {
    return res.status(429).json({ error: 'Too many metadata uploads from this address, try again later' });
  }
  const body = (req.body ?? {}) as MetadataBody;
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const symbol = typeof body.symbol === 'string' ? body.symbol.trim().toUpperCase() : '';
  const description = typeof body.description === 'string' ? body.description.trim() : '';

  if (!name || name.length > 32) return res.status(400).json({ error: 'Invalid name' });
  if (!/^[A-Za-z0-9]{1,10}$/.test(symbol)) return res.status(400).json({ error: 'Invalid symbol' });
  if (description.length > 500) return res.status(400).json({ error: 'Description too long' });

  const s3 = r2Client()!;
  const bucket = process.env.R2_BUCKET!;
  const publicUrl = process.env.R2_PUBLIC_URL!.replace(/\/$/, '');
  const id = randomUUID();

  // Optional image: data URI → upload bytes; https URL → use as-is.
  let imageUrl = '';
  if (typeof body.image === 'string' && body.image) {
    const img = body.image;
    // Reject absurd payloads before the regex/base64 work: a 2MB image is
    // ~2.75MB base64, so anything far beyond that is not a real upload.
    if (img.length > 4 * 1024 * 1024) {
      return res.status(400).json({ error: 'Image is too large' });
    }
    const dataUri = img.match(/^data:(image\/(png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)$/);
    if (dataUri) {
      const bytes = Buffer.from(dataUri[3], 'base64');
      if (bytes.length > MAX_IMAGE_BYTES) {
        return res.status(400).json({ error: 'Image must be under 2 MB' });
      }
      const ext = dataUri[2] === 'jpeg' ? 'jpg' : dataUri[2];
      const key = `tokens/${id}/image.${ext}`;
      await s3.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: bytes,
          ContentType: `image/${dataUri[2]}`,
        }),
      );
      imageUrl = `${publicUrl}/${key}`;
    } else if (/^https:\/\/[^/]+\/.+/.test(img) && img.length < 500) {
      imageUrl = img;
    } else {
      return res.status(400).json({ error: 'Image must be an https URL or an image upload' });
    }
  }

  const metadata = { name, symbol, description, image: imageUrl };
  const json = JSON.stringify(metadata);
  if (Buffer.byteLength(json) > MAX_JSON_BYTES) {
    return res.status(400).json({ error: 'Metadata too large' });
  }
  const key = `tokens/${id}/metadata.json`;
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: json,
      ContentType: 'application/json',
    }),
  );
  // Return the image URL alongside the URI. Clients must use imageUrl
  // directly for registry cards: re-fetching the metadata JSON from the
  // browser is blocked by the R2 public bucket's missing CORS headers,
  // which silently drops the card image (Oct 2026 incident).
  return res.status(201).json({ uri: `${publicUrl}/${key}`, imageUrl });
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method === 'GET') return res.status(200).json({ configured: isConfigured() });
  if (req.method === 'POST') {
    try {
      return await handlePost(req, res);
    } catch (e) {
      return res.status(500).json({ error: e instanceof Error ? e.message : 'Upload failed' });
    }
  }
  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ error: 'Method not allowed' });
}
