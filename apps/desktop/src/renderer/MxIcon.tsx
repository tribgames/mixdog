import { createElement, type ComponentType, type SVGProps } from 'react';
import {
  createLucideIcon,
  AlertTriangle,
  Bot,
  Check,
  CircleAlert,
  MessageSquare,
  Pause,
  Target,
  FileDiff,
  Bug,
  Circle,
  CircleDot,
  CirclePause,
  ChevronDown,
  ChevronsUpDown,
  Copy,
  Crosshair,
  Clock,
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

// The island's shell glyph: a compact chevron with a short underscore close to it,
// optically centred on the 24-unit grid so it carries the same weight as the
// agent and file glyphs (lucide's Terminal spreads the two marks apart).
const ShellPrompt = createLucideIcon('ShellPrompt', [
  ['path', { d: 'm4 5 7 7-7 7', key: 'chevron' }],
  ['path', { d: 'M13 19h7', key: 'underscore' }],
]);

// Name-keyed facade over the shared lucide icon set, so call sites stay
// declarative and every glyph picks up the global `svg.lucide` stroke tuning.
// Built with createElement (no JSX) so every consumer toolchain (vite app
// build, tsx test harness) agrees on the runtime without a React global.
const GLYPHS: Record<string, ComponentType<SVGProps<SVGSVGElement> & { size?: number | string }>> = {
  agent: Bot,
  // Goal segment state glyphs: the shape, not only the tint, names the state.
  'goal-active': Target,
  'goal-paused': Pause,
  'goal-blocked': CircleAlert,
  'goal-waiting': MessageSquare,
  check: Check,
  'file-diff': FileDiff,
  breakpoint: CircleDot,
  debug: Bug,
  'check-small': Check,
  'chevron-down': ChevronDown,
  'chevron-grabber-vertical': ChevronsUpDown,
  clock: Clock,
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
  'shell-prompt': ShellPrompt,
  tests: FlaskConical,
  warning: AlertTriangle,
  zap: Zap,
};

export function MxIcon({
  name,
  size = 16,
  className = '',
  ...rest
}: {
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
