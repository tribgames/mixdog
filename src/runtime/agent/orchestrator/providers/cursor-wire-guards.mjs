import { mergeFlatSchemaProperty } from './lib/flat-schema-merge.mjs';
import { REAUTH_GUIDANCE } from './cursor-auth.mjs';
import { isTransientErrorCode } from './provider-error-kind.mjs';

const SCHEMA_ANNOTATIONS = new Set([
  '$comment',
  '$id',
  '$schema',
  'default',
  'deprecated',
  'examples',
  'readOnly',
  'title',
  'writeOnly',
]);

export const MAX_CONNECT_FRAME_BYTES = 64 * 1024 * 1024;
export const MAX_CHECKPOINT_BYTES = 48 * 1024 * 1024;
export const MAX_TOOL_TEXT_BYTES = 512 * 1024;
const MAX_TOOL_MEDIA_BYTES = 16 * 1024 * 1024;
const MAX_USER_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_CONVERSATION_BLOB_BYTES = 128 * 1024 * 1024;
const MAX_CONVERSATION_BLOB_ENTRIES = 512;
const MAX_INDIVIDUAL_BLOB_BYTES = 32 * 1024 * 1024;

function boundedInteger(value, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min) return fallback;
  return Math.min(max, Math.floor(parsed));
}

export function resolveCursorStreamTuning(env = process.env) {
  return {
    idleTimeoutMs: boundedInteger(env.MIXDOG_CURSOR_STREAM_IDLE_TIMEOUT_MS, 180_000),
    parkTimeoutMs: boundedInteger(env.MIXDOG_CURSOR_STREAM_PARK_TIMEOUT_MS, 45_000, { min: 1_000 }),
    maxRetries: boundedInteger(env.MIXDOG_CURSOR_STREAM_IDLE_MAX_RETRIES, 5, { max: 10 }),
    // Transport retry: 250ms base, 2s ceiling.
    retryBaseDelayMs: boundedInteger(env.MIXDOG_CURSOR_STREAM_RETRY_BASE_MS, 250, { max: 60_000 }),
    retryMaxDelayMs: boundedInteger(env.MIXDOG_CURSOR_STREAM_RETRY_MAX_MS, 2_000, { max: 120_000 }),
    // A rate limit gets one recovery (min(1, maxRetries)).
    maxThrottleRetries: boundedInteger(env.MIXDOG_CURSOR_THROTTLE_MAX_RETRIES, 1, { max: 5 }),
    // One credential-refresh retry; the outer provider layer adds none for a
    // stream that already ran, and re-sending a rejected credential only
    // hammers the token endpoint.
    maxAuthRetries: boundedInteger(env.MIXDOG_CURSOR_AUTH_MAX_RETRIES, 1, { max: 5 }),
  };
}

function slimSchema(value, depth = 0) {
  if (value == null || depth > 12) return value;
  if (Array.isArray(value)) return value.map((entry) => slimSchema(entry, depth + 1));
  if (typeof value !== 'object') return value;
  const output = {};
  for (const [key, child] of Object.entries(value)) {
    if (SCHEMA_ANNOTATIONS.has(key) || child === undefined) continue;
    if (key === 'additionalProperties' && child === true) continue;
    if (key === 'required' && Array.isArray(child) && child.length === 0) continue;
    output[key] = slimSchema(child, depth + 1);
  }
  return output;
}

function flattenCursorTopLevelCompoundSchema(schema) {
  const branches = [
    ...(Array.isArray(schema?.oneOf) ? schema.oneOf : []),
    ...(Array.isArray(schema?.anyOf) ? schema.anyOf : []),
    ...(Array.isArray(schema?.allOf) ? schema.allOf : []),
  ];
  if (!branches.length) return schema;
  const { oneOf: _oneOf, anyOf: _anyOf, allOf: _allOf, properties: rootProperties, ...root } = schema;
  const properties = structuredClone(rootProperties || {});
  for (const branch of branches) {
    for (const [name, property] of Object.entries(branch?.properties || {})) {
      properties[name] = mergeFlatSchemaProperty(properties[name], property);
    }
  }
  return {
    ...root,
    type: 'object',
    properties,
  };
}

export function prepareCursorToolDefinition(tool) {
  const fn = tool?.function || tool || {};
  const inputSchema =
    fn.parameters && typeof fn.parameters === 'object'
      ? flattenCursorTopLevelCompoundSchema(slimSchema(fn.parameters))
      : { type: 'object', properties: {} };
  return {
    name: fn.name,
    description: String(fn.description || ''),
    inputSchema,
  };
}

