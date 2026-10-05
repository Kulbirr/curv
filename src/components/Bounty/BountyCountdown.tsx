import { useEffect, useState } from 'react';

function parts(ms: number): { d: number; h: number; m: number; s: number } {
  const total = Math.max(0, Math.floor(ms / 1000));
  return {
    d: Math.floor(total / 86400),
    h: Math.floor((total % 86400) / 3600),
    m: Math.floor((total % 3600) / 60),
    s: total % 60,
  };
}

/** Live countdown to a timestamp. Wraps cleanly on mobile. */
export default function BountyCountdown({ endsAt, startsAt }: { endsAt: number; startsAt: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  if (now < startsAt) {
    const p = parts(startsAt - now);
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs font-semibold text-neutral-300">
        Starts in {p.d > 0 ? `${p.d}d ` : ''}
        {String(p.h).padStart(2, '0')}:{String(p.m).padStart(2, '0')}:{String(p.s).padStart(2, '0')}
      </span>
    );
  }
  if (now >= endsAt) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs font-semibold text-neutral-400">
        Ended
      </span>
    );
  }
  const p = parts(endsAt - now);
  const urgent = endsAt - now < 24 * 3600_000;
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-3 py-1 text-xs font-semibold ${
        urgent
          ? 'border-[#32f27b]/40 bg-[#32f27b]/10 text-[#32f27b]'
          : 'border-white/10 bg-white/5 text-neutral-300'
      }`}
    >
      {p.d > 0 ? `${p.d}d ` : ''}
      {String(p.h).padStart(2, '0')}:{String(p.m).padStart(2, '0')}:{String(p.s).padStart(2, '0')}
      {urgent ? ' left' : ' remaining'}
    </span>
  );
}
