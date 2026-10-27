// Devin OAuth provider: chat models run through a Devin account over the
// Cascade GetChatMessage stream.
//
// Per send: the stored Devin session token (devin-auth.mjs) is exchanged for a
// fresh user JWT, a router model is assigned (AssignModel), the transcript is
// lowered by devin-wire-request.mjs, and the decoded response deltas are
// projected onto chat-completions chunks so the shared compat consumer owns
// live text, tool-call assembly (dispatched only once the stream ended and
// their JSON is complete), exposure flags and watchdogs.
import { createHash, randomUUID } from 'node:crypto';
import { noteAbandonedUsage } from '../../../shared/llm/usage-context.mjs';
import { REAUTH_GUIDANCE, resolveDevinOAuthAccessToken } from './devin-auth.mjs';
import { DEVIN_ENUMS } from './devin-wire-protobuf.mjs';
import {
  DEVIN_ASSIGN_MODEL_PATH,
  DEVIN_DEFAULT_BASE_URL,
  devinRequestMetadata,
  exchangeDevinUserJwt,
} from './devin-wire-session.mjs';
import { DevinWireError, devinStream, devinUnary } from './devin-wire-transport.mjs';
import { fetchDevinModels, normalizeDevinModels } from './devin-wire-models.mjs';
import {
  DEVIN_LARGE_HISTORY_RECOVERY_BYTES,
  DEVIN_PROVIDER_ID,
  DEVIN_REPLAY_ITEM_TYPE,
  buildDevinChatRequest,
  devinHistoryBytes,
  devinRouterPrompt,
} from './devin-wire-request.mjs';
import { preparePdfTextForProvider } from './media-normalization.mjs';
import { consumeCompatChatCompletionStream } from './openai-compat-stream.mjs';
import { resolveCompatMaxOutputTokens } from './openai-compat-wire.mjs';
import { parseDevinToolCalls } from './devin-wire-tool-args.mjs';
import { createProviderReplay } from './lib/provider-replay.mjs';

export const DEVIN_CHAT_PATH = '/exa.api_server_pb.ApiServerService/GetChatMessage';
// The opaque rejection Devin answers some oversized requests with.
const OPAQUE_INTERNAL_RE = /\binternal error\b/i;
const { StopReason } = DEVIN_ENUMS;

function accountKey(sessionToken) {
  return createHash('sha256').update(String(sessionToken)).digest('hex').slice(0, 24);
}

function abortReason(signal) {
  return signal.reason instanceof Error ? signal.reason : new Error('Devin request aborted');
}

/**
 * Mixdog usage from a ModelUsageStats frame (input excludes cache reads and
 * writes), carrying the turn's Devin credit charges when the stream reported any.
 */
export function devinUsage(stats, credits = null) {
  if (!stats) return undefined;
  const input = Number(stats.inputTokens || 0);
  const cacheRead = Number(stats.cacheReadTokens || 0);
  const cacheWrite = Number(stats.cacheWriteTokens || 0);
  return {
    inputTokens: input,
    outputTokens: Number(stats.outputTokens || 0),
    cachedTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    promptTokens: input + cacheRead + cacheWrite,
    ...(credits ? { credits: { ...credits } } : {}),
    // 64-bit counters decode as bigint; usage leaves this boundary as numbers.
    raw: Object.fromEntries(
      Object.entries(stats).map(([key, value]) => [key, typeof value === 'bigint' ? Number(value) : value])
    ),
  };
}

// Collapsed effort families advertise their tiers the way other providers do.
function catalogModel(row, provider) {
  const levels = Array.isArray(row.reasoningLevels) ? row.reasoningLevels : [];
  return {
    ...(levels.length
      ? {
          reasoningLevels: levels,
          reasoningOptions: [{ type: 'effort', values: levels }],
          defaultEffort: row.defaultEffort || null,
          // No thinking-off route: 'none' is absent from the levels.
          ...(row.requiresEffort ? { requiresEffort: true } : {}),
        }
      : {}),
    ...(row.isDefault ? { isDefault: true } : {}),
    id: row.id,
    display: row.name,
    provider,
    mode: 'chat',
    contextWindow: row.contextWindow,
    outputTokens: row.maxOutputTokens,
    description: row.description,
    supportsVision: row.supportsVision,
    supportsFunctionCalling: row.supportsTools,
    reasoning: row.reasoning,
    supportsReasoning: row.supportsReasoning,
  };
}

