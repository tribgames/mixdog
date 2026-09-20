import http from 'node:http';

export const TRANSIENT_MEMORY_RPC_BACKOFF_MS = 400;

export function isConnResetLikeError(err) {
  const code = String(err?.code || '');
  const msg = String(err?.message || err || '');
  return code === 'ECONNRESET' || code === 'ECONNREFUSED' || /ECONNRESET|socket hang up/i.test(msg);
}

export function isMemoryWorkerNotReadyError(err) {
  const msg = String(err?.message || err || '');
  return /memory worker exited before ready|memory worker ready timeout|memory runtime did not become ready|memory worker degraded|memory worker draining/i.test(
    msg
  );
}

export function isTransientMemoryRpcError(err) {
  return isConnResetLikeError(err) || isMemoryWorkerNotReadyError(err);
}

export function memoryAbortError(reason) {
  if (reason instanceof Error) return reason;
  const error = new Error(typeof reason === 'string' && reason ? reason : 'memory proxy request aborted');
  error.name = 'AbortError';
  error.code = 'ABORT_ERR';
  return error;
}

function parseResponse(res, data, { resolve, reject }) {
  let parsed = null;
  try {
    parsed = data ? JSON.parse(data) : null;
  } catch {}
  if (res.statusCode && res.statusCode >= 400) {
    const message = parsed?.error || parsed?.content?.[0]?.text || data || `HTTP ${res.statusCode}`;
    const error = new Error(message);
    error.statusCode = res.statusCode;
    reject(error);
    return;
  }
  resolve(parsed ?? { raw: data });
}

// One JSON request against the loopback daemon. Settles exactly once; an
// abort signal destroys the in-flight request (or rejects before it starts).
export function requestJson({
  port,
  method = 'GET',
  path = '/',
  body = null,
  timeoutMs = 10_000,
  headers = {},
  signal = null,
}) {
  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    let req = null;
    const cleanup = () => {
      try {
        signal?.removeEventListener?.('abort', onAbort);
      } catch {}
    };
    const resolve = (value) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolvePromise(value);
    };
    const reject = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      rejectPromise(error);
    };
    const onAbort = () => {
      const error = memoryAbortError(signal?.reason);
      if (req) req.destroy(error);
      else reject(error);
    };
    if (signal?.aborted) {
      reject(memoryAbortError(signal.reason));
      return;
    }
    const payload = body == null ? null : JSON.stringify(body);
    req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method,
        headers: {
          ...headers,
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
        },
        timeout: timeoutMs,
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => parseResponse(res, data, { resolve, reject }));
        res.on('error', reject);
      }
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy(new Error(`memory proxy request timed out: ${method} ${path}`));
    });
    try {
      signal?.addEventListener?.('abort', onAbort, { once: true });
    } catch {}
    if (signal?.aborted) {
      onAbort();
      return;
    }
    if (payload) req.write(payload);
    req.end();
  });
}
