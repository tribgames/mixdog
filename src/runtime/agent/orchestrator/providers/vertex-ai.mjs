import { resolveProviderApiKey } from '../../../shared/provider-api-key.mjs';
import { getLlmDispatcher } from '../../../shared/llm/http-agent.mjs';
import { sanitizeToolPairs } from '../session/context-utils.mjs';
import { noteRequestServiceTier } from '../../../shared/llm/usage-context.mjs';
import { buildGeminiRequest } from './gemini-request-body.mjs';
import { geminiEndsWithFunctionResponse, runGeminiStreamAttempts } from './gemini-retry-policy.mjs';
import { consumeGeminiRestStreamResponse } from './gemini-stream.mjs';
import { geminiTextLeakGuardFor } from './gemini-sdk-request.mjs';
import { createGeminiReasoningRelay } from './gemini-reasoning-relay.mjs';
import {
  geminiFailureUsage,
  geminiIncompleteError,
  geminiSendResult,
  parseGeminiCandidate,
  resolveGeminiUsage,
} from './gemini-response.mjs';
import { emitGeminiToolCalls } from './gemini-schema.mjs';
import { geminiRestError } from './gemini.mjs';
import {
  ANTHROPIC_RETRY_BACKOFF_MS,
  ANTHROPIC_RETRY_JITTER_RATIO,
  anthropicMaxAttempts,
  canFallbackNonStreaming,
  emitProviderRetryStage,
  withRetry,
} from './retry-classifier.mjs';
import { buildAnthropicApiRequest } from './anthropic-api-request.mjs';
import { applyAnthropicErrorContract } from './anthropic-error-contract.mjs';
import { createAnthropicMidState, assertAnthropicStreamNotEmpty } from './anthropic-midstream-recovery.mjs';
import { parseSSEStream } from './anthropic-sse.mjs';
import { buildAnthropicTurnResult } from './anthropic-turn-result.mjs';
import { streamCallbacks } from './lib/send-callbacks.mjs';
import { preparePdfTextForProvider } from './media-normalization.mjs';
import { VERTEX_API_KEY_MODE, VertexAccessTokenManager } from './vertex-ai-auth.mjs';
import { VertexMaasRoute, toVertexExclusiveUsage, vertexErrorBody } from './vertex-ai-maas.mjs';
import {
  VERTEX_FLEX_TIER,
  claudeVersion,
  VERTEX_MODELS,
  VERTEX_MULTI_REGIONS,
  VERTEX_PRIORITY_TIER,
  assertVertexServing,
  vertexEnvLocation,
  vertexModelAccessError,
  vertexPricingModel,
  vertexRequestedTier,
  vertexRoute,
  vertexTierOption,
} from './vertex-ai-models.mjs';

export {
  VERTEX_FLEX_TIER,
  VERTEX_MODELS,
  VERTEX_PRIORITY_TIER,
  VERTEX_REGIONAL_PRICING_SUFFIX,
  VERTEX_SERVICE_TIER_PARAMETER,
} from './vertex-ai-models.mjs';

const VERTEX_ANTHROPIC_VERSION = 'vertex-2023-10-16';

// Vertex takes Anthropic betas in the body (`anthropic_beta`), never as a
// header, and only these (effort, fast mode, server fallback and the other
// first-party betas are not offered); tool search has its own name there.
const INTERLEAVED_THINKING_BETA = 'interleaved-thinking-2025-05-14';
const VERTEX_CLAUDE_BETAS = new Map([
  [INTERLEAVED_THINKING_BETA, INTERLEAVED_THINKING_BETA],
  ['advanced-tool-use-2025-11-20', 'tool-search-tool-2025-10-19'],
  ['context-1m-2025-08-07', 'context-1m-2025-08-07'],
  ['context-management-2025-06-27', 'context-management-2025-06-27'],
  ['compact-2026-01-12', 'compact-2026-01-12'],
]);

// Interleaved thinking needs the beta only for a manual thinking budget with
// tools on Claude 4+ (adaptive thinking interleaves on its own; 3.x has none).
function needsInterleavedThinking(body, model) {
  const version = claudeVersion(model);
  return body.thinking?.type === 'enabled' && Array.isArray(body.tools) && body.tools.length > 0 && !(version?.[0] < 4);
}

/** The Vertex names of the selected `betas` this request body needs. */
function vertexClaudeBetas(betas, body, model) {
  const out = new Set();
  for (const beta of betas || []) {
    const mapped = VERTEX_CLAUDE_BETAS.get(beta);
    if (!mapped || (mapped === INTERLEAVED_THINKING_BETA && !needsInterleavedThinking(body, model))) continue;
    out.add(mapped);
  }
  return [...out];
}

