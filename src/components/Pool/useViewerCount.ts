import { useEffect, useState } from 'react';

const HEARTBEAT_MS = 15_000;
const STORAGE_KEY = 'curv-viewer-id';

function getSessionId(): string {
  try {
    const existing = sessionStorage.getItem(STORAGE_KEY);
    if (existing) return existing;
    const id =
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `v-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 14)}`;
    sessionStorage.setItem(STORAGE_KEY, id);
    return id;
  } catch {
    // sessionStorage unavailable (private mode etc.): ephemeral id still
    // heartbeats fine, it just won't survive reloads.
    return `v-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 14)}`;
  }
}

/**
 * Anonymous watcher count for a pool. Heartbeats every 15s while the tab is
 * visible; returns null until the first heartbeat resolves. Best-effort:
 * a failed heartbeat keeps the last known count.
 */
export function useViewerCount(poolAddress: string | null): number | null {
  const [count, setCount] = useState<number | null>(null);

  useEffect(() => {
    if (!poolAddress) return;
    const sessionId = getSessionId();
    let stopped = false;
    let timer: ReturnType<typeof setInterval> | null = null;

    const beat = async () => {
      if (stopped || document.visibilityState !== 'visible') return;
      try {
        const res = await fetch(`/api/pools/${poolAddress}/viewers`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId }),
        });
        if (!res.ok || stopped) return;
        const data = (await res.json()) as { viewers?: unknown };
        if (typeof data.viewers === 'number') setCount(data.viewers);
      } catch {
        // Heartbeat is fire-and-forget; keep the last known count.
      }
    };

    const onVisibility = () => {
      if (document.visibilityState === 'visible') void beat();
    };
    document.addEventListener('visibilitychange', onVisibility);
    void beat();
    timer = setInterval(() => void beat(), HEARTBEAT_MS);
    return () => {
      stopped = true;
      if (timer) clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [poolAddress]);

  return count;
}
