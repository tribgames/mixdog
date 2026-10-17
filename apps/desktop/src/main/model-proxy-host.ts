import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  decodeModelProxyWire,
  encodeModelProxyWire,
  MODEL_PROXY_HEARTBEAT_MS,
  MODEL_PROXY_LEASE_MS,
  MODEL_PROXY_METHODS,
  MODEL_PROXY_OPERATIONS,
  MODEL_PROXY_REQUEST_EVENT,
  modelProxyErrorFromWire,
  modelProxyErrorToWire,
  modelProxyWireValue,
  stripModelProxySecrets,
  type ModelProxyMethod,
} from '../../../../src/runtime/agent/orchestrator/providers/model-proxy-channel.mjs';
import {
  disposeTransportScope,
  forkTransportScope,
} from '../../../../src/runtime/agent/orchestrator/providers/transport-scope.mjs';
import { sanitizeModelProxyUsageReply } from '../../../../src/runtime/agent/orchestrator/providers/model-proxy-usage-wire.mjs';
import { packagedRuntimeSourceRoot } from './runtime-layout';

/** PC-side executor for "model calls via the client PC" (remote/SSH mode).
 *
 * The remote daemon holds no model credentials. It publishes the state of its
 * pending model calls on the `model-proxy-request` desktop event of THIS
 * app's authenticated session connection; the executor claims each call, runs
 * it with the PC's own provider registry and credentials (the modules the
 * local daemon uses), streams every send-option callback back as events and
 * settles it with the final result. Nothing else can reach it: it is fed only
 * by the session connection's desktop events and answers only through that
 * connection's operations. */

export interface ModelProxyProviderInstance {
  send(messages: unknown, model: unknown, tools: unknown, options: Record<string, unknown>): Promise<unknown>;
  listModels?(): Promise<unknown>;
  _refreshModelCache?(): Promise<unknown>;
  isAvailable?(): Promise<unknown>;
  resolveWireRoute?(model: string, ctx: { agent: boolean; legacy: boolean }): Promise<unknown> | unknown;
  releaseTransportScope?(scope: string): void;
  getCachedModelInfo?(model: string): unknown;
  firstResponseBudget?(model?: string): unknown;
}

/** A provider's first-response budget when it is a usable pair of durations. */
function firstResponseBudget(value: unknown): { transportMs: number; semanticMs: number } | undefined {
  const { transportMs, semanticMs } = record(value);
  return typeof transportMs === 'number' &&
    typeof semanticMs === 'number' &&
    Number.isFinite(transportMs) &&
    Number.isFinite(semanticMs) &&
    transportMs > 0 &&
    semanticMs > 0
    ? { transportMs, semanticMs }
    : undefined;
}

export interface ModelProxyRuntime {
  oauthUsage?(name: string, provider: ModelProxyProviderInstance | undefined, force: boolean): Promise<unknown>;
  captureUsageAccount?(
    name: string,
    accountId: string,
    provider: ModelProxyProviderInstance
  ): (() => string | undefined) | undefined;
  /** The PC's providers — availability, adapter traits — with its registry
   *  loaded on demand first, so a cold PC never answers "nothing enabled".
   *  Reads which credentials exist, never a stored key's value. */
  providerConfig(): Promise<{ providers: Record<string, unknown>; ready?: boolean }>;
  /** `name` built with only its own credential, loaded on demand; undefined
   *  when it is not enabled on this PC. */
  provider(name: string): Promise<ModelProxyProviderInstance | undefined>;
  finalizeTools(tools: unknown[], nativePrefixCount: number): unknown[];
}

/** Largest call payload (wire JSON characters) this PC accepts from a server:
 *  room for the 64 MiB of inlined attachments as base64 plus the transcript. */
export const MODEL_PROXY_MAX_REQUEST_BYTES = 128 * 1024 * 1024;
/** Payload characters all of one server's running calls may hold at once. */
export const MODEL_PROXY_MAX_INFLIGHT_BYTES = 256 * 1024 * 1024;
/** Advertised requests (and cancellations) one snapshot event may make this PC look at. */
export const MODEL_PROXY_MAX_SNAPSHOT_ENTRIES = 64;
/** A claim the daemon has not answered by then is given up. */
export const MODEL_PROXY_CLAIM_TIMEOUT_MS = 15_000;
/** Largest event-reply results text decoded (callback return values are tiny). */
export const MODEL_PROXY_MAX_EVENT_REPLY_CHARS = 1024 * 1024;

export interface ModelProxyHostOptions {
  invoke(operation: string, args: unknown[]): Promise<unknown>;
  loadRuntime(): Promise<ModelProxyRuntime>;
  /** Which of this PC's providers the server may use (the per-host setting);
   *  every provider when absent. */
  isProviderAllowed?: (provider: string) => boolean;
  maxRequestBytes?: number;
  maxInflightBytes?: number;
  maxSnapshotEntries?: number;
  claimTimeoutMs?: number;
  heartbeatMs?: number;
  /** Silence after which the daemon has failed our calls (its liveness lease). */
  leaseMs?: number;
  now?: () => number;
  /** Each claimed call once it ended: answered, failed (the error reached the
   *  daemon), undelivered (the answer could not reach it) or abandoned (the
   *  daemon fell silent past its lease). */
  onCallSettled?(event: ModelProxyCallSettled): void;
}

export interface ModelProxyCallSettled {
  provider: string;
  outcome: 'answered' | 'failed' | 'undelivered' | 'abandoned';
  error?: unknown;
}

export interface ModelProxyHost {
  /** Feed one desktop event; true when it was the model-proxy lane. */
  handleDesktopEvent(name: string, value: unknown): boolean;
  readonly running: number;
  dispose(): void;
}

interface ProxyCall {
  provider?: unknown;
  method?: unknown;
  force?: unknown;
  model?: unknown;
  messages?: unknown;
  tools?: unknown;
  toolsFinalized?: unknown;
  nativePrefixCount?: unknown;
  context?: unknown;
  options?: unknown;
  callbacks?: unknown;
}

interface QueuedEvent {
  name: string;
  args: unknown;
  resolve(value: unknown): void;
  reject(error: unknown): void;
}

const ALLOWED_METHODS = new Set<string>(MODEL_PROXY_METHODS);

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function cancelledError(): Error {
  const error = new Error('The remote session cancelled the model call.');
  error.name = 'AbortError';
  return error;
}

function providerUnavailable(name: string): Error {
  return Object.assign(new Error(`Provider "${name}" is not enabled on this PC.`), {
    code: 'MODEL_PROXY_PROVIDER_UNAVAILABLE',
  });
}

function providerNotAllowed(name: string): Error {
  return Object.assign(new Error(`This PC does not let this server use provider "${name}".`), {
    code: 'MODEL_PROXY_PROVIDER_NOT_ALLOWED',
  });
}

