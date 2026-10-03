import type { NextApiRequest, NextApiResponse } from 'next'

/**
 * Logo proxy for quote-asset directory.
 *
 * Some issuers (e.g. xStocks) host logos with hotlink protection that
 * returns 403 to direct browser requests. This route fetches the image
 * server-side and streams it to the browser, so token logos actually render
 * in the pair picker instead of falling back to letter avatars.
 *
 * GET /api/quote-logo?url=<encoded-image-url>
 *
 * Only http(s) URLs are allowed. Responses are cached at the edge for 24h.
 */

const ALLOWED_HOSTS = new Set([
  'xstocks-metadata.backed.fi',
  'raw.githubusercontent.com',
])

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  const raw = req.query.url
  const urlStr = Array.isArray(raw) ? raw[0] : raw
  if (!urlStr || typeof urlStr !== 'string') {
    res.status(400).json({ error: 'missing url' })
    return
  }
  let url: URL
  try {
    url = new URL(urlStr)
  } catch {
    res.status(400).json({ error: 'invalid url' })
    return
  }
  if (url.protocol !== 'https:' || !ALLOWED_HOSTS.has(url.hostname)) {
    res.status(400).json({ error: 'host not allowed' })
    return
  }
  try {
    const upstream = await fetch(url.toString(), {
      headers: {
        'user-agent': 'Curv/1.0 (+quote-logo)',
        accept: 'image/*',
      },
      signal: AbortSignal.timeout(8000),
    })
    if (!upstream.ok || !upstream.body) {
      res.status(502).json({ error: 'upstream failed' })
      return
    }
    const contentType = upstream.headers.get('content-type') || 'image/png'
    if (!contentType.startsWith('image/')) {
      res.status(502).json({ error: 'not an image' })
      return
    }
    res.setHeader('Content-Type', contentType)
    res.setHeader('Cache-Control', 'public, max-age=86400, s-maxage=86400')
    const buf = Buffer.from(await upstream.arrayBuffer())
    res.status(200).send(buf)
  } catch {
    res.status(502).json({ error: 'fetch failed' })
  }
}
