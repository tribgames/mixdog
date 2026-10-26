// Cursor HTTP/2 transport: endpoints, RPC headers, the bidi stream, unary
// calls and Connect frame parsing.
import crypto from 'node:crypto';
import http2 from 'node:http2';
import { MAX_CONNECT_FRAME_BYTES, createCursorByteQueue } from './cursor-wire-guards.mjs';
import { cursorClientVersion, warmCursorClientVersion } from './cursor-client-version.mjs';
import { retryAfterMsFromError } from './retry-classifier.mjs';
import { providerTimeoutError } from '../stall-policy.mjs';

export { warmCursorClientVersion };

const API_URL = process.env.CURSOR_API_URL || 'https://api2.cursor.sh';
const RUN_PATH = '/agent.v1.AgentService/Run';
export const MODELS_PATH = '/agent.v1.AgentService/GetUsableModels';
export const AVAILABLE_MODELS_PATH = '/aiserver.v1.AiService/AvailableModels';
export const USAGE_PATH = '/aiserver.v1.DashboardService/GetCurrentPeriodUsage';
export const PLAN_PATH = '/aiserver.v1.DashboardService/GetPlanInfo';
export const END_STREAM_FLAG = 2;
const H2_PING_INTERVAL_MS = 20_000;
const CONNECT_TIMEOUT_MS = 30_000;
export const SSE_HEADERS = {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache',
  Connection: 'keep-alive',
};

export const textEncoder = new TextEncoder();
export const textDecoder = new TextDecoder();

function rpcHeaders(accessToken, path, unary) {
  return {
    ':method': 'POST',
    ':path': path,
    'content-type': unary ? 'application/proto' : 'application/connect+proto',
    te: 'trailers',
    authorization: `Bearer ${accessToken}`,
    'x-ghost-mode': 'true',
    'x-cursor-client-version': cursorClientVersion(),
    'x-cursor-client-type': 'cli',
    'x-request-id': crypto.randomUUID(),
    ...(unary ? {} : { 'connect-protocol-version': '1' }),
  };
}

// HTTP-equivalent status for every Connect error code.
const CONNECT_CODE_STATUS = Object.freeze({
  canceled: 499,
  unknown: 500,
  invalid_argument: 400,
  deadline_exceeded: 504,
  not_found: 404,
  already_exists: 409,
  permission_denied: 403,
  resource_exhausted: 429,
  failed_precondition: 400,
  aborted: 409,
  out_of_range: 400,
  unimplemented: 501,
  internal: 500,
  unavailable: 503,
  data_loss: 500,
  unauthenticated: 401,
});

// Connect code for a plain HTTP failure that carried no Connect error body.
const HTTP_STATUS_CODE = Object.freeze({
  401: 'unauthenticated',
  403: 'permission_denied',
  404: 'not_found',
  429: 'resource_exhausted',
  500: 'internal',
  502: 'unavailable',
  503: 'unavailable',
  504: 'deadline_exceeded',
});

// Only explicit wording about the tool catalog or request payload being too
// large counts; resource_exhausted otherwise stays a throttle.
const REQUEST_TOO_LARGE_RE =
  /\b(?:tool\s+(?:catalog|definitions?|schemas?)|tools|payload|request(?:\s+body)?)\b[^.\n]{0,80}?\b(?:too\s+(?:large|big)|exceed(?:s|ed)?\b[^.\n]{0,30}?\b(?:size|limit|maximum))/i;

// Rate/quota wording wins over the size match: "request exceeded the rate
// limit" is a throttle, not an oversized request.
const THROTTLE_CUE_RE = /too\s+many\s+requests|quota|rate[\s_-]*limit|throttl/i;

function firstValue(value) {
  return Array.isArray(value) ? value[0] : value;
}

// Lowercased string-valued header map without HTTP/2 pseudo-headers.
function plainHeaders(source) {
  const headers = {};
  for (const [key, value] of Object.entries(source || {})) {
    const first = firstValue(value);
    if (key.startsWith(':') || first == null || typeof first === 'object') continue;
    headers[key.toLowerCase()] = String(first);
  }
  return headers;
}

