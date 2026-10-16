/**
 * OpenCode Go's Gemini route: `@ai-sdk/google` models are served by the
 * gateway's generateContent endpoint, `{base}/models/{id}:streamGenerateContent`
 * (https://opencode.ai/docs/go/ — Endpoints table). This engine reuses the
 * direct Gemini adapter's request builder, stream consumer, retry ladder and
 * result shaping, and only moves the transport onto the gateway: the Go key
 * (never GEMINI_API_KEY) goes to the Go origin only, as a bearer token and the
 * `x-goog-api-key` header, with the session / User-Agent headers of every Go
 * request. Gateway models have no explicit cachedContents.
 */
import { GeminiProvider, geminiRestError } from './gemini.mjs';
import { GEMINI_FIRST_BYTE_TIMEOUT_MS, consumeGeminiRestStreamResponse } from './gemini-stream.mjs';
import { geminiBareModelId } from './gemini-cache-policy.mjs';
import { geminiFailureUsage } from './gemini-response.mjs';
import { geminiEndsWithFunctionResponse, runGeminiStreamAttempts } from './gemini-retry-policy.mjs';
import { geminiTextLeakGuardFor } from './gemini-sdk-request.mjs';
import { emitProviderRetryStage } from './retry-classifier.mjs';
import { originBoundFetch } from './lib/origin-bound-fetch.mjs';
import { createPassthroughSignal, createTimeoutSignal } from '../stall-policy.mjs';
import { getLlmDispatcher } from '../../../shared/llm/http-agent.mjs';
import { reloadProviderApiKey, resolveProviderApiKey } from '../../../shared/provider-api-key.mjs';

const PROVIDER = 'opencode-go';

/** The generateContent request body for a built Gemini request. */
export function openCodeGoGeminiBody({
  contents,
  systemInstruction,
  geminiTools,
  toolConfig,
  generationConfig,
  safetySettings,
}) {
  return {
    contents,
    ...(systemInstruction ? { systemInstruction: { parts: [{ text: systemInstruction }] } } : {}),
    ...(geminiTools ? { tools: geminiTools } : {}),
    ...(toolConfig ? { toolConfig } : {}),
    ...(generationConfig ? { generationConfig } : {}),
    ...(safetySettings ? { safetySettings } : {}),
  };
}

export class OpenCodeGoGeminiEngine extends GeminiProvider {
  name = PROVIDER;

  /** @param {object} config  the Go provider config; `baseURL` is the OpenAI-style `.../v1` base */
  constructor(config) {
    const base = String(config.baseURL || '').replace(/\/+$/, '');
    super({
      ...config,
      fetchFn: originBoundFetch(new URL(base).origin, config.fetchImpl, PROVIDER),
      // No Google host to warm and no Google SDK client: this engine never uses either.
      preconnectFn: () => {},
      createGenAI: () => null,
    });
    this.gatewayBase = base;
  }

  _getApiKey() {
    return resolveProviderApiKey(PROVIDER, this.config);
  }

  reloadApiKey() {
    const key = reloadProviderApiKey(PROVIDER, this.config);
    if (key) this.config = { ...(this.config || {}), apiKey: key };
    return key || '';
  }

  async isAvailable() {
    return Boolean(this._getApiKey());
  }

  // The gateway has no cachedContents resource.
  async _ensureGeminiCache() {
    return null;
  }

  _headers(opts) {
    const key = this._getApiKey();
    return {
      'Content-Type': 'application/json',
      ...(key ? { Authorization: `Bearer ${key}`, 'x-goog-api-key': key } : {}),
      ...(this.config?.extraHeaders || {}),
      ...(opts?.requestHeaders || {}),
    };
  }

  _url(model, method) {
    return `${this.gatewayBase}/models/${encodeURIComponent(geminiBareModelId(model))}:${method}`;
  }

  async _openGatewayStream(url, body, opts, attemptSignal) {
    const openFirstByte = createTimeoutSignal(
      attemptSignal,
      GEMINI_FIRST_BYTE_TIMEOUT_MS,
      'OpenCode Go Gemini first byte'
    );
    let res;
    try {
      res = await this._fetch(url, {
        method: 'POST',
        headers: this._headers(opts),
        body: JSON.stringify(body),
        signal: openFirstByte.signal,
        dispatcher: getLlmDispatcher(),
      });
    } finally {
      openFirstByte.cleanup();
    }
    if (!res.ok) {
      throw geminiRestError(res, await res.text().catch(() => ''), 'OpenCode Go Gemini streamGenerateContent');
    }
    return res;
  }

  async _generateContent(model, body, opts, signal) {
    const res = await this._fetch(this._url(model, 'generateContent'), {
      method: 'POST',
      headers: this._headers(opts),
      body: JSON.stringify(body),
      signal,
      dispatcher: getLlmDispatcher(),
    });
    if (!res.ok) {
      throw geminiRestError(res, await res.text().catch(() => ''), 'OpenCode Go Gemini generateContent');
    }
    return await res.json();
  }

  async _streamViaSdk(stream) {
    const { opts, signal, useModel, contents, callbacks } = stream;
    const body = openCodeGoGeminiBody(stream);
    const url = `${this._url(useModel, 'streamGenerateContent')}?alt=sse`;
    const passthrough = createPassthroughSignal(signal);
    try {
      return await runGeminiStreamAttempts({
        signal: passthrough.signal,
        sleepFn: this.config?.sleepFn,
        onRetry: ({ attempt, maxAttempts, lastErr, delayMs }) => {
          emitProviderRetryStage(opts.onStageChange, { attempt: attempt + 1, maxAttempts, lastErr, delayMs });
          process.stderr.write(
            `[opencode-go:gemini] retry attempt ${attempt + 1} after ${lastErr?.message || lastErr?.code || 'transient error'}\n`
          );
        },
        afterToolResult: geminiEndsWithFunctionResponse(contents),
        run: async ({ signal: attemptSignal, connected }) => {
          try {
            opts.onStageChange?.('requesting');
          } catch {
            /* heartbeat best-effort */
          }
          const res = await this._openGatewayStream(url, body, opts, attemptSignal);
          connected();
          const textLeakGuard = geminiTextLeakGuardFor(stream);
          const response = await consumeGeminiRestStreamResponse(res, {
            signal: attemptSignal,
            onStreamDelta: callbacks.onStreamDelta,
            onTextDelta: callbacks.onTextDelta,
            textLeakGuard,
            label: 'OpenCode Go Gemini streamGenerateContent',
            failureUsage: geminiFailureUsage(opts, null, useModel),
          });
          return { response, textLeakGuard };
        },
      });
    } catch (err) {
      const recovered = await this._recoverGeminiNonStreaming({
        streamErr: err,
        signal: passthrough.signal,
        opts,
        model: useModel,
        generate: (fallbackSignal) => this._generateContent(useModel, body, opts, fallbackSignal),
      });
      if (!recovered) throw err;
      return { response: recovered, textLeakGuard: null };
    } finally {
      passthrough.cleanup();
    }
  }
}