// ── What a server may hand this PC, and what it gets back ───────────────────
// The server is untrusted input: it chooses the call, never how this PC's
// credentials are used, and learns nothing about this PC beyond the answer.

/** Send options a server may set: request shaping the provider adapters read
 *  (sampling, reasoning, tool choice, cache lanes, session/turn ids for wire
 *  parity, retry policy). Everything else is dropped: the keys in
 *  MODEL_PROXY_DROPPED_SEND_OPTIONS, `signal` (set by this PC), `on*`
 *  callbacks (bridged by name through the event lane, never taken as values)
 *  and every `_`-prefixed process-local seam. Kept in step with the adapters
 *  by model-proxy-send-options.test.mjs, which scans every option they read. */
export const MODEL_PROXY_SEND_OPTION_KEYS: ReadonlySet<string> = new Set([
  'admissionOwner',
  'admissionPriority',
  'agent',
  'cacheBreakIntent',
  'cacheRetention',
  'cacheStrategy',
  'codexRequestKind',
  'codexSessionId',
  'codexThreadId',
  'codexTurnId',
  'codexWindowId',
  'codexWireParity',
  'compatWireApi',
  'customReplay',
  'deepseekReasoningEffort',
  'deepseekThinking',
  'disableBetaHeaders',
  'disableParallelToolUse',
  'disableReasoning',
  'effort',
  'effortConfiguration',
  'effortConfigurationEnabled',
  'effortProjection',
  'ephemeral',
  'fallbackModel',
  'fast',
  'fenceState',
  'forceHttpFallback',
  'forceReasoningOff',
  'grokCacheLaneAuto',
  'grokCacheLaneSeed',
  'grokCacheLaneShards',
  'grokCacheLaneSlot',
  'grokResponsesCacheLaneAuto',
  'grokResponsesCacheLaneSeed',
  'grokResponsesCacheLaneShards',
  'grokResponsesCacheLaneSlot',
  'harmony',
  'idempotencyKey',
  'include',
  'includeEncryptedReasoning',
  'includeThoughts',
  'initialConsecutive529Errors',
  'iteration',
  'knownToolNames',
  'max_output_tokens',
  'max_tokens',
  'maxAttempts',
  'maxOutputTokens',
  'maxTokens',
  'min_p',
  'minP',
  'modelParameters',
  'multiAgent',
  'nativeInclude',
  'nativePdf',
  'nativeTools',
  'nativeToolSearch',
  'nativeToolSearchProvider',
  'openRouterReasoningEffort',
  'outputTokens',
  'parallelToolCalls',
  'parentSessionId',
  'perAttemptLabel',
  'perAttemptTimeoutMs',
  'presence_penalty',
  'presencePenalty',
  'promptCacheKey',
  'promptCacheLane',
  'promptCacheLaneSeed',
  'promptCacheLaneSlot',
  'promptCacheProvider',
  'promptCacheScope',
  'providerCacheKey',
  'providerNativeToolPrefixCount',
  'providerState',
  'providerToolSnapshotAuthoritative',
  'reasoning',
  'reasoningSummary',
  'recoveryOwner',
  'repetition_penalty',
  'repetitionPenalty',
  'replayEncryptedReasoning',
  'replayProvider',
  'replaysReasoningContent',
  'requestId',
  'requestKind',
  'responsesNativeItems',
  'responsesPromptCacheKey',
  'retry429',
  'retry529',
  'retryJitterMode',
  'retryJitterRatio',
  'role',
  'safetySettings',
  'selectedContextWindow',
  'serverFallback',
  'service_tier',
  'serviceTier',
  // Projected to MODEL_PROXY_SESSION_KEYS by serverSendOptions.
  'session',
  'sessionId',
  'sharedCachePrefixCount',
  'stateKey',
  'statelessConversation',
  'temperature',
  'thinking',
  'thinkingBudget',
  'thinkingBudgetTokens',
  'thinkingLevel',
  'threadId',
  'toolChoice',
  'toolChoiceThinkingConflict',
  'top_k',
  'top_p',
  'topK',
  'topP',
  'turnId',
  'turnStartedAtUnixMs',
  'usageSessionId',
  'verbosity',
  'windowId',
  'wireRoute',
  'xaiApiMode',
  'xaiCacheLaneAuto',
  'xaiCacheLaneSeed',
  'xaiCacheLaneShards',
  'xaiCacheLaneSlot',
  'xaiReasoningEffort',
  'xaiResponsesCacheLaneAuto',
  'xaiResponsesCacheLaneSeed',
  'xaiResponsesCacheLaneShards',
  'xaiResponsesCacheLaneSlot',
  'xaiResponsesCacheScope',
  'xaiResponsesTransport',
  'xaiServerToolSearch',
  'xaiTransport',
]);

/** Send options adapters read that a server may NOT set, with the reason. */
export const MODEL_PROXY_DROPPED_SEND_OPTIONS: ReadonlyMap<string, string> = new Map([
  ['_captureModelProxyUsageAccount', 'desktop-only serving identity proof; never supplied by the server'],
  ['baseURL', "would point this PC's credentials at another host"],
  ['requestHeaders', "arbitrary headers on this PC's authenticated request (adapters add their own)"],
  ['extraBody', 'arbitrary fields merged into the request body'],
  ['auth', "this PC's credential, never the server's to supply"],
  ['installationId', "this PC's own Codex installation identity"],
  ['codexInstallationId', "this PC's own Codex installation identity"],
  [
    'modelMaxOutputTokens',
    "the gateway's own output ceiling for the model, derived on this PC from its provider config and catalog",
  ],
  ['responsesTransport', 'a provider config setting of this PC (adapters discard it from send options)'],
  ['signal', 'cancellation is this PC-side controller, driven by the channel'],
  [
    'toolExecutionSessionId',
    'native Cursor tool authorization is process-local and the server daemon executes the tools; execute sets it empty so proxied Cursor calls stay ordinary Mixdog tool calls',
  ],
  [
    'transportScope',
    "a process-local connection scope; the server's value is never used (execute allocates and disposes this PC's own for a request that carries one)",
  ],
]);

/** `session` subfields adapters read (ids, deferred tool catalogs, owner and
 *  permission labels for cache scoping); the rest of the record stays on the server. */
export const MODEL_PROXY_SESSION_KEYS: ReadonlySet<string> = new Set([
  'agent',
  'codexSessionId',
  'codexWireSessionId',
  'deferredDiscoveredTools',
  'deferredLateToolCatalog',
  'deferredNativeTools',
  'deferredToolCatalog',
  'id',
  'owner',
  'model',
  'parentSessionId',
  'permission',
  'profileId',
  'promptCacheKey',
  'provider',
  'role',
  'sourceName',
  'sourceType',
  'threadId',
  'toolPermission',
  'turnId',
  'windowId',
  'wireRoute',
]);