// Flex and Priority PayGo are selected per request with
// X-Vertex-AI-LLM-Shared-Request-Type (Provisioned Throughput is still used
// first when the project has it). The served tier is usageMetadata.trafficType:
// ON_DEMAND_FLEX, ON_DEMAND_PRIORITY, or ON_DEMAND for a Priority request
// downgraded to Standard PayGo (billed at Standard rates).
const SERVED_TIER = Object.freeze({
  ON_DEMAND_FLEX: VERTEX_FLEX_TIER,
  FLEX: VERTEX_FLEX_TIER,
  BATCH: VERTEX_FLEX_TIER,
  ON_DEMAND_PRIORITY: VERTEX_PRIORITY_TIER,
  ON_DEMAND: 'default',
});

// Multi-region locations are served by representative endpoints, not by
// <location>-aiplatform.googleapis.com.
function vertexHost(location) {
  if (location === 'global') return 'aiplatform.googleapis.com';
  if (VERTEX_MULTI_REGIONS.has(location)) return `aiplatform.${location}.rep.googleapis.com`;
  return `${location}-aiplatform.googleapis.com`;
}

// Express mode: an API key on the global endpoint, with no project or location in the path.
const EXPRESS_BASE = 'https://aiplatform.googleapis.com/v1';

/**
 * The request's location, and whether the user configured it (`pinned`):
 * without one, the environment's region (for a Claude model, its own first),
 * else global.
 */
function vertexLocation(config, claudeId = '') {
  const configured = String(config?.location || '').trim();
  const location = (configured || vertexEnvLocation(process.env, claudeId) || 'global').trim().toLowerCase();
  // The location names the host the bearer token is sent to: only a region
  // label (or global / a multi-region) may reach the host template.
  if (!/^[a-z][a-z0-9-]{0,62}$/.test(location)) throw new Error('[vertex-ai] location is invalid');
  return { location, pinned: Boolean(configured) };
}

function servesAt(route, location, tier) {
  try {
    assertVertexServing(route, location, tier);
    return true;
  } catch {
    return false;
  }
}

const isNotFound = (error) => [error?.status, error?.httpStatus, error?.response?.status].map(Number).includes(404);

function vertexProjectOverride(config) {
  const projectId = String(config?.projectId || '').trim();
  if (projectId && (!/^[a-zA-Z0-9._:-]{1,128}$/.test(projectId) || projectId.includes('/'))) {
    throw new Error('[vertex-ai] project ID override is invalid');
  }
  return projectId;
}

function geminiCallbacks(opts) {
  const reasoning = createGeminiReasoningRelay(opts);
  return {
    onStreamDelta: typeof opts.onStreamDelta === 'function' ? opts.onStreamDelta : null,
    onToolCall: typeof opts.onToolCall === 'function' ? opts.onToolCall : null,
    onTextDelta: typeof opts.onTextDelta === 'function' ? opts.onTextDelta : null,
    onReasoningDelta: reasoning.onReasoningDelta,
    retractReasoning: reasoning.retract,
  };
}

// Vertex rejects (400) functionCall.id / functionResponse.id, which the
// Gemini API request builder carries; calls pair by name and order here.
function withoutFunctionIds(contents) {
  const strip = (key, part) => {
    const { id: _id, ...rest } = part[key];
    return { ...part, [key]: rest };
  };
  return (contents || []).map((content) =>
    Array.isArray(content?.parts)
      ? {
          ...content,
          parts: content.parts.map((part) => {
            if (part?.functionCall && 'id' in part.functionCall) return strip('functionCall', part);
            if (part?.functionResponse && 'id' in part.functionResponse) return strip('functionResponse', part);
            return part;
          }),
        }
      : content
  );
}

function geminiVertexBody(request) {
  return {
    contents: withoutFunctionIds(request.contents),
    // Vertex accepts only a Content object here, never a bare string.
    ...(request.systemInstruction ? { systemInstruction: { parts: [{ text: request.systemInstruction }] } } : {}),
    ...(request.generationConfig ? { generationConfig: request.generationConfig } : {}),
    ...(request.geminiTools ? { tools: request.geminiTools } : {}),
    ...(request.toolConfig ? { toolConfig: request.toolConfig } : {}),
    ...(request.safetySettings ? { safetySettings: request.safetySettings } : {}),
  };
}

export class VertexAIProvider {
  static inputExcludesCache = true;
  nativePdf = true;
  name = 'vertex-ai';

