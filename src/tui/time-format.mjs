/**
 * TUI duration formatting — moved to runtime/shared/time-format.mjs so the
 * desktop tool cards share the exact same elapsed labels. This module remains
 * as the TUI-facing import path.
 */
export { formatDuration, formatElapsed } from '../runtime/shared/time-format.mjs';
