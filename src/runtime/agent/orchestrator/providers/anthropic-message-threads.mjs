/**
 * anthropic-message-threads.mjs — Anthropic message threads (delta sending)
 * for both first-party Anthropic routes (API key and OAuth).
 *
 * The provider builds its full request exactly as before; this module then
 * decides how that request goes on the wire:
 *   create    the full request plus `thread: {type: 'create'}`
 *   continue  only the messages after the server-held conversation, plus
 *             `thread: {type: 'continue', previous_message_id}`; `system` and
 *             `tools` left out (the thread keeps the create-time values)
 *   none      the unchanged full request
 *
 * Per conversation (`opts.transportScope || opts.sessionId`, per provider) it
 * keeps only ids and digests: the latest stored response id, a fingerprint of
 * the create-only and fixed fields, the account identity, the digest/length of
 * the exact wire message prefix the server holds, and the digest of the stored
 * response's complete content. A send continues only when its own full wire
 * messages are that prefix followed by a message whose content is exactly the
 * stored response, nothing fixed changed and the thread is younger than
 * THREAD_CONTINUE_MAX_AGE_MS; everything else creates. Compaction, rewind,
 * edits, model/account/system/tool/cache-strategy changes therefore fall back
 * to a create by construction.
 *
 * A send that threads owns its conversation until the next send takes it: the
 * stored state is consumed when the send begins and written back only by that
 * owner, only while the conversation was not torn down since (session close,
 * delete, scope disposal), and only for a response that reached message_stop
 * with a normal stop. Anything else leaves "unknown" and the next turn creates.
 * A second send on a conversation whose owner is still in flight goes
 * unthreaded.
 */
import { createHash } from 'node:crypto';
import {
  anthropicFirstPartyRoute,
  anthropicTurnScopedReminders,
  countAnthropicCacheControls,
  resolveAnthropicCacheTtls,
} from './lib/anthropic-request-utils.mjs';
import { splitTailReminder } from './lib/tail-reminder-split.mjs';

export const MESSAGE_THREADS_BETA = 'message-threads-2026-08-12';

// The API expires a thread 5 minutes after its latest stored response; a
// continue older than this margin is skipped for a direct create.
export const THREAD_CONTINUE_MAX_AGE_MS = 270_000;

// The request-wide limit on cache_control breakpoints with `thread` set.
const THREAD_MAX_BREAKPOINTS = 4;

// How long a threaded stream that ended on an early terminal frame (tool_use
// message_delta) is read on in the background for the message_stop that
// confirms storage. The turn itself is not held for it.
export const THREAD_MESSAGE_STOP_WAIT_MS = 5_000;

// Models the feature documents as supported (dated variants of a listed alias
// and the dated ids themselves match).
const SUPPORTED_MODELS = [
  'claude-fable-5-1',
  'claude-mythos-5-1',
  'claude-fable-5',
  'claude-mythos-5',
  'claude-mythos-preview',
  'claude-opus-5-5',
  'claude-opus-5',
  'claude-sonnet-5-5',
  'claude-sonnet-5',
  'claude-haiku-5-5',
  'claude-haiku-4-5-20251001',
  'claude-opus-4-8',
  'claude-opus-4-7',
  'claude-opus-4-6',
  'claude-sonnet-4-6',
  'claude-opus-4-5-20251101',
  'claude-sonnet-4-5-20250929',
];

const NORMAL_STOPS = new Set(['end_turn', 'tool_use', 'stop_sequence', 'pause_turn', 'max_tokens']);
const REPLAY_CODES = new Set([
  'thread_not_found',
  'thread_already_continued',
  'thread_continue_in_flight',
  'thread_fingerprint_mismatch',
]);
// thread_unsupported_request values that are organization settings: no
// request of this account can be threaded.
const ACCOUNT_UNSUPPORTED = new Set(['hipaa', 'inference_hooks']);
// An uncoded refusal that names the `thread` parameter or the beta itself.
const EXPLICIT_THREAD_REJECTION = new RegExp(
  `${MESSAGE_THREADS_BETA}|(?:^|[^\\w-])thread(?:[\`'"]|\\s*:|\\.(?:type|previous_message_id)\\b|\\s+(?:parameter|field)\\b)`,
  'i'
);

// scope -> Map(provider -> { token, inFlight, state, disabledAccount }).
// The inner map is the scope's generation: teardown drops it, so a send
// planned before the teardown can no longer write into the new one.
const scopes = new Map();
// account key -> { confirmed, disabled, logged }
const accounts = new Map();
// scope -> Set(release) of background message_stop reads still open.
const drains = new Map();
// The latest threaded plan's mode, for diagnostics.
let lastPlanned = null;