/**
 * Per-turn projection of decoded GetChatMessageResponse frames onto
 * chat-completions chunks. Tool calls are keyed by their wire id; a frame
 * without an id continues the last call, and one with neither is dropped.
 * Arguments may arrive as deltas or as growing snapshots.
 */
export function createDevinTurn({ onReasoningDelta } = {}) {
  const calls = new Map();
  let activeCall = '';
  let inThinking = false;
  const signatures = [];
  let signatureType = '';
  const turn = {
    sawOutput: false,
    messageId: '',
    thinking: '',
    stopReason: StopReason.UNSPECIFIED,
    usage: null,
    // The concrete model that served the turn: the router assignment, then
    // the latest uid the stream reports (fallbacks, capacity routing).
    upstreamModel: '',
    // Credit charges { cost, committedCost, acuCost }; each nonzero report replaces its field.
    credits: null,
  };

  const toolDeltas = (deltaToolCalls) => {
    const out = [];
    for (const call of deltaToolCalls || []) {
      const id = String(call.id || '') || activeCall;
      if (!id) continue;
      let entry = calls.get(id);
      const delta = {};
      if (!entry) {
        entry = { index: calls.size, args: '', name: '' };
        calls.set(id, entry);
        Object.assign(delta, { id, type: 'function' });
      }
      activeCall = id;
      // The last name a call is given wins; names go out with the terminal chunk.
      if (call.name) entry.name = call.name;
      // Arguments the server could not parse arrive as invalidJsonStr instead;
      // they take the same repair-or-marker path, never an empty `{}`.
      const raw = String(call.argumentsJson || call.invalidJsonStr || '');
      const merged = raw.startsWith(entry.args) ? raw : entry.args + raw;
      const piece = raw ? merged.slice(entry.args.length) : '';
      if (raw) entry.args = merged;
      out.push({ index: entry.index, ...delta, function: { arguments: piece } });
    }
    return out;
  };

  // Each call's final name, attached once the stream ended.
  turn.finalToolNames = () =>
    [...calls.values()].map((entry) => ({ index: entry.index, function: { name: entry.name, arguments: '' } }));

  turn.chunk = (msg) => {
    if (msg.messageId && !turn.messageId) turn.messageId = msg.messageId;
    if (msg.stopReason) turn.stopReason = msg.stopReason;
    if (msg.usage) turn.usage = msg.usage;
    if (msg.actualModelUid) turn.upstreamModel = msg.actualModelUid;
    const cost = Number(msg.creditCost || 0);
    const committedCost = Number(msg.committedCreditCost || 0);
    const acuCost = Number(msg.committedAcuCost || 0);
    if (cost || committedCost || acuCost) {
      turn.credits ??= {};
      if (cost) turn.credits.cost = cost;
      if (committedCost) turn.credits.committedCost = committedCost;
      if (acuCost) turn.credits.acuCost = acuCost;
    }
    const delta = {};
    if (msg.deltaThinking) {
      if (!inThinking) signatures.push('');
      inThinking = true;
      turn.thinking += msg.deltaThinking;
      delta.reasoning_content = msg.deltaThinking;
      try {
        onReasoningDelta?.(msg.deltaThinking);
      } catch {}
    }
    // Signatures stream as deltas and may arrive after the thinking they sign
    // (behind its text or tool calls): every fragment extends the latest
    // thinking block's signature.
    if (msg.deltaSignature) {
      if (!signatures.length) signatures.push('');
      signatures[signatures.length - 1] += msg.deltaSignature;
    }
    if (msg.deltaSignatureType) signatureType = msg.deltaSignatureType;
    if (msg.deltaText) {
      inThinking = false;
      delta.content = msg.deltaText;
    }
    const toolCalls = toolDeltas(msg.deltaToolCalls);
    if (msg.deltaToolCalls?.length) inThinking = false;
    if (toolCalls.length) delta.tool_calls = toolCalls;
    if (msg.deltaThinking || msg.deltaText || msg.deltaToolCalls?.length) turn.sawOutput = true;
    return { ...(msg.messageId ? { id: msg.messageId } : {}), choices: [{ index: 0, delta }] };
  };

  // The terminal finish reason, once the stream ended with a clean trailer.
  turn.finishReason = () => {
    if (calls.size) return 'tool_calls';
    return turn.stopReason === StopReason.MAX_TOKENS ? 'length' : 'stop';
  };

  // Replay record for the next request: native message id, thinking and the
  // first thinking block's signature (with the signature type the stream
  // reported), bound to the model that produced them.
  turn.replay = (model) => {
    const signature = signatures.find(Boolean);
    return createProviderReplay(DEVIN_PROVIDER_ID, [
      {
        type: DEVIN_REPLAY_ITEM_TYPE,
        model,
        ...(turn.messageId ? { messageId: turn.messageId } : {}),
        ...(turn.thinking ? { thinking: turn.thinking } : {}),
        ...(signature ? { signature, ...(signatureType ? { signatureType } : {}) } : {}),
      },
    ]);
  };
  return turn;
}