/** The server's send options reduced to the allowlist. */
export function serverSendOptions(value: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(record(value))) {
    if (!MODEL_PROXY_SEND_OPTION_KEYS.has(key)) continue;
    if (key === 'session') {
      const session = Object.fromEntries(
        Object.entries(record(entry)).filter(([field]) => MODEL_PROXY_SESSION_KEYS.has(field))
      );
      if (Object.keys(session).length) out.session = session;
      continue;
    }
    out[key] = entry;
  }
  return out;
}

/** Error properties the daemon's recovery paths read; nothing else (headers,
 *  `cause`, response bodies, request snapshots) leaves this PC. */
const ERROR_PROPS = new Set([
  'status',
  'httpStatus',
  'code',
  'retryAfter',
  'retryAfterMs',
  'partialContent',
  'partialUsage',
  'liveTextEmitted',
  'emittedToolCall',
  'unsafeToRetry',
  'quotaExhausted',
  'reauthRequired',
  'providerErrorCode',
  'providerErrorType',
  'requestId',
  'responseFailed',
  'wsCloseCode',
  'midstreamRetries',
]);
const MAX_ERROR_TEXT = 16 * 1024;
const MAX_PARTIAL_CONTENT = 4 * 1024 * 1024;
const CREDENTIAL_TEXT =
  /\b(?:sk|pk|rk|xai|gsk|sess)-[A-Za-z0-9_-]{12,}\b|\bBearer\s+[A-Za-z0-9._~+/=-]{8,}|\bAIza[0-9A-Za-z_-]{20,}\b/g;

function redactedText(value: string, limit: number): string {
  return value.replace(CREDENTIAL_TEXT, '[redacted]').slice(0, limit);
}

/** The wire record of a PC-side failure: name, message and the allowlisted
 *  recovery fields, credential-shaped text redacted. */
export function proxyErrorRecord(error: unknown): { name: string; message: string; props: Record<string, unknown> } {
  const wire = modelProxyErrorToWire(error);
  const props: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record(stripModelProxySecrets(wire.props)))) {
    if (!ERROR_PROPS.has(key)) continue;
    if (typeof value === 'string') {
      props[key] = redactedText(value, key === 'partialContent' ? MAX_PARTIAL_CONTENT : MAX_ERROR_TEXT);
    } else if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
      props[key] = value;
    } else if (key === 'partialUsage') {
      props[key] = Object.fromEntries(Object.entries(record(value)).filter(([, entry]) => typeof entry === 'number'));
    }
  }
  return {
    name: redactedText(String(wire.name || 'Error'), 200),
    message: redactedText(String(wire.message || ''), MAX_ERROR_TEXT),
    props,
  };
}

/** Model ids a custom provider hides: its stored model rows and v2 overrides,
 *  the same two sources the renderer's picker filter reads. */
function hiddenCustomModels(entry: Record<string, unknown>): string[] {
  const hidden = new Set<string>();
  for (const row of Array.isArray(entry.models) ? entry.models : []) {
    const model = record(row);
    if (typeof model.id === 'string' && model.hidden === true) hidden.add(model.id);
  }
  for (const [id, override] of Object.entries(record(entry.modelOverrides))) {
    if (record(override).hidden === true) hidden.add(id);
  }
  return [...hidden];
}

/** What a server learns about this PC's providers: whether each is usable for
 *  it and the adapter traits its stand-in needs. A provider the server may not
 *  use is left out entirely. No base URL, account, org, label, model list or
 *  any other stored field; a custom provider adds only the ids of models
 *  hidden on this PC, so remote pickers hide them too. */
export function publicProviderConfig(
  providers: unknown,
  isProviderAllowed: (provider: string) => boolean,
  supportsOAuthUsage = false
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, raw] of Object.entries(record(providers))) {
    if (!isProviderAllowed(name)) continue;
    const entry = record(raw);
    const traits = record(entry.modelProxy);
    const modelProxy: Record<string, unknown> = {};
    if (supportsOAuthUsage) modelProxy.oauthUsage = true;
    if (typeof traits.inputExcludesCache === 'boolean') modelProxy.inputExcludesCache = traits.inputExcludesCache;
    if (typeof traits.nativePdf === 'boolean') modelProxy.nativePdf = traits.nativePdf;
    if (traits.consumesReadWindows === true) modelProxy.consumesReadWindows = true;
    const budget = firstResponseBudget(traits.firstResponseBudget);
    if (budget) modelProxy.firstResponseBudget = budget;
    out[name] = {
      enabled: entry.enabled === true,
      ...(entry.type === 'custom' ? { type: 'custom', hiddenModels: hiddenCustomModels(entry) } : {}),
      ...(['present', 'absent', 'unreadable'].includes(String(entry.authState)) ? { authState: entry.authState } : {}),
      modelProxy,
    };
  }
  return out;
}

// ── Callbacks back to the server ────────────────────────────────────────────

const MAX_CALLBACK_TEXT = 1024 * 1024;
/** Detail fields that would describe this PC's sign-ins (e.g. the
 *  account-pool's `accountId` on `account-changed`). */
const IDENTIFYING_DETAIL = /account|email|user|login|org|tenant|token|key|secret|auth|credential/i;

/** A callback detail object reduced to non-identifying scalars, text redacted. */
function scalarDetail(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (IDENTIFYING_DETAIL.test(key)) continue;
    if (typeof entry === 'string') out[key] = redactedText(entry, 2_000);
    else if ((typeof entry === 'number' && Number.isFinite(entry)) || typeof entry === 'boolean' || entry === null) {
      out[key] = entry;
    }
  }
  return out;
}

const shortText = (value: unknown): string | undefined => (typeof value === 'string' ? value.slice(0, 64) : undefined);

/** The send-option callbacks a provider may invoke back on the server, each
 *  with the projection of its arguments that may leave this PC. Any other
 *  callback a server names is never installed. Kept in step with the adapters
 *  by model-proxy-send-options.test.mjs. */
export const MODEL_PROXY_CALLBACKS: ReadonlyMap<string, (args: unknown[]) => unknown[]> = new Map<
  string,
  (args: unknown[]) => unknown[]
>([
  // (stage, detail): retry/reconnect detail keeps its counters and redacted
  // reason text; account-changed keeps only provider and time, never the
  // PC's account id.
  [
    'onStageChange',
    ([stage, detail]) => {
      const projected = scalarDetail(detail);
      return projected === undefined ? [shortText(stage)] : [shortText(stage), projected];
    },
  ],
  // (kind): a progress kind label only.
  ['onStreamDelta', ([kind]) => [shortText(kind)]],
  // (text): the model's own output.
  ['onTextDelta', ([text]) => [typeof text === 'string' ? text.slice(0, MAX_CALLBACK_TEXT) : '']],
  // ({ chars, reasoning, reason }): counters and a reason label.
  ['onTextReset', ([info]) => [scalarDetail(info) ?? {}]],
  // (call): a tool call the model made — model output, wire-copied.
  ['onToolCall', ([call]) => [call]],
  // ({ name, index, pointer, reason, message }): a server tool left out for
  // an invalid schema — about the server's own tool list, text redacted.
  ['onToolExcluded', ([info]) => [scalarDetail(info) ?? {}]],
]);

