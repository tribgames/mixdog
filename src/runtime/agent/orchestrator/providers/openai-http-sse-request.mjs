/**
 * openai-http-sse-request.mjs — the initial POST of the HTTP/SSE fallback:
 * request-body zstd gating, bounded retries of the initial request, and the
 * admission checks on the response (status, turn-state header, body).
 *
 * Returns an OK response whose body is ready to stream; every failure path
 * throws with the initial-response markers the retry classifier reads.
 */
import { promisify } from 'node:util';
import zlib from 'node:zlib';
import {
  REQ_COMPRESSION_MIN_BYTES,
  compressBody,
  createCompressionLatch,
  hasContentEncoding,
  resendIfEncodingRejected,
  withContentEncoding,
} from './lib/request-compression.mjs';
import { traceAgentFetch } from '../agent-trace.mjs';
import { PROVIDER_HTTP_RESPONSE_TIMEOUT_MS, createTimeoutSignal } from '../stall-policy.mjs';
import { CODEX_REQUEST_RETRY_BACKOFF_MS, CODEX_RETRY_JITTER_RATIO } from './openai-retry-policy.mjs';
import { classifyError, jitterDelayMs, retryAfterMsFromError, sleepWithAbort } from './retry-classifier.mjs';
import { emitProviderRetryStage } from './retry-executor.mjs';
import { adviceGatedRetry } from './retry-midstream.mjs';
import { TERMINAL_EDGE_STATUSES } from './retry-classification.mjs';
import { DETERMINISTIC_KINDS, providerErrorKind } from './provider-error-kind.mjs';
import { readStreamOutcome } from './lib/stream-outcome.mjs';
import { getLlmDispatcher, recycleLlmDispatcher } from '../../../shared/llm/http-agent.mjs';
import { CODEX_RESPONSES_URL } from './openai-codex-endpoints.mjs';
import { captureCodexTurnState } from './openai-turn-state.mjs';
import { httpLabel, httpResponseError } from './openai-error-contract.mjs';

// Public OpenAI Responses API endpoint for the api-key `openai` provider.
// The openai-direct WS transport hits the same origin (openai-ws-pool
// OPENAI_WS_URL = wss://api.openai.com/v1/responses); this HTTP/SSE fallback
// mirrors it so OpenAIDirectProvider can fall back off WebSocket like
// openai-oauth. Same Responses SSE wire format, only endpoint + auth differ.
const OPENAI_DIRECT_RESPONSES_URL = 'https://api.openai.com/v1/responses';
const CODEX_REQUEST_MAX_RETRIES = 4;
// Advice-gated retry for the OpenAI request loops (same options the shared
// withRetry takes): an overload and an untyped 429 retry only with server advice.
const OPENAI_REQUEST_RETRY_OPTS = Object.freeze({
  overloadRetryRequiresAdvice: true,
  generic429RetryRequiresAdvice: true,
  backoffMs: CODEX_REQUEST_RETRY_BACKOFF_MS,
  retryJitterRatio: CODEX_RETRY_JITTER_RATIO,
});

// Request-layer retry: 5xx and typed transport
// failures only. 408 and 429 are NOT retried here; they surface to the outer
// stream-retry layer, which owns their budget and honors Retry-After.
// A deterministic refusal (quota, billing, entitlement, policy, auth,
// permission, invalid request) is terminal whatever status carries it.
function isRetryableHttpFailure(err) {
  const status = err.httpStatus;
  if (!(status >= 500 && status <= 599) || TERMINAL_EDGE_STATUSES.has(status)) return false;
  const { kind } = providerErrorKind(err);
  if (DETERMINISTIC_KINDS.has(kind)) return false;
  return adviceGatedRetry(err, OPENAI_REQUEST_RETRY_OPTS) !== false;
}
// Request-body zstd gate. Namespace import: on Node runtimes without zlib
// zstd bindings the named export would fail at module load, so the call site
// typeof-guards zlib.zstdCompress instead.
const _openaiReqZstdLatch = createCompressionLatch('MIXDOG_OPENAI_REQ_ZSTD');
export const _resetOpenaiReqZstdLatchForTest = _openaiReqZstdLatch.reset;