/** The concrete wire uid of a catalog row at `effort`: its effort route, else its default uid. */
export function devinWireUid(row, modelId, effort) {
  return (effort && row?.effortUids?.[effort]) || row?.uid || modelId;
}

// The transport ends `frames` only after the end-of-stream trailer, so the
// terminal chunk (and with it tool dispatch) follows a complete response.
async function* devinChunks(frames, turn) {
  for await (const msg of frames) yield turn.chunk(msg);
  const names = turn.finalToolNames();
  yield {
    choices: [{ index: 0, delta: names.length ? { tool_calls: names } : {}, finish_reason: turn.finishReason() }],
  };
}

/**
 * Typed Mixdog contract on a Devin failure: a rejected sign-in names the
 * re-auth step; an oversized request is a context overflow so compaction
 * runs; a stream cut short without its trailer is a truncated stream.
 */
export function devinProviderError(error, { reauth = false } = {}) {
  if (!(error instanceof DevinWireError)) return error;
  if (error.code === 'unauthenticated' && reauth && !error.reauthRequired) {
    error.reauthRequired = true;
    error.message = `Devin rejected the sign-in (${error.message}). ${REAUTH_GUIDANCE}`;
  } else if (error.code === 'request_too_large') {
    error.providerError = { code: 'context_length_exceeded', message: error.message };
  } else if (error.code === 'protocol' && error.retryable) {
    error.truncatedStream = true;
  }
  return error;
}

// An opaque `internal error` invalid_argument rejected by the stream trailer
// before any output: a context overflow when the compactable history is
// large, a transient failure otherwise.
function classifyOpaqueRejection(error, { request, activeTail }) {
  if (!(error instanceof DevinWireError) || error.code !== 'invalid_argument') return;
  if (!OPAQUE_INTERNAL_RE.test(error.detail || '')) return;
  const overflow = devinHistoryBytes(request, activeTail) >= DEVIN_LARGE_HISTORY_RECOVERY_BYTES;
  error.providerError = { code: overflow ? 'context_length_exceeded' : 'internal_error', message: error.message };
}

export class DevinOAuthProvider {
  // Cascade carries no document block: PDFs lower to their text.
  nativePdf = false;
  // ModelUsageStats input tokens exclude cache reads and writes.
  static inputExcludesCache = true;
  name = DEVIN_PROVIDER_ID;
  config;
  _catalogs = new Map();
  _lastCatalogKey = null;

  constructor(config = {}) {
    this.config = config || {};
  }

  get _fetch() {
    return this.config.fetchFn || fetch;
  }

  get _baseUrl() {
    return this.config.baseUrl || DEVIN_DEFAULT_BASE_URL;
  }

