import { getAgentApiKey } from '../../../shared/provider-api-key.mjs';
import { sanitizeToolPairs } from '../session/context-utils.mjs';
import { AnthropicFallbackTriggeredError } from './retry-classifier.mjs';
import { readStreamOutcome } from './lib/stream-outcome.mjs';
import { createPassthroughSignal } from '../stall-policy.mjs';
import { createAbortController } from '../../../shared/abort-controller.mjs';
import { ANTHROPIC_MAX_MIDSTREAM_RETRIES, parseSSEStream } from './anthropic-sse.mjs';
import { buildAnthropicBetaHeaders } from './anthropic-betas.mjs';
import { buildAnthropicApiRequest } from './anthropic-api-request.mjs';
import { armFirstByteWatchdog, createAnthropicApiTransport } from './anthropic-api-transport.mjs';
import { createAnthropicApiRecovery } from './anthropic-api-recovery.mjs';
import { buildAnthropicTurnResult } from './anthropic-turn-result.mjs';
import {
  assertAnthropicStreamNotEmpty,
  createAnthropicMidState,
  createAnthropicMidstreamRecovery,
} from './anthropic-midstream-recovery.mjs';
import { enrichModels } from './model-catalog.mjs';
import { sanitizeModelList } from './model-list-sanitize.mjs';
import { getLlmDispatcher } from '../../../shared/llm/http-agent.mjs';

import {
  loadAnthropic,
  MODELS,
  ANTHROPIC_VERSION,
  _normalizeAnthropicModel,
  _setApiKeyCatalogMirror,
} from './anthropic-messages.mjs';
export { _test, _toAnthropicMessagesForTest } from './anthropic-messages.mjs';

