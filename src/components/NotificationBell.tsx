import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/router';
import { cn } from '@/lib/utils';

interface NotificationItem {
  id: string;
  type: string;
  title: string;
  body: string | null;
  link: string | null;
  createdAt: number;
  readAt: number | null;
}

/**
 * In-app notification inbox, keyed to the connected wallet. Polls
 * lightly; the badge counts unread items. Opening the panel marks
 * everything read. Events: split recipient bound, split payout landed.
 */
export function NotificationBell({ wallet }: { wallet: string }) {
  const router = useRouter();
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [unread, setUnread] = useState(0);
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/notifications?wallet=${encodeURIComponent(wallet)}`);
      if (!res.ok) return;
      const j = (await res.json()) as { notifications: NotificationItem[]; unread: number };
      setItems(j.notifications ?? []);
      setUnread(j.unread ?? 0);
    } catch {
      // Inbox is advisory; a failed poll just leaves the last state.
    }
  }, [wallet]);

  useEffect(() => {
    load();
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, [load]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open ]);

  const toggle = useCallback(async () => {
    const next = !open;
    setOpen(next);
    if (next && unread > 0) {
      setUnread(0);
      setItems((prev) => prev.map((n) => ({ ...n, readAt: n.readAt ?? Date.now() })));
      try {
        await fetch('/api/notifications', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ wallet }),
        });
      } catch {
        // Mark-read is best effort; the badge already cleared locally.
      }
      load();
    }
  }, [open, unread, wallet, load]);

  const go = useCallback(
    (n: NotificationItem) => {
      setOpen(false);
      if (n.link) router.push(n.link);
    },
    [router],
  );

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        onClick={toggle}
        aria-label={unread > 0 ? `${unread} unread notifications` : 'Notifications'}
        aria-expanded={open}
        className="relative flex h-10 w-10 items-center justify-center rounded-full border border-white/10 bg-white/[3%] text-neutral-300 transition hover:border-white/20 hover:text-neutral-100"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-5 w-5" aria-hidden="true">
          <path strokeLinecap="round" strokeLinejoin="round" d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
        </svg>
        {unread > 0 && (
          <span className="absolute -right-0.5 -top-0.5 flex h-5 min-w-5 items-center justify-center rounded-full bg-[#d08a5f] px-1 text-[10px] font-bold text-black">
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 top-12 z-50 w-80 overflow-hidden rounded-2xl border border-white/10 bg-[#141110] shadow-2xl"
        >
          <p className="border-b border-white/5 px-4 py-3 text-[11px] font-bold tracking-[0.2em] text-[#d08a5f]">
            NOTIFICATIONS
          </p>
          {items.length === 0 ? (
            <p className="px-4 py-6 text-sm text-neutral-500">Nothing yet. New fee events land here.</p>
          ) : (
            <ul className="max-h-96 divide-y divide-white/5 overflow-y-auto">
              {items.map((n) => (
                <li key={n.id}>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => go(n)}
                    className={cn(
                      'block w-full px-4 py-3 text-left transition hover:bg-white/[3%]',
                      !n.readAt && 'bg-[#d08a5f]/[4%]',
                    )}
                  >
                    <p className="text-sm font-semibold text-neutral-100">{n.title}</p>
                    {n.body && <p className="mt-1 text-xs leading-relaxed text-neutral-500">{n.body}</p>}
                    <p className="mt-1 text-[11px] text-neutral-600">
                      {new Date(n.createdAt).toLocaleString('en-GB', {
                        day: 'numeric',
                        month: 'short',
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </p>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
