/**
 * src/tui/session/turn-live-call.mjs — the live decode speed of the model call
 * that is streaming right now (`spinner.liveCall`), for the desktop composer's
 * usage readout.
 *
 * Providers report a call's exact output tokens only when it ends (the usage
 * delta), so mid-stream the count is the runtime's own token estimate of the
 * text and reasoning streamed so far (token-estimate.mjs, measured against a
 * real tokenizer at +6.5% aggregate bias). The clock starts when the provider
 * request starts (markLiveCallRequestStart), the wait for the first token
 * included, the same span as the persisted speed and the usage ledger; with no
 * request-start mark it starts at the first visible text/reasoning token.
 *
 * Published at most every LIVE_CALL_PUBLISH_MS with its own sample time, so the
 * reader divides tokens by (sample time - start) and a pause between samples
 * never skews the figure. A tool call's arguments stream without text the
 * runtime can count: once the call turns to one, the live figure is withdrawn
 * until the next call rather than decaying against tokens nobody counted. The
 * call's usage delta ends it.
 */
import { estimateTokens } from '../../runtime/agent/orchestrator/session/token-estimate.mjs';

export const LIVE_CALL_PUBLISH_MS = 250;

function publish({ getState, set }, liveCall) {
  const spinner = getState().spinner;
  if (spinner) set({ spinner: { ...spinner, liveCall } });
}

/** The provider request of the next call started: its clock starts here. */
export function markLiveCallRequestStart(stream, now = Date.now()) {
  stream.liveCallRequestAt = now;
}

/** A text or reasoning chunk of the streaming call arrived. */
export function noteLiveCallText(stream, chunk, now = Date.now()) {
  const text = String(chunk ?? '');
  if (!text || stream.liveCallWithdrawn) return;
  const call = stream.liveCall || { startedAt: stream.liveCallRequestAt ?? now, text: '', publishedAt: 0 };
  stream.liveCall = call;
  call.text += text;
  if (call.publishedAt && now - call.publishedAt < LIVE_CALL_PUBLISH_MS) return;
  call.publishedAt = now;
  publish(stream, { startedAt: call.startedAt, outputTokens: estimateTokens(call.text), at: now });
}

/** The call turned to a tool call (withdraw until the next call) or was reset. */
export function withdrawLiveCall(stream) {
  stream.liveCallWithdrawn = true;
  endLiveCall(stream);
}

/** The call ended (its usage delta landed): the next call starts fresh. */
export function endLiveCall(stream) {
  const had = Boolean(stream.liveCall) || Boolean(stream.getState().spinner?.liveCall);
  stream.liveCall = null;
  if (had) publish(stream, null);
}

export function startNextLiveCall(stream) {
  stream.liveCallWithdrawn = false;
  stream.liveCallRequestAt = null;
  endLiveCall(stream);
}
