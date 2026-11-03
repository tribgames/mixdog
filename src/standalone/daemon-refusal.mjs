// daemon-refusal.mjs — the 503 a daemon front door answers when it will not
// take work now, and how a client reads it back. Two kinds look alike on the
// wire and must not be handled alike:
// - EDAEMON_RETRY_LATER: busy or not ready yet (today: the owner record is
//   being re-verified after an event-loop stall); the same request is asked
//   again after `retryAfterMs`, on the same attachment, silently.
// - EDAEMON_FENCED: fenced or shutting down; this daemon will not serve again,
//   so only re-attaching (to whichever daemon serves next) helps.
import { sendJson } from '../runtime/memory/lib/http-wire.mjs';

export const DAEMON_RETRY_LATER = 'EDAEMON_RETRY_LATER';
export const DAEMON_FENCED = 'EDAEMON_FENCED';

const RETRY_LATER_DEFAULT_MS = 250;

/** Answers `refusal` ({ code, message, retryAfterMs? }); anything but a
 *  retry-later refusal is answered as fenced. */
export function sendDaemonRefusal(res, refusal) {
  const error = String(refusal?.message || 'daemon is not serving');
  if (refusal?.code !== DAEMON_RETRY_LATER) {
    sendJson(res, { error, code: DAEMON_FENCED }, 503);
    return;
  }
  const retryAfterMs = Math.max(1, Math.round(Number(refusal.retryAfterMs) || RETRY_LATER_DEFAULT_MS));
  // Retry-After carries whole seconds; the body keeps the finer hint.
  res.setHeader('Retry-After', String(Math.max(1, Math.ceil(retryAfterMs / 1000))));
  sendJson(res, { error, code: DAEMON_RETRY_LATER, retryAfterMs }, 503);
}

/** The retry delay an HTTP error reply asks for: the body's `retryAfterMs`,
 *  else a delta-seconds `Retry-After` header; null when it names none. */
export function replyRetryAfterMs(body, retryAfterHeader) {
  const fromBody = Number(body?.retryAfterMs);
  if (Number.isFinite(fromBody) && fromBody > 0) return Math.round(fromBody);
  const seconds = /^\s*(\d+)\s*$/.exec(String(retryAfterHeader ?? ''));
  return seconds ? Math.max(1, Number(seconds[1]) * 1000) : null;
}