// ── Attachment references ───────────────────────────────────────────────────

const MAX_MESSAGE_DEPTH = 128;

function refusal(message: string, code: string, status: number): Error {
  return Object.assign(new Error(message), { code, status });
}

/** `[attachment unavailable: name]`, the text a missing stored attachment lowers to. */
function unavailableAttachment(part: Record<string, unknown>): { type: 'text'; text: string } {
  const name = typeof part.filename === 'string' ? part.filename.split(/[\\/]/).pop() : '';
  const label = [name, part.mimeType, part.mediaType, part.type]
    .find((value): value is string => typeof value === 'string' && value !== '')
    // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is replaced.
    ?.replace(/[\u0000-\u001f\]]+/g, '_')
    .slice(0, 200);
  return { type: 'text', text: `[attachment unavailable: ${label || 'file'}]` };
}

/** Messages with every attachment-store reference replaced by its
 *  "unavailable" text. A server inlines what it has; a reference that still
 *  arrives names a blob in a store, and the only store this PC could resolve
 *  it against is its own. So no adapter ever reads this PC's store for a server. */
export function withoutAttachmentReferences(value: unknown, depth = 0): unknown {
  if (!value || typeof value !== 'object') return value;
  if (depth > MAX_MESSAGE_DEPTH)
    throw refusal('The model call is nested too deeply.', 'MODEL_PROXY_REQUEST_INVALID', 400);
  if (Array.isArray(value)) {
    let out: unknown[] | null = null;
    value.forEach((entry, index) => {
      const next = withoutAttachmentReferences(entry, depth + 1);
      if (next === entry) return;
      out ??= [...value];
      out[index] = next;
    });
    return out ?? value;
  }
  const entry = value as Record<string, unknown>;
  if (Object.hasOwn(entry, 'attachmentRef')) return unavailableAttachment(entry);
  let out: Record<string, unknown> | null = null;
  for (const [key, field] of Object.entries(entry)) {
    const next = withoutAttachmentReferences(field, depth + 1);
    if (next === field) continue;
    out ??= { ...entry };
    out[key] = next;
  }
  return out ?? entry;
}

/** In-order event lane for one call: batches whatever the provider emitted
 *  while the previous batch was in flight, and hands each callback the value
 *  the daemon's callback returned (onTextReset's acknowledgement). */
function createEventLane(id: string, invoke: ModelProxyHostOptions['invoke'], controller: AbortController) {
  let queue: QueuedEvent[] = [];
  let pumping: Promise<void> | null = null;
  const pump = async (): Promise<void> => {
    try {
      while (queue.length) {
        const batch = queue;
        queue = [];
        try {
          const reply = record(
            await invoke(MODEL_PROXY_OPERATIONS.event, [
              id,
              encodeModelProxyWire(batch.map((event) => ({ name: event.name, args: event.args }))),
            ])
          );
          if (typeof reply.results !== 'string' || reply.results.length > MODEL_PROXY_MAX_EVENT_REPLY_CHARS) {
            throw new Error('The remote daemon answered the model call events with an oversized reply.');
          }
          const results = decodeModelProxyWire(reply.results);
          const list = Array.isArray(results) ? results : [];
          batch.forEach((event, index) => {
            const result = record(list[index]);
            if (result.ok === false) event.reject(modelProxyErrorFromWire(result.error));
            else event.resolve(result.value ?? undefined);
          });
          if (reply.cancelled === true) controller.abort(cancelledError());
        } catch (error) {
          for (const event of batch) event.reject(error);
          // The daemon can no longer hear this call: stop spending on it.
          controller.abort(error instanceof Error ? error : new Error(String(error)));
        }
      }
    } finally {
      // Cleared in the same turn the queue was last seen empty, so an event a
      // resumed callback emits right after always starts a new pump.
      pumping = null;
    }
  };
  return {
    emit(name: string, args: unknown[]): Promise<unknown> {
      const pending = new Promise<unknown>((resolveEvent, rejectEvent) => {
        // Snapshot now: a provider may mutate the object after the callback.
        queue.push({ name, args: modelProxyWireValue(args), resolve: resolveEvent, reject: rejectEvent });
      });
      // Fire-and-forget callers (deltas) never observe a failed delivery.
      pending.catch(() => {});
      pumping ??= pump();
      return pending;
    },
    async flush(): Promise<void> {
      while (pumping) await pumping;
    },
  };
}

async function catalog(provider: ModelProxyProviderInstance, refresh: boolean) {
  let models: unknown = null;
  if (refresh && typeof provider._refreshModelCache === 'function') models = await provider._refreshModelCache();
  if (!Array.isArray(models) && typeof provider.listModels === 'function') models = await provider.listModels();
  const rows = Array.isArray(models) ? models : [];
  const modelInfo: Record<string, unknown> = {};
  if (typeof provider.getCachedModelInfo === 'function') {
    for (const row of rows) {
      const id = typeof row === 'string' ? row : record(row).id;
      if (typeof id !== 'string' || !id) continue;
      const info = provider.getCachedModelInfo(id);
      if (info == null) continue;
      // The budget depends on the model (a Pro-class model waits longer), so
      // it rides with the model's own catalog entry.
      const budget = typeof info === 'object' ? firstResponseBudget(provider.firstResponseBudget?.(id)) : undefined;
      modelInfo[id] = budget ? { ...record(info), firstResponseBudget: budget } : info;
    }
  }
  return { models: rows, modelInfo };
}

