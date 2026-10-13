/** Значок команды: белая «C» на фиолетовом, с цветным сдвигом, как на её аватарке. */
export function TeamMark({ size = 36 }: { size?: number }) {
  const letter = { x: 32, y: 47, textAnchor: 'middle' as const, fontSize: 46, fontWeight: 900, fontFamily: "'Manrope Variable', 'Manrope', system-ui, sans-serif" };
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true" focusable="false">
      <defs>
        <clipPath id="cp-top">
          <rect x="0" y="0" width="64" height="30" />
        </clipPath>
        <clipPath id="cp-bottom">
          <rect x="0" y="36" width="64" height="28" />
        </clipPath>
      </defs>
      <rect width="64" height="64" rx="10" fill="#8a1fa0" />
      <text {...letter} dx="-3" fill="#f06bff">C</text>
      <text {...letter} dx="3" fill="#22e0f0" clipPath="url(#cp-top)">C</text>
      <text {...letter} dx="4" fill="#22e0f0" clipPath="url(#cp-bottom)">C</text>
      <text {...letter} fill="#fff">C</text>
    </svg>
  );
}