  constructor(config = {}) {
    this.config = config;
    const customFetch = typeof config.fetchFn === 'function' ? config.fetchFn : null;
    this._fetch = customFetch ?? fetch;
    this._auth = new VertexAccessTokenManager({
      credentialResolver: () => resolveProviderApiKey('vertex-ai', this.config),
      authMode: () => this.config.authMode,
      fetchFn: this._fetch,
      now: typeof config.now === 'function' ? config.now : () => Date.now(),
    });
    this._maas = new VertexMaasRoute({
      name: this.name,
      config,
      auth: this._auth,
      fetchFn: customFetch,
    });
  }

  _projectId() {
    return vertexProjectOverride(this.config) || this._auth.projectId();
  }

  _express() {
    return this.config.authMode === VERTEX_API_KEY_MODE;
  }

  _expressKey() {
    const key = String(resolveProviderApiKey('vertex-ai', this.config) || '').trim();
    if (!key) throw new Error('[vertex-ai] the Vertex AI API key is not configured');
    return key;
  }

  /** `target`: the send's { identity, project } and the location it goes to. */
  _locationBase({ location, project }) {
    if (this._express()) return EXPRESS_BASE;
    return `https://${vertexHost(location)}/v1/projects/${encodeURIComponent(project)}/locations/${location}`;
  }

  _url(publisher, model, method, target) {
    // A version suffix (claude-…@default, @YYYYMMDD) stays a literal `@` in the path.
    const id = encodeURIComponent(model).replace(/%40/g, '@');
    return `${this._locationBase(target)}/publishers/${publisher}/models/${id}:${method}`;
  }

  /**
   * `identity` is the account `url` was built for, read in the same tick as
   * the URL before the first attempt; every attempt (retries included) must
   * still run as that account, so a switch in between aborts the request.
   * Express mode sends its API key instead (its URL names no project).
   */
  async _authorizedFetch(url, init, identity) {
    if (this._express()) {
      const headers = new Headers(init?.headers || {});
      headers.set('x-goog-api-key', this._expressKey());
      return await this._fetch(url, { ...init, headers, dispatcher: getLlmDispatcher() });
    }
    let token = '';
    const run = async () => {
      token = await this._auth.getAccessToken({ identity });
      this._auth.assertIdentity(identity);
      const headers = new Headers(init?.headers || {});
      headers.set('Authorization', `Bearer ${token}`);
      return await this._fetch(url, { ...init, headers, dispatcher: getLlmDispatcher() });
    };
    let response = await run();
    if (response.status === 401) {
      this._auth.invalidate(token);
      response = await run();
    }
    return response;
  }

  async send(messages, model, tools, sendOpts = {}) {
    const route = vertexRoute(model);
    const tier = vertexRequestedTier(sendOpts);
    const express = this._express();
    if (express && route.wire !== 'gemini') {
      throw new Error(
        `[vertex-ai] ${route.publisher}/${route.id} needs a service-account key or the gcloud login: ` +
          'a Vertex AI express mode API key serves Gemini models only'
      );
    }
    const requested = vertexLocation(this.config, route.wire === 'claude' ? route.id : '');
    const { pinned } = requested;
    if (express && pinned && requested.location !== 'global') {
      throw new Error(
        '[vertex-ai] a Vertex AI express mode API key serves only the global location; set the location to global'
      );
    }
    // A configured location is never moved. A region from the environment
    // gives way to global when it cannot serve the request (or for express mode).
    let location = express ? 'global' : requested.location;
    if (!pinned && location !== 'global' && !servesAt(route, location, tier) && servesAt(route, 'global', tier)) {
      location = 'global';
    }
    assertVertexServing(route, location, tier);
    await this._auth.ready();
    let result;
    try {
      // One account for the whole send, the region fallback included: its
      // identity and project are read in one tick, and every attempt (on any
      // location) must still run as it.
      const account = express
        ? { identity: null, project: '' }
        : { identity: this._auth.identity(), project: this._projectId() };
      const sendAt = (at) => {
        const target = { ...account, location: at };
        if (route.wire === 'gemini') return this._sendGemini(messages, route.id, tools, sendOpts, tier, target);
        if (route.wire === 'claude') return this._sendClaude(messages, route.id, tools, sendOpts, target);
        return this._sendMaas(messages, route, tools, sendOpts, target);
      };
      try {
        result = await sendAt(location);
      } catch (error) {
        // A region from the environment that does not have the model (404) is retried once on global.
        if (pinned || location === 'global' || !isNotFound(error) || !servesAt(route, 'global', tier)) throw error;
        location = 'global';
        result = await sendAt(location);
      }
    } catch (error) {
      let project = '(unknown project)';
      try {
        project = this._projectId();
      } catch {
        // No resolvable project: keep the placeholder; the original error is rethrown below.
      }
      throw this._auth.accessError(vertexModelAccessError(error, route, { project, location }), { project });
    }
    const pricingModel = vertexPricingModel(route, location);
    if (pricingModel && result && typeof result === 'object') result.pricingModel = pricingModel;
    return result;
  }

