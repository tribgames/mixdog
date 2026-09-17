/**
 * Google Antigravity provider (Cloud Code Assist "unified gateway").
 *
 * One Google OAuth login exposes Gemini 3.x and Anthropic Claude behind a
 * single Gemini-shaped API. Message/tool conversion and SSE consumption are
 * reused from the API-key Gemini provider; only the transport differs:
 *
 *   - requests wrap the Gemini payload in { project, model, request, … }
 *   - responses nest it back under `response` (see unwrapChunk below)
 *   - the host is the IDE-internal daily channel (no automatic host fallback)
 *
 * Auth, endpoints, and headers live in antigravity-oauth-tokens.mjs.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildAntigravityRequest, isAntigravityClaude as isClaudeModel } from './antigravity-request.mjs';

// Opt-in request capture, the Gemini counterpart of MIXDOG_OAI_WS_DUMP_DIR:
// when MIXDOG_ANTIGRAVITY_DUMP_DIR names a directory every serialized
// request body (contents, tools, config — never headers or tokens) is
// written there, so the replayed history can be inspected as sent. Unset
// means no-op.
let _dumpSequence = 0;
function dumpAntigravityRequest(body) {
  const dir = String(process.env.MIXDOG_ANTIGRAVITY_DUMP_DIR || '').trim();
  if (!dir) return;
  try {
    mkdirSync(dir, { recursive: true });
    _dumpSequence += 1;
    const name = `antigravity-${Date.now()}-${String(_dumpSequence).padStart(3, '0')}.json`;
    writeFileSync(join(dir, name), JSON.stringify(body, null, 2));
  } catch {}
}
import { withRetry } from './retry-classifier.mjs';
import { traceAgentUsage } from '../agent-trace.mjs';
import { createProviderReplay } from './lib/provider-replay.mjs';
import { createPassthroughSignal, createTimeoutSignal } from '../stall-policy.mjs';
import { getLlmDispatcher, preconnect } from '../../../shared/llm/http-agent.mjs';
import {
  GEMINI_FIRST_BYTE_TIMEOUT_MS,
  createGeminiTextLeakGuard,
  consumeGeminiRestStreamResponse,
} from './gemini-stream.mjs';
import {
  parseToolCalls,
  emitGeminiToolCalls,
  collectGeminiGroundingSources,
  parseGeminiTextPartMetadata,
} from './gemini-schema.mjs';
import {
  CONTENT_ENDPOINT,
  ANTIGRAVITY_MODELS,
  DEFAULT_ANTIGRAVITY_MODEL,
  antigravityHeaders,
  ensureAccessToken,
  ensureAntigravityVersion,
  hasAntigravityOAuthCredentials,
  loadTokens,
  _scrubTokens,
} from './antigravity-oauth-tokens.mjs';
import {
  antigravityModelCache,
  antigravityQuotaWindows,
  fetchAvailableModels,
  fetchUserQuotaSummary,
  normalizeAntigravityCatalog,
  resolveAntigravityWireModel,
} from './antigravity-oauth-catalog.mjs';

const CLAUDE_THINKING_BETA = 'interleaved-thinking-2025-05-14';

function antigravityError(res, text, endpoint) {
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    /* not JSON */
  }
  const detail = payload?.error || null;
  const message = detail?.message || text?.slice(0, 300) || '';
  const err = new Error(`Antigravity ${res.status} (${endpoint}): ${_scrubTokens(message)}`);
  err.status = res.status;
  err.httpStatus = res.status;
  err.headers = res.headers;
  err.initialResponseError = true;
  if (detail) {
    err.error = detail;
    err.data = payload;
    if (detail.status) err.geminiStatus = detail.status;
  }
  // Account verification is terminal and actionable: surface the URL Google
  // returns instead of a raw API body the user cannot act on.
  // Google puts the link in the error details, not the message text.
  const validationDetail = Array.isArray(detail?.details)
    ? detail.details.find(
        (entry) => entry?.reason === 'VALIDATION_REQUIRED' && typeof entry.metadata?.validation_url === 'string'
      )
    : null;
  const validationUrl =
    validationDetail?.metadata.validation_url ||
    /https:\/\/\S*(?:accounts|console)\.google\.com\/\S+/.exec(message || '')?.[0] ||
    '';
  if (res.status === 403 && /VALIDATION_REQUIRED/i.test(text || '')) {
    err.message = `Antigravity requires account verification${validationUrl ? `: open ${validationUrl} , complete the check, then retry` : ''}`;
    err.validationUrl = validationUrl || undefined;
    err.unsafeToRetry = true;
  }
  return err;
}