async function execute(
  runtime: ModelProxyRuntime,
  call: ProxyCall,
  signal: AbortSignal,
  emit: (name: string, args: unknown[]) => Promise<unknown>,
  isProviderAllowed: (provider: string) => boolean
): Promise<unknown> {
  const method = String(call.method || '') as ModelProxyMethod;
  if (!ALLOWED_METHODS.has(method)) throw new Error(`Model proxy method "${method}" is not allowed.`);
  if (method === 'providerConfig') {
    const answer = await runtime.providerConfig();
    return {
      providers: publicProviderConfig(answer.providers, isProviderAllowed, typeof runtime.oauthUsage === 'function'),
      ready: answer.ready !== false,
    };
  }
  // Restricted to the provider the daemon named; no other surface is reachable.
  const name = String(call.provider || '');
  if (name && !isProviderAllowed(name)) throw providerNotAllowed(name);
  if (method === 'oauthUsage') {
    if (!runtime.oauthUsage) return { status: 'unsupported', accounts: [] };
    let instance: ModelProxyProviderInstance | undefined;
    try {
      instance = name ? await runtime.provider(name) : undefined;
    } catch {
      // Identity proof is independent of a registry/adapter load failure.
    }
    const reply = await runtime.oauthUsage(name, instance, call.force === true);
    if (name && !isProviderAllowed(name)) throw providerNotAllowed(name);
    return sanitizeModelProxyUsageReply(name, reply);
  }
  const provider = name ? await runtime.provider(name) : undefined;
  if (!provider || typeof provider.send !== 'function') throw providerUnavailable(name);
  if (method === 'listModels') return catalog(provider, false);
  if (method === 'refreshModels') return catalog(provider, true);
  if (method === 'isAvailable') {
    return typeof provider.isAvailable === 'function' ? (await provider.isAvailable()) === true : true;
  }
  if (method === 'resolveWireRoute') {
    // The wire is this PC's answer (its config and roster); the server only
    // says whether the session is an agent session and an existing one.
    if (typeof provider.resolveWireRoute !== 'function') return null;
    const context = record(call.context);
    const route = await provider.resolveWireRoute(String(call.model ?? ''), {
      agent: context.agent === true,
      legacy: context.legacy === true,
    });
    return route ?? null;
  }
  const options = serverSendOptions(call.options);
  for (const callback of Array.isArray(call.callbacks) ? call.callbacks : []) {
    const project = typeof callback === 'string' ? MODEL_PROXY_CALLBACKS.get(callback) : undefined;
    if (!project) continue;
    options[callback] = (...args: unknown[]) => emit(callback, project(args));
  }
  options.signal = signal;
  // No tool executes in this process: an empty executor keeps a provider from
  // issuing process-local tool capabilities (Cursor native read/edit) that the
  // server daemon could never honor.
  options.toolExecutionSessionId = '';
  let tools = Array.isArray(call.tools) ? call.tools : undefined;
  if (tools && call.toolsFinalized === true) tools = runtime.finalizeTools(tools, Number(call.nativePrefixCount) || 0);
  const model = typeof call.model === 'string' ? call.model : undefined;
  const messages = withoutAttachmentReferences(Array.isArray(call.messages) ? call.messages : []);
  // A request the server forked from a session (/btw) names a transport scope
  // of its own. The server's scope string means nothing on this PC, so the
  // request gets one allocated here and released when it ends.
  const forkedScope = record(call.options).transportScope
    ? forkTransportScope(String(options.sessionId || name), 'proxy')
    : '';
  if (forkedScope) options.transportScope = forkedScope;
  const provenAccounts = new WeakMap<object, () => string | undefined>();
  if (runtime.captureUsageAccount) {
    options._captureModelProxyUsageAccount = (
      servingProvider: string,
      id: string,
      instance: ModelProxyProviderInstance
    ) => {
      if (servingProvider !== name) return undefined;
      let confirm: (() => string | undefined) | undefined;
      try {
        confirm = runtime.captureUsageAccount?.(name, id, instance);
      } catch {
        return undefined;
      }
      return (result: unknown) => {
        if (!result || typeof result !== 'object') return;
        provenAccounts.set(result, () => {
          const routing = record(record(result).providerMetadata).accountRouting;
          if (
            signal.aborted ||
            !isProviderAllowed(name) ||
            record(routing).provider !== name ||
            record(routing).accountId !== id
          ) return undefined;
          try {
            const scope = confirm?.();
            return scope && /^proxy-[a-f0-9]{64}$/.test(scope) ? scope : undefined;
          } catch {
            return undefined;
          }
        });
      };
    };
  }
  try {
    const result = await provider.send(messages, model, tools, options);
    if (result && typeof result === 'object' && !Array.isArray(result)) {
      const { modelProxyUsageAccount: _unproven, ...answer } = result as Record<string, unknown>;
      const account = !signal.aborted ? provenAccounts.get(result)?.() : undefined;
      return account ? { ...answer, modelProxyUsageAccount: account } : answer;
    }
    return result;
  } finally {
    if (forkedScope) disposeTransportScope(forkedScope, provider);
  }
}

/** Aborts the running calls a daemon snapshot or heartbeat reply lists as cancelled. */
function abortCancelled(running: ReadonlyMap<string, AbortController>, ids: unknown, limit: number): void {
  for (const id of Array.isArray(ids) ? ids.slice(0, limit) : []) {
    if (typeof id === 'string') running.get(id)?.abort(cancelledError());
  }
}

/** The link to the daemon: every answered operation is contact, and while
 *  calls run a heartbeat tells the daemon which are alive and learns which it
 *  cancelled. */
function createDaemonLiveness({
  invoke: invokeOperation,
  running,
  now,
  leaseMs,
  heartbeatMs,
  maxSnapshotEntries,
}: {
  invoke: ModelProxyHostOptions['invoke'];
  running: Map<string, AbortController>;
  now: () => number;
  leaseMs: number;
  heartbeatMs: number;
  maxSnapshotEntries: number;
}) {
  let heartbeatTimer: NodeJS.Timeout | null = null;
  // Last operation the daemon answered. Silence past its lease means it has
  // already failed our calls, so finishing them would only spend for nothing.
  let lastContactAt = now();
  const invoke: ModelProxyHostOptions['invoke'] = async (operation, args) => {
    const reply = await invokeOperation(operation, args);
    lastContactAt = now();
    return reply;
  };

  const stop = (): void => {
    if (!heartbeatTimer) return;
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  };
  /** Abort and forget every active call (their settles still run, unanswered). */
  const abandonAll = (reason: Error): void => {
    stop();
    const controllers = [...running.values()];
    running.clear();
    for (const controller of controllers) controller.abort(reason);
  };
  const heartbeat = async (): Promise<void> => {
    const ids = [...running.keys()];
    if (!ids.length) return stop();
    // Checked per tick, so a hung (never answered) operation counts as silence too.
    if (now() - lastContactAt > leaseMs) {
      abandonAll(
        Object.assign(new Error('The remote daemon stopped answering; the model call was abandoned.'), {
          name: 'AbortError',
          code: 'MODEL_PROXY_UNAVAILABLE',
        })
      );
      return;
    }
    try {
      const reply = record(await invoke(MODEL_PROXY_OPERATIONS.heartbeat, [ids]));
      abortCancelled(running, reply.cancelled, maxSnapshotEntries);
    } catch {
      /* silence is judged against the lease on the next tick */
    }
  };
  const ensure = (): void => {
    if (heartbeatTimer) return;
    heartbeatTimer = setInterval(() => void heartbeat(), heartbeatMs);
    heartbeatTimer.unref?.();
  };
  return { invoke, ensure, stop, abandonAll };
}

