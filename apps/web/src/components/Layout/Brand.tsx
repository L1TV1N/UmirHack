export function BrandMark({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      <rect width="32" height="32" rx="7" fill="#0088cc" />
      <rect x="7" y="8" width="18" height="4" rx="2" fill="#fff" />
      <rect x="7" y="14" width="13" height="4" rx="2" fill="#fff" opacity=".78" />
      <rect x="7" y="20" width="8" height="4" rx="2" fill="#fff" opacity=".52" />
    </svg>
  );
}
