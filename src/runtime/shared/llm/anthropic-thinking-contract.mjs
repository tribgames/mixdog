/** Lowercased model id with dots folded to dashes (claude-opus-4.8 → claude-opus-4-8). */
export function normalizeClaudeModelId(model) {
  return String(model || '')
    .toLowerCase()
    .replace(/\./g, '-');
}

// Version token after the family (claude-opus-4-8, claude-nova-9-1-20270101)
// or before it (claude-3-5-sonnet). Minor is one or two digits and never
// followed by another digit, so a release date (claude-opus-4-20250514) is
// not read as a minor version.
const FAMILY_FIRST_VERSION = /^claude-[a-z][a-z0-9]*-(\d+)(?:-(\d{1,2})(?!\d))?(?:[-@]|$)/;
const VERSION_FIRST_VERSION = /^claude-(\d+)(?:-(\d{1,2})(?!\d))?(?:[-@]|$)/;

/**
 * Release generation of a Claude id as major*100 + minor (4.8 → 408), derived
 * from the version token alone — no family names. A claude-* id without a
 * version token is a not-yet-numbered release and ranks as the newest
 * (Infinity); a non-claude id has no generation (null). A route prefix before
 * the claude token (anthropic/claude-…, us.anthropic.claude-…) is skipped.
 */
export function claudeGeneration(model) {
  const normalized = normalizeClaudeModelId(model);
  const at = normalized.indexOf('claude-');
  if (at < 0) return null;
  const id = normalized.slice(at);
  const m = id.match(FAMILY_FIRST_VERSION) || id.match(VERSION_FIRST_VERSION);
  return m ? Number(m[1]) * 100 + Number(m[2] || 0) : Infinity;
}

// Offline floors, used only for an id no catalog record describes. Each is the
// first generation whose documented API contract has the capability; later
// generations inherit it, so a new release needs no entry here.
export const CLAUDE_GENERATION_FLOOR = Object.freeze({
  // adaptive thinking + output_config.effort
  adaptiveEffort: 406,
  // thinking:{type:"enabled",budget_tokens} is rejected from here on
  manualThinkingRejected: 407,
  // effort tier "xhigh"
  xhighEffort: 407,
  // effort tier "max"
  maxEffort: 405,
});

/** Generation at/above `floor`; ids with no generation (non-claude) never qualify. */
export function claudeGenerationAtLeast(model, floor) {
  const generation = claudeGeneration(model);
  return generation !== null && generation >= floor;
}

// Offline classification for an id the catalog does not describe (catalog
// lookup lives in anthropic-effort.mjs: isAnthropicAdaptiveOnlyModel).
export function isAnthropicAdaptiveOnlyByGeneration(model) {
  return claudeGenerationAtLeast(model, CLAUDE_GENERATION_FLOOR.manualThinkingRejected);
}

// Models that write their user-facing notes between tool calls (tool
// preambles) as progress-update thinking blocks instead of text blocks.
// Kept as an id list: no catalog field carries it, the display value rides a
// beta-gated parameter that other models reject (a wrong "yes" is a 400), and
// a wrong "no" only leaves preambles as text — so unknown ids stay off.
export function emitsAnthropicProgressUpdates(model) {
  const id = normalizeClaudeModelId(model);
  return /^claude-(?:opus-5-5|sonnet-5-5|fable-5-1|mythos-5-1|fable-5)(?:-\d{8})?$/.test(id);
}

// Models that accept turn-scoped mid-conversation system messages
// ({role:'system', clear_at:'next_user_message'}, beta
// mid-conversation-system-clear-at-2026-08-21). An id list for the same
// reason as above: a wrong "yes" is a 400 on every request, a wrong "no" only
// keeps the legacy tail-reminder layout — so unknown ids stay off.
export function supportsAnthropicTurnScopedSystemMessages(model) {
  const id = normalizeClaudeModelId(model);
  return /^claude-(?:fable-5-1|mythos-5-1|fable-5|mythos-5|opus-5-5|opus-5|opus-4-8|sonnet-5-5|haiku-5-5)(?:-\d{8})?$/.test(
    id
  );
}
