// anthropic-cache-warm.mjs — the cache-warm mode both Anthropic providers
// expose as `sendCacheWarm` (session/cache-warm.mjs): one POST of the
// request the provider's own builder produces, no retry, fallback, re-send,
// wait or account rotation, and the stream cut at the first content block
// once the usage (cache read / write) has been reported. Right before the
// POST the account gate (cache-warm-admission.mjs) may skip it; a refusal is
// fed into the shared rate-limit and roster state. The request is bounded by
// the providers' own watchdogs: the first-byte timeout until the usage
// arrives, then the SSE idle timeout between events. Usage is handed to
// `onUsage` as it arrives, so a warm that fails or is aborted after the
// provider accepted it is still accounted. Every exit cancels the stream and
// aborts the transport.
import { PROVIDER_FIRST_BYTE_TIMEOUT_MS, PROVIDER_SSE_IDLE_TIMEOUT_MS } from '../stall-policy.mjs';
import { updateTurnUsage } from './anthropic-sse-turn/turn-state.mjs';
import { _anthropicSseError } from './anthropic-sse.mjs';
import { anthropicQuotaError } from './anthropic-oauth-request/initial-status.mjs';
import { cacheWarmAccountBlock, cacheWarmBlockedError, recordCacheWarmRefusal } from './cache-warm-admission.mjs';

const SSE_LABELS = Object.freeze({ display: 'Anthropic cache warm' });

function usageSnapshot(usage) {
  const { raw: _raw, ...rest } = usage;
  return { ...rest };
}

// An abort deadline: `arm(ms)` (re)starts it; it fires `controller.abort`.
function watchdog(controller) {
  let timer = null;
  return {
    arm(ms, what) {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => controller.abort(new Error(`cache warm ${what} timed out after ${ms}ms`)), ms);
      timer.unref?.();
    },
    clear() {
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}

/**
 * Read a warm's SSE stream until usage is known and the first content block
 * starts, or the message ends. Resolves the usage; a stream error rejects
 * with `error.usage` set to what was reported before it. `onChunk` hears
 * every chunk (the idle watchdog). The stream is cancelled on every exit.
 */
export async function readCacheWarmStream(response, { onUsage = () => {}, onChunk = () => {} } = {}) {
  const usage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0, cacheWriteTokens: 0, raw: null };
  let reported = false;
  const report = (raw) => {
    if (!raw || typeof raw !== 'object') return;
    updateTurnUsage(usage, raw);
    reported = true;
    onUsage(usageSnapshot(usage));
  };
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let cut = buffer.indexOf('\n\n');
      while (cut >= 0) {
        const frame = buffer.slice(0, cut);
        buffer = buffer.slice(cut + 2);
        cut = buffer.indexOf('\n\n');
        const data = frame
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n');
        if (!data) continue;
        let event;
        try {
          event = JSON.parse(data);
        } catch {
          continue;
        }
        if (event?.type === 'error' || event?.error) throw _anthropicSseError(event, SSE_LABELS);
        if (event.type === 'message_start') report(event.message?.usage);
        else if (event.type === 'message_delta') report(event.usage);
        else if (event.type === 'content_block_start' && reported) {
          // The prefix was read (and the cache refreshed) before any content:
          // nothing generated after this point is needed.
          return usageSnapshot(usage);
        } else if (event.type === 'message_stop') return usageSnapshot(usage);
      }
      onChunk(reported);
    }
  } catch (error) {
    if (error && typeof error === 'object' && error.usage === undefined) {
      error.usage = reported ? usageSnapshot(usage) : null;
    }
    throw error;
  } finally {
    await reader.cancel().catch(() => {});
  }
  return usageSnapshot(usage);
}

/**
 * One warm on account instance `instance` (roster account `accountId`, empty
 * for a provider without a roster) of `providerName`: the account gate, then
 * `post(signal)` (the provider's single POST of its built body), then the
 * stream. A refusal reaches the shared rate-limit and roster state; the
 * transport is aborted on every exit.
 */
export async function sendAnthropicCacheWarm({
  providerName,
  instance,
  accountId = '',
  model,
  opts = {},
  post,
  onUsage,
}) {
  const blocked = cacheWarmAccountBlock(providerName, instance, {
    accountId,
    model,
    sessionId: opts.session?.id || opts.sessionId || '',
  });
  if (blocked) throw cacheWarmBlockedError(blocked);
  const controller = new AbortController();
  const callerSignal = opts.signal;
  const onCallerAbort = () => controller.abort(callerSignal.reason);
  if (callerSignal?.aborted) controller.abort(callerSignal.reason);
  else callerSignal?.addEventListener?.('abort', onCallerAbort, { once: true });
  const deadline = watchdog(controller);
  deadline.arm(PROVIDER_FIRST_BYTE_TIMEOUT_MS, 'first byte');
  try {
    const response = await post(controller.signal);
    if (!response.ok) {
      const bodyText = await response.text().catch(() => '');
      throw anthropicQuotaError(response.status, response.headers, bodyText);
    }
    return await readCacheWarmStream(response, {
      onUsage,
      onChunk: (reported) => {
        if (reported) deadline.arm(PROVIDER_SSE_IDLE_TIMEOUT_MS, 'stream');
      },
    });
  } catch (error) {
    await recordCacheWarmRefusal(providerName, instance, error, {
      accountId,
      model,
      aborted: Boolean(callerSignal?.aborted),
    }).catch(() => {});
    throw error;
  } finally {
    callerSignal?.removeEventListener?.('abort', onCallerAbort);
    deadline.clear();
    controller.abort(new Error('cache warm finished'));
  }
}
