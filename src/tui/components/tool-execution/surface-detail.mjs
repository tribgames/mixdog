/**
 * components/tool-execution/surface-detail.mjs — theme-bound status color for
 * the tool card. All surface detection and title/summary/detail derivation
 * lives in runtime/shared/tool-card-model.mjs (single source shared with the
 * desktop renderer); this module re-exports the helpers the TUI card uses and
 * keeps only the theme-dependent dot color.
 */
import { theme } from '../../theme.mjs';
import { deriveToolOutcomeTone } from '../../../runtime/shared/tool-card-model.mjs';

export { isAgentTool, SKILL_SURFACE_NAMES, clampFailureCount } from '../../../runtime/shared/tool-card-model.mjs';

// Theme binding only; semantic outcome lives in the shared card model so the
// TUI and desktop cannot disagree about success, warning, and failure.
export function toolStatusColor(input) {
  const tone = deriveToolOutcomeTone(input);
  if (tone === 'running') return theme.text;
  if (tone === 'warning') return theme.warning;
  if (tone === 'error') return theme.error;
  return theme.success;
}
