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
import { createPassthroughSignal } from '../stall-policy.mjs';
import { preconnect } from '../../../shared/llm/http-agent.mjs';
import { createAntigravityStreamCollector } from './antigravity-stream.mjs';
import { createAntigravityRequest } from './antigravity-transport.mjs';
import { finalizeAntigravityTurn } from './antigravity-response.mjs';
import {
  CONTENT_ENDPOINT,
  ANTIGRAVITY_MODELS,
  DEFAULT_ANTIGRAVITY_MODEL,
  antigravityHeaders,
  ensureAccessToken,
  ensureAntigravityVersion,
  hasAntigravityOAuthCredentials,
  loadTokens,
} from './antigravity-oauth-tokens.mjs';
import {
  antigravityModelCache,
  antigravityQuotaWindows,
  fetchAvailableModels,
  fetchUserQuotaSummary,
  normalizeAntigravityCatalog,
  resolveAntigravityWireModel,
} from './antigravity-oauth-catalog.mjs';

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

const CLAUDE_THINKING_BETA = 'interleaved-thinking-2025-05-14';

async function storedAuth(options) {
  const tokens = await ensureAccessToken(options);
  return { accessToken: tokens.access_token, projectId: tokens.project_id, email: tokens.email || '' };
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
    let opts = sendOpts || {};
    if (route.effort !== sendOpts?.effort) {
      opts = {
        ...sendOpts,
        effort: route.effort,
        thinkingLevel: route.effort == null ? null : sendOpts?.thinkingLevel,
      };
    }
    const onToolCall = typeof opts.onToolCall === 'function' ? opts.onToolCall : null;
    // Relayed through opts so the callback keeps its original receiver.
    const onTextDelta = typeof opts.onTextDelta === 'function' ? (text) => opts.onTextDelta(text) : null;
    const onStreamDelta = typeof opts.onStreamDelta === 'function' ? opts.onStreamDelta : null;
    // Per-turn stream record: live text mirror, ordered parts, native/leaked
    // tool calls and the exposure marks a failed attempt carries
    // (antigravity-stream.mjs).
    const collector = createAntigravityStreamCollector({
      tools,
      useModel,
      onToolCall,
      onTextDelta,
      onStreamDelta,
    });
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

    const passthrough = createPassthroughSignal(signal);
    const endpoint = this._contentEndpoint();
    let lastErr = null;
    let response = null;
    // One retried POST to streamGenerateContent, first-byte window and typed
    // non-OK errors included (antigravity-transport.mjs).
    const requestOnce = createAntigravityRequest({
      fetchFn: this._fetch,
      endpoint,
      headers,
      body,
      opts,
      signal: passthrough.signal,
      collector,
    });
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
        if (status === 401 && !emitted) {
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
          collector.releaseGuard();
          process.stderr.write('[antigravity] 401 — refreshed credentials and retrying once\n');
          // A second failure escapes this catch; only one refresh is attempted.
          response = await requestOnce();
        } else {
          throw err;
        }
      }
    } finally {
      passthrough.cleanup();
    }
    if (!response) throw lastErr || new Error('Antigravity returned no response');

    // Leak-scrubbed text, replay parts, tool calls, citations, the
    // finishReason verdict and usage accounting (antigravity-response.mjs).
    return finalizeAntigravityTurn({ response, collector, useModel, opts, onToolCall });
  }

  // Authenticated options for the v1internal catalog/quota calls.
  async _internalRequestOptions(signal) {
    await this._ensureVersion();
    const auth = await this._ensureAuth({ fetchFn: this._fetch });
    return { accessToken: auth.accessToken, projectId: auth.projectId, fetchFn: this._fetch, signal };
  }

  async _fetchRawModels(signal = null) {
    return fetchAvailableModels(await this._internalRequestOptions(signal));
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
    return fetchUserQuotaSummary(await this._internalRequestOptions(signal));
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
