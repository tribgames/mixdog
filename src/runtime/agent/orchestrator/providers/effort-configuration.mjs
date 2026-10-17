import { isVisibleStreamProgress } from '../../../shared/stream-progress.mjs';
import { anthropicEffortLevelsFor, normalizeAnthropicEffortInput } from './anthropic-effort.mjs';
import { CUSTOM_EFFORT_LEVELS, customEffortLevels, isCustomProviderName } from './custom-reasoning.mjs';
import { codexModelSupportsEffortUpdates } from './openai-oauth-catalog.mjs';

export const EFFORT_CONFIGURATION_BETA = 'mid-conversation-output-config-2026-07-01';
// Mid-conversation effort updates by model version: each family from the
// first version checked on the wire (update accepted, prompt cache kept), and
// every later version of that family. A model that turns out to reject the
// update is switched off at runtime (markEffortConfigurationUnsupported).
// The Anthropic catalogs publish no per-model flag for it, so a measured
// floor is kept for the families already checked: below it the rejection is
// certain, and every request would pay a failed attempt first.
const ANTHROPIC_MIN_VERSION = Object.freeze({
  opus: [5, 0],
  sonnet: [5, 5],
  haiku: [5, 5],
  fable: [5, 1],
  mythos: [5, 1],
});
// A family not measured yet starts at the earliest checked major, on the
// routes that replay a rejected update (the rest cannot recover from one).
const ANTHROPIC_FIRST_MAJOR = Math.min(...Object.values(ANTHROPIC_MIN_VERSION).map(([major]) => major));
const ANTHROPIC_REPLAYING_PROVIDERS = new Set(['anthropic-oauth']);
// https://developers.openai.com/api/docs/guides/reasoning#change-reasoning-mid-conversation
// — GPT-6 and later, standard single-agent mode. The public API publishes no
// per-model flag, so the version is its whole answer; the OAuth backend's
// catalog carries one and only falls back to the version without it.
const OPENAI_MIN_MAJOR = 6;
const unsupportedModels = new Set();

function versionAtLeast([major, minor], [minMajor, minMinor]) {
  return major > minMajor || (major === minMajor && minor >= minMinor);
}

function anthropicVersionSupported(provider, id) {
  const m = id.match(/^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?$/);
  if (!m) return false;
  const version = [Number(m[2]), Number(m[3] || 0)];
  const floor = ANTHROPIC_MIN_VERSION[m[1]];
  if (floor) return versionAtLeast(version, floor);
  return ANTHROPIC_REPLAYING_PROVIDERS.has(provider) && version[0] >= ANTHROPIC_FIRST_MAJOR;
}

// Any `gpt-<major>` id, whatever follows the major (tier names, minors,
// snapshots), so a later naming scheme needs no edit.
function openAiVersionSupported(id) {
  const m = id.match(/^gpt-(\d+)(?:-|$)/);
  return Boolean(m) && Number(m[1]) >= OPENAI_MIN_MAJOR;
}

/** A model that rejected a mid-conversation effort update: no updates for it in this process. */
export function markEffortConfigurationUnsupported(provider, model) {
  unsupportedModels.add(`${provider}:${modelKey(model)}`);
}