function sha(text) {
  return createHash('sha256').update(text).digest('hex');
}

export function threadsSupportModel(model) {
  const id = String(model || '').trim();
  if (!id) return false;
  return SUPPORTED_MODELS.some(
    (listed) =>
      listed === id ||
      (id.startsWith(`${listed}-`) && /^\d{8}$/.test(id.slice(listed.length + 1))) ||
      (listed.startsWith(`${id}-`) && /^\d{8}$/.test(listed.slice(id.length + 1)))
  );
}

/** Threads are on unless the provider config, the send or the environment turns them off. */
export function messageThreadsEnabled(config, opts) {
  if (process.env.MIXDOG_ANTHROPIC_MESSAGE_THREADS === '0') return false;
  return config?.messageThreads !== false && opts?.messageThreads !== false;
}

/** The account a thread belongs to, as an opaque hash. */
export function threadAccountKey(provider, ...parts) {
  return sha([provider, ...parts.map((p) => String(p ?? ''))].join('\u0000'));
}

function conversationScope(opts) {
  return opts?.transportScope || opts?.sessionId || '';
}

// Context editing other than clear_thinking keep:"all", and compaction, are
// not available with threads.
function contextManagementThreadable(body) {
  const cm = body.context_management;
  if (cm == null) return true;
  const edits = Array.isArray(cm.edits) ? cm.edits : [];
  return edits.every((edit) => edit?.type === 'clear_thinking_20251015' && edit?.keep === 'all');
}

// A legacy tail reminder rides the last user message of this request only, so
// the next request rewrites what the server would hold: such a create could
// never be continued.
function carriesLegacyTailReminder(provider, config, model, requestMessages) {
  if (!requestMessages) return false;
  return Boolean(splitTailReminder(requestMessages).reminder) && !anthropicTurnScopedReminders(provider, model, config);
}

function eligible({ provider, config, opts, body, requestMessages }) {
  if (!messageThreadsEnabled(config, opts)) return false;
  if (!anthropicFirstPartyRoute(provider, config)) return false;
  // One-shot forks (side questions, compaction summaries) never continue.
  if (opts?.transportScope || opts?.sharedCachePrefixCount || opts?.requestKind === 'compaction') return false;
  if (!opts?.sessionId) return false;
  if (!threadsSupportModel(body?.model)) return false;
  if (body.compaction != null) return false;
  if (carriesLegacyTailReminder(provider, config, body.model, requestMessages)) return false;
  return contextManagementThreadable(body);
}

function withoutAuthTokens(servers) {
  if (!Array.isArray(servers)) return servers;
  return servers.map((server) => {
    if (!server || typeof server !== 'object') return server;
    const { authorization_token: _token, ...rest } = server;
    return rest;
  });
}

/** Hash of every create-only and fixed field, the beta set and the per-layer cache TTLs. */
export function threadFingerprint(body, betas, opts) {
  return sha(
    JSON.stringify({
      model: body.model,
      system: body.system ?? null,
      tools: body.tools ?? null,
      tool_choice: body.tool_choice ?? null,
      thinking: body.thinking ?? null,
      mcp_servers: withoutAuthTokens(body.mcp_servers) ?? null,
      context_management: body.context_management ?? null,
      output_config: body.output_config ?? null,
      container_skills: body.container?.skills ?? null,
      cache_control: body.cache_control ?? null,
      fallbacks: body.fallbacks !== undefined,
      betas: [...new Set(betas)].sort(),
      cacheTtls: resolveAnthropicCacheTtls(opts),
    })
  );
}

// A string content is one text block on the wire (a breakpoint turns it into
// that shape), so both compare equal.
function contentBlocks(content) {
  return typeof content === 'string' && content ? [{ type: 'text', text: content }] : content;
}

function withoutBlockMarker(block) {
  if (!block || typeof block !== 'object' || !Object.hasOwn(block, 'cache_control')) return block;
  const { cache_control: _marker, ...rest } = block;
  return rest;
}

/**
 * A message's content blocks without their breakpoints. A breakpoint is the
 * `cache_control` property of a content block itself, or of a block inside a
 * tool_result's content list; everything else (tool_use input, tool_result
 * payloads, any user data) is kept byte for byte, `cache_control` keys too.
 */
