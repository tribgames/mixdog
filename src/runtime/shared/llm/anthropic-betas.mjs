import { EFFORT_BETA_HEADER } from './anthropic-effort.mjs';
import { normalizeClaudeModelId } from './anthropic-thinking-contract.mjs';
import { getModelMetadataSync } from './model-catalog.mjs';

const EXTENDED_CACHE_TTL_BETA_HEADER = 'extended-cache-ttl-2025-04-11';
const INTERLEAVED_THINKING_BETA_HEADER = 'interleaved-thinking-2025-05-14';
const FAST_MODE_BETA_HEADER = 'fast-mode-2026-02-01';
const TOOL_SEARCH_BETA_HEADER = 'advanced-tool-use-2025-11-20';
const THINKING_DISPLAY_UPDATES_BETA_HEADER = 'thinking-display-updates-2026-08-18';
export const SERVER_SIDE_FALLBACK_BETA_HEADER = 'server-side-fallback-2026-07-01';

// Fast mode ships on Opus 5.5, Opus 5 and Opus 4.8 only. Opus 4.7 rejects
// `speed: "fast"` and Opus 4.6 silently runs at standard speed.
const KNOWN_FAST_MODE_MODELS = /^claude-opus-(?:4-8|5)(?:$|[-@])/;

// The id pattern is the offline floor. A model the pricing catalog declares
// Fast-capable is accepted too, so a later release needs no edit here.
export function supportsAnthropicFastMode(model) {
  const id = normalizeClaudeModelId(model);
  if (!id) return false;
  return KNOWN_FAST_MODE_MODELS.test(id) || getModelMetadataSync(id, 'anthropic')?.supportsFastMode === true;
}

export function buildAnthropicBetaHeaders({
  base = `${INTERLEAVED_THINKING_BETA_HEADER},${EXTENDED_CACHE_TTL_BETA_HEADER}`,
  fastMode = false,
  toolSearch = false,
  effort = false,
  serverFallback = false,
  thinkingDisplayUpdates = false,
} = {}) {
  const headers = String(base || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  if (fastMode && !headers.includes(FAST_MODE_BETA_HEADER)) {
    headers.push(FAST_MODE_BETA_HEADER);
  }
  if (toolSearch && !headers.includes(TOOL_SEARCH_BETA_HEADER)) {
    headers.push(TOOL_SEARCH_BETA_HEADER);
  }
  if (effort && !headers.includes(EFFORT_BETA_HEADER)) {
    headers.push(EFFORT_BETA_HEADER);
  }
  if (serverFallback && !headers.includes(SERVER_SIDE_FALLBACK_BETA_HEADER)) {
    headers.push(SERVER_SIDE_FALLBACK_BETA_HEADER);
  }
  if (thinkingDisplayUpdates && !headers.includes(THINKING_DISPLAY_UPDATES_BETA_HEADER)) {
    headers.push(THINKING_DISPLAY_UPDATES_BETA_HEADER);
  }
  return headers.join(',');
}
