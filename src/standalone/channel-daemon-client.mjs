// Machine-global channels daemon — attach client (TUI side).
//
// Mirrors the memory proxy's attach pattern (POST /client/register + /health,
// 127.0.0.1 only). A TUI uses this to talk to the ONE shared channels daemon
// instead of forking its own worker: tool calls go over POST /call and the
// worker->parent notify path arrives on a persistent SSE stream (GET /events),
// replacing the old node-IPC `{type:'notify'}` messages.
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

function parsePid(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function parsePort(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : null;
}

function isPidAlive(pid) {
  const n = parsePid(pid);
  if (!n) return false;
  try { process.kill(n, 0); return true; }
  catch (error) { return error?.code === 'EPERM'; }
}

// Read + validate the discovery file. Returns null when missing/corrupt or when
// the recorded pid is dead (stale daemon) so the caller reclaims + respawns.
export function readDaemonDiscovery(discoveryPath) {
  let raw;
  try { raw = JSON.parse(readFileSync(discoveryPath, 'utf8')); }
  catch { return null; }
  const port = parsePort(raw?.port);
  const pid = parsePid(raw?.pid);
  if (!port || !pid || !raw?.token) return null;
  if (!isPidAlive(pid)) return null; // dead daemon → treat as absent
  return { port, pid, token: String(raw.token) };
}

function request({ port, method = 'GET', path = '/', token, body = null, timeoutMs = 10_000 }) {
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
      try { response?.destroy?.(error); } catch {}
      try { req?.destroy?.(error); } catch {}
    };
    // http.request's timeout is socket-idle only. This deadline covers headers
    // and the entire response body so a truncated post-header response cannot
    // leave reconnect registration pending forever.
    const deadline = setTimeout(lifecycleTimeout, timeoutMs);
    deadline.unref?.();
    req = http.request({
      hostname: '127.0.0.1',
      port,
      path,
      method,
      headers: {
        ...(token ? { 'X-Mixdog-Daemon-Token': token } : {}),
        ...(payload
          ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
          : {}),
      },
      timeout: timeoutMs,
    }, (res) => {
      response = res;
      if (settled) { try { res.resume?.(); } catch {} return; }
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { if (!settled) data += chunk; });
      res.once('aborted', () => fail(new Error(`daemon response aborted: ${method} ${path}`)));
      res.once('error', (error) => fail(error));
      res.once('end', () => {
        ended = true;
        let parsed = null;
        try { parsed = data ? JSON.parse(data) : null; } catch {}
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
    });
    req.on('error', fail);
    req.on('timeout', lifecycleTimeout);
    if (payload) req.write(payload);
    req.end();
  });
}

export async function probeDaemonHealth({ port, token, timeoutMs = 800 } = {}) {
  try {
    const health = await request({ port, token, path: '/health', timeoutMs });
    return health?.status === 'ok' ? health : null;
  } catch { return null; }
}

