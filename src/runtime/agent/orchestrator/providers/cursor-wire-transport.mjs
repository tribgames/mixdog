// Cursor HTTP/2 transport: endpoints, RPC headers, the bidi stream, unary
// calls and Connect frame parsing.
import crypto from 'node:crypto';
import http2 from 'node:http2';
import { MAX_CONNECT_FRAME_BYTES, createCursorByteQueue } from './cursor-wire-guards.mjs';

const API_URL = process.env.CURSOR_API_URL || 'https://api2.cursor.sh';
const CLIENT_VERSION = process.env.MIXDOG_CURSOR_CLIENT_VERSION || 'cli-2026.08.11-e8db854';
const RUN_PATH = '/agent.v1.AgentService/Run';
export const MODELS_PATH = '/agent.v1.AgentService/GetUsableModels';
export const AVAILABLE_MODELS_PATH = '/aiserver.v1.AiService/AvailableModels';
export const USAGE_PATH = '/aiserver.v1.DashboardService/GetCurrentPeriodUsage';
export const PLAN_PATH = '/aiserver.v1.DashboardService/GetPlanInfo';
export const END_STREAM_FLAG = 2;
const H2_PING_INTERVAL_MS = 20_000;
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
    'x-cursor-client-version': CLIENT_VERSION,
    'x-cursor-client-type': 'cli',
    'x-request-id': crypto.randomUUID(),
    ...(unary ? {} : { 'connect-protocol-version': '1' }),
  };
}

export function cursorError(message, { status = 0, code = '', retryAfter = null } = {}) {
  const error = new Error(message);
  if (status) {
    error.status = status;
    error.httpStatus = status;
  }
  if (code) {
    error.code = code;
    error.cursorCode = code;
  }
  if (retryAfter != null && retryAfter !== '') {
    const headers = { 'retry-after': String(retryAfter) };
    error.retryAfter = retryAfter;
    error.headers = headers;
    error.response = { status, headers };
  }
  return error;
}

export function openCursorStream({ accessToken, path = RUN_PATH, url = API_URL }) {
  const session = http2.connect(url);
  const request = session.request(rpcHeaders(accessToken, path, false));
  let dataHandler = null;
  let closeHandler = null;
  let closed = false;
  let status = 0;
  let retryAfter = null;
  let closeError = null;
  let timeout = setTimeout(
    () => close(cursorError('Cursor connection timed out', { code: 'connection_timeout' })),
    30_000
  );
  const configuredIdle = Number(process.env.MIXDOG_CURSOR_H2_IDLE_TIMEOUT_MS);
  const idleTimeoutMs = Number.isFinite(configuredIdle) && configuredIdle > 0 ? Math.floor(configuredIdle) : 0;
  const ping = setInterval(() => {
    if (closed || session.closed || session.destroyed) return;
    try {
      session.ping(() => {});
    } catch {}
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
    closeError =
      error || (status >= 400 ? cursorError(`Cursor request failed (${status})`, { status, retryAfter }) : null);
    try {
      request.close();
    } catch {}
    try {
      session.close();
    } catch {}
    closeHandler?.(closeError);
  };
  const close = (error = null) => {
    if (closed) return;
    try {
      request.close(http2.constants.NGHTTP2_CANCEL);
    } catch {}
    try {
      session.destroy();
    } catch {}
    finish(error);
  };

  request.on('response', (headers) => {
    status = Number(headers[':status'] || 0);
    retryAfter = headers['retry-after'] ?? null;
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
  return new Promise((resolve, reject) => {
    const session = http2.connect(url);
    const request = session.request(rpcHeaders(accessToken, path, true));
    const chunks = [];
    let status = 0;
    let retryAfter = null;
    let settled = false;
    const timeout = setTimeout(() => finish(new Error('Cursor request timed out')), timeoutMs);
    const finish = (error = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      try {
        request.close();
      } catch {}
      try {
        session.close();
      } catch {}
      if (error) reject(error);
      else if (status >= 400) reject(cursorError(`Cursor request failed (${status})`, { status, retryAfter }));
      else resolve(Buffer.concat(chunks));
    };
    request.on('response', (headers) => {
      status = Number(headers[':status'] || 0);
      retryAfter = headers['retry-after'] ?? null;
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
      throw cursorError('Cursor stream ended with a truncated frame', { code: 'protocol_error' });
    }
  };
  parse.bufferedBytes = () => pending.byteLength;
  return parse;
}

export function parseEndStream(bytes) {
  try {
    const payload = JSON.parse(textDecoder.decode(bytes));
    if (!payload?.error) return null;
    const code = String(payload.error.code || 'error');
    const status =
      {
        unauthenticated: 401,
        permission_denied: 403,
        not_found: 404,
        resource_exhausted: 429,
        invalid_argument: 400,
        internal: 500,
        unavailable: 503,
      }[code] || 0;
    return cursorError(`Cursor ${code}: ${payload.error.message || 'request failed'}`, {
      status,
      code,
      retryAfter:
        payload.error.retryAfter ??
        payload.error.retry_after ??
        payload.metadata?.['retry-after'] ??
        payload.metadata?.retryAfter ??
        null,
    });
  } catch {
    return cursorError('Cursor returned an invalid end-stream frame', { code: 'protocol_error' });
  }
}
