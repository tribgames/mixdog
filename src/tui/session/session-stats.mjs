/**
 * src/tui/session/session-stats.mjs - session-usage accumulator for the TUI
 * session runtime: the shared ui/session-stats shape (a pure module with no
 * statusline dependency) plus the live context-gauge field.
 */
import { createSessionStats as createBaseSessionStats } from '../../ui/session-stats.mjs';

export { applyUsageDelta } from '../../ui/session-stats.mjs';

export function createSessionStats() {
  return { ...createBaseSessionStats(), currentContextTokens: 0 };
}
