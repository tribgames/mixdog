// channel-client/daemon-request.mjs
// One JSON request to the local channel daemon (127.0.0.1 only), the health
// probe built on it, and the tool-call wrapper that classifies failures.
import http from 'node:http';

export function request({
  port,
  method = 'GET',
  path = '/',
  token,
  body = null,
  timeoutMs = 10_000,
  agent = undefined,
}) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : JSON.stringify(body);
    let req = null;
    let response = null;
    let ended = false;
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      fn(value);
    };
    const fail = (error) => finish(reject, error instanceof Error ? error : new Error(String(error)));
    const lifecycleTimeout = () => {
      const error = new Error(`daemon request timed out: ${method} ${path}`);
      fail(error);
      try {
        response?.destroy?.(error);
      } catch {}
      try {
        req?.destroy?.(error);
      } catch {}
    };
    // http.request's timeout is socket-idle only. This deadline covers headers
    // and the entire response body so a truncated post-header response cannot
    // leave reconnect registration pending forever.
    const deadline = setTimeout(lifecycleTimeout, timeoutMs);
    deadline.unref?.();
    req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method,
        agent,
        headers: {
          ...(token ? { 'X-Mixdog-Daemon-Token': token } : {}),
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
        },
        timeout: timeoutMs,
      },
      (res) => {
        response = res;
        if (settled) {
          try {
            res.resume?.();
          } catch {}
          return;
        }
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          if (!settled) data += chunk;
        });
        res.once('aborted', () => fail(new Error(`daemon response aborted: ${method} ${path}`)));
        res.once('error', (error) => fail(error));
        res.once('end', () => {
          ended = true;
          let parsed = null;
          try {
            parsed = data ? JSON.parse(data) : null;
          } catch {}
          if (res.statusCode && res.statusCode >= 400) {
            const err = new Error(parsed?.error || data || `HTTP ${res.statusCode}`);
            err.statusCode = res.statusCode;
            fail(err);
            return;
          }
          finish(resolve, parsed ?? {});
        });
        res.once('close', () => {
          if (!ended && !settled) fail(new Error(`daemon response closed before end: ${method} ${path}`));
        });
      }
    );
    req.on('error', fail);
    req.on('timeout', lifecycleTimeout);
    if (payload) req.write(payload);
    req.end();
  });
}

export async function probeChannelHealth({ port, token, timeoutMs = 800 } = {}) {
  try {
    const health = await request({ port, token, path: '/health', timeoutMs });
    return health?.status === 'ok' ? health : null;
  } catch {
    return null;
  }
}

/** call(name, args, { timeoutMs, callId }) over POST /call. A transport
 *  failure (daemon dead/restarted/unreachable) is tagged daemonTransportError
 *  so the worker's execute() drops this stale attach and re-attaches instead
 *  of surfacing it as a tool error; tool errors come back as {error} (200)
 *  and keep the daemon's machine-readable `code`. */
export function createChannelCall({ port, serverToken, agent, getClientToken }) {
  return async function call(name, args = {}, { timeoutMs = 120_000, callId = null } = {}) {
    let out;
    try {
      out = await request({
        port,
        token: serverToken,
        method: 'POST',
        path: '/call',
        // callId (stable across a logical call's retries) lets the daemon dedup
        // a retried transport failure to a single side-effect.
        body: { token: getClientToken(), name, args: args || {}, ...(callId ? { callId } : {}) },
        timeoutMs,
        agent,
      });
    } catch (err) {
      err.daemonTransportError = true;
      throw err;
    }
    if (out?.error) {
      const err = new Error(out.error);
      if (out.code) err.code = String(out.code);
      throw err;
    }
    return out?.result;
  };
}
