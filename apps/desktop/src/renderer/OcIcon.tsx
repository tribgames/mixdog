import { createElement, type SVGProps } from 'react';
import { OC_ICON_MARKUP } from './oc-icon-markup';

// OpenCode v2's hand-drawn 20x20 icon set, ported verbatim from
// packages/ui/src/components/icon.tsx (MIT). Glyphs carry their own stroke
// weights (~1.25px optical) inside the markup, so the global `svg.lucide`
// thinning rule must not — and does not — apply here. Built with
// createElement (no JSX) so every consumer toolchain (vite app build, tsx
// test harness) agrees on the runtime without a React global.
export function OcIcon({ name, size = 16, className = '', ...rest }: {
  name: string;
  size?: number;
} & SVGProps<SVGSVGElement>) {
  return createElement('svg', {
    viewBox: '0 0 20 20',
    width: size,
    height: size,
    fill: 'none',
    'aria-hidden': 'true',
    focusable: 'false',
    className: `oc-icon ${className}`.trim(),
    dangerouslySetInnerHTML: { __html: (OC_ICON_MARKUP as Record<string, string>)[name] || '' },
    ...rest,
  });
}