function blocksWithoutBreakpoints(content) {
  const blocks = contentBlocks(content);
  if (!Array.isArray(blocks)) return blocks;
  return blocks.map((block) => {
    const bare = withoutBlockMarker(block);
    if (bare?.type !== 'tool_result' || !Array.isArray(bare.content)) return bare;
    return { ...bare, content: bare.content.map(withoutBlockMarker) };
  });
}

// One wire message as the server stores it, minus breakpoints.
function messageKey(message) {
  return JSON.stringify({ ...message, content: blocksWithoutBreakpoints(message?.content) });
}

function prefixHash(messages, count) {
  const hash = createHash('sha256');
  for (let i = 0; i < count; i++) hash.update(`${messageKey(messages[i])}\n`);
  return hash.digest('hex');
}

// Key-order independent serialization: a tool input the stream parsed and the
// same input lowered from the transcript compare equal.
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * Digest of an assistant message's complete content: every block with every
 * field (text with its exact whitespace, tool_use id/name/input, thinking and
 * redacted_thinking with their signatures, any other block verbatim), minus
 * breakpoints. The streamed response and the transcript's lowered copy of it
 * digest equal only when the next request would replay exactly what the API
 * stored.
 */
export function anthropicResponseDigest(content) {
  const blocks = blocksWithoutBreakpoints(content);
  return Array.isArray(blocks) ? sha(canonical(blocks.map(requestForm))) : '';
}

// A streamed tool_use names its caller; `{type: 'direct'}` is what a request
// block without one means, so it is dropped. Any other caller stays and
// cannot match a transcript block.
function requestForm(block) {
  if (block?.type !== 'tool_use' || block.caller?.type !== 'direct' || Object.keys(block.caller).length !== 1) {
    return block;
  }
  const { caller: _direct, ...rest } = block;
  return rest;
}

function accountRecord(key) {
  let record = accounts.get(key);
  if (!record) accounts.set(key, (record = { confirmed: false, disabled: false, logged: false }));
  return record;
}

function logOnce(account, line) {
  if (account.logged) return;
  account.logged = true;
  if (!process.env.MIXDOG_QUIET_PROVIDER_LOG) process.stderr.write(`[anthropic-threads] ${line}\n`);
}

/** Why a continue is not possible for `messages` (null when it is). */
function continueBlocker(state, { account, fingerprint, messages, now }) {
  if (!state?.responseId) return 'no-thread';
  if (state.account !== account) return 'account';
  if (state.fingerprint !== fingerprint) return 'fingerprint';
  if (now - state.storedAt > THREAD_CONTINUE_MAX_AGE_MS) return 'expired';
  const n = state.prefixCount;
  if (messages.length <= n) return 'prefix';
  if (prefixHash(messages, n) !== state.prefixHash) return 'prefix';
  const stored = messages[n];
  if (stored?.role !== 'assistant' || anthropicResponseDigest(stored.content) !== state.responseDigest) {
    return 'response';
  }
  const delta = messages.length - n - 1;
  // A paused turn resumes with no messages and takes no new user turn; any
  // other stop needs new messages.
  if (state.stopReason === 'pause_turn' ? delta !== 0 : delta === 0) return 'delta';
  return null;
}

function continueBody(body, state) {
  const { system: _system, tools: _tools, messages, ...rest } = body;
  return {
    ...rest,
    messages: messages.slice(state.prefixCount + 1),
    thread: { type: 'continue', previous_message_id: state.responseId },
  };
}

// Breakpoints a request with `thread` carries: on a continue the create-time
// system/tools breakpoints count again; stored messages do not.
function breakpointCount(wire, createBody) {
  const top = wire.cache_control ? 1 : 0;
  return (
    top +
    countAnthropicCacheControls(createBody.system || []) +
    countAnthropicCacheControls(createBody.tools || []) +
    countAnthropicCacheControls(wire.messages || [])
  );
}

// The streamed response the API stored: message_stop arrived, the stop was a
// normal one, no tool call was cut by max_tokens, no fallback model wrote it,
// and every block was recorded completely.
function storedResponse(result, receipt) {
  if (!receipt?.id || !receipt.stoppedAt || receipt.opaque || !Array.isArray(receipt.blocks)) return false;
  const stop = result?.stopReason;
  if (!NORMAL_STOPS.has(stop)) return false;
  const toolCall = receipt.blocks.some((b) => b?.type === 'tool_use' || b?.type === 'server_tool_use');
  if (stop === 'max_tokens' && toolCall) return false;
  if (receipt.blocks.some((b) => b?.type === 'fallback')) return false;
  if (Array.isArray(result.contentBlockTypes) && result.contentBlockTypes.includes('fallback')) return false;
  const iterations = result.usage?.raw?.iterations;
  if (Array.isArray(iterations) && iterations.some((it) => it?.type === 'fallback_message')) return false;
  return true;
}

