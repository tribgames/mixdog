// Shared request-body compression for provider POSTs (Anthropic gzip, Codex
// zstd). Policy in one place:
//  - bodies below REQ_COMPRESSION_MIN_BYTES are never compressed (CPU + header
//    cost outweighs the upload saving);
//  - a request that already carries Content-Encoding is never double-encoded;
//  - a compression failure fails open to the plain body;
//  - a 400/415 on a compressed request is drained and the SAME request is
//    resent once uncompressed; compression latches off process-wide only when
//    that plain resend succeeds (the encoding was the cause). If the resend
//    fails too, nothing latches and the resend's response is returned.
import { promisify } from 'node:util';
import { gzip } from 'node:zlib';

export const REQ_COMPRESSION_MIN_BYTES = 8 * 1024;

export function createCompressionLatch(envVar) {
  let latched = false;
  return {
    disabled: () => latched || process.env[envVar] === '0',
    latchOff: () => {
      latched = true;
    },
    reset: () => {
      latched = false;
    },
  };
}

// One latch for every api.anthropic.com /v1/messages path (OAuth + API key).
export const anthropicGzipLatch = createCompressionLatch('MIXDOG_ANTHROPIC_REQ_GZIP');
// Compress on the libuv threadpool so large turn bodies never block the main thread.
export const gzipAsync = promisify(gzip);

export const hasContentEncoding = (headers) => new Headers(headers || {}).has('content-encoding');

export function withContentEncoding(headers, encoding) {
  if (headers instanceof Headers || Array.isArray(headers)) {
    const next = new Headers(headers);
    next.delete('content-length');
    next.set('Content-Encoding', encoding);
    return next;
  }
  const rest = Object.fromEntries(
    Object.entries(headers || {}).filter(([name]) => name.toLowerCase() !== 'content-length')
  );
  return { ...rest, 'Content-Encoding': encoding };
}

// Fail open: any compression error yields the plain body.
export async function compressBody(raw, compress, encoding) {
  try {
    return { bytes: await compress(raw), encoding };
  } catch {
    return { bytes: raw, encoding: null };
  }
}

export const isEncodingRejection = (response) => response.status === 400 || response.status === 415;

export async function resendIfEncodingRejected({ response, encoded, resend, latch }) {
  if (!encoded || !isEncodingRejection(response)) return response;
  try {
    await response.arrayBuffer();
  } catch {
    /* drain best-effort */
  }
  const retry = await resend();
  if (retry.ok) latch.latchOff();
  return retry;
}

/**
 * Send `raw` compressed when eligible, with the rejection resend above.
 * `send(bytes, headers)` performs one HTTP request.
 */
export async function sendWithCompression({ raw, headers, encoding, compress, latch, send }) {
  const plain = () => send(raw, headers);
  if (latch.disabled() || raw.length < REQ_COMPRESSION_MIN_BYTES || hasContentEncoding(headers)) return plain();
  const packed = await compressBody(raw, compress, encoding);
  if (!packed.encoding) return plain();
  const response = await send(packed.bytes, withContentEncoding(headers, encoding));
  return resendIfEncodingRejected({ response, encoded: true, resend: plain, latch });
}

export const sendGzipCompressed = ({ compress = gzipAsync, ...rest }) =>
  sendWithCompression({ ...rest, encoding: 'gzip', compress, latch: anthropicGzipLatch });
