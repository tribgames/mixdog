import { normalizeAnthropicEffortInput } from './anthropic-effort.mjs';
import { codexModelSupportsEffortUpdates } from './openai-oauth-catalog.mjs';

export const EFFORT_CONFIGURATION_BETA = 'mid-conversation-output-config-2026-07-01';
// Mid-conversation effort updates by model version: each family from the
// first version checked on the wire (update accepted, prompt cache kept), and
// every later version of that family. A model that turns out to reject the
// update is switched off at runtime (markEffortConfigurationUnsupported).
const ANTHROPIC_MIN_VERSION = Object.freeze({
  opus: [5, 0],
  sonnet: [5, 5],
  haiku: [5, 5],
  fable: [5, 1],
  mythos: [5, 1],
});
// https://developers.openai.com/api/docs/guides/reasoning#change-reasoning-mid-conversation
// — GPT-6 and later, standard single-agent mode. The public API publishes no
// per-model flag, so the version is its whole answer; the OAuth backend's
// catalog carries one and only falls back to the version without it.
const OPENAI_MIN_MAJOR = 6;
const unsupportedModels = new Set();

function versionAtLeast([major, minor], [minMajor, minMinor]) {
  return major > minMajor || (major === minMajor && minor >= minMinor);
}

function anthropicVersionSupported(id) {
  const m = id.match(/^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?$/);
  const floor = m && ANTHROPIC_MIN_VERSION[m[1]];
  return Boolean(floor) && versionAtLeast([Number(m[2]), Number(m[3] || 0)], floor);
}

function openAiVersionSupported(id) {
  const m = id.match(/^gpt-(\d+)(?:-\d+)?(?:-[a-z]+)?$/);
  return Boolean(m) && Number(m[1]) >= OPENAI_MIN_MAJOR;
}

/** A model that rejected a mid-conversation effort update: no updates for it in this process. */
export function markEffortConfigurationUnsupported(provider, model) {
  unsupportedModels.add(`${provider}:${modelKey(model)}`);
}

/** True for a provider error that names the mid-conversation effort update. */
export function isEffortConfigurationRejection(status, text) {
  return status === 400 && /output_config|mid-conversation|configuration_update|reasoning_effort_update/i.test(String(text || ''));
}

/**
 * Runs `send(opts)`; when the model rejects the mid-conversation effort
 * update, switches the updates off for it and replays the request once
 * without them. The rejection happens before any output streams.
 */