/** Claiming a call from the daemon, and refusing one outright. */
function createClaims({
  invoke,
  claimTimeoutMs,
  isDisposed,
  onCallSettled,
}: {
  invoke: ModelProxyHostOptions['invoke'];
  claimTimeoutMs: number;
  isDisposed(): boolean;
  onCallSettled: ModelProxyHostOptions['onCallSettled'];
}) {
  /** Refuses a claimed call outright: the daemon gets the reason at once
   *  instead of waiting out its claim deadline. */
  const refuse = async (id: string, error: Error): Promise<void> => {
    await invoke(MODEL_PROXY_OPERATIONS.resolve, [
      id,
      false,
      null,
      encodeModelProxyWire(proxyErrorRecord(error)),
    ]).catch(() => {});
    onCallSettled?.({ provider: '', outcome: 'failed', error });
  };

  /** The claim, given up after `claimTimeoutMs`; a payload that still arrives
   *  later is refused so the daemon is not left waiting on it. */
  const claim = (id: string): Promise<Record<string, unknown>> =>
    new Promise((resolveClaim, rejectClaim) => {
      let late = false;
      const timer = setTimeout(() => {
        late = true;
        rejectClaim(new Error('The remote daemon did not answer the claim in time.'));
      }, claimTimeoutMs);
      timer.unref?.();
      invoke(MODEL_PROXY_OPERATIONS.claim, [id]).then(
        (value) => {
          clearTimeout(timer);
          if (!late) return resolveClaim(record(value));
          if (typeof record(value).payload === 'string' && !isDisposed()) {
            void refuse(id, refusal('This PC gave up waiting for the model call.', 'MODEL_PROXY_UNAVAILABLE', 503));
          }
        },
        (error) => {
          clearTimeout(timer);
          if (!late) rejectClaim(error);
        }
      );
    });
  return { claim, refuse };
}

/** Tells the daemon a call failed and how it ended. */
async function failCall(
  invoke: ModelProxyHostOptions['invoke'],
  id: string,
  lane: ReturnType<typeof createEventLane>,
  controller: AbortController,
  error: unknown
): Promise<{ failure: unknown; outcome: Exclude<ModelProxyCallSettled['outcome'], 'answered'> }> {
  const reason = controller.signal.reason as { code?: unknown } | undefined;
  let outcome: Exclude<ModelProxyCallSettled['outcome'], 'answered'> =
    reason?.code === 'MODEL_PROXY_UNAVAILABLE' ? 'abandoned' : 'failed';
  await lane.flush().catch(() => {});
  const delivered = await invoke(MODEL_PROXY_OPERATIONS.resolve, [
    id,
    false,
    null,
    encodeModelProxyWire(proxyErrorRecord(error)),
  ]).then(
    () => true,
    () => false
  );
  if (!delivered && outcome === 'failed') outcome = 'undelivered';
  return { failure: error, outcome };
}

/** Runs an admitted call and answers the daemon with its outcome. */
async function serveCall(
  id: string,
  payload: string,
  call: ProxyCall,
  {
    running,
    inflight,
    invoke,
    liveness,
    loadRuntime,
    isProviderAllowed,
    onCallSettled,
  }: {
    running: Map<string, AbortController>;
    inflight: { bytes: number };
    invoke: ModelProxyHostOptions['invoke'];
    liveness: ReturnType<typeof createDaemonLiveness>;
    loadRuntime: ModelProxyHostOptions['loadRuntime'];
    isProviderAllowed: (provider: string) => boolean;
    onCallSettled: ModelProxyHostOptions['onCallSettled'];
  }
): Promise<void> {
  const controller = new AbortController();
  running.set(id, controller);
  inflight.bytes += payload.length;
  liveness.ensure();
  const lane = createEventLane(id, invoke, controller);
  const provider = String(call.provider || '');
  let settled: ModelProxyCallSettled['outcome'] = 'answered';
  let failure: unknown;
  try {
    const value = await execute(await loadRuntime(), call, controller.signal, lane.emit, isProviderAllowed);
    await lane.flush();
    await invoke(MODEL_PROXY_OPERATIONS.resolve, [id, true, encodeModelProxyWire(value), null]);
  } catch (error) {
    ({ failure, outcome: settled } = await failCall(invoke, id, lane, controller, error));
  } finally {
    inflight.bytes -= payload.length;
    running.delete(id);
    if (!running.size) liveness.stop();
  }
  onCallSettled?.({ provider, outcome: settled, ...(failure === undefined ? {} : { error: failure }) });
}

/** The claimed payload checked against this PC's size limits, or the refusal to send. */
function admitPayload(
  payload: string,
  inflightBytes: number,
  { maxRequestBytes, maxInflightBytes }: { maxRequestBytes: number; maxInflightBytes: number }
): ProxyCall | Error {
  // Sized before anything is decoded or held.
  if (payload.length > maxRequestBytes) {
    return refusal(
      'The model call is larger than this PC accepts from a server.',
      'MODEL_PROXY_REQUEST_TOO_LARGE',
      413
    );
  }
  if (inflightBytes + payload.length > maxInflightBytes) {
    return refusal(
      'This PC is already holding as much model-call data for this server as it accepts; try again shortly.',
      'MODEL_PROXY_BUSY',
      429
    );
  }
  try {
    return record(decodeModelProxyWire(payload)) as ProxyCall;
  } catch {
    return refusal('The model call is malformed.', 'MODEL_PROXY_REQUEST_INVALID', 400);
  }
}

/** The request ids a snapshot advertises that this PC could take up: bounded
 *  to its first `limit` entries, well-formed and not already in progress. */
function advertisedRequestIds(requests: unknown, limit: number, inProgress: (id: string) => boolean): Set<string> {
  const next = new Set<string>();
  for (const request of Array.isArray(requests) ? requests.slice(0, limit) : []) {
    const id = record(request).id;
    if (typeof id !== 'string' || !id || id.length > 128 || inProgress(id)) continue;
    next.add(id);
  }
  return next;
}

