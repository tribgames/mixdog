/**
 * openai-oauth-http-sse.mjs — HTTP/SSE fallback transport for openai-oauth.
 *
 * Used when the WebSocket transport is
 * unhealthy (see _shouldUseOpenAIHttpFallback / shouldFallbackTransport).
 * Owns SSE frame parsing and fallback headers; the initial POST lives in
 * openai-http-sse-request.mjs, the liveness gates in
 * openai-http-sse-watchdogs.mjs and the event folding + single-emit
 * tool-call dedupe contract (scripts/openai-oauth-http-sse-toolcall-smoke.mjs)
 * in openai-http-sse-response-state.mjs.
 */
import { randomBytes } from 'node:crypto';
import { createPassthroughSignal } from '../stall-policy.mjs';
import { shouldFallbackTransport } from './retry-classifier.mjs';
import { CODEX_OAUTH_ORIGINATOR } from './openai-codex-endpoints.mjs';
import { parseProviderJsonBatch } from './stream-json-pool.mjs';
import { envFlag as _envFlag } from '../../../shared/env.mjs';
import { activateCodexTurnState } from './openai-turn-state.mjs';
import { openHttpSseResponse } from './openai-http-sse-request.mjs';
import { createHttpSseWatchdogs } from './openai-http-sse-watchdogs.mjs';
import { createHttpSseResponseState } from './openai-http-sse-response-state.mjs';
export { envPositiveInt as _envPositiveInt } from '../../../shared/env.mjs';
export { _endTurnFromEvent } from './openai-http-sse-response-state.mjs';
export { _envFlag };

function _sseEventsFromBuffer(buffer) {
  const frames = [];
  let rest = buffer.replace(/\r\n/g, '\n');
  while (true) {
    const idx = rest.indexOf('\n\n');
    if (idx < 0) break;
    frames.push(rest.slice(0, idx));
    rest = rest.slice(idx + 2);
  }
  return { frames, rest };
}

function _sseJsonPayload(frame) {
  const lines = String(frame || '').split('\n');
  const data = [];
  for (const line of lines) {
    if (!line || line.startsWith(':')) continue;
    if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
  }
  if (!data.length) return null;
  const raw = data.join('\n').trim();
  return !raw || raw === '[DONE]' ? null : raw;
}

