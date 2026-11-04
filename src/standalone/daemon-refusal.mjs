// daemon-refusal.mjs — the 503 a daemon front door answers when it will not
// take work: EDAEMON_FENCED, fenced or shutting down. That daemon never serves
// again and never ran the refused request, so the client re-attaches to
// whichever daemon serves next and asks there (no UI: a reconnect).
import { sendJson } from '../runtime/memory/lib/http-wire.mjs';

export const DAEMON_FENCED = 'EDAEMON_FENCED';

/** Answers `refusal` ({ code, message }) as fenced. */
export function sendDaemonRefusal(res, refusal) {
  sendJson(res, { error: String(refusal?.message || 'daemon is not serving'), code: DAEMON_FENCED }, 503);
}