// Attach to a live daemon described by `discovery` ({port, token}). Registers
// this client, opens the notify SSE stream, and returns a handle whose call()
// dispatches channel tools over HTTP. onNotify receives the SAME
// `{type:'notify', method, params}` shape the old IPC path delivered, so the
// TUI-side onNotify handler stays unchanged (thin glue).
export async function attachToDaemon({
  discovery,
  leadPid = process.pid,
  cwd = process.cwd(),
  onNotify = () => {},
  log = () => {},
  onFatal = () => {},
} = {}) {
  const expectedPid = parsePid(discovery?.pid);
  if (!discovery?.port || !discovery?.token || !expectedPid) throw new Error('daemon discovery {port, pid, token} required');
  const { port, token: serverToken } = discovery;
  const staleDiscoveryError = (reason) => {
    const err = new Error(reason);
    err.daemonDiscoveryStale = true;
    return err;
  };
  const isExpectedDaemon = (health) => Number(health?.pid) === expectedPid;

  const initialHealth = await probeDaemonHealth({ port, token: serverToken, timeoutMs: 800 });
  if (!isExpectedDaemon(initialHealth)) throw staleDiscoveryError('daemon discovery pid does not match health');

  let reg;
  try {
    reg = await request({
      port,
      token: serverToken,
      method: 'POST',
      path: '/client/register',
      body: { leadPid, cwd },
      timeoutMs: 3000,
    });
  } catch (err) {
    if (err?.statusCode === 401 || err?.statusCode === 403) {
      const stale = staleDiscoveryError(`daemon register rejected (${err.statusCode})`);
      stale.daemonAuthRejected = true;
      throw stale;
    }
    throw err;
  }
  let clientToken = reg?.token;
  if (!clientToken) throw new Error('daemon register returned no client token');

  let sseReq = null;
  let closed = false;
  let fatal = false;
  let reconnectTimer = null;
  let reconnectProbe = false;
  let reconnectRegistration = null;
  let reconnectRegistrationId = null;
  let reconnectReplaceToken = null;
  let lifecycle = 0;
  let stableTimer = null;
  let closePromise = null;
  // Bounded reconnect is only for a verified-live daemon's transient SSE loss.
  // A stale/dead endpoint signals onFatal immediately so the owner re-reads
  // discovery instead of spinning against the captured port.
  let reconnectAttempts = 0;
  const MAX_RECONNECTS = 5;
  const STABLE_STREAM_MS = 5_000;

  async function deregister(token, { registrationId = null, replaceToken = null } = {}) {
    if (!token) return;
    try {
      await request({
        port, token: serverToken, method: 'POST', path: '/client/deregister',
        body: {
          token,
          ...(registrationId ? { registrationId, replaceToken, leadPid, cwd } : {}),
        },
        timeoutMs: 1500,
      });
    } catch { /* best-effort; daemon sweep reaps us */ }
  }

  function clearStableTimer() {
    if (stableTimer) { try { clearTimeout(stableTimer); } catch {} stableTimer = null; }
  }

  function signalFatal(reason) {
    if (closed || fatal) return;
    fatal = true;
    closed = true;
    lifecycle++;
    if (reconnectTimer) { try { clearTimeout(reconnectTimer); } catch {} reconnectTimer = null; }
    clearStableTimer();
    try { sseReq?.destroy?.(); } catch {}
    log(`sse stale endpoint (${reason}); signalling re-attach`);
    try { onFatal(reason); } catch {}
  }

  // A stream ending can be a transient connection loss, but must not leave this
  // client retrying a dead discovery endpoint. Verify that the original daemon
  // is still alive before spending the bounded reconnect budget on it.
  function handleStreamLoss(reason) {
    if (closed || fatal || reconnectTimer || reconnectProbe) return;
    reconnectProbe = true;
    void probeDaemonHealth({ port, token: serverToken, timeoutMs: 800 }).then((health) => {
      reconnectProbe = false;
      if (closed || fatal) return;
      if (!isExpectedDaemon(health)) {
        signalFatal(reason);
        return;
      }
      scheduleReconnect(reason);
    });
  }

  function openStream() {
    if (closed) return;
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: `/events?token=${encodeURIComponent(clientToken)}&server_token=${encodeURIComponent(serverToken)}`,
      method: 'GET',
      headers: { Accept: 'text/event-stream', 'X-Mixdog-Daemon-Token': serverToken },
    }, (res) => {
      if (req !== sseReq || closed) { res.resume(); return; }
      if (res.statusCode !== 200) {
        res.resume();
        // A token rejection means this port now belongs to a different daemon;
        // re-read discovery now rather than re-registering against it.
        if (res.statusCode === 401 || res.statusCode === 403) {
          signalFatal('bad sse status ' + res.statusCode);
        } else {
          handleStreamLoss('bad sse status ' + res.statusCode);
        }
        return;
      }
      res.setEncoding('utf8');
      // A bare 200 followed by an immediate end is not a stable stream. Only
      // reset the bounded reconnect budget after this exact stream stays live.
      clearStableTimer();
      stableTimer = setTimeout(() => {
        if (!closed && !fatal && req === sseReq) reconnectAttempts = 0;
      }, STABLE_STREAM_MS);
      stableTimer.unref?.();
      let buf = '';
      res.on('data', (chunk) => {
        if (req !== sseReq || closed) return;
        buf += chunk;
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const raw = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          for (const line of raw.split('\n')) {
            if (!line.startsWith('data:')) continue; // skip ': ka' keepalives
            const json = line.slice(5).trim();
            if (!json) continue;
            let msg = null;
            try { msg = JSON.parse(json); } catch { continue; }
            if (msg?.type === 'notify') { try { onNotify(msg); } catch (e) { log(`onNotify threw: ${e?.message || e}`); } }
          }
        }
      });
      res.on('end', () => {
        if (req === sseReq) {
          clearStableTimer();
          handleStreamLoss('sse ended');
        }
      });
      res.on('error', () => {
        if (req === sseReq) {
          clearStableTimer();
          handleStreamLoss('sse error');
        }
      });
    });
    req.on('error', () => {
      if (req === sseReq) signalFatal('sse req error');
    });
    sseReq = req;
    req.end();
  }

  function scheduleReconnect(reason) {
    if (closed || reconnectTimer) return;
    if (++reconnectAttempts > MAX_RECONNECTS) {
      signalFatal(`giving up after ${reconnectAttempts} attempts (${reason})`);
      return;
    }
    log(`sse reconnect scheduled (${reason}, attempt ${reconnectAttempts})`);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (closed || fatal) return;
      // Re-register (the daemon may have pruned us) then reopen the stream.
      // Re-register mints a fresh client token (the old one was pruned); adopt
      // it so the reopened stream and subsequent calls target the live entry.
      // reattach:true — a reconnect is NOT a new terminal, so it must NOT steal
      // the ownership seat (last-wins is reserved for genuine fresh registers).
      const generation = lifecycle;
      const registrationId = reconnectRegistrationId ||= randomUUID();
      const replaceToken = reconnectReplaceToken ||= clientToken;
      const registration = request({
        port, token: serverToken, method: 'POST', path: '/client/register',
        body: {
          leadPid, cwd, reattach: true, replaceToken,
          registrationId,
        }, timeoutMs: 3000,
      }).then(async (r) => {
        const freshToken = r?.token;
        if (!freshToken) return false;
        if (closed || fatal || generation !== lifecycle) {
          await deregister(freshToken);
          return false;
        }
        clientToken = freshToken;
        reconnectRegistrationId = null;
        reconnectReplaceToken = null;
        return true;
      }).catch(() => false);
      reconnectRegistration = registration;
      void registration.finally(() => {
        if (reconnectRegistration === registration) reconnectRegistration = null;
        if (!closed && !fatal && generation === lifecycle) openStream();
      });
    }, 1000);
    reconnectTimer.unref?.();
  }

  openStream();

  async function call(name, args = {}, { timeoutMs = 120_000, callId = null } = {}) {
    let out;
    try {
      out = await request({
        port,
        token: serverToken,
        method: 'POST',
        path: '/call',
        // callId (stable across a logical call's retries) lets the daemon dedup
        // a retried transport failure to a single side-effect.
        body: { token: clientToken, name, args: args || {}, ...(callId ? { callId } : {}) },
        timeoutMs,
      });
    } catch (err) {
      // Transport failure (daemon dead/restarted/unreachable) — tag so the
      // worker's execute() drops this stale attach and re-attaches, instead of
      // surfacing it as a tool error. Tool errors come back as {error} (200).
      err.daemonTransportError = true;
      throw err;
    }
    if (out && out.error) throw new Error(out.error);
    return out?.result;
  }

  async function close(reason = 'client close') {
    if (closePromise) return closePromise;
    closed = true;
    lifecycle++;
    if (reconnectTimer) { try { clearTimeout(reconnectTimer); } catch {} reconnectTimer = null; }
    clearStableTimer();
    try { sseReq?.destroy?.(); } catch {}
    // A re-register already in flight can mint a fresh token after close().
    // Await it so its stale branch deregisters that token before close resolves.
    const pendingRegistration = reconnectRegistration;
    const registrationId = reconnectRegistrationId;
    const replaceToken = reconnectReplaceToken;
    closePromise = (async () => {
      if (pendingRegistration) await pendingRegistration;
      await deregister(clientToken, { registrationId, replaceToken });
      log(`detached (${reason})`);
    })();
    return closePromise;
  }

  return { call, close, clientToken, port };
}