function unthreaded(body, betas) {
  return {
    mode: 'none',
    body,
    betas,
    commit() {},
    settle() {},
    classify: () => null,
    toCreate() {},
  };
}

/**
 * The wire plan for one send. `body` is the full request the provider built
 * (final messages, images prepared); `betas` the beta names it sends;
 * `requestMessages` the transcript messages the provider was given.
 * `opts._anthropicThread` (internal, from a thread-error resend):
 * { force: 'create'|'none', replay }.
 * Returns { mode, body, betas, commit(result), settle(), classify(), toCreate() }.
 */
export function planAnthropicThread({
  provider,
  config,
  opts,
  body,
  betas = [],
  account,
  requestMessages = null,
  now = Date.now(),
}) {
  const directive = opts?._anthropicThread || null;
  const scope = conversationScope(opts);
  if (directive?.force === 'none' || !eligible({ provider, config, opts, body, requestMessages })) {
    return unthreaded(body, betas);
  }
  const accountState = accountRecord(account);
  if (accountState.disabled) return unthreaded(body, betas);
  let generation = scopes.get(scope);
  const record = generation?.get(provider) || null;
  if (record?.disabledAccount === account) return unthreaded(body, betas);
  // Another send of this conversation is still in flight: it owns the thread.
  if (record?.inFlight) return unthreaded(body, betas);

  const threadBetas = betas.includes(MESSAGE_THREADS_BETA) ? betas : [...betas, MESSAGE_THREADS_BETA];
  const fingerprint = threadFingerprint(body, threadBetas, opts);
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const prior = record?.state || null;

  let mode = 'create';
  let wire = { ...body, thread: { type: 'create' } };
  const blocker =
    directive?.force === 'create' ? 'forced' : continueBlocker(prior, { account, fingerprint, messages, now });
  if (!blocker) {
    const candidate = continueBody(body, prior);
    if (breakpointCount(candidate, body) <= THREAD_MAX_BREAKPOINTS) {
      mode = 'continue';
      wire = candidate;
    }
  }
  if (mode === 'create' && breakpointCount(wire, body) > THREAD_MAX_BREAKPOINTS) return unthreaded(body, betas);

  // Take the conversation: the previous id is consumed (or abandoned) by this
  // send either way, and only this send may store the next one.
  if (!generation) scopes.set(scope, (generation = new Map()));
  const token = {};
  generation.set(provider, { token, inFlight: true, state: null, disabledAccount: null });
  lastPlanned = { mode, blocker, messages: wire.messages?.length ?? 0 };
  const owned = () => scopes.get(scope) === generation && generation.get(provider)?.token === token;

  const commitNow = (result, receipt) => {
    if (!owned() || !storedResponse(result, receipt)) return;
    accountState.confirmed = true;
    generation.get(provider).state = {
      account,
      fingerprint,
      prefixCount: messages.length,
      prefixHash: prefixHash(messages, messages.length),
      responseId: receipt.id,
      responseDigest: anthropicResponseDigest(receipt.blocks),
      stopReason: result.stopReason,
      storedAt: receipt.stoppedAt,
      fromReplay: plan.replay,
    };
  };

  const plan = {
    mode,
    body: wire,
    betas: threadBetas,
    blocker,
    replay: directive?.replay === true,
    // The state this continue started from was itself made by a replay.
    afterReplay: mode === 'continue' && prior?.fromReplay === true,
    /** A dropped continue was resent once: the next attempt replays in place. */
    toCreate() {
      if (plan.mode !== 'continue') return;
      wire.messages = body.messages;
      if (body.system !== undefined) wire.system = body.system;
      if (body.tools !== undefined) wire.tools = body.tools;
      wire.thread = { type: 'create' };
      plan.mode = 'create';
      plan.replay = true;
      plan.afterReplay = false;
    },
    /** Record the streamed response once the API confirmed storing it
     *  (message_stop), now or when a background read sees it. */
    commit(result) {
      const receipt = result?.threadReceipt;
      if (!receipt) return;
      if (receipt.stoppedAt || !receipt.pending) {
        commitNow(result, receipt);
        return;
      }
      // Tearing the conversation down releases the background read at once.
      const release = typeof receipt.cancel === 'function' ? receipt.cancel : null;
      if (release) {
        if (!drains.has(scope)) drains.set(scope, new Set());
        drains.get(scope).add(release);
      }
      receipt.pending.then(() => {
        const pending = drains.get(scope);
        pending?.delete(release);
        if (pending && !pending.size) drains.delete(scope);
        commitNow(result, receipt);
      });
    },
    /** The send is over: a later send may take the conversation. */
    settle() {
      if (owned()) generation.get(provider).inFlight = false;
    },
    /** The resend directive for a rejected threaded request, or null when the rejection is not about threads. */
    classify(status, errorBody) {
      return classifyRejection(plan, {
        status,
        errorBody,
        accountState,
        directive,
        disableConversation: () => {
          if (owned()) generation.get(provider).disabledAccount = account;
        },
      });
    },
  };
  return plan;
}