  async _sendMaas(messages, route, tools, opts, target) {
    // Built for the account it is sent with.
    const baseURL = `${this._locationBase(target)}/endpoints/openapi`;
    return await this._maas.send(messages, `${route.publisher}/${route.id}`, tools, opts, {
      baseURL,
      identity: target.identity,
    });
  }

  async _sendGemini(messages, model, tools, opts, tier, target) {
    const signal = opts.signal || null;
    const headers = {
      'Content-Type': 'application/json',
      ...(tier ? { 'X-Vertex-AI-LLM-Shared-Request-Type': tier } : {}),
    };
    const failureUsage = geminiFailureUsage(opts, null, model);
    const vertexFailureUsage = {
      ...failureUsage,
      normalize: (um) => toVertexExclusiveUsage(failureUsage.normalize(um)),
    };
    const callbacks = geminiCallbacks(opts);
    const request = buildGeminiRequest(messages, model, tools, opts, null);
    const body = geminiVertexBody(request);
    // One account for every attempt and the unary fallback: the send's.
    const { identity } = target;
    const streamUrl = `${this._url('google', model, 'streamGenerateContent', target)}?alt=sse`;
    const unaryUrl = this._url('google', model, 'generateContent', target);
    const stream = { ...request, opts, signal, useModel: model, tools, callbacks, cachedContent: null };
    try {
      opts.onStageChange?.('requesting');
    } catch {
      // A throwing progress callback must not fail the request.
    }
    // Every attempt sends the same tier; the served trafficType settles the price.
    noteRequestServiceTier(tier === VERTEX_PRIORITY_TIER ? tier : '');

    let outcome;
    try {
      outcome = await runGeminiStreamAttempts({
        signal,
        sleepFn: this.config.sleepFn,
        afterToolResult: geminiEndsWithFunctionResponse(request.contents),
        failureUsage: vertexFailureUsage,
        run: async ({ signal: attemptSignal, connected }) => {
          callbacks.retractReasoning();
          const res = await this._authorizedFetch(
            streamUrl,
            { method: 'POST', headers, body: JSON.stringify(body), signal: attemptSignal },
            identity
          );
          if (!res.ok) {
            const text = vertexErrorBody(await res.text().catch(() => ''));
            throw geminiRestError(res, text, 'Vertex AI Gemini streamGenerateContent');
          }
          connected();
          try {
            opts.onStageChange?.('streaming');
          } catch {
            // A throwing progress callback must not fail the request.
          }
          const textLeakGuard = geminiTextLeakGuardFor(stream);
          const response = await consumeGeminiRestStreamResponse(res, {
            signal: attemptSignal,
            onStreamDelta: callbacks.onStreamDelta,
            onTextDelta: callbacks.onTextDelta,
            onReasoningDelta: callbacks.onReasoningDelta,
            textLeakGuard,
            label: 'Vertex AI Gemini streamGenerateContent',
            failureUsage: vertexFailureUsage,
          });
          return { response, textLeakGuard };
        },
      });
    } catch (streamError) {
      if (!canFallbackNonStreaming(streamError, { signal })) throw streamError;
      callbacks.retractReasoning();
      const res = await this._authorizedFetch(
        unaryUrl,
        { method: 'POST', headers, body: JSON.stringify(body), signal },
        identity
      );
      if (!res.ok) {
        const text = vertexErrorBody(await res.text().catch(() => ''));
        throw geminiRestError(res, text, 'Vertex AI Gemini generateContent');
      }
      outcome = { response: await res.json(), textLeakGuard: null };
    }

    const parsed = parseGeminiCandidate(outcome.response, outcome.textLeakGuard);
    const usage = resolveGeminiUsage(outcome.response, opts, null, model, this.name);
    const incomplete = geminiIncompleteError(outcome.response, parsed, model, usage);
    if (incomplete) throw incomplete;
    outcome.textLeakGuard?.releaseDeferredToolCalls?.();
    emitGeminiToolCalls(parsed.nativeToolCalls, callbacks.onToolCall);
    const result = geminiSendResult(parsed, model, opts, toVertexExclusiveUsage(usage));
    // The served tier decides the price: a Flex or Priority request can be
    // served by Provisioned Throughput first, and a Priority one downgraded.
    const served = SERVED_TIER[usage?.raw?.trafficType];
    if (served) result.serviceTier = served;
    return result;
  }

