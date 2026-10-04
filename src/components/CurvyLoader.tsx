import { cn } from '@/lib/utils';

/**
 * Curvy crawling loader. Replaces the generic spinner everywhere:
 * Curvy wiggles side to side like a worm on the move while content loads.
 */
export default function CurvyLoader({
  size = 40,
  className,
}: {
  size?: number;
  className?: string;
}) {
  return (
    <div
      className={cn('flex items-center justify-center', className)}
      role="status"
      aria-label="Loading"
    >
      <img
        src="/curvy.png"
        width={size}
        height={size}
        alt=""
        aria-hidden="true"
        className="curvy-crawl rounded-full object-cover"
        style={{ width: size, height: size }}
      />
      <style jsx>{`
        @keyframes curvy-crawl {
          0%,
          100% {
            transform: translateX(-6%) rotate(-8deg);
          }
          25% {
            transform: translateX(0) rotate(0deg) translateY(-4%);
          }
          50% {
            transform: translateX(6%) rotate(8deg);
          }
          75% {
            transform: translateX(0) rotate(0deg) translateY(-4%);
          }
        }
        .curvy-crawl {
          animation: curvy-crawl 1.2s ease-in-out infinite;
        }
        @media (prefers-reduced-motion: reduce) {
          .curvy-crawl {
            animation: none;
          }
        }
      `}</style>
    </div>
  );
}
