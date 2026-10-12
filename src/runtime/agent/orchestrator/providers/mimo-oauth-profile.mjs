// MiMo wire profile: the opt-in hooks the shared Chat Completions sender reads
// from `config.chatProfile`, plus the model roster helpers and gateway error
// shaping. Nothing here applies to any other provider.
import { markProviderRecoveryExhausted } from './retry-classifier.mjs';
import { scrubOAuthSecrets } from './lib/oauth-token-utils.mjs';
import { PROVIDER_MAX_BEFORE_WARN_MS, STALL_ABORT_S, STALL_TICK_MS } from '../stall-policy.mjs';
import { PACKAGE_VERSION } from '../../../web-search/lib/package-version.mjs';
import { DEFAULT_MODEL } from './mimo-oauth-tokens.mjs';

const MIMO_EFFORT_LEVELS = Object.freeze(['minimal', 'low', 'medium', 'high']);
const MIMO_DEFAULT_TEMPERATURE = 1.0;
const MIMO_DEFAULT_MAX_OUTPUT_TOKENS = 128_000;
// Slow reasoning can stay silent for minutes: wait for the first byte as long
// as the agent stall watchdog allows, and tolerate long gaps between events.
export const MIMO_FIRST_BYTE_TIMEOUT_MS = Math.min(300_000, PROVIDER_MAX_BEFORE_WARN_MS);
export const MIMO_SEMANTIC_IDLE_TIMEOUT_MS = Math.min(480_000, Math.max(10_000, STALL_ABORT_S * 1000 - STALL_TICK_MS));

// Local roster used when /models fails or comes back empty.
const SEED_CONTEXT = 1_048_576;
const SEED_OUTPUT = 131_072;
export const SEED_MODELS = Object.freeze(
  [
    ['mimo-v2.6-pro', 'MiMo-V2.6-Pro', SEED_CONTEXT],
    ['mimo-v2.6-flash', 'MiMo-V2.6-Flash', SEED_CONTEXT],
    ['mimo-v2.6-pro-ultraspeed', 'MiMo-V2.6-Pro-Ultraspeed', SEED_CONTEXT],
    ['mimo-v2.5-pro', 'MiMo-V2.5-Pro', SEED_CONTEXT],
    ['mimo-v2.5', 'MiMo-V2.5', SEED_CONTEXT],
    ['mimo-v2-pro', 'MiMo-V2-Pro', SEED_CONTEXT],
    ['mimo-v2-omni', 'MiMo-V2-Omni', 262_144],
  ].map(([id, display_name, context_window]) =>
    Object.freeze({ id, display_name, context_window, max_output_tokens: SEED_OUTPUT })
  )
);

export function seedModelItems() {
  return SEED_MODELS.map((item) => ({ ...item }));
}

// Speech/transcription ids cannot serve a text chat turn.
export function isChatModelId(id) {
  const text = String(id || '').toLowerCase();
  return Boolean(text) && !text.includes('-tts') && !text.includes('-asr');
}

// Prefer the flagship only when this credential actually serves it; otherwise
// the first chat model the roster lists, and the seed default for an empty one.
export function chooseDefaultModel(ids) {
  const chat = (ids || []).filter(isChatModelId);
  if (chat.includes(DEFAULT_MODEL)) return DEFAULT_MODEL;
  return chat[0] || DEFAULT_MODEL;
}

// Exact seed id, else the longest seed whose id is a lineage prefix of the
// model (dated or suffixed variants of a seeded model).
function seedRow(model) {
  const id = String(model || '').toLowerCase();
  let seed = SEED_MODELS.find((item) => item.id === id) || null;
  if (!seed) {
    for (const item of SEED_MODELS) {
      if (id.startsWith(`${item.id}-`) && (!seed || item.id.length > seed.id.length)) seed = item;
    }
  }
  if (!seed) return null;
  return {
    id: String(model),
    contextWindow: seed.context_window,
    outputTokens: seed.max_output_tokens,
    reasoning: true,
    vision: true,
    inputModalities: ['text', 'image'],
  };
}

// Fill the gaps a /models row leaves (names, limits, effort levels).
export function decorateModelRows(rows, items) {
  const display = new Map();
  for (const item of items || []) {
    if (typeof item?.id === 'string' && typeof item.display_name === 'string' && item.display_name.trim()) {
      display.set(item.id, item.display_name.trim());
    }
  }
  return rows.map((row) => {
    const seed = seedRow(row.id);
    return {
      ...row,
      name: display.get(row.id) || row.name,
      contextWindow: row.contextWindow || seed?.contextWindow || 0,
      outputTokens: row.outputTokens || seed?.outputTokens || null,
      ...(seed && row.reasoning === undefined ? { reasoning: seed.reasoning } : {}),
      ...(seed && row.vision === undefined ? { vision: seed.vision } : {}),
      ...(seed && row.inputModalities === undefined ? { inputModalities: seed.inputModalities } : {}),
      reasoningLevels: [...MIMO_EFFORT_LEVELS],
      reasoningContentField: 'reasoning_content',
    };
  });
}