export function _buildOpenAIHttpFallbackHeaders({
  auth,
  cacheKey,
  statelessConversation = false,
  poolKey = null,
  turnId = null,
}) {
  if (auth?.type === 'openai-direct') {
    // Public API-key auth: Bearer <OPENAI_API_KEY>, no chatgpt-account-id /
    // originator (mirrors openai-ws-pool _buildHandshakeHeaders' direct
    // branch). session_id anchors are an OAuth-backend behavior, so omit
    // them — the public API keys its prefix cache off body.prompt_cache_key.
    return {
      Authorization: `Bearer ${auth.apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      'x-client-request-id': randomBytes(16).toString('hex'),
    };
  }
  const headers = {
    Authorization: `Bearer ${auth.access_token}`,
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
    'OpenAI-Beta': 'responses=experimental',
    originator: CODEX_OAUTH_ORIGINATOR,
    'chatgpt-account-id': auth.account_id || '',
    'x-client-request-id': randomBytes(16).toString('hex'),
  };
  if (cacheKey && !statelessConversation) {
    const sid = String(cacheKey);
    // Backend-native anchors (see openai-ws-pool _buildHandshakeHeaders):
    // the hyphenated `session-id`/`thread-id` pair; legacy underscore
    // `session_id` kept for backward compat.
    headers.session_id = sid;
    headers['session-id'] = sid;
    headers['thread-id'] = sid;
  }
  const turnState = activateCodexTurnState(poolKey, turnId);
  if (turnState) headers['x-codex-turn-state'] = turnState;
  return headers;
}

// WS→HTTP/SSE fallback predicate → shared shouldFallbackTransport
// (retry-classifier.mjs). The per-provider env flag is computed here and passed
// as `enabled`; OAuth rate limits are terminal and must never trigger a
// transport fallback, even if a caller has marked a prior WS attempt exhausted.
export function _shouldUseOpenAIHttpFallback(err, externalSignal) {
  if (Number(err?.httpStatus || 0) === 429) return false;
  // Codex switches WS→HTTPS on a typed transport failure; the only extra
  // deny is exposure (relayed text / dispatched tool), which the shared
  // predicate reads off the canonical record stamped by the WS transport.
  return shouldFallbackTransport(err, {
    signal: externalSignal,
    enabled: _envFlag('MIXDOG_OPENAI_OAUTH_HTTP_FALLBACK', true),
  });
}

// Exported for the single-emit regression smoke (scripts/openai-oauth-
// http-sse-toolcall-smoke.mjs): the SSE stream can surface the same
// function_call across response.function_call_arguments.done +
// response.output_item.done + response.completed, and onToolCall must fire
// exactly once per call id. No production caller imports this name; the
// provider invokes it internally.
export async function sendViaHttpSse({
  auth,
  body,
  opts,
  onStreamDelta,
  onToolCall,
  onTextDelta,
  onStageChange,
  externalSignal,
  poolKey,
  cacheKey,
  iteration,
  useModel,
  fetchFn = fetch,
  _sleepFn,
} = {}) {
  // No fixed wall-clock total cap on the HTTP/SSE fallback stream: a
  // healthy, still-streaming turn is never killed purely on elapsed time
  // (anthropic-oauth uses the same createPassthroughSignal pattern). The
  // stream is bounded instead by:
  //   (a) the initial-response timeout in openai-http-sse-request.mjs for a
  //       socket that never sends the initial response,
  //   (b) the SEMANTIC idle watchdog (openai-http-sse-watchdogs.mjs), which
  //       resets on every meaningful() chunk — a live stream stays alive, a
  //       truly silent one still aborts, and
  //   (c) externalSignal (client disconnect / replaced-by-newer-request).
  const totalTimeout = createPassthroughSignal(externalSignal);
  const statelessConversation = opts?.statelessConversation === true || _envFlag('MIXDOG_OAI_STATELESS_HTTP', false);
  const turnId = opts?.turnId || opts?.codexTurnId || opts?.session?.turnId || null;
  const headers = _buildOpenAIHttpFallbackHeaders({
    auth,
    cacheKey,
    statelessConversation,
    poolKey,
    turnId,
  });
  const response = await openHttpSseResponse({
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
  });

  try {
    onStreamDelta?.('transport');
  } catch {}
  try {
    onStageChange?.('streaming');
  } catch {}
  const sseStartedAt = Date.now();
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let ttftMs = null;
  const watchdogs = createHttpSseWatchdogs({
    opts,
    reader,
    totalTimeout,
    stallPartial: () => state.stallPartial(),
  });
  const meaningful = (kind = 'semantic') => {
    if (ttftMs == null) ttftMs = Date.now() - sseStartedAt;
    watchdogs.noteMeaningful();
    try {
      onStreamDelta?.(kind);
    } catch {}
  };
  const state = createHttpSseResponseState({
    body,
    onToolCall,
    onTextDelta,
    meaningful,
    onServerEvent: watchdogs.noteServerEvent,
  });
  const foldFrames = async (text) => {
    const parsed = _sseEventsFromBuffer(text);
    const payloads = parsed.frames.map(_sseJsonPayload).filter((payload) => payload !== null);
    const events = await parseProviderJsonBatch(payloads);
    for (const event of events) state.handleEvent(event);
    return parsed.rest;
  };
  let buffer = '';
  try {
    watchdogs.armFirstServerEvent();
    while (true) {
      if (totalTimeout.signal?.aborted) {
        watchdogs.clearSemanticIdle();
        const reason = totalTimeout.signal.reason;
        throw reason instanceof Error ? reason : new Error('OpenAI OAuth HTTP fallback aborted');
      }
      const abortReason = watchdogs.abortReason();
      if (abortReason) throw abortReason;
      const { value, done } = await watchdogs.read();
      if (done) break;
      try {
        onStreamDelta?.('transport');
      } catch {}
      buffer += decoder.decode(value, { stream: true });
      // These bytes have already been delivered by reader.read(). Finish
      // this bounded chunk before observing abort on the next read so
      // visible text is never lost at the cancellation boundary.
      buffer = await foldFrames(buffer);
    }
    // The read() above can unblock via reader.cancel() as {done:true} on an
    // external/total-timeout abort. Surface that as the abort/timeout error
    // instead of treating the partial stream as a successful response.
    const abortReason = watchdogs.abortReason();
    if (abortReason) throw abortReason;
    buffer += decoder.decode();
    await foldFrames(`${buffer}\n\n`);
    state.flushLeak();
  } catch (err) {
    throw state.stampStreamError(err);
  } finally {
    watchdogs.dispose();
  }
  return state.finish({ useModel, poolKey, iteration, sseStartedAt, ttftMs });
}
