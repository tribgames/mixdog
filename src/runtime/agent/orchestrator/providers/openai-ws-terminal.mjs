/**
 * openai-ws-terminal.mjs — the errors a Responses WS stream settles with,
 * built from the wire frame (or socket event) that ended it. Pure: each
 * builder returns a tagged Error the stream loop stores as terminalError.
 */
import { typedStatusFrom } from './retry-classifier.mjs';
import { _httpStatusFromWsClose } from './openai-ws-events.mjs';

/** A server `event.error` on any frame. Same wire-error contract as
 *  response.failed / the top-level error frame: the frame is attached so
 *  classifyError() applies the typed fatal-code deny-list and default-retries
 *  everything else (observed live: a status-less "servers are currently
 *  overloaded" error event failed the turn outright with zero retries). The
 *  status itself stays typed-only — never synthesized from message text. */
export function serverErrorEventError(error, event) {
  const err = new Error(error.message || 'Responses WS error');
  try {
    err.payload = error;
    err.responseFailed = event;
    const typed = typedStatusFrom(error, event);
    if (typed) err.httpStatus = typed;
    const code = error.code ?? error.type ?? null;
    if (typeof code === 'string' && code) err.providerErrorCode = code;
  } catch {}
  return err;
}

/** response.failed, or response.done with status 'failed'. The payload is
 *  attached so the mid-stream classifier can sniff network_error /
 *  stream_disconnected without re-parsing. TYPED status only: a failure whose
 *  only evidence is message text synthesizes no status. */
export function responseFailedError(event, { label, fallbackMessage, providerErrorCode = false }) {
  const msg = event.response?.error?.message || event.error?.message || event.message || fallbackMessage;
  const err = Object.assign(new Error(`${label}: ${msg}`), { responseFailed: event });
  const typed = typedStatusFrom(event.response?.error, event.error, event);
  if (typed) err.httpStatus = typed;
  if (providerErrorCode) {
    const detail = event.response?.error || event.error || null;
    const code = detail?.code ?? detail?.type ?? null;
    if (typeof code === 'string' && code) err.providerErrorCode = code;
  }
  return err;
}

/** response.incomplete (or response.done status 'incomplete') for a reason
 *  other than max_output_tokens. */
export function responseIncompleteError(event, reasonStr, label) {
  return Object.assign(new Error(`${label}: ${reasonStr}`), {
    responseIncomplete: event,
    incompleteReason: reasonStr,
  });
}

/** response.done with a status that is neither completed, failed nor incomplete. */
export function responseDoneStatusError(status, label) {
  return Object.assign(new Error(`${label}: ${status}`), { responseDoneStatus: status });
}

/** A top-level `error` frame. Same wire-error contract as response.failed:
 *  the frame is attached so classifyError() applies the typed fatal-code
 *  deny-list / default-retry. */
export function errorFrameError(event, label) {
  const errMsg = String(event.message || event.error?.message || 'unknown');
  const err = new Error(`${label}: ${errMsg}`);
  err.responseFailed = event;
  const typed = typedStatusFrom(event.error, event);
  if (typed) err.httpStatus = typed;
  const code = event.error?.code ?? event.error?.type ?? event.code ?? null;
  if (typeof code === 'string' && code) err.providerErrorCode = code;
  return err;
}

/** The socket closed before a terminal frame. */
export function wsClosedError(code, reasonText) {
  const httpStatus = _httpStatusFromWsClose(code, reasonText);
  return Object.assign(
    new Error(
      `OpenAI OAuth WS closed before response.completed (code=${code}${reasonText ? `, reason=${reasonText}` : ''})`
    ),
    { wsCloseCode: code, wsCloseReason: reasonText, ...(httpStatus ? { httpStatus } : {}) }
  );
}

/** A close that arrives AFTER a terminal error was already chosen only
 *  annotates it with the close code and a status derived from it. */
export function annotateWsClose(err, code, reasonText) {
  if (!err || err.wsCloseCode) return;
  try {
    err.wsCloseCode = code;
  } catch {}
  try {
    err.httpStatus = err.httpStatus || _httpStatusFromWsClose(code, reasonText);
  } catch {}
}

/** An incoming frame past the configured byte bound. Retryable: the pool
 *  applies the same bound as `maxPayload` before assembly. */
export function frameTooLargeError(label, frameBytes, limitBytes) {
  const err = new Error(
    `${label} response frame is too large (${frameBytes} bytes; limit ${limitBytes} bytes); request is retryable`
  );
  err.code = 'EOPENAIWSFRAMETOOLARGE';
  err.wsFrameTooLarge = true;
  err.retryable = true;
  return err;
}

/** A later socket error never replaces the first terminal error: it is
 *  chained in via `cause` (or `suppressed` once a cause exists) so
 *  diagnostics keep the original failure visible. */
export function chainSocketError(terminalError, wrapped) {
  try {
    if (!terminalError.cause) terminalError.cause = wrapped;
    else {
      const list = Array.isArray(terminalError.suppressed) ? terminalError.suppressed : [];
      list.push(wrapped);
      terminalError.suppressed = list;
    }
  } catch {}
}
