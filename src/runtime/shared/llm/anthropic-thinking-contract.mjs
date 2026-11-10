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

/** A Claude id as the capability tables read it: trimmed, lowercased, dots
 *  folded to dashes and a release date (-20251001, -2025-10-01) dropped. */
export function claudeModelKey(model) {
  return normalizeClaudeModelId(String(model || '').trim()).replace(/-(?:\d{8}|\d{4}-\d{2}-\d{2})$/, '');
}

/** Family and [major, minor] of a first-party Claude id (claude-opus-4-8,
 *  claude-fable-5.1-20260901); null for every other shape (version-first
 *  legacy ids, route prefixes, @/-v1:0/-fast/-latest variants, previews). */
export function claudeFamilyVersion(model) {
  const m = claudeModelKey(model).match(/^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?$/);
  return m ? { family: m[1], version: [Number(m[2]), Number(m[3] || 0)] } : null;
}

export function claudeVersionAtLeast([major, minor], [minMajor, minMinor]) {
  return major > minMajor || (major === minMajor && minor >= minMinor);
}

/**
 * A capability given per family from a first version on (`floors`:
 * family → [major, minor]), so every later version of the family inherits it.
 * A family without a floor stays off. `exceptions` fixes the answer of an id
 * (as claudeModelKey gives it) that the floors cannot express.
 */
export function claudeCapabilityByFloor(model, { floors, exceptions = {} }) {
  const key = claudeModelKey(model);
  if (Object.hasOwn(exceptions, key)) return exceptions[key];
  const parsed = claudeFamilyVersion(key);
  const floor = parsed && Object.hasOwn(floors, parsed.family) ? floors[parsed.family] : null;
  return Boolean(floor) && claudeVersionAtLeast(parsed.version, floor);
}

// Models that write their user-facing notes between tool calls (tool
// preambles) as progress-update thinking blocks instead of text blocks
// (thinking docs, "Progress updates between tool calls": Fable 5 on, Mythos
// 5.1 on, Opus 5.5 on, Sonnet 5.5 on). No catalog field carries it, and the
// display value rides a beta-gated parameter, so a model that rejects it is
// switched off at runtime (anthropic-capability-fallback.mjs).
export const ANTHROPIC_PROGRESS_UPDATES = Object.freeze({
  floors: Object.freeze({ opus: [5, 5], sonnet: [5, 5], fable: [5, 0], mythos: [5, 1] }),
});

export function emitsAnthropicProgressUpdates(model) {
  return claudeCapabilityByFloor(model, ANTHROPIC_PROGRESS_UPDATES);
}

// Models that accept turn-scoped mid-conversation system messages
// ({role:'system', clear_at:'next_user_message'}, beta
// mid-conversation-system-clear-at-2026-08-21). claude-sonnet-5 and
// claude-mythos-preview stay off (they were never on the turn-scoped list);
// a model that rejects the message is switched off at runtime.
export const ANTHROPIC_TURN_SCOPED_SYSTEM = Object.freeze({
  floors: Object.freeze({ opus: [4, 8], sonnet: [5, 5], haiku: [5, 5], fable: [5, 0], mythos: [5, 0] }),
});

export function supportsAnthropicTurnScopedSystemMessages(model) {
  return claudeCapabilityByFloor(model, ANTHROPIC_TURN_SCOPED_SYSTEM);
}
