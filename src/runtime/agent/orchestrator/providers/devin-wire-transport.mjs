// Devin Connect transport over fetch: unary RPCs (`application/proto`) and
// server-streaming RPCs (`application/connect+proto` envelopes).
//
// Every failure surfaces as DevinWireError { code, status, retryable, message }.
import { gunzipSync, gzipSync } from 'node:zlib';
import { decodeDevinMessage, encodeDevinMessage } from './devin-wire-protobuf.mjs';
import { retryAfterMsFromError } from './retry-classifier.mjs';

export const DEVIN_COMPRESSED_FLAG = 0x01;
export const DEVIN_END_STREAM_FLAG = 0x02;
// Advertised envelope length cap: the 4-byte prefix is peer-controlled, so an
// oversize length fails on the header instead of buffering the payload.
export const DEVIN_MAX_FRAME_BYTES = 16 * 1024 * 1024;
// Separate cap on what one gzip payload may inflate to.
export const DEVIN_MAX_DECOMPRESSED_BYTES = 32 * 1024 * 1024;
const FRAME_HEADER_BYTES = 5;
const MAX_ERROR_DETAIL_CHARS = 2000;

export const DEVIN_STREAM_HEADERS = Object.freeze({
  'content-type': 'application/connect+proto',
  'connect-protocol-version': '1',
  'connect-content-encoding': 'gzip',
  'connect-accept-encoding': 'gzip',
  'accept-encoding': 'identity',
  'user-agent': 'connect-go/1.18.1 (go1.26.3)',
});

export const DEVIN_UNARY_HEADERS = Object.freeze({
  'content-type': 'application/proto',
  'connect-protocol-version': '1',
  accept: '*/*',
});

