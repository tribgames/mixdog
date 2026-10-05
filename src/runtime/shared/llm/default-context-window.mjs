// The context window a model starts with when the user has not picked one.
//
// A provider row states the window it serves by default (`contextWindow`) and,
// when it can serve more, the largest one (`maxContextWindow`). The picker's
// 10% stops and the session's compaction boundary both follow that pair. A row
// that serves its whole window by default makes the largest window the
// starting point, and every request then re-sends whatever the session has
// accumulated up to it: on stored sessions of 1M rows left at 100%
// (2026-09-25..10-05) the average lead request carried 225K tokens and 62% of
// the token volume was spent above 300K. Replaying those sessions against a
// 500K boundary cut that volume by 19% (lead) and 14% (agents).
//
// The default is therefore set by range: a window up to the ceiling is used
// whole, a larger one starts at the ceiling and keeps the rest selectable — the
// shape provider rows with a smaller default of their own (272K of 872K)
// already have. An explicit selection is never touched.
export const DEFAULT_CONTEXT_WINDOW_CEILING = 500_000;

// A local model's window is the memory its runtime allocated, not a budget.
const LOCAL_PROVIDERS = new Set(['mixdog-local', 'local']);

function positiveTokens(value) {
  const tokens = Number(value);
  return Number.isFinite(tokens) && tokens > 0 ? Math.floor(tokens) : 0;
}

/**
 * The default and the largest selectable window of one model row, in tokens.
 * `defaultWindow` is 0 when the row states no window to start from.
 */
export function contextWindowRange({ provider = '', contextWindow, maxContextWindow } = {}) {
  const served = positiveTokens(contextWindow);
  const maxWindow = Math.max(served, positiveTokens(maxContextWindow));
  const whole = { defaultWindow: served, maxWindow };
  if (served <= DEFAULT_CONTEXT_WINDOW_CEILING) return whole;
  if (LOCAL_PROVIDERS.has(String(provider || '').toLowerCase())) return whole;
  // The picker moves in 10% stops of the largest window. A window so close to
  // the ceiling that both round to the last stop keeps its whole size: that
  // stop would otherwise name the ceiling and leave the full window unreachable.
  if (Math.round((DEFAULT_CONTEXT_WINDOW_CEILING / maxWindow) * 10) >= 10) return whole;
  return { defaultWindow: DEFAULT_CONTEXT_WINDOW_CEILING, maxWindow };
}