export function createModelProxyHost({
  invoke: invokeOperation,
  loadRuntime,
  isProviderAllowed = () => true,
  maxRequestBytes = MODEL_PROXY_MAX_REQUEST_BYTES,
  maxInflightBytes = MODEL_PROXY_MAX_INFLIGHT_BYTES,
  maxSnapshotEntries = MODEL_PROXY_MAX_SNAPSHOT_ENTRIES,
  claimTimeoutMs = MODEL_PROXY_CLAIM_TIMEOUT_MS,
  heartbeatMs = MODEL_PROXY_HEARTBEAT_MS,
  leaseMs = MODEL_PROXY_LEASE_MS,
  now = Date.now,
  onCallSettled,
}: ModelProxyHostOptions): ModelProxyHost {
  const running = new Map<string, AbortController>();
  const claiming = new Set<string>();
  /** The latest snapshot's requests not yet taken up. */
  let advertised = new Set<string>();
  const inflight = { bytes: 0 };
  let disposed = false;
  const liveness = createDaemonLiveness({
    invoke: invokeOperation,
    running,
    now,
    leaseMs,
    heartbeatMs,
    maxSnapshotEntries,
  });
  const { invoke } = liveness;
  const { claim, refuse } = createClaims({ invoke, claimTimeoutMs, isDisposed: () => disposed, onCallSettled });

  /** Synchronous, so the in-flight check and the call taking its share
   *  (`serve`) are one step. */
  const admit = (payload: string): ProxyCall | Error =>
    admitPayload(payload, inflight.bytes, { maxRequestBytes, maxInflightBytes });

  const serve = (id: string, payload: string, call: ProxyCall): Promise<void> =>
    serveCall(id, payload, call, {
      running,
      inflight,
      invoke,
      liveness,
      loadRuntime,
      isProviderAllowed,
      onCallSettled,
    });

  const run = async (id: string): Promise<void> => {
    claiming.add(id);
    let claimed: Record<string, unknown>;
    try {
      claimed = await claim(id);
    } catch {
      return;
    } finally {
      claiming.delete(id);
    }
    // Another client claimed it, or the daemon already gave up.
    if (disposed || typeof claimed.payload !== 'string') return;
    const payload = claimed.payload;
    const admitted = admit(payload);
    if (admitted instanceof Error) await refuse(id, admitted);
    else await serve(id, payload, admitted);
  };

  /** Takes up every advertised request not already in progress. */
  function pump(): void {
    if (disposed) return;
    for (const id of advertised) {
      advertised.delete(id);
      if (!running.has(id) && !claiming.has(id)) void run(id).finally(pump);
    }
  }

  return {
    handleDesktopEvent(name: string, value: unknown): boolean {
      if (name !== MODEL_PROXY_REQUEST_EVENT) return false;
      if (disposed) return true;
      const snapshot = record(value);
      // A snapshot is bounded before it is looked at: only its first entries count.
      abortCancelled(running, snapshot.cancelled, maxSnapshotEntries);
      advertised = advertisedRequestIds(
        snapshot.requests,
        maxSnapshotEntries,
        (id) => running.has(id) || claiming.has(id)
      );
      pump();
      return true;
    },
    get running() {
      return running.size;
    },
    dispose(): void {
      disposed = true;
      advertised.clear();
      liveness.abandonAll(Object.assign(new Error('The desktop app is closing.'), { name: 'AbortError' }));
    },
  };
}

interface RuntimeLayoutOptions {
  packaged: boolean;
  resourcesPath: string;
  appPath: string;
}

/** The PC runtime modules a proxied call needs (injected for tests). */
export interface ModelProxyRuntimeModules {
  usage?: {
    snapshot(name: string, provider: ModelProxyProviderInstance | undefined, options: { force: boolean }): Promise<unknown>;
    captureAccount(
      name: string,
      accountId: string,
      provider: ModelProxyProviderInstance
    ): (() => string | undefined) | undefined;
  };
  /** `secrets: 'presence'`: which credentials exist, no keychain value read. */
  loadConfig(options: { secrets: 'presence' }): { providers?: unknown } | null | undefined;
  initProviders(config: Record<string, unknown>): Promise<unknown>;
  getProvider(name: string): ModelProxyProviderInstance | undefined;
  getAllProviders(): Map<string, unknown>;
  /** One provider's stored key (environment first), read on demand. */
  readApiKey(name: string): Promise<string | null>;
  probeAuth(name: string, config: Record<string, unknown>): 'present' | 'absent' | 'unreadable';
  finalizeProviderRequestTools(tools: unknown[], nativePrefixCount: number): unknown[];
  now?: () => number;
}

/** A provider's key is re-read after this long, so a rotated key applies. */
const API_KEY_TTL_MS = 60_000;
/** The registry's "nothing enabled" refusal: a real state of this PC, not a failure. */
const NO_ENABLED_PROVIDERS = 'PROVIDERS_NONE_ENABLED';

/** The PC side of the proxy over its own provider registry. Credentials are
 *  never prewarmed in bulk: availability comes from which credentials exist,
 *  and a provider's own key is read only when a call for it arrives. */
export function createModelProxyRuntime(modules: ModelProxyRuntimeModules): ModelProxyRuntime {
  const now = modules.now ?? Date.now;
  const keys = new Map<string, { value: string | null; at: number }>();
  let chain: Promise<unknown> = Promise.resolve();
  const keyEnvironment = (entry: Record<string, unknown>) =>
    entry.type === 'custom' && entry.auth !== 'none' && typeof entry.apiKeyEnv === 'string' ? entry.apiKeyEnv : '';
  const credentialState = (name: string, entry: Record<string, unknown>) => {
    const environment = keyEnvironment(entry);
    return environment ? (process.env[environment] ? 'present' : 'absent') : modules.probeAuth(name, entry);
  };
  const usageEnabled = (name: string) => {
    const configured = record(record(modules.loadConfig({ secrets: 'presence' })?.providers)[name]);
    return (
      (configured.enabled === true || configured.credentialProbeUnavailable === true) &&
      credentialState(name, configured) !== 'absent'
    );
  };

  /** Applies the current availability plus the keys loaded so far; serialized
   *  so a call never observes another call's half-built registry. */
  const sync = (): Promise<Record<string, unknown>> => {
    const apply = async () => {
      const available = record(modules.loadConfig({ secrets: 'presence' })?.providers);
      const config: Record<string, unknown> = {};
      for (const [name, entry] of Object.entries(available)) {
        const key = keyEnvironment(record(entry)) ? null : keys.get(name)?.value;
        config[name] = key ? { ...record(entry), apiKey: key } : entry;
      }
      try {
        await modules.initProviders(config);
      } catch (error) {
        if ((error as { code?: unknown } | null)?.code !== NO_ENABLED_PROVIDERS) throw error;
      }
      return available;
    };
    const next = chain.then(apply, apply);
    chain = next.catch(() => {});
    return next;
  };

  return {
    async providerConfig() {
      const available = await sync();
      const live = modules.getAllProviders();
      const providers: Record<string, unknown> = {};
      for (const name of new Set([...Object.keys(available), ...live.keys()])) {
        const instance = live.get(name) as
          | {
              constructor?: { inputExcludesCache?: unknown };
              nativePdf?: unknown;
              consumesReadWindows?: unknown;
              firstResponseBudget?: () => unknown;
            }
          | undefined;
        const traits: Record<string, unknown> = {};
        if (modules.usage) traits.oauthUsage = true;
        const excludes = instance?.constructor?.inputExcludesCache;
        if (typeof excludes === 'boolean') traits.inputExcludesCache = excludes;
        if (typeof instance?.nativePdf === 'boolean') traits.nativePdf = instance.nativePdf;
        if (instance?.consumesReadWindows === true) traits.consumesReadWindows = true;
        // The adapter's own figure, for a model the catalog has no entry for.
        const budget = firstResponseBudget(instance?.firstResponseBudget?.());
        if (budget) traits.firstResponseBudget = budget;
        const configured = record(available[name]);
        const authState = credentialState(name, configured);
        const configuredEnabled = configured.enabled === true || configured.credentialProbeUnavailable === true;
        providers[name] = {
          ...(stripModelProxySecrets(record(available[name])) as Record<string, unknown>),
          // Availability is what this PC can actually run right now. An
          // unreadable credential counts while the registry holds its adapter,
          // on the first read as on every later one.
          enabled: configuredEnabled && Boolean(instance) && authState !== 'absent',
          authState,
          modelProxy: traits,
        };
      }
      return { providers, ready: true };
    },
    async provider(name) {
      const available = record(record(modules.loadConfig({ secrets: 'presence' })?.providers)[name]);
      if (available.enabled !== true && available.credentialProbeUnavailable !== true) return undefined;
      if (credentialState(name, available) === 'absent') return undefined;
      const cached = keys.get(name);
      // A named environment variable is the only key source for this route.
      // The adapter resolves it on the PC; never read a fallback keychain key.
      if (keyEnvironment(available)) keys.delete(name);
      else if (!cached || now() - cached.at > API_KEY_TTL_MS) {
        keys.set(name, { value: await modules.readApiKey(name), at: now() });
      }
      await sync();
      return modules.getProvider(name);
    },
    finalizeTools: (tools, nativePrefixCount) => modules.finalizeProviderRequestTools(tools, nativePrefixCount),
    ...(modules.usage
      ? {
          oauthUsage: async (name: string, provider: ModelProxyProviderInstance | undefined, force: boolean) => {
            if (!usageEnabled(name)) return { status: 'unavailable', accounts: [] };
            const reply = await modules.usage!.snapshot(name, provider, { force });
            return usageEnabled(name) ? reply : { status: 'unavailable', accounts: [] };
          },
          captureUsageAccount: (name: string, id: string, provider: ModelProxyProviderInstance) => {
            if (!usageEnabled(name)) return undefined;
            const confirm = modules.usage!.captureAccount(name, id, provider);
            return () => (usageEnabled(name) ? confirm?.() : undefined);
          },
        }
      : {}),
  };
}

