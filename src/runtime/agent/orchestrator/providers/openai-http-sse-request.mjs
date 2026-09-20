/**
 * openai-http-sse-request.mjs — the initial POST of the HTTP/SSE fallback:
 * request-body zstd gating, bounded retries of the initial request, and the
 * admission checks on the response (status, turn-state header, body).
 *
 * Returns an OK response whose body is ready to stream; every failure path
 * throws with the initial-response markers the retry classifier reads.
 */
import zlib from 'node:zlib';
import { traceAgentFetch } from '../agent-trace.mjs';
import { PROVIDER_HTTP_RESPONSE_TIMEOUT_MS, createTimeoutSignal } from '../stall-policy.mjs';
import { classifyError, jitterDelayMs, sleepWithAbort } from './retry-classifier.mjs';
import { readStreamOutcome } from './lib/stream-outcome.mjs';
import { getLlmDispatcher, recycleLlmDispatcher } from '../../../shared/llm/http-agent.mjs';
import { CODEX_RESPONSES_URL } from './openai-codex-endpoints.mjs';
import { captureCodexTurnState } from './openai-turn-state.mjs';

// Public OpenAI Responses API endpoint for the api-key `openai` provider.
// The openai-direct WS transport hits the same origin (openai-ws-pool
// OPENAI_WS_URL = wss://api.openai.com/v1/responses); this HTTP/SSE fallback
// mirrors it so OpenAIDirectProvider can fall back off WebSocket like
// openai-oauth. Same Responses SSE wire format, only endpoint + auth differ.
const OPENAI_DIRECT_RESPONSES_URL = 'https://api.openai.com/v1/responses';
const CODEX_REQUEST_MAX_RETRIES = 4;
const CODEX_REQUEST_BACKOFF_MS = Object.freeze([200, 400, 800, 1600]);
const CODEX_RETRY_JITTER_RATIO = 0.1;

// Request-body zstd gate. Namespace import: on Node runtimes without zlib
// zstd bindings the named export would fail at module load, so the call site
// typeof-guards zlib.zstdCompressSync instead.
const OPENAI_REQ_ZSTD_MIN_BYTES = 8 * 1024;
let _openaiReqZstdLatch = false;
function _openaiReqZstdDisabled() {
  return _openaiReqZstdLatch || process.env.MIXDOG_OPENAI_REQ_ZSTD === '0';
}
function _disableOpenaiReqZstd() {
  _openaiReqZstdLatch = true;
}
function _zstdHeaders(headers, bodyForSend) {
  return bodyForSend.encoding ? { ...headers, 'Content-Encoding': bodyForSend.encoding } : headers;
}

// Request-body zstd: compression is enabled for the codex backend on the
// OpenAI provider — the server decompresses Content-Encoding: zstd.
// openai-direct is excluded: only the codex backend is verified. Env
// kill-switch plus a process-wide latch flipped on the first 400 seen on
// a compressed request, which then replays that attempt uncompressed.
function encodeRequestBody(auth, rawBytes) {
  return auth?.type !== 'openai-direct' &&
    !_openaiReqZstdDisabled() &&
    typeof zlib.zstdCompressSync === 'function' &&
    rawBytes.length >= OPENAI_REQ_ZSTD_MIN_BYTES
    ? { bytes: zlib.zstdCompressSync(rawBytes), encoding: 'zstd' }
    : { bytes: rawBytes, encoding: null };
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
  let bodyForSend = encodeRequestBody(auth, rawBytes);
  let response;
  for (let attempt = 0; attempt <= CODEX_REQUEST_MAX_RETRIES; attempt++) {
    const headerTimeout = createTimeoutSignal(
      totalTimeout.signal,
      PROVIDER_HTTP_RESPONSE_TIMEOUT_MS,
      'OpenAI OAuth HTTP fallback initial response'
    );
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
      response = await fetchFn(responsesUrl, {
        method: 'POST',
        headers: _zstdHeaders(headers, bodyForSend),
        body: bodyForSend.bytes,
        signal: headerTimeout.signal,
        dispatcher: getLlmDispatcher(),
      });
    } catch (err) {
      requestError =
        headerTimeout.signal?.aborted && headerTimeout.signal.reason instanceof Error
          ? headerTimeout.signal.reason
          : err;
    } finally {
      headerTimeout.cleanup();
    }

    // zstd rejection fallback: a 400 on a compressed request latches
    // compression OFF process-wide and replays this attempt uncompressed.
    if (response && response.status === 400 && bodyForSend.encoding) {
      _disableOpenaiReqZstd();
      bodyForSend = { bytes: rawBytes, encoding: null };
      await response.arrayBuffer().catch(() => {});
      response = undefined;
      continue;
    }
    const retryableStatus = response && response.status >= 500 && response.status <= 599;
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
      if (retryableTransport && requestError) {
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
      const attemptFailure =
        requestError ||
        Object.assign(new Error(`OpenAI OAuth HTTP fallback ${response.status}`), {
          httpStatus: response.status,
          headers: response.headers,
          initialResponseError: true,
        });
      if (readStreamOutcome(attemptFailure).replaySafe !== true) {
        if (response) await response.arrayBuffer().catch(() => {});
        totalTimeout.cleanup();
        throw attemptFailure;
      }
      // A non-success response has not exposed any streamed output. Drain
      // its body before reissuing so the dispatcher can reuse the socket.
      if (response) await response.arrayBuffer().catch(() => {});
      const raw = CODEX_REQUEST_BACKOFF_MS[attempt];
      await sleepWithAbort(
        jitterDelayMs(raw, CODEX_RETRY_JITTER_RATIO),
        externalSignal,
        _sleepFn,
        'OpenAI OAuth HTTP request retry backoff aborted'
      );
      response = undefined;
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
  return response;
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
  const response = await postWithRetries({
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

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    const err = new Error(`OpenAI OAuth HTTP fallback ${response.status}: ${text.slice(0, 200)}`);
    err.httpStatus = response.status;
    err.headers = response.headers;
    err.initialResponseError = true;
    totalTimeout.cleanup();
    throw err;
  }
  if (auth?.type !== 'openai-direct') {
    const responseTurnState = response.headers?.get?.('x-codex-turn-state');
    if (responseTurnState) captureCodexTurnState(poolKey, turnId, responseTurnState);
  }
  if (!response.body) {
    totalTimeout.cleanup();
    throw Object.assign(new Error('OpenAI OAuth HTTP fallback returned no response body'), {
      initialResponseError: true,
    });
  }
  return response;
}