export class DevinWireError extends Error {
  constructor(message, { code, status = 0, retryable = false, connectCode = '', detail, retryAfterMs, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'DevinWireError';
    this.code = code;
    this.status = status;
    this.retryable = retryable;
    if (connectCode) this.connectCode = connectCode;
    if (detail) this.detail = detail;
    if (Number.isFinite(retryAfterMs)) this.retryAfterMs = retryAfterMs;
  }
}

// Connect code -> [Mixdog code, HTTP-equivalent status, retryable].
const CONNECT_CODES = Object.freeze({
  canceled: ['aborted', 499, false],
  unknown: ['internal', 500, true],
  invalid_argument: ['invalid_argument', 400, false],
  deadline_exceeded: ['unavailable', 504, true],
  not_found: ['not_found', 404, false],
  already_exists: ['invalid_argument', 409, false],
  permission_denied: ['permission', 403, false],
  resource_exhausted: ['resource_exhausted', 429, true],
  failed_precondition: ['invalid_argument', 400, false],
  aborted: ['unavailable', 409, true],
  out_of_range: ['invalid_argument', 400, false],
  unimplemented: ['not_found', 501, false],
  internal: ['internal', 500, true],
  unavailable: ['unavailable', 503, true],
  data_loss: ['internal', 500, true],
  unauthenticated: ['unauthenticated', 401, false],
});

const HTTP_STATUS_CONNECT_CODE = Object.freeze({
  400: 'invalid_argument',
  401: 'unauthenticated',
  403: 'permission_denied',
  404: 'not_found',
  408: 'deadline_exceeded',
  429: 'resource_exhausted',
  502: 'unavailable',
  503: 'unavailable',
  504: 'deadline_exceeded',
});

// Size wording turns resource_exhausted into request_too_large; throttle and
// quota wording always wins ("request exceeded the rate limit" is a throttle).
const TOO_LARGE_RE =
  /\b(?:too\s+(?:large|big|long)|exceeds?\s+(?:the\s+)?(?:maximum|max|size|length)|(?:payload|message|request|prompt|context)\s+(?:size|length)\b|maximum\s+(?:request|message|payload)\s+size)/i;
const THROTTLE_RE = /too\s+many\s+requests|quota|rate[\s_-]*limit|throttl|credits?|capacity/i;
// Devin words two throttles under other codes, as the reference executor
// (CLIProxyAPI devin_wire.go) maps them to 429: a model "in high demand"
// arrives as permission_denied, a spent quota as failed_precondition.
const HIGH_DEMAND_RE = /high demand/i;
const SPENT_QUOTA_RE = /quota|credit|acu|exhausted|limit/i;

// The throttle's [Mixdog code, HTTP-equivalent status, retryable] for a
// throttle Devin sent under a non-throttle code; null otherwise.
function rewordedThrottle(code, detail) {
  if (code === 'permission_denied' && HIGH_DEMAND_RE.test(detail)) return CONNECT_CODES.resource_exhausted;
  if (code === 'failed_precondition' && SPENT_QUOTA_RE.test(detail)) return CONNECT_CODES.resource_exhausted;
  return null;
}

function sanitizeDetail(text) {
  const normalized = String(text || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized || /^(?:<!doctype\s+html\b|<html\b)/i.test(normalized)) return '';
  // Control characters or broken surrogates mean binary or hostile output.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: detects control characters in untrusted server text
  if (/[\u0000-\u001f\u007f-\u009f]/.test(normalized) || !normalized.isWellFormed()) return '';
  if (normalized.length <= MAX_ERROR_DETAIL_CHARS) return normalized;
  const cut = /[\ud800-\udbff]/.test(normalized[MAX_ERROR_DETAIL_CHARS - 1])
    ? MAX_ERROR_DETAIL_CHARS - 1
    : MAX_ERROR_DETAIL_CHARS;
  return `${normalized.slice(0, cut)}…`;
}

const REDACTED = '[redacted]';
// Credential shapes redacted even when the request did not carry them.
const CREDENTIAL_RE = /devin-session-token\$[^\s"'<>,;]+|\bBearer\s+[^\s"'<>,;]+|\beyJ[\w-]+\.[\w-]+\.[\w-]*/gi;

// Server diagnostics may echo what the request carried; every known secret
// and every credential-shaped token is replaced before text is surfaced.
function redactCredentials(text, secrets) {
  let out = String(text ?? '');
  for (const secret of secrets) out = out.replaceAll(secret, REDACTED);
  return out.replace(CREDENTIAL_RE, REDACTED);
}

// Every credential a request carries (`Metadata.apiKey`, `Metadata.userJwt`,
// assignment JWTs, credential headers), plus the bare token behind a scheme
// prefix (`devin-session-token$…`, `Bearer …`). Longest first so a secret that
// contains another is replaced whole.
function requestSecrets(message, headers) {
  const secrets = new Set();
  const add = (value) => {
    const text = typeof value === 'string' ? value.trim() : '';
    for (const candidate of [text, text.slice(text.lastIndexOf('$') + 1), text.replace(/^Bearer\s+/i, '')]) {
      if (candidate) secrets.add(candidate);
    }
  };
  for (const source of [message, message?.metadata]) {
    for (const [key, value] of Object.entries(source || {})) {
      if (/(?:apiKey|Jwt|Token)$/i.test(key)) add(value);
    }
  }
  for (const [name, value] of Object.entries(headers || {})) {
    if (/authorization|cookie|token|jwt|api[-_]?key/i.test(name)) add(value);
  }
  return [...secrets].sort((a, b) => b.length - a.length);
}

function summarizeDetails(details, secrets) {
  if (!Array.isArray(details)) return '';
  const parts = [];
  for (const entry of details) {
    if (!entry || typeof entry !== 'object') continue;
    const type = typeof entry.type === 'string' ? entry.type : '';
    let evidence = typeof entry.value === 'string' ? entry.value : '';
    if (entry.debug !== undefined) {
      try {
        evidence = typeof entry.debug === 'string' ? entry.debug : JSON.stringify(entry.debug);
      } catch {}
    }
    const part = [type, evidence].filter(Boolean).join(': ');
    if (part) parts.push(part);
  }
  return sanitizeDetail(redactCredentials(parts.join('; '), secrets));
}

function retryAfterMsOf(headers) {
  const value = headers?.get?.('retry-after');
  if (!value) return undefined;
  const ms = retryAfterMsFromError({ headers: { 'retry-after': value } });
  return Number.isFinite(ms) ? ms : undefined;
}

function connectError(
  { connectCode = '', message = '', details, status = 0, headers, operation = 'request' },
  secrets
) {
  let code = String(connectCode || HTTP_STATUS_CONNECT_CODE[status] || '').toLowerCase();
  // Server-chosen codes outside the Connect vocabulary are never surfaced.
  if (code && !Object.hasOwn(CONNECT_CODES, code)) code = 'unknown';
  if (!code && status >= 500) code = 'internal';
  if (!code && status === 413) code = 'resource_exhausted';
  const detail = sanitizeDetail(redactCredentials(message, secrets));
  const reworded = rewordedThrottle(code, detail);
  const [mixdogCode, mappedStatus, retryable] = reworded ||
    CONNECT_CODES[code] || ['internal', status || 500, status >= 500];
  const detailsSummary = summarizeDetails(details, secrets);
  const tooLarge =
    status === 413 ||
    (mixdogCode === 'resource_exhausted' && detail && !THROTTLE_RE.test(detail) && TOO_LARGE_RE.test(detail));
  const finalCode = tooLarge ? 'request_too_large' : mixdogCode;
  const head = `Devin ${operation} ${code || 'error'}${status ? ` (HTTP ${status})` : ''}`;
  const text = [head, detail].filter(Boolean).join(': ') + (detailsSummary ? ` [details: ${detailsSummary}]` : '');
  // A reworded throttle reports its throttle status, not the carrier's.
  const carrierStatus = reworded ? mappedStatus : status || mappedStatus;
  const error = new DevinWireError(text, {
    code: finalCode,
    status: tooLarge ? 413 : carrierStatus,
    retryable: tooLarge ? false : retryable,
    connectCode: code,
    detail: [detail, detailsSummary].filter(Boolean).join(' '),
    retryAfterMs: retryAfterMsOf(headers),
  });
  return error;
}

// Builds the error for a Connect `{ code, message, details }` object, an HTTP
// status, or both. `status` is the real HTTP status when there was one.
// Credential-shaped tokens in server text are redacted.
export function devinConnectError(fields) {
  return connectError(fields, []);
}

function protocolError(message, { retryable = false, cause } = {}) {
  return new DevinWireError(`Devin protocol error: ${message}`, { code: 'protocol', retryable, cause });
}

// Requests carry credentials in the body, so a redirect is never followed:
// the body would be replayed to a host nobody validated.
function redirectError(status = 0) {
  return new DevinWireError('Devin server redirected the request; redirects are refused', {
    code: 'protocol',
    status,
    retryable: false,
  });
}

function isAbort(error, signal) {
  return signal?.aborted || error?.name === 'AbortError' || error?.code === 'ABORT_ERR';
}

function abortedError(cause) {
  return new DevinWireError('Devin request aborted', { code: 'aborted', status: 499, retryable: false, cause });
}

// A copy of a transport error chain with credentials redacted from every message.
function redactedCause(error, secrets, depth = 0) {
  if (!(error instanceof Error) || depth > 4) return undefined;
  const copy = new Error(redactCredentials(error.message, secrets));
  copy.name = error.name;
  if (typeof error.code === 'string') copy.code = error.code;
  const inner = redactedCause(error.cause, secrets, depth + 1);
  if (inner) copy.cause = inner;
  return copy;
}

// Normalizes anything thrown by fetch/body reading into a DevinWireError.
function transportError(error, signal, secrets) {
  if (error instanceof DevinWireError) return error;
  if (isAbort(error, signal)) return abortedError(error);
  // fetch with `redirect: 'error'` rejects a redirect as a network error.
  if (error?.cause?.message === 'unexpected redirect') return redirectError();
  return new DevinWireError(`Devin connection failed: ${redactCredentials(error?.message || error, secrets)}`, {
    code: 'unavailable',
    status: 0,
    retryable: true,
    cause: redactedCause(error, secrets),
  });
}

function inflateSync(payload, maxDecompressedBytes) {
  try {
    return new Uint8Array(gunzipSync(payload, { maxOutputLength: maxDecompressedBytes }));
  } catch (error) {
    if (error?.code === 'ERR_BUFFER_TOO_LARGE') {
      throw protocolError(`decompressed payload exceeds ${maxDecompressedBytes}-byte cap`, { cause: error });
    }
    throw protocolError('invalid gzip payload', { cause: error });
  }
}

function decodeOrThrow(typeName, bytes) {
  try {
    return decodeDevinMessage(typeName, bytes);
  } catch (error) {
    throw protocolError(`malformed ${typeName}: ${error.message}`, { cause: error });
  }
}

export function encodeDevinFrame(payload, flags = 0) {
  const frame = new Uint8Array(FRAME_HEADER_BYTES + payload.length);
  frame[0] = flags;
  new DataView(frame.buffer).setUint32(1, payload.length, false);
  frame.set(payload, FRAME_HEADER_BYTES);
  return frame;
}

// Incremental envelope reader. Chunks are kept as received and joined only
// once a frame's announced length has fully arrived.
export function createDevinFrameReader({ maxFrameBytes = DEVIN_MAX_FRAME_BYTES } = {}) {
  const chunks = [];
  let buffered = 0;

  const take = (size) => {
    const out = new Uint8Array(size);
    let offset = 0;
    while (offset < size) {
      const chunk = chunks[0];
      const needed = size - offset;
      if (chunk.length <= needed) {
        out.set(chunk, offset);
        offset += chunk.length;
        chunks.shift();
      } else {
        out.set(chunk.subarray(0, needed), offset);
        chunks[0] = chunk.subarray(needed);
        offset = size;
      }
    }
    buffered -= size;
    return out;
  };

  const peekHeader = () => {
    const header = new Uint8Array(FRAME_HEADER_BYTES);
    let offset = 0;
    for (const chunk of chunks) {
      const part = chunk.subarray(0, FRAME_HEADER_BYTES - offset);
      header.set(part, offset);
      offset += part.length;
      if (offset === FRAME_HEADER_BYTES) break;
    }
    return header;
  };

  return {
    // Returns every frame completed by `chunk`, in wire order.
    push(chunk) {
      if (chunk?.length) {
        chunks.push(chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk));
        buffered += chunk.length;
      }
      const frames = [];
      while (buffered >= FRAME_HEADER_BYTES) {
        const header = peekHeader();
        const flags = header[0];
        const length = new DataView(header.buffer).getUint32(1, false);
        if (length > maxFrameBytes) {
          throw protocolError(`frame length ${length} exceeds ${maxFrameBytes}-byte cap`);
        }
        if (buffered < FRAME_HEADER_BYTES + length) break;
        take(FRAME_HEADER_BYTES);
        frames.push({ flags, payload: take(length) });
      }
      return frames;
    },
    get bufferedBytes() {
      return buffered;
    },
  };
}

const textDecoder = new TextDecoder('utf-8', { fatal: true });
const lenientTextDecoder = new TextDecoder('utf-8');

// A trailer that is not JSON carries no error: the stream simply ended.
// Tolerated on purpose: established clients of this service accept such a
// trailer, and whether the server ever sends one cannot be ruled out, so
// rejecting it could fail every turn. Completion still requires the
// end-of-stream frame itself.
function readTrailer(bytes, operation, secrets) {
  let parsed;
  try {
    parsed = JSON.parse(lenientTextDecoder.decode(bytes).trim());
  } catch {
    return null;
  }
  const error = parsed?.error;
  if (!error || typeof error !== 'object') return null;
  const connectCode = typeof error.code === 'string' ? error.code : '';
  const message = typeof error.message === 'string' ? error.message : '';
  if (!connectCode && !message) return null;
  const metadata = parsed.metadata && typeof parsed.metadata === 'object' ? parsed.metadata : {};
  const retryAfter = [metadata['retry-after']].flat()[0];
  return connectError(
    {
      connectCode: connectCode || 'unknown',
      message,
      details: error.details,
      operation,
      headers: retryAfter == null ? undefined : new Headers({ 'retry-after': String(retryAfter) }),
    },
    secrets
  );
}

// Parses an end-of-stream payload; returns the DevinWireError it carries or null.
export function parseDevinTrailer(bytes, operation = 'stream') {
  return readTrailer(bytes, operation, []);
}

function requestUrl(baseUrl, path) {
  return `${String(baseUrl).replace(/\/+$/, '')}${path}`;
}

async function readBody(response, maxBytes, signal, secrets) {
  if (!response.body) return new Uint8Array(0);
  const reader = response.body.getReader();
  const parts = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > maxBytes) throw protocolError(`response body exceeds ${maxBytes}-byte cap`);
      parts.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw transportError(error, signal, secrets);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

// Error body of a failed HTTP response: Connect JSON `{ code, message }` when present.
async function httpError(response, operation, signal, secrets) {
  let connectCode = '';
  let message = '';
  let details;
  try {
    const bytes = await readBody(response, 64 * 1024, signal, secrets);
    const contentType = response.headers.get('content-type') || '';
    if (!/text\/html/i.test(contentType)) {
      const text = textDecoder.decode(bytes).trim();
      try {
        const parsed = JSON.parse(text);
        if (typeof parsed?.code === 'string') connectCode = parsed.code;
        message = [parsed?.message, parsed?.error, parsed?.error?.message].find((v) => typeof v === 'string') ?? '';
        details = parsed?.details;
      } catch {
        message = text;
      }
    }
  } catch (error) {
    if (error instanceof DevinWireError && error.code === 'aborted') throw error;
  }
  return connectError(
    { connectCode, message, details, status: response.status, headers: response.headers, operation },
    secrets
  );
}

async function post({ baseUrl, path, body, headers, fetchFn, signal, secrets }) {
  if (signal?.aborted) throw abortedError(signal.reason);
  let response;
  try {
    response = await fetchFn(requestUrl(baseUrl, path), { method: 'POST', headers, body, signal, redirect: 'error' });
  } catch (error) {
    throw transportError(error, signal, secrets);
  }
  // A fetch that hands back a redirect instead of rejecting it is refused too.
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel().catch(() => {});
    throw redirectError(response.status);
  }
  return response;
}