export class AnthropicProvider {
  // Anthropic reports usage.input_tokens EXCLUDING cache_read/cache_creation
  // (those are separate fields), so the live context-window footprint must
  // add cache_read back. See providerInputExcludesCache() in registry.mjs.
  static inputExcludesCache = true;
  name = 'anthropic';
  client;
  config;
  apiKey;
  fastModeBetaHeaderLatched = false;
  constructor(config) {
    this.config = config || {};
    this.name = this.config.name || 'anthropic';
    this.apiKey = this.config.apiKey || (this.name === 'anthropic' ? process.env.ANTHROPIC_API_KEY : null);
    this.client = this._createClient(this.apiKey);
  }
  // Tool-search is a request capability, not an account capability. Keep it
  // off the client defaults and add it only on turns that actually serialize
  // defer_loading tools.
  _createClient(apiKey) {
    const betaHeaders = this.config.disableBetaHeaders ? null : buildAnthropicBetaHeaders();
    return new (loadAnthropic())({
      apiKey,
      ...(this.config.baseURL ? { baseURL: this.config.baseURL } : {}),
      defaultHeaders: {
        ...(betaHeaders ? { 'anthropic-beta': betaHeaders } : {}),
        ...(this.config.extraHeaders || {}),
      },
      maxRetries: 0,
    });
  }
  reloadApiKey() {
    try {
      const newKey =
        getAgentApiKey(this.name) ||
        this.config.apiKey ||
        (this.name === 'anthropic' ? process.env.ANTHROPIC_API_KEY : null);
      if (newKey) {
        this.config = { ...(this.config || {}), apiKey: newKey };
        this.apiKey = newKey;
        this.client = this._createClient(newKey);
      }
    } catch {
      /* best effort */
    }
  }
  async send(messages, model, tools, sendOpts) {
    // Defense-in-depth: enforce tool_use / tool_result pairing before
    // the Anthropic API call. Mirror of the OAuth path; loop.mjs only
    // runs sanitizeToolPairs when budget is exceeded, so an under-budget
    // dispatch with an aborted-mid-flight tool_use would otherwise hit
    // the provider as a hard 400 (`tool_use ids ... without tool_result`).
    messages = sanitizeToolPairs(messages);
    try {
      return await this._doSend(messages, model, tools, sendOpts);
    } catch (err) {
      const status = Number(err?.status || err?.httpStatus || err?.response?.status || 0);
      // Auth recovery re-issues the whole turn, so it is a REPLAY: a
      // typed 401 is re-sent once after reloading the key, unless the
      // failure already exposed output or dispatched a tool call.
      const replayPermitted = readStreamOutcome(err).replaySafe === true;
      if (status === 401 && replayPermitted) {
        process.stderr.write(`[provider] Auth error, re-reading provider authentication...\n`);
        this.reloadApiKey();
        return await this._doSend(messages, model, tools, sendOpts);
      }
      throw err;
    }
  }
  async _doSend(messages, model, tools, sendOpts) {
    if (!model) throw new Error(`[${this.name}] model is required — pass it from the caller preset`);
    const useModel = model;
    const opts = sendOpts || {};
    // Wire request (system/cache layout, tools, effort, fast mode, images)
    // and the per-request beta headers derived from that final body —
    // anthropic-api-request.mjs. Fast mode latches on the provider instance.
    const { params, requestHeaders, knownToolNames, fastModeLatched } = await buildAnthropicApiRequest({
      name: this.name,
      config: this.config,
      messages,
      useModel,
      tools,
      opts,
      fastModeLatched: this.fastModeBetaHeaderLatched,
    });
    this.fastModeBetaHeaderLatched = fastModeLatched;

    const onStageChange = typeof opts.onStageChange === 'function' ? opts.onStageChange : null;
    const onStreamDelta = typeof opts.onStreamDelta === 'function' ? opts.onStreamDelta : null;
    const onToolCall = typeof opts.onToolCall === 'function' ? opts.onToolCall : null;
    const onTextDelta = typeof opts.onTextDelta === 'function' ? opts.onTextDelta : null;
    const onTextReset = typeof opts.onTextReset === 'function' ? opts.onTextReset : null;

    // No absolute wall-clock cap on streaming generation: a stream still
    // emitting SSE deltas must not be killed by a fixed total-lifetime timer.
    // Mirrors the OAuth provider (Option A). Bounded instead by the
    // per-attempt first-byte/HTTP-response timeout, the SSE idle watchdog,
    // the agent stall watchdog, and externalSignal (client disconnect /
    // replaced-by-newer-request). totalSignal is a pure pass-through.
    const externalSignal = opts.signal || null;
    const totalTimeout = createPassthroughSignal(externalSignal);
    const totalSignal = totalTimeout.signal;

    const cleanupCancelHandler = (handler) => {
      if (!handler) return;
      try {
        totalSignal.removeEventListener('abort', handler);
      } catch {}
    };

    // The SDK calls and their initial-response retry policy
    // (anthropic-api-transport.mjs).
    const transport = createAnthropicApiTransport({
      client: this.client,
      label: this.name,
      opts,
      useModel,
      params,
      requestHeaders,
      totalSignal,
    });
    // Usage accounting + caller-visible projection, shared by the streaming
    // success path and the non-streaming fallback (anthropic-turn-result.mjs).
    const buildTurnResult = (parseResult) =>
      buildAnthropicTurnResult(parseResult, { provider: this.name, useModel, opts });
    // Non-streaming re-issue of a dead stream, behind the transport-recovery
    // budget and the exposed-output retraction handshake
    // (anthropic-api-recovery.mjs).
    const recovery = createAnthropicApiRecovery({
      label: this.name,
      opts,
      useModel,
      params,
      totalSignal,
      transport,
      buildTurnResult,
      onStageChange,
      onTextReset,
    });
    // Bounded mid-stream retries for transient stream loss; jittered backoff
    // between attempts (anthropic-midstream-recovery.mjs, shared with
    // anthropic-oauth).
    const midstream = createAnthropicMidstreamRecovery({
      label: this.name,
      outcomeProvider: 'anthropic',
      midstreamOwner: `${this.name}-midstream`,
      unreachableMessage: 'Anthropic mid-stream retry: unreachable',
      // The transport's withRetry already exhausted the full request-level
      // budget for a non-OK initial response, so it must not earn an
      // additional SSE retry budget here.
      initialResponseErrorTerminal: true,
      maxRetries: ANTHROPIC_MAX_MIDSTREAM_RETRIES,
      totalSignal,
      recovery,
    });

    try {
      for (let attemptIndex = 0; attemptIndex <= ANTHROPIC_MAX_MIDSTREAM_RETRIES; attemptIndex++) {
        const streamController = createAbortController();
        let cancelHandler = null;

        if (totalSignal) {
          if (totalSignal.aborted) {
            const reason = totalSignal.reason;
            throw reason instanceof Error ? reason : new Error('Anthropic request aborted');
          }
          cancelHandler = () => {
            try {
              streamController.abort(totalSignal.reason);
            } catch {}
          };
          totalSignal.addEventListener('abort', cancelHandler, { once: true });
        }

        const midState = createAnthropicMidState(attemptIndex);

        let firstByte = null;
        let response = null;

        try {
          try {
            onStageChange?.('requesting');
          } catch {}

          response = await transport.requestStreamingResponse();

          try {
            onStageChange?.('streaming');
          } catch {}

          firstByte = armFirstByteWatchdog(streamController, midState);

          const parseResult = await parseSSEStream(
            response,
            streamController.signal,
            (reason) => streamController.abort(reason),
            onStreamDelta,
            onToolCall,
            midState,
            onTextDelta,
            knownToolNames,
            { relayProgressUpdates: params.thinking?.display === 'updates' }
          );
          try {
            streamController.abort?.('Anthropic SSE complete');
          } catch {}

          firstByte.cleanup();
          assertAnthropicStreamNotEmpty(midState, parseResult, 'Anthropic');

          return buildTurnResult(parseResult);
        } catch (err) {
          if (err instanceof AnthropicFallbackTriggeredError) {
            process.stderr.write(`[${this.name}] ${err.message}\n`);
            return this._doSend(messages, err.fallbackModel, tools, {
              ...opts,
              fallbackModel: undefined,
              _fallbackTriggered: true,
            });
          }
          // Ordered recovery ladder: canonical outcome stamp, acknowledged
          // non-streaming replay for exposed output, bounded streaming
          // retries, silent-stall fallback, classifier-driven retries.
          const decision = await midstream.onStreamError({
            err,
            midState,
            controller: streamController,
            response,
            attemptIndex,
          });
          if (decision.retry) continue;
          return decision.value;
        } finally {
          firstByte?.cleanup();
          cleanupCancelHandler(cancelHandler);
        }
      }
      throw midstream.exhaustedError();
    } finally {
      totalTimeout.cleanup();
    }
  }
  async listModels() {
    const apiKey =
      this.apiKey || this.config?.apiKey || (this.name === 'anthropic' ? process.env.ANTHROPIC_API_KEY : null);
    if (!apiKey) return MODELS;
    try {
      const base = String(this.config?.baseURL || 'https://api.anthropic.com').replace(/\/+$/, '');
      const res = await fetch(`${base}/v1/models`, {
        signal: AbortSignal.timeout(10_000),
        method: 'GET',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': ANTHROPIC_VERSION,
          ...(this.config?.extraHeaders || {}),
        },
        dispatcher: getLlmDispatcher(),
      });
      if (!res.ok) throw new Error(`list_models ${res.status}`);
      const data = await res.json();
      const items = Array.isArray(data?.data) ? data.data : [];
      const normalized = items.map((m) => _normalizeAnthropicModel(m, this.name)).filter(Boolean);
      const enriched = sanitizeModelList(await enrichModels(normalized), { provider: this.name });
      // Feed the resolver-visible mirror so API-key-only installs get
      // catalog outputTokens without depending on the OAuth disk cache.
      if (enriched.length) _setApiKeyCatalogMirror(enriched.slice());
      return enriched.length ? enriched : MODELS;
    } catch (err) {
      if (!process.env.MIXDOG_QUIET_PROVIDER_LOG)
        process.stderr.write(`[${this.name}] listModels fetch failed (${err.message})\n`);
      return MODELS;
    }
  }
  async isAvailable() {
    // Availability probes must not spend tokens or depend on a live
    // network. Dispatch owns authentication validation and 401 reload.
    return !!(this.apiKey || this.config?.apiKey || (this.name === 'anthropic' && process.env.ANTHROPIC_API_KEY));
  }
}