// Mixdog effort → MiMo `reasoning_effort`; the ladder's top edges fold to high.
function mimoEffort(value) {
  const effort = String(value ?? '')
    .trim()
    .toLowerCase();
  if (MIMO_EFFORT_LEVELS.includes(effort)) return effort;
  return ['xhigh', 'max', 'ultra'].includes(effort) ? 'high' : null;
}

function thinkingDisabled(thinking, effort) {
  const mode = String(thinking?.type ?? thinking ?? '')
    .trim()
    .toLowerCase();
  return thinking === false || mode === 'disabled' || mode === 'off' || mode === 'none' || effort === 'none';
}

function namedToolChoice(choice) {
  if (!choice || typeof choice !== 'object') return null;
  const name = choice.function?.name || choice.name;
  return typeof name === 'string' && name ? name : null;
}

function applyMimoParams(params, { opts = {}, config = {}, modelInfo = null } = {}) {
  const temperature = Number(opts.temperature);
  params.temperature = Number.isFinite(temperature) && temperature >= 0 ? temperature : MIMO_DEFAULT_TEMPERATURE;

  for (const [key, wire] of [
    ['topP', 'top_p'],
    ['topK', 'top_k'],
  ]) {
    const value = Number(opts[key] ?? config?.[key]);
    if ((opts[key] ?? config?.[key]) != null && Number.isFinite(value) && value >= 0) params[wire] = value;
  }

  const limit = Number(modelInfo?.outputTokens);
  const requested = params.max_tokens || MIMO_DEFAULT_MAX_OUTPUT_TOKENS;
  params.max_tokens = Number.isFinite(limit) && limit > 0 ? Math.min(requested, limit) : requested;

  const thinking = opts.thinking ?? config?.thinking;
  const rawEffort = opts.effort ?? config?.reasoningEffort;
  const effort = String(rawEffort ?? '')
    .trim()
    .toLowerCase();
  if (thinkingDisabled(thinking, effort)) {
    params.thinking = { type: 'disabled' };
  } else if (thinking !== undefined || effort) {
    params.thinking = { type: 'enabled' };
    const level = mimoEffort(effort);
    if (level) params.reasoning_effort = level;
  }

  if (params.tools?.length) {
    if (opts.toolChoice === 'required') params.tool_choice = 'required';
    else {
      const name = namedToolChoice(opts.toolChoice);
      if (name) params.tool_choice = { type: 'function', function: { name } };
    }
  }
  return params;
}

// Session affinity and client identity, sent per request.
export function mimoRequestHeaders(opts = {}) {
  const headers = { 'User-Agent': `mimocode/${PACKAGE_VERSION}` };
  if (opts.ephemeral === true) return headers;
  const sessionId = String(opts.sessionId || opts.session?.id || '').trim();
  if (sessionId) headers['x-session-affinity'] = sessionId;
  const parentId = String(opts.parentSessionId || opts.session?.parentSessionId || '').trim();
  if (sessionId && parentId) headers['x-parent-session-id'] = parentId;
  return headers;
}

const FRIENDLY_GATEWAY_CODES = Object.freeze({
  421: 'Request blocked by content moderation',
  441: 'Request blocked by risk control',
});

// The gateway body is `{ error: { code, message, param } }`; the SDK exposes it
// as err.error (already unwrapped) or leaves it wrapped for stream events.
function gatewayError(err) {
  const body = err?.error;
  if (!body || typeof body !== 'object') return null;
  return body.error && typeof body.error === 'object' ? body.error : body;
}

// Readable failure text: the friendly label for known block codes, otherwise
// the gateway message, followed by `param` when it carries the real reason.
export function mimoErrorDetail(err, secrets = []) {
  const gw = gatewayError(err);
  let text = '';
  if (gw) {
    const base = FRIENDLY_GATEWAY_CODES[String(gw.code)] || (typeof gw.message === 'string' ? gw.message : '');
    if (base) text = typeof gw.param === 'string' && gw.param && gw.param !== base ? `${base}: ${gw.param}` : base;
  }
  return scrubOAuthSecrets(text || String(err?.message || err || ''), secrets).trim();
}

// Keep gateway detail on the error; a quota refusal can never succeed on replay.
function refineMimoError(err) {
  if (!err || typeof err !== 'object') return err;
  const gw = gatewayError(err);
  if (!gw) return err;
  const detail = mimoErrorDetail(err);
  if (detail && detail !== err.message) err.message = detail;
  if (gw.code !== undefined && gw.code !== null) err.mimoGatewayCode = String(gw.code);
  if (typeof gw.param === 'string' && gw.param) err.mimoGatewayParam = gw.param;
  if (String(gw.code || gw.type || '').toLowerCase() === 'insufficient_quota') {
    err.code = 'insufficient_quota';
    markProviderRecoveryExhausted(err, { owner: 'mimo-oauth' });
  }
  return err;
}

export const MIMO_CHAT_PROFILE = Object.freeze({
  replaysReasoningContent: true,
  firstByteTimeoutMs: MIMO_FIRST_BYTE_TIMEOUT_MS,
  semanticIdleTimeoutMs: MIMO_SEMANTIC_IDLE_TIMEOUT_MS,
  resolveModelInfo: (provider, model) => provider.getCachedModelInfo(model) || seedRow(model),
  applyParams: applyMimoParams,
  refineError: refineMimoError,
});