// Request-body zstd: compression is enabled for the codex backend on the
// OpenAI provider — the server decompresses Content-Encoding: zstd.
// openai-direct is excluded: only the codex backend is verified. Compression
// runs on the libuv threadpool (zlib.zstdCompress, promisified) so it never
// blocks the main thread; runtimes without the async zstd binding send plain.
// Env kill-switch; the 400/415 resend + latch policy is shared
// (lib/request-compression.mjs).
async function encodeRequestBody(auth, headers, rawBytes) {
  const plain = { bytes: rawBytes, encoding: null };
  if (
    auth?.type === 'openai-direct' ||
    _openaiReqZstdLatch.disabled() ||
    typeof zlib.zstdCompress !== 'function' ||
    rawBytes.length < REQ_COMPRESSION_MIN_BYTES ||
    hasContentEncoding(headers)
  ) {
    return plain;
  }
  return compressBody(rawBytes, promisify(zlib.zstdCompress), 'zstd');
}

async function postWithRetries({
  responsesUrl,
  headers,
  rawBytes,
  auth,
  fetchFn,
  externalSignal,
  totalTimeout,
  onStageChange,
  _sleepFn,
}) {
  const label = httpLabel(auth);
  const bodyForSend = await encodeRequestBody(auth, headers, rawBytes);
  const fetchOnce = async (bytes, sendHeaders) => {
    const headerTimeout = createTimeoutSignal(
      totalTimeout.signal,
      PROVIDER_HTTP_RESPONSE_TIMEOUT_MS,
      `${label} initial response`
    );
    try {
      return await fetchFn(responsesUrl, {
        method: 'POST',
        headers: sendHeaders,
        body: bytes,
        signal: headerTimeout.signal,
        dispatcher: getLlmDispatcher(),
      });
    } catch (err) {
      throw headerTimeout.signal?.aborted && headerTimeout.signal.reason instanceof Error
        ? headerTimeout.signal.reason
        : err;
    } finally {
      headerTimeout.cleanup();
    }
  };
  let response;
  let httpError = null;
  for (let attempt = 0; attempt <= CODEX_REQUEST_MAX_RETRIES; attempt++) {
    let requestError = null;
    try {
      // Keep the established stage name for consumers, while making each
      // bounded retry an observable liveness heartbeat. Session runtime
      // liveness updates lastProgressAt for every stage callback,
      // including a repeated `requesting` stage.
      try {
        onStageChange?.('requesting', {
          attempt: attempt + 1,
          maxAttempts: CODEX_REQUEST_MAX_RETRIES + 1,
          retry: attempt > 0,
        });
      } catch {}
      response = bodyForSend.encoding
        ? await fetchOnce(bodyForSend.bytes, withContentEncoding(headers, bodyForSend.encoding))
        : await fetchOnce(rawBytes, headers);
      // Encoding rejection (400/415): resent uncompressed inside this attempt,
      // so it never consumes a retry; the latch flips only if that succeeds.
      response = await resendIfEncodingRejected({
        response,
        encoded: Boolean(bodyForSend.encoding),
        resend: () => fetchOnce(rawBytes, headers),
        latch: _openaiReqZstdLatch,
      });
    } catch (err) {
      response = undefined;
      requestError = err;
    }
    // The error body is read exactly once, here, into the contract fields.
    httpError = null;
    if (response && !response.ok) {
      const text = await response.text().catch(() => '');
      httpError = httpResponseError({
        label,
        status: response.status,
        headers: response.headers,
        text,
        initialResponse: true,
      });
    }
    const retryableStatus = httpError !== null && isRetryableHttpFailure(httpError);
    // Typed transient transport failures only (errno / SDK connection
    // type). An unknown pre-response failure throws immediately instead of
    // re-issuing the POST.
    const retryableTransport =
      !response &&
      requestError &&
      classifyError(requestError) === 'transient' &&
      !externalSignal?.aborted &&
      !totalTimeout.signal?.aborted;
    if (attempt < CODEX_REQUEST_MAX_RETRIES && (retryableStatus || retryableTransport)) {
      if (retryableTransport) {
        const code = String(requestError.code || requestError.cause?.code || '');
        if (code === 'ECONNRESET' || code === 'EPIPE' || code === 'UND_ERR_SOCKET') {
          try {
            recycleLlmDispatcher();
          } catch {}
        }
      }
      // Reissuing the POST is a REPLAY: allowed for a typed transient
      // failure of the initial request, denied once the failure carries
      // exposure evidence (relayed output / dispatched tool call).
      const attemptFailure = requestError || httpError;
      if (readStreamOutcome(attemptFailure).replaySafe !== true) {
        totalTimeout.cleanup();
        throw attemptFailure;
      }
      // Server advice (Retry-After / Retry-After-Ms) replaces the local curve.
      // Uncapped for retryable errors; the attempt count is
      // the bound, and the abort signal cancels the wait.
      // The shared schedule carries a leading duplicate (withRetry convention).
      const raw = OPENAI_REQUEST_RETRY_OPTS.backoffMs[attempt + 1];
      const delayMs =
        retryAfterMsFromError(attemptFailure) ?? jitterDelayMs(raw, OPENAI_REQUEST_RETRY_OPTS.retryJitterRatio);
      emitProviderRetryStage(onStageChange, {
        attempt: attempt + 2,
        maxAttempts: CODEX_REQUEST_MAX_RETRIES + 1,
        lastErr: attemptFailure,
        delayMs,
      });
      try {
        await sleepWithAbort(
          delayMs,
          externalSignal || totalTimeout.signal,
          _sleepFn,
          `${label} request retry backoff aborted`
        );
      } catch (abortErr) {
        totalTimeout.cleanup();
        throw abortErr;
      }
      response = undefined;
      httpError = null;
      continue;
    }
    if (requestError) {
      totalTimeout.cleanup();
      // The initial response never arrived: nothing was sampled, so the
      // typed rules upstream decide whether to retry.
      throw requestError;
    }
    break;
  }
  return { response, httpError };
}