async function storedAuth(options) {
  const tokens = await ensureAccessToken(options);
  return { accessToken: tokens.access_token, projectId: tokens.project_id, email: tokens.email || '' };
}

// A retired wire id answers with one plain-text notice and no finishReason.
// That is a terminal answer about the model, not a truncated stream.
const RETIRED_MODEL_NOTICE = /\bno longer (?:available|supported)\b/i;

function retiredModelError(err, streamedText, model) {
  if (!(err?.code === 'TRUNCATED_STREAM' && /no finishReason/.test(String(err?.message || '')))) return null;
  const text = String(streamedText || '').trim();
  if (!RETIRED_MODEL_NOTICE.test(text)) return null;
  return Object.assign(new Error(`Antigravity retired ${model}: ${text}`), {
    code: 'MODEL_RETIRED',
    status: 404,
    httpStatus: 404,
    unsafeToRetry: true,
    modelRetired: true,
  });
}

export class AntigravityOAuthProvider {
  // usageMetadata.promptTokenCount is the total, cached tokens included.
  static inputExcludesCache = false;
  name = 'antigravity-oauth';

  constructor(config = {}) {
    this.config = config || {};
    this._fetch = typeof config.fetchFn === 'function' ? config.fetchFn : fetch;
    this._preconnect = typeof config.preconnectFn === 'function' ? config.preconnectFn : preconnect;
    // AuthStorage equivalent: refreshes the token and resolves the project.
    // Injectable so wire-shape tests do not need a real credential store.
    // The store keeps snake_case fields; requests read the camelCase view.
    this._ensureAuth = typeof config.ensureAuthFn === 'function' ? config.ensureAuthFn : storedAuth;
    // Client version for the hub identity header, discovered once per process.
    this._ensureVersion =
      typeof config.ensureVersionFn === 'function'
        ? config.ensureVersionFn
        : () => ensureAntigravityVersion({ fetchFn: this._fetch });
    this._preconnect(this._contentEndpoint());
  }

  _contentEndpoint() {
    const configured = String(this.config.baseURL || '').trim();
    return configured || CONTENT_ENDPOINT;
  }

  _buildBody(messages, model, tools, opts) {
    const body = buildAntigravityRequest(messages, model, tools, opts, this._projectId);
    dumpAntigravityRequest(body);
    return body;
  }