function truncateUtf8(value, maxBytes) {
  const text = String(value ?? '');
  const encoded = Buffer.from(text, 'utf8');
  if (encoded.length <= maxBytes) return text;
  const notice = Buffer.from('\n\n[Mixdog truncated this Cursor tool result to stay within the wire limit.]');
  const end = Math.max(0, maxBytes - notice.length);
  const clipped = encoded
    .subarray(0, end)
    .toString('utf8')
    .replace(/\uFFFD$/u, '');
  return `${clipped}${notice.toString('utf8')}`;
}

export function capCursorToolResult(result) {
  const media = [];
  let mediaBytes = 0;
  for (const image of Array.isArray(result?.media) ? result.media : []) {
    const bytes = image?.data instanceof Uint8Array ? image.data : null;
    if (!bytes || bytes.byteLength > MAX_TOOL_MEDIA_BYTES) continue;
    if (mediaBytes + bytes.byteLength > MAX_TOOL_MEDIA_BYTES) break;
    media.push(image);
    mediaBytes += bytes.byteLength;
  }
  return {
    ...result,
    content: truncateUtf8(result?.content, MAX_TOOL_TEXT_BYTES),
    media,
  };
}

export function assertCursorUserImages(images) {
  for (const image of images || []) {
    const size = image?.data?.byteLength || 0;
    if (size > MAX_USER_IMAGE_BYTES) {
      const error = new Error(`Cursor image exceeds ${MAX_USER_IMAGE_BYTES} bytes`);
      error.code = 'cursor_payload_too_large';
      throw error;
    }
  }
}

function blobBytes(blobs) {
  let total = 0;
  for (const value of blobs.values()) total += value?.byteLength || 0;
  return total;
}

export function storeCursorBlob(blobs, key, value) {
  const data = value instanceof Uint8Array ? value : new Uint8Array(value);
  if (data.byteLength > MAX_INDIVIDUAL_BLOB_BYTES) {
    const error = new Error(`Cursor blob exceeds ${MAX_INDIVIDUAL_BLOB_BYTES} bytes`);
    error.code = 'cursor_payload_too_large';
    throw error;
  }
  if (blobs.has(key)) blobs.delete(key);
  blobs.set(key, data);
  while (blobs.size > MAX_CONVERSATION_BLOB_ENTRIES || blobBytes(blobs) > MAX_CONVERSATION_BLOB_BYTES) {
    const oldest = blobs.keys().next().value;
    if (oldest === undefined || (oldest === key && blobs.size === 1)) break;
    blobs.delete(oldest);
  }
  return data;
}

export function createCursorByteQueue() {
  let chunks = [];
  let chunkIndex = 0;
  let chunkOffset = 0;
  let byteLength = 0;

  const compact = () => {
    if (chunkIndex < 64) return;
    chunks = chunks.slice(chunkIndex);
    chunkIndex = 0;
  };
  const copy = (count, consume) => {
    if (count > byteLength) throw new Error('Cursor byte queue underflow');
    const output = Buffer.allocUnsafe(count);
    let written = 0;
    let index = chunkIndex;
    let offset = chunkOffset;
    while (written < count) {
      const chunk = chunks[index];
      const take = Math.min(count - written, chunk.length - offset);
      chunk.copy(output, written, offset, offset + take);
      written += take;
      offset += take;
      if (offset === chunk.length) {
        index += 1;
        offset = 0;
      }
    }
    if (consume) {
      chunkIndex = index;
      chunkOffset = offset;
      byteLength -= count;
      compact();
    }
    return output;
  };

  return {
    get byteLength() {
      return byteLength;
    },
    append(value) {
      const chunk = Buffer.from(value);
      if (!chunk.length) return;
      chunks.push(chunk);
      byteLength += chunk.length;
    },
    peek(count) {
      return copy(count, false);
    },
    read(count) {
      return copy(count, true);
    },
  };
}

