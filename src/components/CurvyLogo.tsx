/**
 * Curvy, the Curv mascot and face of the AI signals feed.
 * A glowing green curve creature on a dark background.
 * Shown uncropped so the whole worm is visible.
 */
export default function CurvyLogo({ size = 40 }: { size?: number }) {
  return (
    <img
      src="/curvy.png"
      width={size}
      height={size}
      alt="Curvy, the Curv mascot"
      className="object-contain"
      style={{ width: size, height: size }}
    />
  );
}