  async send(messages, model, tools, sendOpts = {}) {
    const signal = sendOpts?.signal || null;
    // Picker ids name a tier family; the wire id carries the chosen effort.
    const route = resolveAntigravityWireModel(model || DEFAULT_ANTIGRAVITY_MODEL, sendOpts?.effort);
    const useModel = route.model;
    const opts =
      route.effort === sendOpts?.effort
        ? sendOpts || {}
        : { ...sendOpts, effort: route.effort, thinkingLevel: route.effort == null ? null : sendOpts?.thinkingLevel };
    const onToolCall = typeof opts.onToolCall === 'function' ? opts.onToolCall : null;
    // Streamed text is kept so a retirement notice can be told apart from
    // a truncated stream when the gateway omits the finishReason.
    let streamedText = '';
    const onTextDelta =
      typeof opts.onTextDelta === 'function'
        ? (text) => {
            if (typeof text === 'string') streamedText += text;
            opts.onTextDelta(text);
          }
        : null;
    const onStreamDelta = typeof opts.onStreamDelta === 'function' ? opts.onStreamDelta : null;
    if (signal?.aborted) {
      const reason = signal.reason;
      throw reason instanceof Error ? reason : new Error('Antigravity request aborted');
    }

    this._preconnect(this._contentEndpoint());
    // Normalize history while version discovery and token refresh run.
    // The authenticated project is bound only after those tasks finish.
    const [, auth, request] = await Promise.all([
      this._ensureVersion(),
      this._ensureAuth({ fetchFn: this._fetch }),
      Promise.resolve().then(() => this._buildBody(messages, useModel, tools, opts)),
    ]);
    this._projectId = auth.projectId;
    request.project = auth.projectId;
    const body = JSON.stringify(request);
    const headers = {
      Authorization: `Bearer ${auth.accessToken}`,
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      ...antigravityHeaders(),
      ...(isClaudeModel(useModel) ? { 'anthropic-beta': CLAUDE_THINKING_BETA } : {}),
    };

    let textLeakGuard = null;
    let terminalFailure = null;
    let streamedParts = [];
    let streamedNativeToolCalls = [];
    const seenNativeToolIds = new Set();
    const emittedToolIds = new Set();
    const dispatchToolCall = onToolCall
      ? (call) => {
          // A failure already observed in this chunk must win over both
          // native calls and calls recovered from its text.
          if (terminalFailure || emittedToolIds.has(call.id)) return;
          emittedToolIds.add(call.id);
          onToolCall(call);
        }
      : null;
    const onChunk = (chunk) => {
      const candidate = chunk?.candidates?.[0];
      const finishReason =
        candidate?.finishReason ||
        (chunk?.promptFeedback?.blockReason ? `PROMPT_${chunk.promptFeedback.blockReason}` : null);
      if (finishReason && String(finishReason).replace(/^FINISH_REASON_/, '') !== 'STOP') {
        terminalFailure ||= finishReason;
      }
      if (!onToolCall) return;
      const parts = candidate?.content?.parts ?? [];
      streamedParts.push(...parts);
      if (terminalFailure || !parts.some((part) => part?.functionCall)) return;
      // Parse against the turn's parts so anonymous call IDs keep the
      // same ordinal as final parsing, even across separate SSE chunks.
      const fresh = (parseToolCalls(streamedParts) || []).filter((call) => {
        if (seenNativeToolIds.has(call.id)) return false;
        seenNativeToolIds.add(call.id);
        return true;
      });
      const calls = textLeakGuard?.enabled ? textLeakGuard.filterNativeToolCalls(fresh) : fresh;
      if (calls?.length) streamedNativeToolCalls.push(...calls);
      emitGeminiToolCalls(calls, dispatchToolCall);
    };
    const passthrough = createPassthroughSignal(signal);
    const endpoint = this._contentEndpoint();
    let lastErr = null;
    let response = null;
    // One forced token refresh per send: a second 401 after a fresh token is
    // a real authorization failure, not a stale bearer.
    let refreshedAuth = false;
    const requestOnce = () =>
      withRetry(
        async ({ signal: attemptSignal }) => {
          try {
            opts.onStageChange?.('requesting');
          } catch {
            /* heartbeat */
          }
          const firstByte = createTimeoutSignal(attemptSignal, GEMINI_FIRST_BYTE_TIMEOUT_MS, 'Antigravity first byte');
          let res;
          try {
            res = await this._fetch(`${endpoint}/v1internal:streamGenerateContent?alt=sse`, {
              method: 'POST',
              headers,
              body,
              signal: firstByte.signal,
              dispatcher: getLlmDispatcher(),
            });
          } catch (err) {
            // Fetch surfaces AbortError; rethrow the timer/parent
            // reason so same-host retry sees EPROVIDERTIMEOUT and
            // a caller cancel stays a cancel.
            if (firstByte.signal.aborted && firstByte.signal.reason instanceof Error) {
              throw firstByte.signal.reason;
            }
            throw err;
          } finally {
            firstByte.cleanup();
          }
          if (!res.ok) {
            const text = await res.text().catch(() => '');
            throw antigravityError(res, text, endpoint);
          }
          textLeakGuard = createGeminiTextLeakGuard({
            knownToolNames: tools?.map((t) => t.name).filter(Boolean) ?? [],
            onTextDelta,
            onToolCall: dispatchToolCall,
            onStreamDelta,
          });
          streamedText = '';
          terminalFailure = null;
          streamedParts = [];
          streamedNativeToolCalls = [];
          seenNativeToolIds.clear();
          emittedToolIds.clear();
          try {
            return await consumeGeminiRestStreamResponse(res, {
              signal: attemptSignal,
              onStreamDelta,
              onTextDelta,
              onChunk,
              textLeakGuard,
              label: 'Antigravity streamGenerateContent',
              // Cloud Code Assist nests the Gemini payload under
              // `response`; in-band error events stay top level.
              unwrapChunk: (chunk) => (chunk && typeof chunk === 'object' && chunk.response ? chunk.response : chunk),
            });
          } catch (streamErr) {
            const error = retiredModelError(streamErr, streamedText, useModel) || streamErr;
            // Native calls now run before EOF. Preserve
            // their history and prohibit resampling after
            // a tool callback.
            if (emittedToolIds.size) {
              error.emittedToolCall = true;
              error.unsafeToRetry = true;
              const leaked = textLeakGuard.getLeakedToolCalls();
              error.partialToolCalls = [...streamedNativeToolCalls, ...leaked];
              const replay = createProviderReplay('antigravity', leaked.length ? [] : streamedParts);
              if (replay) replay.requestContext = { model: useModel };
              if (replay) error.partialProviderReplay = replay;
            }
            throw error;
          }
        },
        {
          signal: passthrough.signal,
          onRetry: ({ attempt, lastErr: retryErr }) => {
            try {
              opts.onStageChange?.('requesting');
            } catch {
              /* heartbeat */
            }
            process.stderr.write(
              `[antigravity] retry ${attempt + 1} after ${retryErr?.message || 'transient error'}\n`
            );
          },
        }
      );
    try {
      try {
        response = await requestOnce();
      } catch (err) {
        lastErr = err;
        const status = Number(err?.status || err?.httpStatus || 0);
        const emitted = err?.unsafeToRetry === true || err?.liveTextEmitted === true || err?.emittedToolCall === true;
        // A typed 401 says THIS access token is no longer accepted.
        // Force one credential refresh and replay the same host instead
        // of surfacing a re-login prompt for a token that only needed a
        // refresh. shouldRefresh() alone never covers this: a
        // server-side revocation/rotation happens while the local
        // expiry still looks valid.
        if (status === 401 && !emitted && !refreshedAuth) {
          refreshedAuth = true;
          let refreshed = null;
          try {
            refreshed = await this._ensureAuth({ fetchFn: this._fetch, force: true });
          } catch {
            // Refresh itself failed (revoked / no refresh token):
            // the original 401 is the actionable error.
            throw err;
          }
          // refreshTokens() preserves project_id/email, so only the
          // bearer changes; the already-serialized body stays valid.
          this._projectId = refreshed.projectId;
          headers.Authorization = `Bearer ${refreshed.accessToken}`;
          textLeakGuard = null;
          process.stderr.write('[antigravity] 401 — refreshed credentials and retrying once\n');
          response = await requestOnce();
        } else {
          throw err;
        }
      }
    } finally {
      passthrough.cleanup();
    }
    if (!response) throw lastErr || new Error('Antigravity returned no response');

    const candidate = response.candidates?.[0] || null;
    const responseParts = candidate?.content?.parts ?? [];
    const textParts = responseParts.filter((p) => p?.thought !== true && 'text' in p);
    const rawContent = textParts.map((p) => ('text' in p ? p.text : '')).join('');
    const providerMetadata = parseGeminiTextPartMetadata(responseParts);
    const content = textLeakGuard?.enabled ? textLeakGuard.scrubAssistantText(rawContent) : rawContent;
    const leakedToolCalls = textLeakGuard?.getLeakedToolCalls() ?? [];
    const providerReplay = createProviderReplay(
      'antigravity',
      leakedToolCalls.length || rawContent !== content ? [] : responseParts
    );
    // Thought signatures are only valid for the model family that minted
    // them; the request builder consults this when the route changes.
    if (providerReplay) providerReplay.requestContext = { model: useModel };
    let nativeToolCalls = onToolCall
      ? streamedNativeToolCalls.length
        ? streamedNativeToolCalls
        : undefined
      : parseToolCalls(responseParts);
    if (!onToolCall && textLeakGuard?.enabled) nativeToolCalls = textLeakGuard.filterNativeToolCalls(nativeToolCalls);
    let toolCalls = nativeToolCalls;
    if (leakedToolCalls.length) {
      toolCalls = toolCalls?.length ? [...toolCalls, ...leakedToolCalls] : leakedToolCalls;
    }
    const citations = collectGeminiGroundingSources(candidate);

    const promptBlockReason = response.promptFeedback?.blockReason || null;
    const finishReason =
      terminalFailure || candidate?.finishReason || (promptBlockReason ? `PROMPT_${promptBlockReason}` : null);
    const normalizedFinish = String(finishReason || '').replace(/^FINISH_REASON_/, '');
    if (finishReason && normalizedFinish !== 'STOP') {
      throw Object.assign(new Error(`Antigravity response incomplete: finishReason=${finishReason}`), {
        name: 'ProviderIncompleteError',
        code: 'PROVIDER_INCOMPLETE',
        providerIncomplete: true,
        finishReason,
        partialContent: content,
        partialToolCalls: toolCalls,
        partialProviderReplay: providerReplay,
        providerMetadata,
        model: useModel,
        rawUsage: response.usageMetadata || null,
        ...(emittedToolIds.size ? { emittedToolCall: true, unsafeToRetry: true } : {}),
      });
    }

    const um = response.usageMetadata || null;
    let usage;
    if (um) {
      const inputTokens = um.promptTokenCount || um.prompt_token_count || 0;
      const cachedTokens = um.cachedContentTokenCount || um.cached_content_token_count || 0;
      const outputTokens =
        (um.candidatesTokenCount || um.candidates_token_count || 0) +
        (um.thoughtsTokenCount || um.thoughts_token_count || 0);
      usage = { inputTokens, outputTokens, cachedTokens, promptTokens: inputTokens };
      traceAgentUsage({
        sessionId: opts.sessionId || opts.session?.id || null,
        iteration: Number.isFinite(Number(opts.iteration)) ? Number(opts.iteration) : null,
        inputTokens,
        outputTokens,
        cachedTokens,
        cacheWriteTokens: 0,
        promptTokens: inputTokens,
        model: useModel,
        modelDisplay: useModel,
        rawUsage: um,
        provider: 'antigravity-oauth',
      });
    }

    return {
      content,
      model: useModel,
      toolCalls,
      citations: citations.length ? citations : undefined,
      providerReplay,
      providerMetadata,
      providerState: opts.providerState,
      usage,
    };
  }

