// Machine-global channels daemon — attach client (TUI side).
//
// Mirrors the memory proxy's attach pattern (POST /client/register + /health,
// 127.0.0.1 only). A TUI uses this to talk to the ONE shared channels daemon
// instead of forking its own worker: tool calls go over POST /call and the
// worker->parent notify path arrives on a persistent SSE stream (GET /events),
// replacing the old node-IPC `{type:'notify'}` messages.
import http from 'node:http';
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
    const req = http.request({
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
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = data ? JSON.parse(data) : null; } catch {}
        if (res.statusCode && res.statusCode >= 400) {
          const err = new Error(parsed?.error || data || `HTTP ${res.statusCode}`);
          err.statusCode = res.statusCode;
          reject(err);
          return;
        }
        resolve(parsed ?? {});
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error(`daemon request timed out: ${method} ${path}`)); });
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
  if (!discovery?.port || !discovery?.token) throw new Error('daemon discovery {port, token} required');
  const { port, token: serverToken } = discovery;

  const reg = await request({
    port,
    token: serverToken,
    method: 'POST',
    path: '/client/register',
    body: { leadPid, cwd },
    timeoutMs: 3000,
  });
  let clientToken = reg?.token;
  if (!clientToken) throw new Error('daemon register returned no client token');

  let sseReq = null;
  let closed = false;
  let reconnectTimer = null;
  // Bounded SSE reconnect: after repeated failures (daemon dead/restarted) give
  // up and signal the owner via onFatal so it can invalidate the cached attach
  // and re-attach fresh (re-read discovery, respawn-if-dead) rather than spin
  // forever against a dead port.
  let reconnectAttempts = 0;
  const MAX_RECONNECTS = 5;

  function openStream() {
    if (closed) return;
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: `/events?token=${encodeURIComponent(clientToken)}&server_token=${encodeURIComponent(serverToken)}`,
      method: 'GET',
      headers: { Accept: 'text/event-stream', 'X-Mixdog-Daemon-Token': serverToken },
    }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        scheduleReconnect('bad sse status ' + res.statusCode);
        return;
      }
      res.setEncoding('utf8');
      reconnectAttempts = 0; // a live stream resets the failure budget
      let buf = '';
      res.on('data', (chunk) => {
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
      res.on('end', () => scheduleReconnect('sse ended'));
      res.on('error', () => scheduleReconnect('sse error'));
    });
    req.on('error', () => scheduleReconnect('sse req error'));
    req.end();
    sseReq = req;
  }

  function scheduleReconnect(reason) {
    if (closed || reconnectTimer) return;
    if (++reconnectAttempts > MAX_RECONNECTS) {
      log(`sse giving up after ${reconnectAttempts} attempts (${reason}); signalling re-attach`);
      closed = true;
      try { sseReq?.destroy?.(); } catch {}
      try { onFatal(reason); } catch {}
      return;
    }
    log(`sse reconnect scheduled (${reason}, attempt ${reconnectAttempts})`);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      // Re-register (the daemon may have pruned us) then reopen the stream.
      // Re-register mints a fresh client token (the old one was pruned); adopt
      // it so the reopened stream and subsequent calls target the live entry.
      // reattach:true — a reconnect is NOT a new terminal, so it must NOT steal
      // the ownership seat (last-wins is reserved for genuine fresh registers).
      request({ port, token: serverToken, method: 'POST', path: '/client/register', body: { leadPid, cwd, reattach: true }, timeoutMs: 3000 })
        .then((r) => { if (r?.token) clientToken = r.token; })
        .catch(() => {})
        .finally(() => openStream());
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
    closed = true;
    if (reconnectTimer) { try { clearTimeout(reconnectTimer); } catch {} reconnectTimer = null; }
    try { sseReq?.destroy?.(); } catch {}
    try {
      await request({ port, token: serverToken, method: 'POST', path: '/client/deregister', body: { token: clientToken }, timeoutMs: 1500 });
    } catch { /* best-effort; daemon sweep reaps us */ }
    log(`detached (${reason})`);
  }

  return { call, close, clientToken, port };
}
