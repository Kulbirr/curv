/**
 * Prism, the Curv AI. A geometric prism mark in the Curv green gradient,
 * suggesting the AI sees the market from every angle.
 */
export default function PrismLogo({ size = 40 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      fill="none"
      role="img"
      aria-label="Prism, the Curv AI"
    >
      <defs>
        <linearGradient id="prism-g" x1="8" y1="6" x2="40" y2="42" gradientUnits="userSpaceOnUse">
          <stop stopColor="#4bf78f" />
          <stop offset="1" stopColor="#1fae55" />
        </linearGradient>
      </defs>
      {/* Outer prism: a diamond split into facets */}
      <path
        d="M24 4 L42 24 L24 44 L6 24 Z"
        fill="url(#prism-g)"
        fillOpacity="0.18"
        stroke="url(#prism-g)"
        strokeWidth="2.5"
        strokeLinejoin="round"
      />
      {/* Inner facet lines */}
      <path d="M24 4 L24 24 L6 24" stroke="url(#prism-g)" strokeWidth="1.5" strokeLinejoin="round" opacity="0.7" />
      <path d="M24 4 L24 24 L42 24" stroke="url(#prism-g)" strokeWidth="1.5" strokeLinejoin="round" opacity="0.7" />
      <path d="M6 24 L24 24 L24 44" stroke="url(#prism-g)" strokeWidth="1.5" strokeLinejoin="round" opacity="0.45" />
      <path d="M42 24 L24 24 L24 44" stroke="url(#prism-g)" strokeWidth="1.5" strokeLinejoin="round" opacity="0.45" />
      {/* Core: the signal eye */}
      <circle cx="24" cy="24" r="5" fill="url(#prism-g)" />
    </svg>
  );
}