export function cursorError(
  message,
  { status = 0, code = '', cursorCode = code, headers = null, retryAfter = null, reauthRequired = false, detail } = {}
) {
  const error = new Error(message);
  if (status) {
    error.status = status;
    error.httpStatus = status;
  }
  if (code) {
    error.code = code;
    error.cursorCode = cursorCode;
  }
  if (detail != null) error.cursorDetail = detail;
  if (reauthRequired) error.reauthRequired = true;
  const errorHeaders = plainHeaders(headers);
  if (retryAfter != null && retryAfter !== '') {
    error.retryAfter = retryAfter;
    errorHeaders['retry-after'] = String(retryAfter);
  }
  if (Object.keys(errorHeaders).length) {
    error.headers = errorHeaders;
    error.response = { status, headers: errorHeaders };
    const retryAfterMs = retryAfterMsFromError(error);
    if (Number.isFinite(retryAfterMs)) error.retryAfterMs = retryAfterMs;
  }
  return error;
}

function httpStatusError(status, headers) {
  return cursorError(`Cursor request failed (${status})`, {
    status,
    code: HTTP_STATUS_CODE[status] || '',
    headers,
  });
}

export function openCursorStream({ accessToken, path = RUN_PATH, url = API_URL }) {
  const session = http2.connect(url);
  const request = session.request(rpcHeaders(accessToken, path, false));
  let dataHandler = null;
  let closeHandler = null;
  let closed = false;
  let status = 0;
  let responseHeaders = null;
  let closeError = null;
  let timeout = setTimeout(
    () => close(cursorError('Cursor connection timed out', { code: 'connection_timeout' })),
    CONNECT_TIMEOUT_MS
  );
  const configuredIdle = Number(process.env.MIXDOG_CURSOR_H2_IDLE_TIMEOUT_MS);
  const idleTimeoutMs = Number.isFinite(configuredIdle) && configuredIdle > 0 ? Math.floor(configuredIdle) : 0;
  const ping = setInterval(() => {
    if (closed || session.closed || session.destroyed) return;
    try {
      session.ping(() => {});
    } catch {
      // the session may have closed since the check above
    }
  }, H2_PING_INTERVAL_MS);
  ping.unref?.();

  const resetTimeout = () => {
    clearTimeout(timeout);
    timeout =
      idleTimeoutMs > 0
        ? setTimeout(
            () => close(cursorError('Cursor H2 stream timed out', { code: 'stream_idle_timeout' })),
            idleTimeoutMs
          )
        : null;
  };
  const finish = (error = null) => {
    if (closed) return;
    closed = true;
    clearTimeout(timeout);
    clearInterval(ping);
    closeError = error || (status >= 400 ? httpStatusError(status, responseHeaders) : null);
    try {
      request.close();
    } catch {
      // the request stream may already be closed
    }
    try {
      session.close();
    } catch {
      // the session may already be closed
    }
    closeHandler?.(closeError);
  };
  const close = (error = null) => {
    if (closed) return;
    try {
      request.close(http2.constants.NGHTTP2_CANCEL);
    } catch {
      // the request stream may already be closed
    }
    try {
      session.destroy();
    } catch {
      // the session may already be destroyed
    }
    finish(error);
  };

  request.on('response', (headers) => {
    status = Number(headers[':status'] || 0);
    responseHeaders = headers;
    resetTimeout();
  });
  request.on('data', (chunk) => {
    resetTimeout();
    dataHandler?.(Buffer.from(chunk));
  });
  request.on('end', () => finish());
  request.on('aborted', () => finish(cursorError('Cursor stream was aborted', { code: 'stream_aborted' })));
  request.on('error', (error) => finish(error));
  session.on('error', (error) => finish(error));
  session.on('goaway', (errorCode) => {
    finish(cursorError(`Cursor GOAWAY (${errorCode})`, { code: 'goaway' }));
  });

  return {
    get alive() {
      return !closed;
    },
    write(bytes) {
      if (closed) return;
      // Deliberately NOT resetTimeout(): frames written here (client
      // heartbeat every 5s, tool results) are OUR traffic and say nothing
      // about the server still being alive. Refreshing the deadline on
      // every write let a silent server hold the connection open
      // indefinitely even when an idle timeout was configured.
      // Only 'response'/'data' from the server re-arm it.
      request.write(bytes);
    },
    close,
    onData(handler) {
      dataHandler = handler;
    },
    onClose(handler) {
      closeHandler = handler;
      if (closed) queueMicrotask(() => handler(closeError));
    },
  };
}

