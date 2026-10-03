import { execute, query } from './index';

export interface Notification {
  id: string;
  wallet: string;
  type: string;
  title: string;
  body: string | null;
  link: string | null;
  createdAt: number;
  readAt: number | null;
}

function rowToNotification(r: {
  id: string;
  wallet: string;
  type: string;
  title: string;
  body: string | null;
  link: string | null;
  created_at: number;
  read_at: number | null;
}): Notification {
  return {
    id: r.id,
    wallet: r.wallet,
    type: r.type,
    title: r.title,
    body: r.body,
    link: r.link,
    createdAt: r.created_at,
    readAt: r.read_at,
  };
}

/** Append a notification for one wallet. IDs are unique per event. */
export async function insertNotification(n: {
  id: string;
  wallet: string;
  type: string;
  title: string;
  body?: string;
  link?: string;
}): Promise<void> {
  await execute(
    `INSERT INTO notifications (id, wallet, type, title, body, link, created_at, read_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, NULL)
     ON CONFLICT (id) DO NOTHING`,
    [n.id, n.wallet, n.type, n.title, n.body ?? null, n.link ?? null, Date.now()],
  );
}

export async function listNotifications(wallet: string, limit = 30): Promise<Notification[]> {
  const rows = await query<{
    id: string;
    wallet: string;
    type: string;
    title: string;
    body: string | null;
    link: string | null;
    created_at: number;
    read_at: number | null;
  }>(
    'SELECT id, wallet, type, title, body, link, created_at, read_at FROM notifications WHERE wallet = $1 ORDER BY created_at DESC LIMIT $2',
    [wallet, limit],
  );
  return rows.map(rowToNotification);
}

export async function countUnreadNotifications(wallet: string): Promise<number> {
  const rows = await query<{ count: string }>(
    'SELECT COUNT(*) AS count FROM notifications WHERE wallet = $1 AND read_at IS NULL',
    [wallet],
  );
  return Number(rows[0]?.count ?? 0);
}

export async function markNotificationsRead(wallet: string, ids?: string[]): Promise<void> {
  if (ids && ids.length > 0) {
    await execute(
      'UPDATE notifications SET read_at = $1 WHERE wallet = $2 AND read_at IS NULL AND id = ANY($3)',
      [Date.now(), wallet, ids],
    );
  } else {
    await execute('UPDATE notifications SET read_at = $1 WHERE wallet = $2 AND read_at IS NULL', [
      Date.now(),
      wallet,
    ]);
  }
}