/** Credential presence by the PC's own rules: the registry's OAuth set and its
 *  tri-state probe, otherwise resolveProviderApiKey's precedence (presence
 *  only, no key value read). */
export function modelProxyCredentialProbe(modules: {
  OAUTH_PROVIDER_NAMES: ReadonlySet<string>;
  oauthCredentialProbeState(name: string): 'present' | 'absent' | 'unreadable';
  hasProviderApiKey(name: string, config: Record<string, unknown>): boolean;
}): ModelProxyRuntimeModules['probeAuth'] {
  return (name, entry) => {
    if (name === 'mixdog-local' || (entry.type === 'custom' && entry.auth === 'none')) return 'present';
    if (modules.OAUTH_PROVIDER_NAMES.has(name)) return modules.oauthCredentialProbeState(name);
    return modules.hasProviderApiKey(name, entry) ? 'present' : 'absent';
  };
}

/** Lazily loads the PC's own runtime modules — the same provider registry and
 *  agent config the local daemon uses. Loaded on the first proxied call only,
 *  so local mode never pays for it. */
export function modelProxyRuntimeLoader({
  packaged,
  resourcesPath,
  appPath,
}: RuntimeLayoutOptions): () => Promise<ModelProxyRuntime> {
  const sourceRoot = packaged ? packagedRuntimeSourceRoot(resourcesPath) : resolve(appPath, '../../src');
  const moduleUrl = (...parts: string[]) => pathToFileURL(join(sourceRoot, ...parts)).href;
  let pending: Promise<ModelProxyRuntime> | null = null;
  const load = async (): Promise<ModelProxyRuntime> => {
    const [configModule, registryModule, requestToolsModule, apiKeyModule, oauthProbeModule, usageModule] = await Promise.all([
      import(/* @vite-ignore */ moduleUrl('runtime', 'agent', 'orchestrator', 'config.mjs')),
      import(/* @vite-ignore */ moduleUrl('runtime', 'agent', 'orchestrator', 'providers', 'registry.mjs')),
      import(
        /* @vite-ignore */ moduleUrl('runtime', 'agent', 'orchestrator', 'runtime-core', 'provider-request-tools.mjs')
      ),
      import(/* @vite-ignore */ moduleUrl('runtime', 'shared', 'provider-api-key.mjs')),
      import(
        /* @vite-ignore */ moduleUrl('runtime', 'agent', 'orchestrator', 'providers', 'oauth-credential-probes.mjs')
      ),
      import(/* @vite-ignore */ moduleUrl('runtime', 'agent', 'orchestrator', 'providers', 'model-proxy-usage-host.mjs')),
    ]);
    const config = configModule as unknown as Pick<ModelProxyRuntimeModules, 'loadConfig'>;
    const registry = registryModule as unknown as Pick<
      ModelProxyRuntimeModules,
      'initProviders' | 'getProvider' | 'getAllProviders'
    > & { OAUTH_PROVIDER_NAMES: ReadonlySet<string> };
    const requestTools = requestToolsModule as unknown as Pick<
      ModelProxyRuntimeModules,
      'finalizeProviderRequestTools'
    >;
    const apiKeys = apiKeyModule as unknown as {
      readAgentApiKeyAsync(name: string): Promise<string | null>;
      hasProviderApiKey(name: string, config: Record<string, unknown>): boolean;
    };
    const oauthProbes = oauthProbeModule as unknown as {
      oauthCredentialProbeState(name: string): 'present' | 'absent' | 'unreadable';
    };
    return createModelProxyRuntime({
      usage: usageModule.createModelProxyUsage(),
      loadConfig: (options) => config.loadConfig(options),
      initProviders: (providers) => registry.initProviders(providers),
      getProvider: (name) => registry.getProvider(name),
      getAllProviders: () => registry.getAllProviders(),
      readApiKey: (name) => apiKeys.readAgentApiKeyAsync(name),
      probeAuth: modelProxyCredentialProbe({
        OAUTH_PROVIDER_NAMES: registry.OAUTH_PROVIDER_NAMES,
        oauthCredentialProbeState: oauthProbes.oauthCredentialProbeState,
        hasProviderApiKey: apiKeys.hasProviderApiKey,
      }),
      finalizeProviderRequestTools: (tools, nativePrefixCount) =>
        requestTools.finalizeProviderRequestTools(tools, nativePrefixCount),
    });
  };
  return () => {
    pending ??= load().catch((error) => {
      pending = null;
      throw error;
    });
    return pending;
  };
}