export async function openHttpSseResponse({
  auth,
  body,
  headers,
  poolKey,
  turnId,
  useModel,
  fetchFn,
  externalSignal,
  totalTimeout,
  onStageChange,
  _sleepFn,
}) {
  const fetchStartedAt = Date.now();
  const responsesUrl = auth?.type === 'openai-direct' ? OPENAI_DIRECT_RESPONSES_URL : CODEX_RESPONSES_URL;
  const { response, httpError } = await postWithRetries({
    responsesUrl,
    headers,
    rawBytes: Buffer.from(JSON.stringify(body)),
    auth,
    fetchFn,
    externalSignal,
    totalTimeout,
    onStageChange,
    _sleepFn,
  });

  traceAgentFetch({
    sessionId: poolKey,
    headersMs: Date.now() - fetchStartedAt,
    httpStatus: response.status,
    provider: 'openai-oauth',
    model: useModel,
    transport: 'http',
  });

  if (httpError) {
    totalTimeout.cleanup();
    throw httpError;
  }
  if (auth?.type !== 'openai-direct') {
    const responseTurnState = response.headers?.get?.('x-codex-turn-state');
    if (responseTurnState) captureCodexTurnState(poolKey, turnId, responseTurnState);
  }
  if (!response.body) {
    totalTimeout.cleanup();
    throw Object.assign(new Error(`${httpLabel(auth)} returned no response body`), {
      initialResponseError: true,
    });
  }
  return response;
}