  async _sessionToken() {
    return this.config.accessToken || resolveDevinOAuthAccessToken();
  }

  // A fresh user JWT (plus the accepted api key and chat host) for one turn.
  async _userSession(sessionToken, signal) {
    try {
      return await exchangeDevinUserJwt({ sessionToken, fetchFn: this._fetch, signal, baseUrl: this._baseUrl });
    } catch (error) {
      throw devinProviderError(error, { reauth: true });
    }
  }

  async _catalog(key, sessionToken, signal) {
    let catalog = this._catalogs.get(key);
    if (!catalog) {
      const configs = await fetchDevinModels({ sessionToken, fetchFn: this._fetch, signal, baseUrl: this._baseUrl });
      const rows = normalizeDevinModels(configs, { defaultModelUid: configs?.defaultModelUid });
      catalog = {
        rows: new Map(rows.map((row) => [row.id, row])),
        models: rows.map((row) => catalogModel(row, this.name)),
      };
      // An empty answer is not pinned: the next lookup asks again.
      if (rows.length) this._catalogs.set(key, catalog);
    }
    this._lastCatalogKey = key;
    return catalog;
  }

  getCachedModelInfo(model) {
    return this._catalogs.get(this._lastCatalogKey)?.models.find((entry) => entry.id === model) || null;
  }

  async listModels() {
    const sessionToken = await this._sessionToken();
    return (await this._catalog(accountKey(sessionToken), sessionToken, null)).models;
  }

  async _refreshModelCache() {
    this._catalogs.clear();
    return this.listModels();
  }

  // A router row is not a chat model: AssignModel resolves it, per turn, into
  // a concrete uid plus the JWT that authorizes it on the chat sharing the
  // cascade id. An incomplete assignment fails the turn.
  async _assignModel({ session, routerUid, cascadeId, messages, vision, signal }) {
    const response = await devinUnary({
      baseUrl: session.apiHost || this._baseUrl,
      path: DEVIN_ASSIGN_MODEL_PATH,
      requestType: 'AssignModelRequest',
      responseType: 'AssignModelResponse',
      message: {
        metadata: devinRequestMetadata({ apiKey: session.apiKey, client: 'cli' }),
        modelRouterUid: routerUid,
        cascadeId,
        chatMessagePrompt: devinRouterPrompt(messages, { vision }),
      },
      fetchFn: this._fetch,
      signal,
    });
    const assignment = response.assignment;
    if (!assignment?.assignmentJwt || !assignment?.modelUid) {
      throw new DevinWireError('Devin AssignModel returned no assignment JWT and model uid', { code: 'protocol' });
    }
    return assignment;
  }

