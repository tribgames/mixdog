/**
 * wire-route.mjs — which wire a gateway model is reached on.
 *
 * A gateway that speaks several wires (OpenRouter, OpenCode Go, Command Code,
 * DeepSeek) sends each model over its brand-native or best-supported wire:
 * 'messages' (Anthropic Messages), 'responses' (OpenAI Responses), 'chat'
 * (Chat Completions) or 'gemini' (generateContent). One answer per
 * provider+model, in this order:
 *
 *   1. an explicit per-model user override (provider config `modelWires`),
 *   2. catalog / endpoint metadata (models.dev SDK package, the roster's
 *      advertised endpoints),
 *   3. the provider's model-family table,
 *   4. the provider default.
 *
 * Every tier is limited to the wires the gateway actually serves for that
 * model (`offered`, narrowed by advertised endpoints), so no tier can guess an
 * endpoint the gateway does not offer.
 *
 * A session pins its answer (`session.wireRoute`) before its first request,
 * so the tool snapshot, history lowering, request serialization and usage
 * normalization of every later turn follow the same wire; an existing session
 * keeps the wire it started on even after this table changes.
 *
 * `nativeDeferredTools` marks, per wire, whether the gateway is verified to
 * carry provider-native deferred tools (defer_loading + tool_reference on
 * Messages, tool_search output on Responses). It is OFF for every gateway
 * until verified live. A route pinned before its session's first request
 * records the flag (`nativeDeferredTools: true`); the session's tool surface
 * follows that record, so flipping a flag later only affects new sessions.
 */

export const WIRES = Object.freeze(['messages', 'responses', 'chat', 'gemini']);

const GO_RESPONSES = /^(?:muse-spark-|gpt-|grok-)/i;
const GO_MESSAGES = /^(?:minimax-|qwen|claude-)/i;
const GO_GEMINI = /^gemini-/i;
// Before Claude joined the cold-catalog Messages prefixes.
const GO_MESSAGES_BEFORE_CLAUDE = /^(?:minimax-|qwen)/i;

// Unverified: no gateway wire carries native deferred tools yet.
const nativeDeferredOff = () => ({ messages: false, responses: false });