  async _sendClaude(messages, model, tools, opts, target) {
    messages = sanitizeToolPairs(messages);
    messages = await preparePdfTextForProvider(messages, this);
    const requestOpts = { ...opts, fast: false, serverFallback: false };
    const { params, betas, knownToolNames } = await buildAnthropicApiRequest({
      name: this.name,
      config: { ...this.config, disableBetaHeaders: true },
      messages,
      useModel: model,
      tools,
      opts: requestOpts,
      fastModeLatched: false,
      capabilityModel: model,
    });
    const { model: _model, ...body } = params;
    body.anthropic_version = VERTEX_ANTHROPIC_VERSION;
    const vertexBetas = vertexClaudeBetas(betas, body, model);
    if (vertexBetas.length) body.anthropic_beta = vertexBetas;
    const callbacks = streamCallbacks(opts);
    try {
      callbacks.onStageChange?.('requesting');
    } catch {
      // A throwing progress callback must not fail the request.
    }
    // One account for every attempt: the send's.
    const { identity } = target;
    const url = this._url('anthropic', model, 'streamRawPredict', target);
    const payload = JSON.stringify(body);
    // The initial response retries like the first-party Anthropic route: 429
    // and 529 (and 5xx) on its backoff, Retry-After honored.
    const response = await withRetry(
      async ({ signal: attemptSignal }) => {
        const res = await this._authorizedFetch(
          url,
          { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payload, signal: attemptSignal },
          identity
        );
        if (res.ok) return res;
        const text = await res.text().catch(() => '');
        const error = Object.assign(
          new Error(`Vertex AI Claude streamRawPredict ${res.status}: ${text.slice(0, 300)}`),
          {
            status: res.status,
            httpStatus: res.status,
            headers: res.headers,
            response: { status: res.status, headers: res.headers },
            initialResponseError: true,
          }
        );
        throw applyAnthropicErrorContract(error, { status: res.status, headers: res.headers, bodyText: text });
      },
      {
        signal: opts.signal || null,
        maxAttempts: anthropicMaxAttempts(),
        backoffMs: ANTHROPIC_RETRY_BACKOFF_MS,
        retryJitterRatio: ANTHROPIC_RETRY_JITTER_RATIO,
        retryJitterMode: 'positive',
        recoveryOwner: 'vertex-ai-claude-initial-response',
        retry529: opts.retry529,
        sleepFn: this.config.sleepFn,
        onRetry: ({ attempt, maxAttempts, lastErr, delayMs }) =>
          emitProviderRetryStage(callbacks.onStageChange, { attempt: attempt + 1, maxAttempts, lastErr, delayMs }),
      }
    );
    try {
      callbacks.onStageChange?.('streaming');
    } catch {
      // A throwing progress callback must not fail the request.
    }
    const controller = new AbortController();
    const externalSignal = opts.signal || null;
    const abort = () => controller.abort(externalSignal?.reason);
    if (externalSignal) {
      if (externalSignal.aborted) abort();
      else externalSignal.addEventListener('abort', abort, { once: true });
    }
    const midState = createAnthropicMidState(0);
    try {
      const parsed = await parseSSEStream(
        response,
        controller.signal,
        (reason) => controller.abort(reason),
        callbacks.onStreamDelta,
        callbacks.onToolCall,
        midState,
        callbacks.onTextDelta,
        knownToolNames,
        { onStreamItemStart: callbacks.onStreamItemStart }
      );
      assertAnthropicStreamNotEmpty(midState, parsed, 'Vertex AI Claude');
      return buildAnthropicTurnResult(parsed, { provider: this.name, useModel: model, opts });
    } finally {
      externalSignal?.removeEventListener?.('abort', abort);
    }
  }

  async listModels() {
    return VERTEX_MODELS.map((model) => {
      const tierOption = vertexTierOption(model.id);
      return { ...model, provider: this.name, ...(tierOption ? { modelParameterOptions: [tierOption] } : {}) };
    });
  }

  async isAvailable() {
    try {
      if (this._express()) return Boolean(this._expressKey());
      await this._auth.ready();
      return Boolean(this._projectId());
    } catch {
      return false;
    }
  }
}