function operationName(path) {
  return String(path).split('/').filter(Boolean).pop() || 'request';
}

export async function devinUnary({
  baseUrl,
  path,
  requestType,
  responseType,
  message = {},
  headers = {},
  fetchFn = fetch,
  signal,
  maxResponseBytes = DEVIN_MAX_FRAME_BYTES,
  maxDecompressedBytes = DEVIN_MAX_DECOMPRESSED_BYTES,
}) {
  const operation = operationName(path);
  const secrets = requestSecrets(message, headers);
  const response = await post({
    baseUrl,
    path,
    body: encodeDevinMessage(requestType, message),
    headers: { ...DEVIN_UNARY_HEADERS, ...headers },
    fetchFn,
    signal,
    secrets,
  });
  if (!response.ok) throw await httpError(response, operation, signal, secrets);
  let bytes = await readBody(response, maxResponseBytes, signal, secrets);
  // Some edges return a gzip body without Content-Encoding. A protobuf message
  // can never start with 0x1f (wire type 7), so the magic is unambiguous.
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) bytes = inflateSync(bytes, maxDecompressedBytes);
  return decodeOrThrow(responseType, bytes);
}

export async function* devinStream({
  baseUrl,
  path,
  requestType,
  responseType,
  message = {},
  headers = {},
  fetchFn = fetch,
  signal,
  maxFrameBytes = DEVIN_MAX_FRAME_BYTES,
  maxDecompressedBytes = DEVIN_MAX_DECOMPRESSED_BYTES,
}) {
  const operation = operationName(path);
  const secrets = requestSecrets(message, headers);
  const body = encodeDevinFrame(gzipSync(encodeDevinMessage(requestType, message)), DEVIN_COMPRESSED_FLAG);
  const response = await post({
    baseUrl,
    path,
    body,
    headers: { ...DEVIN_STREAM_HEADERS, ...headers },
    fetchFn,
    signal,
    secrets,
  });
  if (!response.ok) throw await httpError(response, operation, signal, secrets);
  if (!response.body) throw protocolError('response body is empty', { retryable: true });

  const reader = response.body.getReader();
  const frames = createDevinFrameReader({ maxFrameBytes });
  // Whether the end-of-stream trailer arrived. The body is read to its end: an
  // error-free trailer does not stop it, but a body that stops without one (a
  // frame boundary included) was cut short.
  let terminated = false;
  try {
    for (;;) {
      let chunk;
      try {
        chunk = await reader.read();
      } catch (error) {
        throw transportError(error, signal, secrets);
      }
      if (chunk.done) break;
      // Only the compressed and end-of-stream bits carry meaning; others are ignored.
      for (const { flags, payload } of frames.push(chunk.value)) {
        const bytes = flags & DEVIN_COMPRESSED_FLAG ? inflateSync(payload, maxDecompressedBytes) : payload;
        if (flags & DEVIN_END_STREAM_FLAG) {
          const trailerError = readTrailer(bytes, operation, secrets);
          if (trailerError) throw trailerError;
          terminated = true;
          continue;
        }
        yield decodeOrThrow(responseType, bytes);
      }
    }
    if (frames.bufferedBytes) {
      throw protocolError(`stream ended inside a frame (${frames.bufferedBytes} bytes buffered)`, { retryable: true });
    }
    if (!terminated) throw protocolError('stream ended without an end-of-stream trailer', { retryable: true });
  } finally {
    await reader.cancel().catch(() => {});
  }
}