export async function withEffortConfigurationFallback(provider, model, opts, send) {
  try {
    return await send(opts);
  } catch (error) {
    const status = error?.status ?? error?.httpStatus;
    if (opts?._effortConfigurationRetry || !isEffortConfigurationRejection(status, error?.message)) throw error;
    markEffortConfigurationUnsupported(provider, model);
    process.stderr.write(`[${provider}] ${model} rejected the mid-conversation effort update; retrying once without it\n`);
    return send({ ...opts, effortConfigurationEnabled: false, _effortConfigurationRetry: true });
  }
}
const OPENAI_PROVIDERS = new Set(['openai', 'openai-oauth']);
const ANTHROPIC_PROVIDERS = new Set(['anthropic', 'anthropic-oauth']);
const EFFORTS = new Set(['minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
const META_KEY = 'effortConfiguration';
const anthropicEffortBodies = new WeakSet();

export function markAnthropicEffortBody(body, projection) {
  if (projection?.mode === 'anthropic') anthropicEffortBodies.add(body);
  return body;
}

export function usesAnthropicEffortBody(body) {
  return anthropicEffortBodies.has(body);
}

export function cloneAnthropicEffortBody(body, overrides) {
  const cloned = { ...body, ...overrides };
  if (usesAnthropicEffortBody(body)) anthropicEffortBodies.add(cloned);
  return cloned;
}

function modelKey(model) {
  return String(model || '')
    .trim()
    .toLowerCase()
    .replace(/-\d{4}-\d{2}-\d{2}$/, '')
    .replace(/-\d{8}$/, '')
    .replace(/\./g, '-');
}

function openAiSupportsEffortUpdates(provider, model, id) {
  const declared = provider === 'openai-oauth' ? codexModelSupportsEffortUpdates(String(model || '').trim()) : null;
  return declared ?? openAiVersionSupported(id);
}

export function effortConfigurationMode(provider, model, opts = {}) {
  const id = modelKey(model);
  if (opts.effortConfigurationEnabled === false || Number(opts.thinkingBudgetTokens) > 0) return null;
  if (unsupportedModels.has(`${provider}:${id}`)) return null;
  if (OPENAI_PROVIDERS.has(provider) && openAiSupportsEffortUpdates(provider, model, id)) {
    const parameters = opts.modelParameters || {};
    const mode = opts.reasoning?.mode ?? parameters.reasoning_mode ?? parameters.mode ?? 'standard';
    if (mode !== 'standard' || opts.multiAgent === true || parameters.multi_agent === true) return null;
    return 'responses';
  }
  if (
    ANTHROPIC_PROVIDERS.has(provider) &&
    anthropicVersionSupported(id) &&
    opts.disableBetaHeaders !== true &&
    (!opts.baseURL || /^https:\/\/api\.anthropic\.com(?:\/|$)/.test(opts.baseURL))
  )
    return 'anthropic';
  return null;
}

function normalizedEffort(provider, model, effort) {
  if (ANTHROPIC_PROVIDERS.has(provider)) return normalizeAnthropicEffortInput(effort, model) || null;
  const value = String(effort || 'medium')
    .trim()
    .toLowerCase();
  return value === 'ultra' ? 'max' : value;
}

function validSnapshot(value, provider, model, mode) {
  return (
    value?.version === 1 &&
    value.provider === provider &&
    value.model === modelKey(model) &&
    value.mode === mode &&
    EFFORTS.has(value.initialEffort) &&
    EFFORTS.has(value.effort)
  );
}

// `turnEffort` overrides the session's saved effort for this turn only (auto
// effort); the saved default itself is never changed here.
export function prepareTurnEffortConfiguration(session, provider, turnEffort) {
  const config = provider?.config || {};
  const opts = { ...config, modelParameters: session.modelParameters || {} };
  const mode = effortConfigurationMode(session.provider, session.model, opts);
  const effort = normalizedEffort(session.provider, session.model, turnEffort ?? session.effort);
  if (!mode || !EFFORTS.has(effort)) return null;
  const first = (session.messages || []).find((message) =>
    validSnapshot(message?.meta?.[META_KEY], session.provider, session.model, mode)
  )?.meta?.[META_KEY];
  const snapshot = {
    version: 1,
    provider: session.provider,
    model: modelKey(session.model),
    mode,
    initialEffort: first?.initialEffort || effort,
    effort,
  };
  // Persist the start/current distinction; the turn receives its own value
  // snapshot so a UI edit cannot change an in-flight provider request.
  session.effortConfiguration = snapshot;
  return snapshot;
}

// The turn's snapshot carrying a tool-result step's effort (auto effort per
// step), or null when that effort is not valid for the model.
export function stepEffortConfiguration(snapshot, provider, model, effort) {
  const value = normalizedEffort(provider, model, effort);
  if (!snapshot || !EFFORTS.has(value)) return null;
  return { ...snapshot, effort: value };
}

export function projectEffortConfiguration(messages, provider, model, opts = {}) {
  const mode = effortConfigurationMode(provider, model, opts);
  if (!mode) return null;
  // A user message carries a turn's effort; a tool result carries the effort
  // of the step that follows its tool batch.
  const marked = (messages || []).filter(
    (message) =>
      (message?.role === 'user' || message?.role === 'tool') &&
      validSnapshot(message?.meta?.[META_KEY], provider, model, mode)
  );
  const seed = marked[0]?.meta?.[META_KEY] || opts.effortConfiguration;
  if (!validSnapshot(seed, provider, model, mode)) return null;
  const updates = new Map();
  let current = seed.initialEffort;
  for (const message of marked) {
    const value = message.meta[META_KEY];
    if (value.effort !== current) {
      updates.set(message, value.effort);
      current = value.effort;
    }
  }
  if (!marked.length && seed.effort !== current) {
    const nextUser = messages.findLast((message) => message?.role === 'user');
    if (nextUser) {
      updates.set(nextUser, seed.effort);
      current = seed.effort;
    }
  }
  return { mode, initialEffort: seed.initialEffort, effort: current, updates };
}

// Split only before a user message or after a whole tool-result batch.
// Sanitizing each segment before inserting the trusted empty system control
// avoids losing it as empty text, and never separates a tool call from its
// result. An update after a batch that a user message directly follows is
// superseded by that message's own update.
export function lowerAnthropicEffortHistory(messages, lower, projection) {
  if (!projection) return lower(messages);
  // Cache markers otherwise turn a string into a text-block array only on
  // some turns. Keep one representation throughout a configured history.
  const canonical = (items) =>
    items.map((message) =>
      typeof message.content === 'string' ? { ...message, content: [{ type: 'text', text: message.content }] } : message
    );
  if (!projection.updates.size) return canonical(lower(messages));
  const result = [];
  let segment = [];
  let afterBatch = null;
  const control = (effort) => {
    if (segment.length) result.push(...lower(segment));
    result.push({ role: 'system', content: [], output_config: { effort } });
    segment = [];
  };
  for (const message of messages) {
    const effort = projection.updates.get(message);
    if (message.role !== 'tool' && (effort || afterBatch)) control(effort || afterBatch);
    if (message.role !== 'tool') afterBatch = null;
    else if (effort) afterBatch = effort;
    segment.push(message);
  }
  if (afterBatch) control(afterBatch);
  if (segment.length) result.push(...lower(segment));
  return canonical(result);
}

export function stripEffortConfiguration(messages) {
  return messages.map((message) => {
    if (!message?.meta || !Object.hasOwn(message.meta, META_KEY)) return message;
    const { [META_KEY]: _drop, ...meta } = message.meta;
    return { ...message, meta };
  });
}

export function rebaseCompactedEffortConfiguration(before, after) {
  const last = before.findLast((message) => {
    const value = message?.meta?.[META_KEY];
    return value && validSnapshot(value, value.provider, value.model, value.mode);
  })?.meta?.[META_KEY];
  if (!last) return after;
  const result = stripEffortConfiguration(after);
  const index = result.findIndex((message) => message?.role === 'user');
  if (index >= 0)
    result[index] = {
      ...result[index],
      meta: { ...result[index].meta, [META_KEY]: { ...last, initialEffort: last.effort } },
    };
  return result;
}
