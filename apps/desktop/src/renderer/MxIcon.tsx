import { createElement, type ComponentType, type SVGProps } from 'react';
import {
  AlertTriangle,
  Check,
  Bug,
  Circle,
  CircleDot,
  CirclePause,
  ChevronDown,
  ChevronsUpDown,
  Copy,
  Crosshair,
  FileClock,
  FileText,
  FlaskConical,
  Folder,
  History,
  Image,
  ListChecks,
  LoaderCircle,
  Merge,
  MoreHorizontal,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  SkipForward,
  Square,
  StepForward,
  Terminal,
  Trash2,
  Undo2,
  X,
  Zap,
} from 'lucide-react';

// Name-keyed facade over the shared lucide icon set, so call sites stay
// declarative and every glyph picks up the global `svg.lucide` stroke tuning.
// Built with createElement (no JSX) so every consumer toolchain (vite app
// build, tsx test harness) agrees on the runtime without a React global.
const GLYPHS: Record<string, ComponentType<SVGProps<SVGSVGElement> & { size?: number | string }>> = {
  check: Check,
  breakpoint: CircleDot,
  debug: Bug,
  'check-small': Check,
  'chevron-down': ChevronDown,
  'chevron-grabber-vertical': ChevronsUpDown,
  'close-small': X,
  copy: Copy,
  continue: Play,
  delete: Trash2,
  edit: Pencil,
  'file-clock': FileClock,
  folder: Folder,
  // Crosshair, not Target: the bullseye's three concentric rings collapse at
  // the 15px chip size and read as a status dot (CircleDot already means
  // in-progress/breakpoint here). One circle + cross keeps the aim semantics
  // legible on the 1px pixel-snapped stroke.
  goal: Crosshair,
  history: History,
  'in-progress': CircleDot,
  loading: LoaderCircle,
  merge: Merge,
  'magnifying-glass': Search,
  more: MoreHorizontal,
  'open-file': FileText,
  paused: CirclePause,
  pending: Circle,
  photo: Image,
  plus: Plus,
  output: Terminal,
  play: Play,
  refresh: RefreshCw,
  reset: RotateCcw,
  restore: Undo2,
  'step-in': StepForward,
  'step-out': SkipForward,
  'step-over': StepForward,
  stop: Square,
  tasks: ListChecks,
  terminal: Terminal,
  tests: FlaskConical,
  warning: AlertTriangle,
  zap: Zap,
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
