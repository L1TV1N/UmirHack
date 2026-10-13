export function BrandMark({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id="brand-g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#22b8f0" />
          <stop offset="1" stopColor="#0069b4" />
        </linearGradient>
        <linearGradient id="brand-h" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#fff" stopOpacity=".34" />
          <stop offset=".55" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
      </defs>
      <rect width="64" height="64" rx="15" fill="url(#brand-g)" />
      <rect width="64" height="64" rx="15" fill="url(#brand-h)" />
      <rect x="13" y="16" width="38" height="8" rx="4" fill="#fff" />
      <rect x="13" y="28" width="27" height="8" rx="4" fill="#fff" opacity=".86" />
      <rect x="13" y="40" width="17" height="8" rx="4" fill="#fff" opacity=".62" />
      <circle cx="39" cy="44" r="4.6" fill="#ff5cbf" />
    </svg>
  );
}