export async function callCursorUnary({ accessToken, path, body, url = API_URL, timeoutMs = 5_000 }) {
  await warmCursorClientVersion();
  return new Promise((resolve, reject) => {
    const session = http2.connect(url);
    const request = session.request(rpcHeaders(accessToken, path, true));
    const chunks = [];
    let status = 0;
    let responseHeaders = null;
    let settled = false;
    const timeout = setTimeout(() => finish(providerTimeoutError('Cursor request', timeoutMs)), timeoutMs);
    const finish = (error = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      try {
        request.close();
      } catch {
        // the request stream may already be closed
      }
      try {
        session.close();
      } catch {
        // the session may already be closed
      }
      if (error) reject(error);
      else if (status >= 400) reject(httpStatusError(status, responseHeaders));
      else resolve(Buffer.concat(chunks));
    };
    request.on('response', (headers) => {
      status = Number(headers[':status'] || 0);
      responseHeaders = headers;
    });
    request.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    request.on('end', () => finish());
    request.on('error', finish);
    session.on('error', finish);
    request.end(body);
  });
}

export function connectFrame(bytes, flags = 0) {
  if (bytes.length > MAX_CONNECT_FRAME_BYTES) {
    throw cursorError(`Cursor frame exceeds ${MAX_CONNECT_FRAME_BYTES} bytes`, {
      code: 'cursor_payload_too_large',
    });
  }
  const frame = Buffer.alloc(5 + bytes.length);
  frame[0] = flags;
  frame.writeUInt32BE(bytes.length, 1);
  frame.set(bytes, 5);
  return frame;
}

export function createFrameParser(onMessage, onEnd) {
  const pending = createCursorByteQueue();
  const parse = (chunk) => {
    pending.append(chunk);
    while (pending.byteLength >= 5) {
      const header = pending.peek(5);
      const flags = header[0];
      const length = header.readUInt32BE(1);
      if (length > MAX_CONNECT_FRAME_BYTES) {
        throw cursorError(`Cursor frame exceeds ${MAX_CONNECT_FRAME_BYTES} bytes`, { code: 'protocol_error' });
      }
      if (pending.byteLength < length + 5) return;
      pending.read(5);
      const payload = pending.read(length);
      if (flags & 1) {
        throw cursorError('Cursor returned an unsupported compressed frame', { code: 'protocol_error' });
      }
      if (flags & ~END_STREAM_FLAG) {
        throw cursorError(`Cursor returned unsupported frame flags: ${flags}`, { code: 'protocol_error' });
      }
      if (flags & END_STREAM_FLAG) onEnd(payload);
      else onMessage(payload);
    }
  };
  parse.finish = () => {
    if (pending.byteLength) {
      throw cursorError('Cursor stream ended with a truncated frame', { code: 'incomplete_stream' });
    }
  };
  parse.bufferedBytes = () => pending.byteLength;
  return parse;
}

export function parseEndStream(bytes) {
  try {
    const payload = JSON.parse(textDecoder.decode(bytes));
    if (!payload?.error) return null;
    const connectCode = String(payload.error.code || 'error').toLowerCase();
    const detail = String(payload.error.message || 'request failed');
    const tooLarge =
      connectCode === 'resource_exhausted' && !THROTTLE_CUE_RE.test(detail) && REQUEST_TOO_LARGE_RE.test(detail);
    const retryAfter =
      payload.error.retryAfter ??
      payload.error.retry_after ??
      payload.metadata?.['retry-after'] ??
      payload.metadata?.retryAfter ??
      null;
    return cursorError(`Cursor ${connectCode}: ${detail}`, {
      status: tooLarge ? 413 : CONNECT_CODE_STATUS[connectCode] || 0,
      code: tooLarge ? 'request_too_large' : connectCode,
      cursorCode: connectCode,
      headers: payload.metadata,
      retryAfter: firstValue(retryAfter),
      detail,
    });
  } catch {
    return cursorError('Cursor returned an invalid end-stream frame', { code: 'protocol_error' });
  }
}