/** The thread error fields of an Anthropic error body (text or parsed). */
export function anthropicThreadErrorDetails(errorBody) {
  let parsed = errorBody;
  if (typeof errorBody === 'string') {
    try {
      parsed = JSON.parse(errorBody);
    } catch {
      parsed = null;
    }
  }
  const error = parsed?.error && typeof parsed.error === 'object' ? parsed.error : parsed;
  const details = error?.details || {};
  const unsupported = Array.isArray(details.unsupported) ? details.unsupported.map(String) : [];
  const message = String(error?.message || (typeof errorBody === 'string' ? errorBody : '') || '');
  return { code: typeof details.error_code === 'string' ? details.error_code : '', unsupported, message };
}

function classifyRejection(plan, { status, errorBody, accountState, directive, disableConversation }) {
  if (plan.mode === 'none') return null;
  const { code, unsupported, message } = anthropicThreadErrorDetails(errorBody);
  if (code === 'thread_unsupported_request') {
    if (unsupported.some((value) => ACCOUNT_UNSUPPORTED.has(value))) {
      accountState.disabled = true;
      logOnce(accountState, `threads unavailable for this account (${unsupported.join(',')}); sending unthreaded`);
    } else {
      disableConversation();
    }
    return { force: 'none' };
  }
  if (REPLAY_CODES.has(code)) {
    // A continue that still cannot be served right after a replay: the API may
    // be unable to store this conversation.
    if (code === 'thread_not_found' && plan.afterReplay) {
      disableConversation();
      return { force: 'none' };
    }
    if (plan.mode !== 'continue' || directive?.replay) return { force: 'none' };
    return { force: 'create', replay: true };
  }
  if (code.startsWith('thread_')) return { force: 'none' };
  // An uncoded refusal that names the thread parameter or the beta itself (a
  // route that does not take threads). The first one for an account turns
  // threads off for it in this process. Any other error is not about threads.
  const s = Number(status) || 0;
  if ((s === 400 || s === 403 || s === 422) && EXPLICIT_THREAD_REJECTION.test(message)) {
    if (!accountState.confirmed) {
      accountState.disabled = true;
      logOnce(accountState, `threads rejected for this account (HTTP ${s}); sending unthreaded from now on`);
    }
    return { force: 'none' };
  }
  return null;
}

/** Drop every thread record of a conversation scope (a new generation) and
 *  release its background message_stop reads. */
export function forgetAnthropicThreads(scope) {
  if (!scope) return;
  scopes.delete(scope);
  const pending = drains.get(scope);
  drains.delete(scope);
  for (const release of pending || []) {
    try {
      release();
    } catch {
      // releasing a background read is best-effort
    }
  }
}

// Session close, delete/reap and transport-scope disposal reach providers
// through this global (session-close.mjs, transport-scope.mjs); chain the
// handler already installed so every transport keeps its teardown. A turn
// abort (`inFlightOnly`) needs nothing: the send in flight already consumed
// its state and records nothing without message_stop.
const _priorThreadCloseHook = globalThis.__mixdogCloseProviderConnectionsForSession;
globalThis.__mixdogCloseProviderConnectionsForSession = (scope, reason, options) => {
  try {
    _priorThreadCloseHook?.(scope, reason, options);
  } finally {
    if (!options?.inFlightOnly) forgetAnthropicThreads(scope);
  }
};

export const _threadTest = {
  reset() {
    scopes.clear();
    accounts.clear();
    drains.clear();
  },
  state: (scope, provider) => scopes.get(scope)?.get(provider)?.state || null,
  record: (scope, provider) => scopes.get(scope)?.get(provider) || null,
  setStoredAt(scope, provider, storedAt) {
    const state = scopes.get(scope)?.get(provider)?.state;
    if (state) state.storedAt = storedAt;
  },
  scopes: () => [...scopes.keys()],
  lastPlanned: () => lastPlanned,
};