  async _fetchRawModels(signal = null) {
    await this._ensureVersion();
    const auth = await this._ensureAuth({ fetchFn: this._fetch });
    return fetchAvailableModels({
      accessToken: auth.accessToken,
      projectId: auth.projectId,
      fetchFn: this._fetch,
      signal,
    });
  }

  // Live catalog with a disk cache; the curated list covers an offline or
  // signed-out daemon so the picker never goes empty.
  async listModels() {
    const cached = antigravityModelCache.loadSync();
    if (cached) return cached;
    try {
      const models = normalizeAntigravityCatalog(await this._fetchRawModels());
      if (models.length) {
        antigravityModelCache.save(models);
        return models;
      }
    } catch (err) {
      console.warn(`[antigravity-oauth] catalog refresh failed, using the curated list: ${err?.message || err}`);
    }
    return ANTIGRAVITY_MODELS;
  }

  async _refreshModelCache() {
    const models = normalizeAntigravityCatalog(await this._fetchRawModels());
    if (!models.length) throw new Error('[antigravity-oauth] fetchAvailableModels listed no chat models');
    antigravityModelCache.save(models);
    return models;
  }

  async _fetchQuotaSummary(signal = null) {
    await this._ensureVersion();
    const auth = await this._ensureAuth({ fetchFn: this._fetch });
    return fetchUserQuotaSummary({
      accessToken: auth.accessToken,
      projectId: auth.projectId,
      fetchFn: this._fetch,
      signal,
    });
  }

  async getUsageSnapshot() {
    return {
      provider: this.name,
      model: null,
      source: 'antigravity-quota-summary',
      quotaWindows: antigravityQuotaWindows(await this._fetchQuotaSummary()),
    };
  }

  async isAvailable() {
    try {
      if (!hasAntigravityOAuthCredentials()) return false;
      return Boolean(loadTokens()?.project_id);
    } catch {
      return false;
    }
  }
}

export {
  hasAntigravityOAuthCredentials,
  describeAntigravityOAuthCredentials,
  forgetAntigravityOAuthCredentials,
} from './antigravity-oauth-tokens.mjs';
export { beginOAuthLogin, loginOAuth } from './antigravity-oauth-login.mjs';
