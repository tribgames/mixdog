import { createElement, type ComponentType, type SVGProps } from 'react';
import {
  Check,
  ChevronDown,
  ChevronsUpDown,
  Copy,
  FileText,
  Image,
  Plus,
  RotateCcw,
  Search,
  Square,
  Terminal,
  X,
} from 'lucide-react';

// Name-keyed facade over the shared lucide icon set, so call sites stay
// declarative and every glyph picks up the global `svg.lucide` stroke tuning.
// Built with createElement (no JSX) so every consumer toolchain (vite app
// build, tsx test harness) agrees on the runtime without a React global.
const GLYPHS: Record<string, ComponentType<SVGProps<SVGSVGElement> & { size?: number | string }>> = {
  check: Check,
  'check-small': Check,
  'chevron-down': ChevronDown,
  'chevron-grabber-vertical': ChevronsUpDown,
  'close-small': X,
  copy: Copy,
  'magnifying-glass': Search,
  'open-file': FileText,
  photo: Image,
  plus: Plus,
  reset: RotateCcw,
  stop: Square,
  terminal: Terminal,
};

export function MxIcon({ name, size = 16, className = '', ...rest }: {
  name: string;
  size?: number;
} & SVGProps<SVGSVGElement>) {
  const Glyph = GLYPHS[name];
  if (!Glyph) return null;
  return createElement(Glyph, {
    size,
    // The stop affordance is a FILLED square; everything else stays stroked.
    fill: name === 'stop' ? 'currentColor' : 'none',
    'aria-hidden': 'true',
    focusable: 'false',
    className: `mx-icon ${className}`.trim(),
    ...rest,
  });
}
