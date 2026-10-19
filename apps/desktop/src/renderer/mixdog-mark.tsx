/** The Mixdog logo mark: three arcs around a star, currentColor strokes. */
export function MixdogMark({ className, size }: { className?: string; size?: number }) {
  return (
    <svg className={className} width={size} height={size} viewBox="44 44 168 168" aria-hidden="true">
      <g fill="none" stroke="currentColor" strokeWidth="22" strokeLinecap="round">
        <path d="M116.2 61A68 68 0 0 1 191.9 104.7" />
        <path d="M116.2 61A68 68 0 0 1 191.9 104.7" transform="rotate(120 128 128)" />
        <path d="M116.2 61A68 68 0 0 1 191.9 104.7" transform="rotate(240 128 128)" />
      </g>
      <polygon points="128,112 133,123 144,128 133,133 128,144 123,133 112,128 123,123" fill="currentColor" />
    </svg>
  );
}