  // One streamed GetChatMessage. An error after live text or a dispatched
  // tool call is marked unsafe to retry by the compat consumer.
  async _streamTurn({ session, messages, model, wireUid, modelRow, tools, sendOpts, cascadeId, turn, signal }) {
    const assignment = modelRow?.router
      ? await this._assignModel({
          session,
          routerUid: wireUid,
          cascadeId,
          messages,
          vision: modelRow.supportsVision === true,
          signal,
        })
      : null;
    if (assignment) turn.upstreamModel = assignment.modelUid;
    const { request, activeTail } = buildDevinChatRequest(messages, {
      model,
      chatModelUid: assignment?.modelUid || wireUid,
      ...(assignment ? { modelAssignmentJwt: assignment.assignmentJwt } : {}),
      modelRow,
      tools,
      metadata: devinRequestMetadata({ apiKey: session.apiKey, userJwt: session.jwt, client: 'cli' }),
      cascadeId,
      maxOutputTokens: resolveCompatMaxOutputTokens(sendOpts),
      temperature: sendOpts.temperature,
      topP: sendOpts.topP,
      stopSequences: sendOpts.stopSequences,
    });
    try {
      sendOpts.onStageChange?.('requesting');
    } catch {}
    // Whether the server accepted the request: a failure after that came
    // from the stream itself (its trailer), not from the HTTP status.
    let accepted = false;
    const frames = devinStream({
      baseUrl: session.apiHost || this._baseUrl,
      path: DEVIN_CHAT_PATH,
      requestType: 'GetChatMessageRequest',
      responseType: 'GetChatMessageResponse',
      message: request,
      fetchFn: async (...args) => {
        const response = await this._fetch(...args);
        accepted = response.ok;
        return response;
      },
      signal,
    });
    let liveTextEmitted = false;
    let streaming = false;
    try {
      return await consumeCompatChatCompletionStream(devinChunks(frames, turn), {
        signal,
        label: this.name,
        providerName: this.name,
        // The wrapper below always exists; the stream joins the session's
        // logical request only when the caller reports progress into it.
        sessionId: typeof sendOpts.onStreamDelta === 'function' ? sendOpts.sessionId : null,
        onStreamDelta: (delta) => {
          if (!streaming) {
            streaming = true;
            try {
              sendOpts.onStageChange?.('streaming');
            } catch {}
          }
          sendOpts.onStreamDelta?.(delta);
        },
        onToolCall: (call) => sendOpts.onToolCall?.(call),
        onTextDelta: (text) => {
          if (text) liveTextEmitted = true;
          sendOpts.onTextDelta?.(text);
        },
        onStreamItemStart: sendOpts.onStreamItemStart,
        parseToolCalls: parseDevinToolCalls,
        // Text stays text: only deltaToolCalls produce tool calls.
        leakedToolCallRecovery: false,
      });
    } catch (error) {
      if (liveTextEmitted) Object.assign(error, { liveTextEmitted: true, unsafeToRetry: true });
      if (accepted && !turn.sawOutput) classifyOpaqueRejection(error, { request, activeTail });
      const usage = devinUsage(turn.usage, turn.credits);
      const servedModel = turn.upstreamModel || model;
      if (usage && !error.partialUsage) {
        if (signal?.aborted) noteAbandonedUsage(usage, servedModel);
        else Object.assign(error, { partialUsage: usage, partialModel: servedModel });
      }
      throw error;
    }
  }

  async send(messages, model, tools, sendOpts = {}) {
    const signal = sendOpts.signal || null;
    if (signal?.aborted) throw abortReason(signal);
    const modelId = String(model || '').trim();
    if (!modelId) throw new Error('Devin requires a model id. Pick a Devin model in Mixdog.');
    const sessionToken = await this._sessionToken();
    const key = accountKey(sessionToken);
    const catalog = await this._catalog(key, sessionToken, signal);
    const modelRow = catalog.rows.get(modelId) || null;
    const wireUid = devinWireUid(modelRow, modelId, sendOpts.effort);
    const prepared = await preparePdfTextForProvider(messages, this);
    // The server threads turns that share one cascade id.
    const cascadeId = String(sendOpts.transportScope || sendOpts.sessionId || randomUUID());
    const attempt = async (session) => {
      const turn = createDevinTurn({ onReasoningDelta: sendOpts.onReasoningDelta });
      const args = {
        session,
        messages: prepared,
        model: modelId,
        wireUid,
        modelRow,
        tools,
        sendOpts,
        cascadeId,
        turn,
        signal,
      };
      return { turn, assembled: await this._streamTurn(args) };
    };
    // Every turn exchanges a fresh user JWT; a refused one is a re-auth.
    const session = await this._userSession(sessionToken, signal);
    let outcome;
    try {
      outcome = await attempt(session);
    } catch (error) {
      if (signal?.aborted) throw abortReason(signal);
      throw devinProviderError(error, { reauth: true });
    }
    const { turn, assembled } = outcome;
    return {
      content: assembled.content || '',
      // The served model, as other providers report the response's model.
      model: turn.upstreamModel || modelId,
      ...(turn.credits ? { credits: { ...turn.credits } } : {}),
      toolCalls: assembled.toolCalls,
      stopReason: assembled.stopReason,
      ...(assembled.reasoningContent ? { reasoningContent: assembled.reasoningContent } : {}),
      providerReplay: turn.replay(modelId),
      usage: devinUsage(turn.usage, turn.credits),
    };
  }
}