/** True for a provider error that names the mid-conversation effort update. */
export function isEffortConfigurationRejection(status, text) {
  const message = String(text || '');
  if (status !== 400) return false;
  if (/mid-conversation|configuration_update|reasoning_effort_update/i.test(message)) return true;
  // A rejected `output_config.effort` VALUE (the error quotes a level) belongs
  // to the effort-rejection fallback (effort-rejection.mjs); a rejected field
  // ("output_config.effort is not supported") is still the update case.
  if (
    /output_config\.effort\b(?!_)/i.test(message) &&
    /['"`](?:none|minimal|low|medium|high|xhigh|max|ultra)['"`]/i.test(message)
  )
    return false;
  return /output_config/i.test(message);
}

/**
 * Runs `send(opts)`; when the model rejects the mid-conversation effort
 * update, switches the updates off for it and replays the request once
 * without them. Never replay after output reached the caller, cancellation,
 * or an explicit opt-out; a late error is not evidence of missing support.
 */
export async function withEffortConfigurationFallback(provider, model, opts, send) {
  let streamed = false;
  const track =
    (callback, isProgress = false) =>
    (...args) => {
      if (!isProgress || isVisibleStreamProgress(args[0])) streamed = true;
      return callback(...args);
    };
  const tracked = { ...opts };
  if (typeof opts?.onStreamDelta === 'function') tracked.onStreamDelta = track(opts.onStreamDelta, true);
  if (typeof opts?.onTextDelta === 'function') tracked.onTextDelta = track(opts.onTextDelta);
  if (typeof opts?.onToolCall === 'function') tracked.onToolCall = track(opts.onToolCall);
  try {
    return await send(tracked);
  } catch (error) {
    const status = error?.status ?? error?.httpStatus;
    const emitted =
      streamed || error?.liveTextEmitted === true || error?.emittedToolCall === true || error?.unsafeToRetry === true;
    if (
      opts?._effortConfigurationRetry ||
      opts?.effortConfigurationEnabled === false ||
      opts?.signal?.aborted ||
      emitted ||
      !isEffortConfigurationRejection(status, error?.message)
    )
      throw error;
    markEffortConfigurationUnsupported(provider, model);
    process.stderr.write(
      `[${provider}] ${model} rejected the mid-conversation effort update; retrying once without it\n`
    );
    return send({ ...tracked, effortConfigurationEnabled: false, _effortConfigurationRetry: true });
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

// A custom route on the Responses wire (`opts.protocol`) serving GPT-6 or
// later takes the same update as the official routes. The version is read
// from the id's last `/` segment, so gateway ids like `openai/gpt-6.1-sol` count.
function customResponsesSupportsEffortUpdates(provider, opts, id) {
  return (
    isCustomProviderName(provider) &&
    opts.protocol === 'openai-responses' &&
    openAiVersionSupported(id.slice(id.lastIndexOf('/') + 1))
  );
}

export function effortConfigurationMode(provider, model, opts = {}) {
  const id = modelKey(model);
  if (opts.effortConfigurationEnabled === false || Number(opts.thinkingBudgetTokens) > 0) return null;
  if (unsupportedModels.has(`${provider}:${id}`)) return null;
  if (
    (OPENAI_PROVIDERS.has(provider) && openAiSupportsEffortUpdates(provider, model, id)) ||
    customResponsesSupportsEffortUpdates(provider, opts, id)
  ) {
    const parameters = opts.modelParameters || {};
    const mode = opts.reasoning?.mode ?? parameters.reasoning_mode ?? parameters.mode ?? 'standard';
    if (mode !== 'standard' || opts.multiAgent === true || parameters.multi_agent === true) return null;
    return 'responses';
  }
  if (
    ANTHROPIC_PROVIDERS.has(provider) &&
    anthropicVersionSupported(provider, id) &&
    opts.disableBetaHeaders !== true &&
    (!opts.baseURL || /^https:\/\/api\.anthropic\.com(?:\/|$)/.test(opts.baseURL))
  )
    return 'anthropic';
  return null;
}

// Custom providers on the Chat and Responses wires take a fresh effort with
// every request, so auto effort sends a turn's or step's effort as that
// request's own effort: no mid-conversation update, no beta header (except a
// Responses-wire GPT-6+ model, which takes the 'responses' update). A custom
// Anthropic-wire provider keeps auto effort off.
const CUSTOM_AUTO_EFFORT_PROTOCOLS = new Set(['openai-chat', 'openai-responses']);

/** Auto effort applies to this custom route: a Chat/Responses protocol and a
 *  model row declaring a non-empty effort level list. */
export function customAutoEffortCapable(provider, protocol, model) {
  return (
    isCustomProviderName(provider) &&
    CUSTOM_AUTO_EFFORT_PROTOCOLS.has(protocol) &&
    (customEffortLevels(model)?.length || 0) > 0
  );
}

/** The model auto effort reads its effort options from: a custom provider's
 *  effective row (its declared levels); an Anthropic route's id with the
 *  levels the wire builder accepts (provider rows ignored); the bare id for every other route. */
export function autoEffortModel(providerName, providerImpl, model) {
  if (ANTHROPIC_PROVIDERS.has(providerName)) {
    // The wire builder ignores provider rows on first-party routes, so the
    // ladder is exactly what it accepts. `customReasoning` keeps an empty
    // list from falling back to a family ladder.
    return { id: model, reasoningLevels: anthropicEffortLevelsFor(model), customReasoning: true };
  }
  // Every other route reads the provider's own cached model row, the source
  // route resolution (lookupModelMeta) uses; a bare id has no levels and
  // skips the judge.
  return { ...(providerImpl?.getCachedModelInfo?.(model) || {}), id: model };
}

/** The effort-change mode of a session's route: 'responses' / 'anthropic'
 *  (mid-conversation update), 'custom' (per-request effort), or null. A
 *  custom route takes an update mode only when its model declares levels. */
export function turnEffortConfigurationMode(session, provider) {
  const protocol = provider?.customConfig?.protocol;
  const opts = { ...(provider?.config || {}), modelParameters: session.modelParameters || {}, protocol };
  const custom = customAutoEffortCapable(
    session.provider,
    protocol,
    autoEffortModel(session.provider, provider, session.model)
  );
  const mode = effortConfigurationMode(session.provider, session.model, opts);
  if (mode && (custom || !isCustomProviderName(session.provider))) return mode;
  return custom ? 'custom' : null;
}

const CUSTOM_EFFORTS = new Set(CUSTOM_EFFORT_LEVELS);
// A custom route keeps its own levels (including `none`) in either mode.
const effortsFor = (mode, provider) => (mode === 'custom' || isCustomProviderName(provider) ? CUSTOM_EFFORTS : EFFORTS);

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
    effortsFor(mode, provider).has(value.initialEffort) &&
    effortsFor(mode, provider).has(value.effort)
  );
}

// `turnEffort` overrides the session's saved effort for this turn only (auto
// effort); the saved default itself is never changed here. A custom route's
// snapshot only records the turn's effort (per-request effort, never projected
// into the history).
export function prepareTurnEffortConfiguration(session, provider, turnEffort) {
  const mode = turnEffortConfigurationMode(session, provider);
  const effort = normalizedEffort(session.provider, session.model, turnEffort ?? session.effort);
  if (!mode || !effortsFor(mode, session.provider).has(effort)) return null;
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
  if (!snapshot || !effortsFor(snapshot.mode, provider).has(value)) return null;
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

/**
 * Responses-wire placement of a projection's updates while a history is
 * lowered in order: `before(message)` gives the items to emit ahead of a
 * message, `end()` those after the last one. An update on a tool result
 * applies after its whole batch; one on a user message before it. Adjacent
 * updates are rejected, so a batch update that a user message directly
 * follows yields to that message's own.
 */
export function responsesEffortUpdates(projection) {
  let afterBatch = null;
  const items = (effort) => (effort ? [{ type: 'configuration_update', reasoning: { effort } }] : []);
  return {
    before(message) {
      const effort = projection?.updates.get(message);
      if (message.role === 'tool') {
        if (effort) afterBatch = effort;
        return [];
      }
      const value = effort || afterBatch;
      afterBatch = null;
      return items(value);
    },
    end: () => items(afterBatch),
  };
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
