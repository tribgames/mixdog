/**
 * components/tool-execution/surface-detail.mjs — theme-bound status color for
 * the tool card. All surface detection and title/summary/detail derivation
 * moved VERBATIM to runtime/shared/tool-card-model.mjs (single source shared
 * with the desktop renderer); this module re-exports those helpers for the
 * existing TUI imports and keeps only the theme-dependent dot color.
 */
import { theme } from '../../theme.mjs';
import { deriveToolOutcomeTone } from '../../../runtime/shared/tool-card-model.mjs';

export {
  isShellTool,
  shellDisplayStatus,
  shellHeader,
  isAgentTool,
  SKILL_SURFACE_NAMES,
  isBackgroundTaskTool,
  agentResponseTitle,
  agentActionTitle,
  agentActionSummary,
  hasAgentResponseResult,
  resolveBackgroundTaskMeta,
  backgroundTaskElapsed,
  prefixElapsed,
  mergeTerminalDetail,
  shouldPrefixSyncElapsed,
  backgroundTaskResultTitle,
  backgroundTaskActionTitle,
  backgroundTaskFailureDetail,
  backgroundTaskDetail,
  isBackgroundTaskResponseArgs,
  genericCompletedDetail,
  toolSearchLoadedSummary,
  agentTerminalDetail,
  clampFailureCount,
} from '../../../runtime/shared/tool-card-model.mjs';

// Theme binding only; semantic outcome lives in the shared card model so the
// TUI and desktop cannot disagree about success, warning, and failure.
export function toolStatusColor(input) {
  const tone = deriveToolOutcomeTone(input);
  if (tone === 'running') return theme.text;
  if (tone === 'warning') return theme.warning;
  if (tone === 'error') return theme.error;
  return theme.success;
}