export const PROFILES = Object.freeze({
  // OpenRouter serves every model on /chat/completions, /responses and
  // /messages; Claude is native on Messages, OpenAI GPT/o-series on Responses.
  openrouter: {
    offered: ['chat', 'messages', 'responses'],
    nativeDeferredTools: nativeDeferredOff(),
    families: [
      { match: /^~?anthropic\//i, wire: 'messages' },
      { match: /^(?:openai\/(?:gpt-|o\d)|~openai\/)/i, wire: 'responses' },
    ],
    defaultWire: 'chat',
    legacy: () => 'chat',
  },
  // OpenCode Go answers each brand on one wire (models.dev names it per model;
  // the prefixes are the cold-catalog fallback): Gemini on its generateContent
  // endpoint, Claude / MiniMax / Qwen on Messages, GPT / Grok / Muse on
  // Responses, the rest on Chat.
  'opencode-go': {
    offered: ['chat', 'responses', 'messages', 'gemini'],
    nativeDeferredTools: nativeDeferredOff(),
    families: [
      { match: GO_RESPONSES, wire: 'responses' },
      { match: GO_MESSAGES, wire: 'messages' },
      { match: GO_GEMINI, wire: 'gemini' },
    ],
    defaultWire: 'chat',
    // Sessions created before the Gemini wire existed sent Gemini models to Chat.
    legacy: ({ model, catalogWire }) => {
      if (catalogWire && catalogWire !== 'gemini') return catalogWire;
      if (GO_RESPONSES.test(model)) return 'responses';
      return GO_MESSAGES_BEFORE_CLAUDE.test(model) ? 'messages' : 'chat';
    },
  },
  // Command Code declares per-model endpoints: GPT / Muse / Grok prefer
  // Responses when advertised, otherwise Chat, Messages when it is the only
  // wire, and a Responses-only model stays reachable.
  'command-code-oauth': {
    offered: ['chat', 'messages', 'responses'],
    nativeDeferredTools: nativeDeferredOff(),
    families: [
      { match: /(?:^|\/)(?:gpt-|muse-|grok-)/i, wire: 'responses' },
      // Claude answers on /messages only: it keeps that wire even when the
      // roster cannot be read (the other families wait for the roster).
      { match: /(?:^|\/)claude-/i, wire: 'messages', cold: true },
    ],
    defaultWire: 'chat',
    preference: ['chat', 'messages', 'responses'],
    legacy: ({ endpoints }) => (endpoints.includes('chat') || !endpoints.includes('messages') ? 'chat' : 'messages'),
  },
  // DeepSeek's Anthropic endpoint carries thinking + tool blocks for agent/tool
  // sessions; Chat stays the wire for tool-less one-shot requests. It has no
  // Responses endpoint.
  deepseek: {
    offered: ['chat', 'messages'],
    nativeDeferredTools: nativeDeferredOff(),
    families: [{ match: /^deepseek-/i, wire: 'messages', agentOnly: true }],
    defaultWire: 'chat',
    legacy: () => 'chat',
  },
});

// User-defined providers (`custom-<uuid>`): one profile per configured
// provider, registered when the provider is built (customWireProfile).
const CUSTOM_PROFILES = new Map();

function profileOf(provider) {
  const name = String(provider || '');
  return Object.hasOwn(PROFILES, name) ? PROFILES[name] : CUSTOM_PROFILES.get(name) || null;
}

/**
 * The profile of a user-defined OpenAI-compatible provider: the wires its
 * endpoint is declared to serve (`wires`, default the protocol's own wire),
 * the protocol's wire as default and as the wire every existing session
 * started on. No model-family table: only the per-model `modelWires`
 * override picks another wire.
 */
export function customWireProfile({ protocolWire, wires = null }) {
  const offered = Array.isArray(wires) && wires.length ? [...wires] : [protocolWire];
  return {
    offered,
    nativeDeferredTools: nativeDeferredOff(),
    families: [],
    defaultWire: protocolWire,
    legacy: () => protocolWire,
  };
}

/** Register (or replace) the profile of user-defined provider `provider`. */
export function registerWireProfile(provider, profile) {
  CUSTOM_PROFILES.set(String(provider || ''), profile);
}

/** Whether `provider` routes models through this table. */
export function hasWireProfile(provider) {
  return profileOf(provider) !== null;
}

/** Whether `provider` serves `wire` at all. */
export function providerOffersWire(provider, wire) {
  return Boolean(profileOf(provider)?.offered.includes(wire));
}

/** Whether `provider`'s `wire` is verified to carry native deferred tools. */
export function wireSupportsNativeDeferredTools(provider, wire) {
  return profileOf(provider)?.nativeDeferredTools?.[wire] === true;
}

const NATIVE_DEFERRED_FAMILY = Object.freeze({ messages: 'anthropic', responses: 'openai' });

/**
 * The native deferred-tool family ('anthropic' | 'openai') a pinned route
 * gives `provider`, or '' — a route for another provider, one pinned without
 * verified support, or a wire with no native contract (Chat, Gemini).
 */
export function nativeDeferredFamilyForRoute(provider, route) {
  if (route?.nativeDeferredTools !== true) return '';
  const name = String(provider || '')
    .trim()
    .toLowerCase();
  if (!name || String(route.provider || '').toLowerCase() !== name) return '';
  return NATIVE_DEFERRED_FAMILY[route.wire] || '';
}

/**
 * @param {string} provider
 * @param {string} model  the routing id (an alias slug stays the alias)
 * @param {object} [ctx]
 * @param {string|null} [ctx.override]  the user's per-model wire
 * @param {string|null} [ctx.catalogWire]  the catalog's wire for this model
 * @param {string[]|null} [ctx.endpoints]  the wires the gateway advertises for this model
 * @param {boolean} [ctx.known]  false when no metadata describes the model at all
 * @param {boolean} [ctx.agent]  an agent/tool session (or a send carrying tools)
 * @param {boolean} [ctx.legacy]  the wire an existing session started on before this table
 * @param {string[]} [ctx.exclude]  wires that must not be chosen (the one a send was just refused on)
 * @returns {{ wire: string, profileId: string, source: string }|null}  null for a
 *   provider without a profile, or a model no offered wire serves
 */
export function resolveWireRoute(
  provider,
  model,
  {
    override = null,
    catalogWire = null,
    endpoints = null,
    known = true,
    agent = false,
    legacy = false,
    keep = null,
    exclude = [],
  } = {}
) {
  const profile = profileOf(provider);
  if (!profile) return null;
  const id = String(model || '');
  const route = (wire, source) => ({ wire, profileId: `${provider}:${wire}`, source });
  const advertised = (
    Array.isArray(endpoints) ? profile.offered.filter((wire) => endpoints.includes(wire)) : profile.offered
  ).filter((wire) => !exclude.includes(wire));
  const usable = (wire) => advertised.includes(wire);
  // A wire the session already pinned stays while the model is still offered
  // on it (a model nothing describes keeps its pin: no metadata, no change).
  if (keep && (known === false ? profile.offered : advertised).includes(keep)) return route(keep, 'pinned');
  // Nothing describes this model (no roster row, no cached row): the
  // gateway's conventional wire, flagged so a session never pins the guess.
  // A model with no advertised wire at all is not routable.
  const unknown = () => {
    // A family that is certain without metadata (`cold`: Claude on Command
    // Code answers on Messages only) outranks the conventional wire.
    const cold = profile.families.find((rule) => rule.cold === true && rule.match.test(id) && usable(rule.wire));
    const wire =
      cold?.wire ||
      (usable(profile.defaultWire) ? profile.defaultWire : (profile.preference || profile.offered).find(usable));
    return wire ? route(wire, 'unknown') : null;
  };
  if (legacy) {
    if (known === false) return unknown();
    // The wire a pre-table session started on, while the model still offers
    // it; otherwise the fresh resolution below (never an unadvertised wire).
    const legacyWire = profile.legacy({
      model: id,
      catalogWire: usable(catalogWire) ? catalogWire : null,
      endpoints: advertised,
    });
    if (usable(legacyWire)) return route(legacyWire, 'legacy');
  }
  if (override && usable(override)) return route(override, 'override');
  if (known === false) return unknown();
  if (catalogWire && usable(catalogWire)) return route(catalogWire, 'catalog');
  if (Array.isArray(endpoints) && advertised.length === 1) return route(advertised[0], 'endpoints');
  const family = profile.families.find(
    (rule) => rule.match.test(id) && (rule.agentOnly !== true || agent) && usable(rule.wire)
  );
  if (family) return route(family.wire, 'family');
  if (usable(profile.defaultWire)) return route(profile.defaultWire, 'default');
  const preferred = (profile.preference || profile.offered).find(usable);
  return preferred ? route(preferred, 'endpoints') : null;
}

/**
 * The route one send uses: the session's pinned route when it names this
 * provider and model, else a fresh resolution (a send carrying tools counts as
 * an agent/tool request). Resolved before the request is built, so lowering,
 * serialization and usage normalization all follow one answer.
 */
export async function sendWireRoute(provider, model, tools, sendOpts, messages = null) {
  const route = await resolveSendRoute(provider, model, tools, sendOpts, messages);
  // A provider with a wire table that offers the model nowhere: nothing is sent.
  if (!route && hasWireProfile(provider.name)) throw modelNotRoutableError(provider.name, model);
  return route;
}

// Status codes a gateway answers when it does not serve the model on the wire
// asked: 405 / 501 name the endpoint itself; 400 / 404 / 415 / 422 count only
// when the body also says the endpoint or route is unsupported. Auth (401,
// 403), quota / billing (402, 429) and server errors never qualify.
const ENDPOINT_STATUSES = new Set([405, 501]);
const REJECTION_STATUSES = new Set([400, 404, 415, 422]);
const ENDPOINT_WORDS =
  /\b(?:endpoints?|routes?)\b|\/(?:v1\/)?(?:messages|responses|chat\/completions)\b|chat completions/i;
const UNSUPPORTED_WORDS =
  /\bunsupported\b|not (?:be )?(?:supported|available|served|implemented)|(?:does not|doesn't|do not|don't) (?:support|serve)|only (?:available|supported|served)|wrong endpoint|use (?:the )?\/?(?:v1\/)?(?:messages|responses|chat\/completions)\b/i;
// A typed code / type that names an auth, quota, billing or parameter failure
// is never a wire rejection, whatever its message says about endpoints.
const NON_WIRE_ERROR_TYPE =
  /auth|permission|forbidden|api_?key|token|quota|billing|credit|balance|payment|insufficient|rate_?limit|too_many|overload|capacity|(?:unsupported|unknown|unrecognized|invalid)_?(?:parameter|param|field|argument|value)|invalid_?(?:request_)?param|context_?length|max_?tokens/i;
// The same families in message wording.
const NON_WIRE_ERROR_TEXT =
  /\b(?:unsupported|unknown|unrecognized|unexpected|invalid|extra|not permitted|not allowed)\s+(?:request\s+)?(?:parameters?|params?|fields?|arguments?|propert(?:y|ies)|options?|values?|keys?)\b|\bparameters?\b[^.]{0,40}\b(?:not supported|unsupported|not allowed)|\bquota\b|\bbilling\b|\bcredits?\b|\bbalance\b|\binsufficient\b|rate[ -]?limit|too many requests|unauthori[sz]ed|\bforbidden\b|invalid api key|api key|\bpayment\b|\bsubscription\b/i;

const errorTypes = (error) =>
  [
    error.code,
    error.type,
    error.providerErrorCode,
    error.providerErrorType,
    error.error?.code,
    error.error?.type,
    error.providerError?.code,
    error.providerError?.type,
  ].filter((part) => typeof part === 'string');

/**
 * Whether `error` is a clear "this model is not served on this wire"
 * rejection — the only failure a send may answer by switching wire. Typed
 * HTTP evidence only; an aborted, stalled or already-streaming failure
 * (anything that exposed output) never qualifies.
 */
export function isWireUnsupportedError(error) {
  if (!error || typeof error !== 'object') return false;
  if (error.liveTextEmitted === true || error.emittedToolCall === true || error.unsafeToRetry === true) return false;
  if (error.streamStalled === true || error.name === 'AbortError') return false;
  if (error.quotaExhausted === true || error.reauthRequired === true) return false;
  // A body that points at one request field (`param`) is a parameter error.
  if (typeof error.param === 'string' || typeof error.error?.param === 'string') return false;
  if (errorTypes(error).some((type) => NON_WIRE_ERROR_TYPE.test(type))) return false;
  const status = Number(error.status ?? error.httpStatus ?? error.statusCode ?? error.response?.status);
  const text = [error.message, error.error?.message, error.providerError?.message, error.error]
    .filter((part) => typeof part === 'string')
    .join(' ');
  if (NON_WIRE_ERROR_TEXT.test(text)) return false;
  if (ENDPOINT_STATUSES.has(status)) return true;
  if (!REJECTION_STATUSES.has(status)) return false;
  return ENDPOINT_WORDS.test(text) && UNSUPPORTED_WORDS.test(text);
}

// The send options with the output callbacks wrapped: `emitted()` turns true
// as soon as the caller was shown text, reasoning or a tool call.
function trackOutput(sendOpts) {
  let emitted = false;
  const wrap = (fn, shows = () => true) =>
    typeof fn === 'function'
      ? (...args) => {
          if (shows(...args)) emitted = true;
          return fn(...args);
        }
      : fn;
  const opts = { ...(sendOpts || {}) };
  opts.onTextDelta = wrap(opts.onTextDelta);
  opts.onToolCall = wrap(opts.onToolCall);
  opts.onStreamDelta = wrap(opts.onStreamDelta, (kind) => kind === 'text' || kind === 'reasoning' || kind === 'tool');
  return { opts, emitted: () => emitted };
}

/**
 * One send on its resolved route, with at most one switch of wire: when the
 * gateway clearly rejects the model on that wire before anything reached the
 * caller, the same request goes once more on the next wire the model is
 * served on, and the session records the new route (history written on the
 * old wire is lowered, as for any reroute). Never on an auth, quota, abort or
 * mid-stream failure, and never a second time.
 *
 * @param {(wire: string|undefined, history: object[], opts: object) => Promise<object>} dispatch
 *   sends `history` on `wire` through the provider's engine for that wire
 */
export async function sendOnRoute(provider, model, tools, sendOpts, messages, dispatch) {
  const route = await sendWireRoute(provider, model, tools, sendOpts, messages);
  const opts = withoutWireSwitches(sendOpts);
  const tracked = trackOutput(opts);
  try {
    const result = await dispatch(route?.wire, lowerHistoryForRoute(messages, route), tracked.opts);
    // A route re-resolved on this send (its pinned wire was dropped from the
    // provider's config) is reported back like a refusal reroute below.
    if (route?.source === 'reroute' && result && typeof result === 'object' && !Object.isFrozen(result)) {
      result.wireReroute = route;
    }
    return result;
  } catch (error) {
    if (!route || tracked.emitted() || opts.signal?.aborted || !isWireUnsupportedError(error)) throw error;
    const agent = Array.isArray(tools) && tools.length > 0;
    const next = (await provider.resolveWireRoute(model, { agent, exclude: [route.wire] })) || null;
    if (!next || next.wire === route.wire) throw error;
    const session = sendOpts?.session;
    const rerouted = {
      provider: provider.name,
      model,
      ...next,
      source: 'reroute',
      reroutedFrom: route.wire,
      reroutedReason: 'unsupported',
      loweredAssistantCount: countAssistants(session?.messages ?? messages),
    };
    // The pin names its own provider and model, so a projected session (the
    // model proxy's PC side carries no identity fields) is recognised by it.
    if (pinMatches(session?.wireRoute, provider.name, model)) session.wireRoute = rerouted;
    const result = await dispatch(rerouted.wire, lowerHistoryForRoute(messages, rerouted), opts);
    // The authoritative route travels back with the result, for a caller
    // whose session is not the object updated above (a proxied send).
    if (result && typeof result === 'object' && !Object.isFrozen(result)) result.wireReroute = rerouted;
    return result;
  }
}

const pinMatches = (pin, providerName, model) => Boolean(pin) && pin.provider === providerName && pin.model === model;

function modelNotRoutableError(provider, model) {
  return Object.assign(new Error(`[${provider}] model ${model} is not routable: no wire it is served on is offered`), {
    code: 'MODEL_NOT_ROUTABLE',
    provider,
    model,
  });
}

/**
 * Strip the competing wire switches from send options: the resolved route is
 * the only authority on which wire a request goes out on.
 */
export function withoutWireSwitches(sendOpts) {
  const { compatWireApi: _wire, responsesTransport: _transport, ...rest } = sendOpts || {};
  return rest;
}

// Every message field a provider adapter replays as wire-native state.
const WIRE_REPLAY_FIELDS = [
  'providerReplay',
  'reasoning',
  'thinkingBlocks',
  'assistantBlocks',
  'reasoningItems',
  'reasoningContent',
  'providerMetadata',
];

const countAssistants = (messages) =>
  Array.isArray(messages) ? messages.filter((message) => message?.role === 'assistant').length : 0;

/**
 * History as the route's wire may see it. A rerouted session (its pinned wire
 * was no longer offered) carries `loweredAssistantCount`: the assistant turns
 * recorded on the old wire. Their wire-native replay (reasoning, thinking
 * blocks, native items) is dropped; turns produced on the new wire keep theirs.
 */
export function lowerHistoryForRoute(messages, route) {
  const count = route?.source === 'reroute' ? route.loweredAssistantCount : 0;
  if (!(count > 0) || !Array.isArray(messages)) return messages;
  let seen = 0;
  return messages.map((message) => {
    if (message?.role !== 'assistant' || seen++ >= count) return message;
    if (!WIRE_REPLAY_FIELDS.some((field) => field in message)) return message;
    const plain = { ...message };
    for (const field of WIRE_REPLAY_FIELDS) delete plain[field];
    return plain;
  });
}

async function resolveSendRoute(provider, model, tools, sendOpts, messages) {
  const agent = Array.isArray(tools) && tools.length > 0;
  // The session's current pin outranks a copy carried in the send options: a
  // reroute updates the session, and later sends of the same turn reuse opts.
  const sessionPin = sendOpts?.session?.wireRoute;
  const pinned = pinMatches(sessionPin, provider.name, model) ? sessionPin : (sendOpts?.wireRoute ?? sessionPin);
  if (pinMatches(pinned, provider.name, model)) {
    // The pin stands while the model's current endpoints still offer its wire
    // (the provider may have been edited to drop it); otherwise the route is
    // resolved fresh (not legacy) and the reroute is recorded.
    const current = (await provider.resolveWireRoute(model, { agent, keep: pinned.wire })) || null;
    if (current?.source === 'pinned') return pinned;
    if (current && current.source !== 'unknown') {
      const session = sendOpts?.session;
      // An explicit reroute: recorded on the pin, with the history already
      // written on the old wire marked for lowering.
      const repinned = {
        provider: provider.name,
        model,
        ...current,
        source: 'reroute',
        reroutedFrom: pinned.wire,
        loweredAssistantCount: countAssistants(session?.messages ?? messages),
      };
      if (session?.wireRoute === pinned) session.wireRoute = repinned;
      return repinned;
    }
    return current;
  }
  // A session created before this table that already talked to its model keeps
  // its wire even when the pin could not resolve (no metadata yet) and the
  // metadata recovered by this send: resolve as legacy and pin it now.
  const legacySession = legacySessionOf(sendOpts?.session, provider.name, model);
  const route = (await provider.resolveWireRoute(model, legacySession ? { agent, legacy: true } : { agent })) || null;
  if (legacySession && route && route.source !== 'unknown' && legacySession.wireRoute === undefined) {
    legacySession.wireRoute = { provider: provider.name, model, ...route };
    return legacySession.wireRoute;
  }
  return route;
}

// `wireRoute` is absent (not null) on a session created before the table.
const isLegacySession = (subject) => subject.wireRoute === undefined && hasAssistantHistory(subject);

// The session of this send when it is an existing one for this provider and model.
function legacySessionOf(candidate, providerName, model) {
  return candidate && candidate.provider === providerName && candidate.model === model && isLegacySession(candidate)
    ? candidate
    : null;
}

const hasAssistantHistory = (session) =>
  Array.isArray(session?.messages) && session.messages.some((message) => message?.role === 'assistant');

/**
 * Pin the session's wire before its turn reaches the request boundary.
 * `session.wireRoute` is null on a session created with this table (resolved
 * fresh) and absent on one created before it: such a session that already
 * talked to its model keeps the wire it started on. A route change (another
 * provider or model) resolves fresh. A single-wire adapter pins nothing, and
 * a resolution that failed or had no metadata is not pinned — the send
 * resolves again and surfaces the real failure.
 *
 * Only a route pinned before the session's first answered request records
 * verified native deferred-tool support: a session that already talked on
 * the bridge keeps it.
 */
export async function pinSessionWireRoute(session, provider) {
  if (!session?.provider || !session.model) return null;
  const current = session.wireRoute;
  if (current && current.provider === session.provider && current.model === session.model) return current;
  if (typeof provider?.resolveWireRoute !== 'function') return null;
  // Decided before any await: the turn appends its own messages afterwards.
  const answered = hasAssistantHistory(session);
  const legacy = current === undefined && answered;
  const { provider: providerName, model } = session;
  let route;
  try {
    route = await provider.resolveWireRoute(model, { agent: true, legacy });
  } catch {
    return null;
  }
  if (!route || route.source === 'unknown') return null;
  // The route changed while resolving: the newer route pins on its own turn.
  if (session.provider !== providerName || session.model !== model) return null;
  const nativeDeferred = !answered && wireSupportsNativeDeferredTools(providerName, route.wire);
  session.wireRoute = {
    provider: providerName,
    model,
    ...route,
    ...(nativeDeferred ? { nativeDeferredTools: true } : {}),
  };
  return session.wireRoute;
}