export function createCursorStreamWatchdog({ idleTimeoutMs, parkTimeoutMs, onTimeout }) {
  let timer = null;
  let stopped = false;
  const arm = (timeoutMs, kind) => {
    if (timer) clearTimeout(timer);
    timer = null;
    if (stopped || timeoutMs <= 0) return;
    timer = setTimeout(() => onTimeout(kind), timeoutMs);
    timer.unref?.();
  };
  return {
    start() {
      arm(idleTimeoutMs, 'idle');
    },
    progress(kind) {
      if (kind === 'work') arm(idleTimeoutMs, 'idle');
      else if (kind === 'park') arm(parkTimeoutMs, 'park');
    },
    // Suspend both deadlines during an intentional retry wait; the next
    // start()/progress('work'|'park') re-arms them, so only real stream
    // silence is ever counted.
    pause() {
      if (timer) clearTimeout(timer);
      timer = null;
    },
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}

export function cursorInteractionProgress(update) {
  if (!update) return 'none';
  if (update.heartbeat) return 'liveness';
  if (update.textDelta?.text || update.thinkingDelta?.text) return 'work';
  if (
    update.tokenDelta ||
    update.toolCallStarted ||
    update.toolCallCompleted ||
    update.partialToolCall ||
    update.toolCallDelta ||
    update.thinkingCompleted ||
    update.summary ||
    update.summaryStarted ||
    update.summaryCompleted ||
    update.stepStarted ||
    update.stepCompleted ||
    update.turnEnded
  )
    return 'work';
  return 'none';
}

// Codes that describe a transient server verdict or a recognized transport
// truncation. Everything else (protocol/decoding errors, 4xx verdicts,
// unknown failures) is deterministic and is never replayed in place.
const TRANSIENT_STREAM_CODES = new Set([
  'unavailable',
  'internal',
  'deadline_exceeded',
  'stream_aborted',
  'goaway',
  'connection_timeout',
  'stream_idle_timeout',
  'stream_park_timeout',
  'incomplete_stream',
  'ERR_HTTP2_STREAM_CANCEL',
  'ERR_HTTP2_GOAWAY_SESSION',
]);

// Protocol-mismatch check: Cursor wraps a wire mismatch in `internal`, and
// re-sending a request the schema cannot decode only burns the retry budget.
// Tested on the server's own detail, before the transient code is trusted.
const PROTOCOL_DRIFT_RE = /\b(protocol|protobuf|wire drift|invalid argument|failed_precondition)\b/i;

export function isCursorProtocolDrift(error) {
  if (error?.code === 'protocol_error') return true;
  return PROTOCOL_DRIFT_RE.test(String(error?.cursorDetail ?? ''));
}

export function isRetryableCursorStreamError(error) {
  if (error?.name === 'AbortError') return false;
  const code = String(error?.code || '');
  if (!TRANSIENT_STREAM_CODES.has(code) && !isTransientErrorCode(code)) return false;
  return !isCursorProtocolDrift(error);
}

// Rejected credentials: worth one forced token refresh before giving up.
export function isCursorAuthError(error) {
  if (error?.name === 'AbortError') return false;
  return error?.code === 'unauthenticated' || error?.code === 'permission_denied';
}

// Credentials for in-place restarts. Every retry force-refreshes and keeps the
// previous token if the refresh fails; a rejected credential is
// only retried when the refresh produced a different token.
export function createCursorCredentialRefresher(initialToken, getAccessToken) {
  let current = initialToken;
  return {
    async refresh(reason, error) {
      let next = current;
      if (getAccessToken) {
        try {
          next = (await getAccessToken({ forceRefresh: true })) || current;
        } catch {
          /* keep the previous token */
        }
      }
      if (reason === 'auth' && next === current) throw error;
      current = next;
      return current;
    },
  };
}

// Final-failure guidance appended once to the original Cursor detail
// (transport-failure hint).
export function withCursorFailureHint(error) {
  if (!(error instanceof Error) || error.cursorHintApplied) return error;
  const hint = isCursorAuthError(error)
    ? REAUTH_GUIDANCE
    : isCursorProtocolDrift(error)
      ? 'Cursor may have changed its wire protocol; update Mixdog or set MIXDOG_CURSOR_CLIENT_VERSION if this persists.'
      : '';
  if (!hint) return error;
  error.cursorHintApplied = true;
  error.message = `${error.message} ${hint}`;
  return error;
}

// resource_exhausted / 429 that is a throttle, not an oversized request.
export function isCursorThrottleError(error) {
  if (error?.name === 'AbortError' || error?.code === 'request_too_large') return false;
  return error?.code === 'resource_exhausted' || Number(error?.httpStatus || error?.status || 0) === 429;
}
