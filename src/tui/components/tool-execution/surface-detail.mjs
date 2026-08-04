/**
 * components/tool-execution/surface-detail.mjs — theme-bound status color for
 * the tool card. All surface detection and title/summary/detail derivation
 * moved VERBATIM to runtime/shared/tool-card-model.mjs (single source shared
 * with the desktop renderer); this module re-exports those helpers for the
 * existing TUI imports and keeps only the theme-dependent dot color.
 */
import { theme } from '../../theme.mjs';
import { normalizeTerminalStatus } from '../../../runtime/shared/tool-card-model.mjs';

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

// Single source of truth for the tool-card dot (●) color. Both the aggregate
// and normal (single-tool) render paths must call this with a resolved
// `terminalStatus` — do not recompute color inline elsewhere.
//   running/pending  -> theme.text (white; blink handled by caller)
//   success          -> theme.success
//   partial failure  -> mixdogOrange || warning (some, not all, of the group failed)
//   all failed       -> theme.error
//   cancelled        -> theme.warning
// The RED/orange failure color is driven ONLY by real tool-call errors
// (`callFailedCount` — backend isError / error toolKind), NOT by command/result
// failures like a `[status: failed]` result. A shell command-exit
// (`exitFailedCount`) is its own distinct neutral state: warning color, never
// red. `terminalStatus` is still consulted so a cancelled card stays warning.
export function toolStatusColor({ pending, groupCount, callFailedCount = 0, exitFailedCount = 0, terminalStatus = '' }) {
  if (pending) return theme.text;
  const status = normalizeTerminalStatus(terminalStatus);
  if (status === 'cancelled') return theme.warning;
  if (status === 'denied') return theme.warning;
  if (callFailedCount > 0) {
    if (groupCount > 1 && callFailedCount < groupCount) return theme.mixdogOrange || theme.warning;
    return theme.error;
  }
  // Command-exit(s) with no real tool-call failure: distinct warning state.
  if (exitFailedCount > 0) return theme.warning;
  return theme.success;
}
