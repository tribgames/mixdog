// Scripted two-client simulation for the machine-global channels daemon
// transport (no Discord token needed — the channels runtime is stubbed).
//
// Verifies the transport + attach client contracts that later slices depend on:
//   1. two TUIs attach to ONE daemon and each get an independent SSE stream;
//   2. tool calls round-trip per client and carry the caller's leadPid;
//   3. notifies are TARGETED (never broadcast) to the routing-pointer client;
//   4. a bind-intent call (rebind_current_transcript) moves the pointer;
//   5. once every client deregisters, the daemon self-shutdown fires.
//
// Run: node scripts/channel-daemon-smoke.mjs
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createChannelDaemonTransport } from '../src/standalone/channel-daemon-transport.mjs';
import { attachToDaemon } from '../src/standalone/channel-daemon-client.mjs';
import { createParentBridge, setChannelNotifySink } from '../src/runtime/channels/lib/parent-bridge.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STUB_ENTRY = path.join(HERE, 'channel-daemon-stub.mjs');

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 1500) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return true; await delay(20); }
  return fn();
};
const waitForAsync = async (fn, ms = 1500) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return true; await delay(20); }
  return await fn();
};
let failures = 0;
function check(label, cond) {
  const ok = !!cond;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
}

async function main() {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'mixdog-daemon-smoke-'));
  const discoveryPath = path.join(tmp, 'channel-daemon.json');
  const remoteStatePath = path.join(tmp, 'channel-remote-state.json');
  let clientsEmptyFired = false;
  let sideEffects = 0; // counts non-idempotent 'reply' dispatches

  // Stub channels runtime: echoes the call + the caller identity the transport
  // resolved, so we can assert per-client leadPid threading.
  const handleCall = async (name, args, ctx) => {
    if (name === 'reply') { sideEffects++; await delay(40); } // simulate a side effect
    return { ok: true, name, args, leadPid: ctx.leadPid };
  };

  const transport = createChannelDaemonTransport({
    handleCall,
    discoveryPath,
    clientGraceMs: 250,
    sweepMs: 1000,
    onClientsEmpty: () => { clientsEmptyFired = true; },
    log: (m) => process.env.DAEMON_SMOKE_VERBOSE && console.log(`[daemon] ${m}`),
  });
  const { port, token } = await transport.start();
  const discovery = { port, token, pid: process.pid };

  const notA = [];
  const notB = [];
  const clientA = await attachToDaemon({ discovery, leadPid: process.pid, cwd: 'A', onNotify: (m) => notA.push(m) });
  const clientB = await attachToDaemon({ discovery, leadPid: process.pid, cwd: 'B', onNotify: (m) => notB.push(m) });
  await delay(150); // let both SSE streams attach

  check('two clients registered', transport._clientsForTest.size === 2);

  // (2) calls round-trip per client.
  const rA = await clientA.call('reload_config', { k: 1 });
  check('client A call round-trips', rA?.ok === true && rA?.name === 'reload_config');
  const rB = await clientB.call('fetch', { q: 2 });
  check('client B call round-trips', rB?.ok === true && rB?.name === 'fetch');

  // (3) Registration is transport-only: a later observer (B) must not steal
  // the occupied pointer from A merely by attaching.
  transport.notify('notifications/claude/channel', { content: 'to-A' });
  await delay(120);
  check('notify #1 remains with first owner (A) after B only attaches',
    notA.length === 1 && notA[0]?.params?.content === 'to-A' && notB.length === 0);

  // (4) A bind-intent call is the explicit ownership transition.
  await clientB.call('rebind_current_transcript', { transcriptPath: '/tmp/b.jsonl' });
  transport.notify('notifications/claude/channel', { content: 'to-B' });
  await delay(120);
  check('notify #2 delivered to B only after explicit rebind',
    notB.length === 1 && notB[0]?.params?.content === 'to-B' && notA.length === 1);

  // (fix 1) idempotent replay: two /call with the SAME callId (a retried
  // transport failure) must run the non-idempotent side-effect exactly once.
  const dupId = 'dup-call-1';
  const [d1, d2] = await Promise.all([
    clientA.call('reply', { n: 1 }, { callId: dupId }),
    clientA.call('reply', { n: 1 }, { callId: dupId }),
  ]);
  check('idempotent replay: same callId → exactly one side-effect',
    sideEffects === 1 && d1?.ok === true && d2?.ok === true);

  // (targeted) the 'acquired' badge goes ONLY to the current owner (pointer=B
  // after the rebind), never broadcast — a displaced/non-owner TUI (B) must not
  // light its remote badge. Still sticky for a late owner attach (below).
  const remoteBefore = { A: notA.length, B: notB.length };
  transport.notify('notifications/mixdog/remote', { state: 'acquired' });
  await delay(120);
  const gotA = notA.slice(remoteBefore.A).filter((m) => m?.method === 'notifications/mixdog/remote');
  const gotB = notB.slice(remoteBefore.B).filter((m) => m?.method === 'notifications/mixdog/remote');
  check('remote-state acquired targets owner (B) only, not broadcast',
    gotB.length === 1 && gotA.length === 0);
  const remoteOwner = JSON.parse(readFileSync(remoteStatePath, 'utf8'));
  check('remote owner state publishes the bound session without polling',
    remoteOwner.enabled === true && remoteOwner.sessionId === 'b');

  // A late observer must neither steal the pointer nor replay the owner's
  // sticky acquired badge merely by attaching.
  const notC = [];
  const clientC = await attachToDaemon({ discovery, leadPid: process.pid, cwd: 'C', onNotify: (m) => notC.push(m) });
  await delay(150);
  check('late observer receives no remote-state replay and does not steal',
    notC.filter((m) => m?.method === 'notifications/mixdog/remote').length === 0 &&
    transport._resolveTargetForTest()?.token === clientB.clientToken);
  await clientC.close();

  // (replay) 'superseded' CLEARS the sticky: a client attaching after it must
  // receive NO remote-state replay (else it would wrongly stop a fresh client).
  transport.notify('notifications/mixdog/remote', { state: 'superseded' });
  await delay(60);
  const notD = [];
  const clientD = await attachToDaemon({ discovery, leadPid: process.pid, cwd: 'D', onNotify: (m) => notD.push(m) });
  await delay(150);
  check('attach after superseded receives no remote-state replay',
    notD.filter((m) => m?.method === 'notifications/mixdog/remote').length === 0);
  await clientD.close();

  // (sink) daemon-mode wiring: owned-runtime routes remote-state through the
  // parent bridge's sendNotifyToParent (NOT raw process.send). The daemon
  // installs a sink -> transport.notify (channel-daemon.mjs:106). Assert an
  // 'acquired' emitted via that sink reaches the current owner — the exact
  // daemon-mode path a raw process.send would drop.
  const { sendNotifyToParent } = createParentBridge({ getInstanceId: () => 'smoke' });
  setChannelNotifySink((method, params) => transport.notify(method, params));
  const sinkBefore = notB.length;
  sendNotifyToParent('notifications/mixdog/remote', { state: 'acquired' });
  await waitFor(() => notB.slice(sinkBefore).some((m) =>
    m?.method === 'notifications/mixdog/remote' && m?.params?.state === 'acquired'), 1000);
  check('daemon-mode acquire via notify sink reaches current owner',
    notB.slice(sinkBefore).filter((m) =>
      m?.method === 'notifications/mixdog/remote' && m?.params?.state === 'acquired').length === 1);
  setChannelNotifySink(null);

  // (5) deregister both → self-shutdown fires after the client grace window.
  await clientA.close();
  await clientB.close();
  await delay(600);
  check('daemon self-shutdown fired after last client left', clientsEmptyFired === true);
  const releasedOwner = JSON.parse(readFileSync(remoteStatePath, 'utf8'));
  check('remote owner state clears when the last client leaves',
    releasedOwner.enabled === false && releasedOwner.sessionId === null);

  await transport.stop();
  try { rmSync(tmp, { recursive: true, force: true }); } catch {}

  await flipTest();
  await pointerStealTest();
  await reattachBufferTest();
  await pointerFailoverTest();
  await pointerReconnectFollowsTest();
  await tokenReplacementRetirementTest();
  await tokenReplacementReplayTest();
  await tokenReplacementResponseLossCloseTest();
  await registrationReplayTtlTest();
  await registrationReplayCleanupTest();
  await staleTokenCallTest();
  await clientReconnectSafetyTest();
  await clientTruncatedReplacementCloseTest();
  await workerAttachSafetyTest();

  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

// Flip coverage: two TUIs attach to ONE daemon via the REAL channel-worker.mjs
// spawn-or-attach path (against the stub daemon entry — no Discord token). The
// first worker spawns the daemon; the second attaches to it.
async function flipTest() {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'mixdog-flip-smoke-'));
  // channel-worker.mjs resolves DAEMON_ENTRY + runtimeRoot at import/call time,
  // so the env must be set BEFORE importing it.
  process.env.MIXDOG_RUNTIME_ROOT = tmp;
  process.env.MIXDOG_DATA_DIR = tmp;
  process.env.MIXDOG_CHANNEL_DAEMON_ENTRY = STUB_ENTRY;
  const { createStandaloneChannelWorker } = await import('../src/standalone/channel-worker.mjs');
  const { readDaemonDiscovery, probeDaemonHealth } = await import('../src/standalone/channel-daemon-client.mjs');
  const discFile = path.join(tmp, 'channel-daemon.json');

  const notA = [];
  const notB = [];
  const mk = (onNotify) => createStandaloneChannelWorker({ entry: STUB_ENTRY, rootDir: tmp, dataDir: tmp, cwd: tmp, onNotify });
  const wA = mk((m) => notA.push(m));
  const wB = mk((m) => notB.push(m));

  await wA.start(); // spawns the (stub) daemon then attaches
  await wB.start(); // attaches to the SAME daemon (no second spawn)
  check('flip: worker A call round-trips', (await wA.execute('reply', { x: 1 }))?.ok === true);
  check('flip: worker B call round-trips', (await wB.execute('reply', { y: 2 }))?.ok === true);

  // B claims the transcript → routing pointer moves to B; a notify emitted by
  // the daemon (on A's 'fetch') must reach B only, never both TUIs.
  await wB.execute('rebind_current_transcript', { transcriptPath: path.join(tmp, 'b.jsonl') });
  await wA.execute('fetch', { probe: true });
  await waitFor(() => notB.some((m) => m?.params?.content === 'ping-from-stub'), 1500);
  check('flip: notify targets the pointer TUI (B) only',
    notB.some((m) => m?.params?.content === 'ping-from-stub') &&
    !notA.some((m) => m?.params?.content === 'ping-from-stub'));

  // (fix 1) daemon death mid-session: stale SSE clients must immediately
  // invalidate and re-read discovery. Both workers reach the replacement
  // without a tool call or the old five one-second stale-port retries.
  const beforeKill = readDaemonDiscovery(discFile);
  if (beforeKill?.pid) { try { process.kill(beforeKill.pid, 'SIGKILL'); } catch {} }
  const reattached = await waitForAsync(async () => {
    const discovery = readDaemonDiscovery(discFile);
    if (!discovery?.pid || discovery.pid === beforeKill?.pid) return false;
    const health = await probeDaemonHealth({ port: discovery.port, token: discovery.token, timeoutMs: 300 });
    return health?.clients >= 2;
  }, 2600);
  const afterKill = readDaemonDiscovery(discFile);
  let recovered = false;
  try { recovered = (await wA.execute('reply', { after: 'stale-sse-replacement' }))?.ok === true; } catch {}
  check('flip: stale SSE immediately re-attaches to replacement (no 1..5 stale-port storm)',
    reattached === true && !!afterKill?.pid && afterKill.pid !== beforeKill?.pid && recovered === true);

  await wA.stop();
  await wB.stop();
  await delay(700);
  const disc = readDaemonDiscovery(discFile);
  check('flip: daemon self-shutdown after last TUI detaches', disc === null);
  try { rmSync(tmp, { recursive: true, force: true }); } catch {}
}

// Explicit ownership steal coverage with DISTINCT alive leadPids (two sleeper
// child processes): registration is non-owning, while a bind call emits the
// targeted 'superseded' frame to the displaced owner.
async function pointerStealTest() {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'mixdog-steal-smoke-'));
  const discoveryPath = path.join(tmp, 'channel-daemon.json');
  const transport = createChannelDaemonTransport({
    handleCall: async (name, args, ctx) => ({ ok: true, name, leadPid: ctx.leadPid }),
    discoveryPath,
    clientGraceMs: 2000,
    sweepMs: 5000,
    onClientsEmpty: () => {},
    log: (m) => process.env.DAEMON_SMOKE_VERBOSE && console.log(`[steal] ${m}`),
  });
  const { port, token } = await transport.start();
  const discovery = { port, token, pid: process.pid };
  const REMOTE = 'notifications/mixdog/remote';

  // Two long-lived children give us two DISTINCT alive lead pids.
  const sleeperA = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 60000)'], { stdio: 'ignore' });
  const sleeperB = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 60000)'], { stdio: 'ignore' });
  await delay(80);

  const notA = [];
  const notB = [];
  const clientA = await attachToDaemon({ discovery, leadPid: sleeperA.pid, cwd: 'A', onNotify: (m) => notA.push(m) });
  await delay(100); // A registers → A is the owner
  const clientB = await attachToDaemon({ discovery, leadPid: sleeperB.pid, cwd: 'B', onNotify: (m) => notB.push(m) });
  await delay(150); // B registers as an observer; A keeps the seat

  check('steal: observer registration leaves owner pointer on A',
    transport._resolveTargetForTest()?.leadPid === sleeperA.pid);
  check('steal: observer registration sends no superseded',
    notA.filter((m) => m?.method === REMOTE && m?.params?.state === 'superseded').length === 0);
  check('steal: observer (B) got no remote-state',
    notB.filter((m) => m?.method === REMOTE).length === 0);

  // Bind A to a real remote session, then publish acquired. The badge still
  // targets owner A only — never the observer B.
  await clientA.call('activate_channel_bridge', { active: true, sessionId: 'a' });
  transport.notify(REMOTE, { state: 'acquired' });
  await delay(120);
  check('steal: acquired targets owner (A) only, not observer B',
    notA.filter((m) => m?.params?.state === 'acquired').length === 1 &&
    notB.filter((m) => m?.params?.state === 'acquired').length === 0);

  // Auto-start is claim-if-vacant: with A actively owning a bound session,
  // B must remain an observer and must not dispatch bridge activation.
  const blocked = await clientB.call('activate_channel_bridge', {
    active: true, claimIfVacant: true, sessionId: 'b-auto',
  });
  await delay(120);
  check('steal: auto claim yields to the live owner without superseding it',
    blocked?.claimSkipped === true &&
    transport._resolveTargetForTest()?.leadPid === sleeperA.pid &&
    notA.filter((m) => m?.params?.state === 'superseded').length === 0);

  // B's explicit claim steals the seat → A (displaced) gets superseded.
  await clientB.call('activate_channel_bridge', { active: true, sessionId: 'b' });
  await delay(120);
  check('steal: explicit bind /call moves pointer to B',
    transport._resolveTargetForTest()?.leadPid === sleeperB.pid);
  check('steal: displaced owner (A) got targeted superseded on bind /call',
    notA.filter((m) => m?.method === REMOTE && m?.params?.state === 'superseded').length === 1);

  // A can explicitly reclaim the seat, targeting B with superseded.
  await clientA.call('activate_channel_bridge', { active: true, sessionId: 'a' });
  await delay(120);
  check('steal: explicit reclaim moves pointer back to A',
    transport._resolveTargetForTest()?.leadPid === sleeperA.pid);
  check('steal: displaced owner (B) got targeted superseded on explicit reclaim',
    notB.filter((m) => m?.method === REMOTE && m?.params?.state === 'superseded').length === 1);

  // superseded via notify() (seat lost to another daemon) still BROADCASTS to
  // every live client, regardless of pointer.
  const aBefore = notA.length;
  const bBefore = notB.length;
  transport.notify(REMOTE, { state: 'superseded' });
  await delay(120);
  check('steal: superseded via notify broadcasts to ALL live clients',
    notA.slice(aBefore).some((m) => m?.params?.state === 'superseded') &&
    notB.slice(bBefore).some((m) => m?.params?.state === 'superseded'));

  await clientA.close();
  await clientB.close();
  try { sleeperA.kill(); } catch {}
  try { sleeperB.kill(); } catch {}
  await transport.stop();
  try { rmSync(tmp, { recursive: true, force: true }); } catch {}
}

// Low-level helpers: register/attach WITHOUT the auto-attach client, so a
// client can be registered but leave its SSE stream closed (to exercise the
// buffered-superseded + reattach paths that attachToDaemon hides).
function rawPost(port, serverToken, p, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request({
      hostname: '127.0.0.1', port, path: p, method: 'POST',
      headers: { 'X-Mixdog-Daemon-Token': serverToken, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    }, (res) => { let d = ''; res.setEncoding('utf8'); res.on('data', (c) => { d += c; }); res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve({}); } }); });
    req.on('error', reject); req.write(payload); req.end();
  });
}
function rawPostLoseResponse(port, serverToken, p, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    let settled = false;
    const done = (err) => {
      if (settled) return;
      settled = true;
      if (err) reject(err); else resolve();
    };
    const req = http.request({
      hostname: '127.0.0.1', port, path: p, method: 'POST',
      headers: { 'X-Mixdog-Daemon-Token': serverToken, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    }, (res) => {
      // The daemon has already committed before emitting response headers; drop
      // the body exactly where a transport response-loss retry would begin.
      try { res.destroy(); } catch {}
      done();
    });
    req.on('error', (err) => { if (!settled) done(err); });
    req.write(payload);
    req.end();
  });
}
function rawSse(port, serverToken, clientToken, onNotify) {
  const req = http.request({
    hostname: '127.0.0.1', port,
    path: `/events?token=${encodeURIComponent(clientToken)}&server_token=${encodeURIComponent(serverToken)}`,
    method: 'GET', headers: { Accept: 'text/event-stream', 'X-Mixdog-Daemon-Token': serverToken },
  }, (res) => {
    res.setEncoding('utf8'); let buf = '';
    res.on('data', (chunk) => {
      buf += chunk; let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const raw = buf.slice(0, idx); buf = buf.slice(idx + 2);
        for (const line of raw.split('\n')) {
          if (!line.startsWith('data:')) continue;
          const j = line.slice(5).trim(); if (!j) continue;
          let m = null; try { m = JSON.parse(j); } catch { continue; }
          if (m?.type === 'notify') onNotify(m);
        }
      }
    });
  });
  req.end(); return req;
}

function readJsonBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => { try { resolve(JSON.parse(body || '{}')); } catch { resolve({}); } });
  });
}
function sendTestJson(res, statusCode, body) {
  const json = JSON.stringify(body);
  res.writeHead(statusCode, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(json) });
  res.end(json);
}
async function startTestServer(handle) {
  const server = http.createServer(handle);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  return server;
}
function testPort(server) { return server.address().port; }
async function stopTestServer(server) {
  await new Promise((resolve) => { try { server.close(() => resolve()); } catch { resolve(); } });
}

// Removed client tokens must never dispatch a tool with a null ownership
// context, including a callId that could otherwise hit the dedup cache.
async function staleTokenCallTest() {
  let dispatched = 0;
  const transport = createChannelDaemonTransport({
    handleCall: async () => { dispatched++; return { ok: true }; },
    clientGraceMs: 2000, sweepMs: 5000, onClientsEmpty: () => {},
  });
  const { port, token } = await transport.start();
  const stale = await rawPost(port, token, '/call', { token: 'removed-token', name: 'reply', callId: 'stale-call' });
  check('transport: stale /call token is rejected before dispatch',
    stale?.error === 'unknown client token' && dispatched === 0);
  await transport.stop();
}

// A reconnecting non-owner must replace its exact old token, not merely leave
// it behind because another client currently owns the pointer.
async function tokenReplacementRetirementTest() {
  let dispatches = 0;
  const transport = createChannelDaemonTransport({
    handleCall: async (name, args, ctx) => {
      dispatches++;
      return { ok: true, name, args, leadPid: ctx.leadPid };
    },
    clientGraceMs: 2000, sweepMs: 5000, onClientsEmpty: () => {},
  });
  const { port, token } = await transport.start();
  const a = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 60000)'], { stdio: 'ignore' });
  const b = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 60000)'], { stdio: 'ignore' });
  const c = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 60000)'], { stdio: 'ignore' });
  await delay(80);
  const oldA = await rawPost(port, token, '/client/register', { leadPid: a.pid, cwd: 'A' });
  await rawPost(port, token, '/client/register', { leadPid: b.pid, cwd: 'B' });
  const ownerC = await rawPost(port, token, '/client/register', { leadPid: c.pid, cwd: 'C' });
  await rawPost(port, token, '/call', {
    token: ownerC.token, name: 'rebind_current_transcript',
    args: { transcriptPath: '/tmp/owner-c.jsonl' }, callId: 'owner-c-bind',
  });
  const oldBufferedBeforeReplace = transport._clientsForTest.get(oldA.token)?.pending?.length === 1;
  const freshA = await rawPost(port, token, '/client/register', {
    leadPid: a.pid, cwd: 'A', reattach: true, replaceToken: oldA.token,
  });
  const freshNotifies = [];
  const freshSse = rawSse(port, token, freshA.token, (message) => freshNotifies.push(message));
  await waitFor(() => freshNotifies.some((message) =>
    message?.method === 'notifications/mixdog/remote' && message?.params?.state === 'superseded'), 1_000);
  const nonOwnerStateMigrated =
    freshNotifies.some((message) => message?.method === 'notifications/mixdog/remote' && message?.params?.state === 'superseded') &&
    transport._clientsForTest.get(freshA.token)?.pending?.length === 0 &&
    transport._resolveTargetForTest()?.token === ownerC.token;
  const stale = await rawPost(port, token, '/call', {
    token: oldA.token, name: 'rebind_current_transcript',
    args: { transcriptPath: '/tmp/stale-a.jsonl' }, callId: 'late-old-dedup',
  });
  const dispatchesBeforeFreshCall = dispatches;
  const [live1, live2] = await Promise.all([
    rawPost(port, token, '/call', {
      token: freshA.token, name: 'rebind_current_transcript',
      args: { transcriptPath: '/tmp/fresh-a.jsonl' }, callId: 'fresh-live-dedup',
    }),
    rawPost(port, token, '/call', {
      token: freshA.token, name: 'rebind_current_transcript',
      args: { transcriptPath: '/tmp/fresh-a.jsonl' }, callId: 'fresh-live-dedup',
    }),
  ]);
  const beforeFreshClose = transport._clientsForTest.size;
  const pointerBeforeFreshClose = transport._resolveTargetForTest()?.token;
  await rawPost(port, token, '/client/deregister', { token: freshA.token });
  check('reconnect: non-owner old token is retired; stale dedup call cannot move pointer',
    stale?.error === 'unknown client token' &&
    oldBufferedBeforeReplace &&
    nonOwnerStateMigrated &&
    !transport._clientsForTest.has(oldA.token) &&
    beforeFreshClose === 3 &&
    pointerBeforeFreshClose === freshA.token &&
    live1?.result?.ok === true && live2?.result?.ok === true &&
    dispatches === dispatchesBeforeFreshCall + 1 &&
    !transport._clientsForTest.has(freshA.token) &&
    transport._clientsForTest.size === 2 &&
    ownerC.token !== freshA.token);
  try { a.kill(); } catch {}
  try { b.kill(); } catch {}
  try { c.kill(); } catch {}
  try { freshSse.destroy(); } catch {}
  await transport.stop();
}

// If replacement commits but its response is lost, the same logical
// registration id must replay the first fresh token rather than create another.
async function tokenReplacementReplayTest() {
  const transport = createChannelDaemonTransport({
    handleCall: async () => ({ ok: true }),
    clientGraceMs: 2000, sweepMs: 5000, onClientsEmpty: () => {},
  });
  const { port, token } = await transport.start();
  const a = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 60000)'], { stdio: 'ignore' });
  const b = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 60000)'], { stdio: 'ignore' });
  await delay(80);
  const oldA = await rawPost(port, token, '/client/register', { leadPid: a.pid, cwd: 'A' });
  const ownerB = await rawPost(port, token, '/client/register', { leadPid: b.pid, cwd: 'B' });
  await rawPost(port, token, '/call', {
    token: ownerB.token, name: 'rebind_current_transcript',
    args: { transcriptPath: '/tmp/owner-b.jsonl' }, callId: 'replay-owner-b-bind',
  });
  const replacement = {
    leadPid: a.pid, cwd: 'A', reattach: true, replaceToken: oldA.token,
    registrationId: 'response-loss-replacement-1',
  };
  await rawPostLoseResponse(port, token, '/client/register', replacement);
  const freshA = await rawPost(port, token, '/client/register', replacement);
  const countAfterReplay = transport._clientsForTest.size;
  const freshNotifies = [];
  const freshSse = rawSse(port, token, freshA.token, (message) => freshNotifies.push(message));
  await waitFor(() => freshNotifies.some((message) =>
    message?.method === 'notifications/mixdog/remote' && message?.params?.state === 'superseded'), 1_000);
  const pendingMigrated = transport._clientsForTest.get(freshA.token)?.pending?.length === 0;
  await rawPost(port, token, '/client/deregister', { token: freshA.token });
  check('reconnect: response-loss replacement replays one fresh token and close leaves no orphan',
    countAfterReplay === 2 &&
    !transport._clientsForTest.has(oldA.token) &&
    transport._resolveTargetForTest()?.token === ownerB.token &&
    pendingMigrated &&
    !transport._clientsForTest.has(freshA.token) &&
    transport._clientsForTest.size === 1 &&
    transport._registrationReplaysForTest.size === 0);
  try { freshSse.destroy(); } catch {}
  try { a.kill(); } catch {}
  try { b.kill(); } catch {}
  await transport.stop();
}

// If the replacement commit survives but its response is lost, an immediate
// close still knows the retired token + registration id and must cancel exactly
// that unknown fresh logical client, not an unrelated live owner.
async function tokenReplacementResponseLossCloseTest() {
  const transport = createChannelDaemonTransport({
    handleCall: async () => ({ ok: true }),
    clientGraceMs: 2000, sweepMs: 5000, onClientsEmpty: () => {},
  });
  const { port, token } = await transport.start();
  const a = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 60000)'], { stdio: 'ignore' });
  const b = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 60000)'], { stdio: 'ignore' });
  await delay(80);
  const oldA = await rawPost(port, token, '/client/register', { leadPid: a.pid, cwd: 'A' });
  const ownerB = await rawPost(port, token, '/client/register', { leadPid: b.pid, cwd: 'B' });
  await rawPost(port, token, '/call', {
    token: ownerB.token, name: 'rebind_current_transcript',
    args: { transcriptPath: '/tmp/owner-b.jsonl' }, callId: 'close-owner-b-bind',
  });
  const cancellation = {
    token: oldA.token, replaceToken: oldA.token, leadPid: a.pid, cwd: 'A',
    registrationId: 'response-loss-immediate-close-1',
  };
  await rawPostLoseResponse(port, token, '/client/register', {
    ...cancellation, reattach: true,
  });
  const fresh = [...transport._clientsForTest.values()].find((client) => client.leadPid === a.pid);
  const pendingMigrated = fresh?.pending?.length === 1;
  const wrongClose = await rawPost(port, token, '/client/deregister', {
    ...cancellation, cwd: 'not-A',
  });
  const close1 = await rawPost(port, token, '/client/deregister', cancellation);
  const close2 = await rawPost(port, token, '/client/deregister', cancellation);
  check('reconnect: response-loss immediate close cancels unknown fresh client without stranding state',
    wrongClose?.error === 'forbidden replacement deregister' &&
    pendingMigrated &&
    close1?.ok === true && close1?.cancelled === true &&
    close2?.ok === true && close2?.cancelled === false &&
    !transport._clientsForTest.has(oldA.token) &&
    !transport._clientsForTest.has(fresh?.token) &&
    transport._clientsForTest.size === 1 &&
    transport._resolveTargetForTest()?.token === ownerB.token &&
    transport._registrationReplaysForTest.size === 0);
  try { a.kill(); } catch {}
  try { b.kill(); } catch {}
  await transport.stop();
}

// Replay TTL bounds only cancellation metadata after a response has flushed:
// a valid client may delay SSE/call well beyond that TTL. A replay near expiry
// refreshes the metadata lifetime so its returned token remains cancellable.
async function registrationReplayTtlTest() {
  const transport = createChannelDaemonTransport({
    handleCall: async () => ({ ok: true }),
    clientGraceMs: 2000, sweepMs: 5000, registrationReplayTtlMs: 100,
    onClientsEmpty: () => {},
  });
  const { port, token } = await transport.start();
  const a = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 60000)'], { stdio: 'ignore' });
  const b = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 60000)'], { stdio: 'ignore' });
  await delay(80);
  const oldA = await rawPost(port, token, '/client/register', { leadPid: a.pid, cwd: 'A' });
  const ownerB = await rawPost(port, token, '/client/register', { leadPid: b.pid, cwd: 'B' });
  await rawPost(port, token, '/call', {
    token: ownerB.token, name: 'rebind_current_transcript',
    args: { transcriptPath: '/tmp/owner-b.jsonl' }, callId: 'ttl-owner-b-bind',
  });
  const valid = await rawPost(port, token, '/client/register', {
    leadPid: a.pid, cwd: 'A', reattach: true, replaceToken: oldA.token, registrationId: 'ttl-valid',
  });
  await delay(150);
  const validSurvived = transport._clientsForTest.has(valid.token) &&
    transport._clientsForTest.get(valid.token)?.pending?.length === 1 &&
    transport._registrationReplaysForTest.size === 0;
  await rawPost(port, token, '/client/deregister', { token: valid.token });

  const oldA2 = await rawPost(port, token, '/client/register', { leadPid: a.pid, cwd: 'A2' });
  const replacement = {
    leadPid: a.pid, cwd: 'A2', reattach: true, replaceToken: oldA2.token, registrationId: 'ttl-refresh',
  };
  const fresh = await rawPost(port, token, '/client/register', replacement);
  await delay(70);
  const replayed = await rawPost(port, token, '/client/register', replacement);
  await delay(60); // Past the original deadline, before the refreshed deadline.
  const replayRefreshed = replayed.token === fresh.token &&
    transport._clientsForTest.has(fresh.token) &&
    transport._registrationReplaysForTest.size === 1;
  await delay(70); // Full refreshed interval elapsed.
  const freshSurvivedRefreshExpiry = transport._clientsForTest.has(fresh.token) &&
    transport._registrationReplaysForTest.size === 0;
  await rawPost(port, token, '/client/deregister', { token: fresh.token });
  check('reconnect: replay TTL preserves flushed clients and refreshes near-expiry replay metadata',
    validSurvived && replayRefreshed && freshSurvivedRefreshExpiry);
  try { a.kill(); } catch {}
  try { b.kill(); } catch {}
  await transport.stop();
}

// Every explicit retirement, replacement, deregister, and stop must clear the
// associated replay entry/timer; no metadata may target an absent token.
async function registrationReplayCleanupTest() {
  const transport = createChannelDaemonTransport({
    handleCall: async () => ({ ok: true }),
    clientGraceMs: 2000, sweepMs: 5000, registrationReplayTtlMs: 1_000,
    onClientsEmpty: () => {},
  });
  const { port, token } = await transport.start();
  const a = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 60000)'], { stdio: 'ignore' });
  await delay(80);
  const old = await rawPost(port, token, '/client/register', { leadPid: a.pid, cwd: 'A' });
  const fresh1 = await rawPost(port, token, '/client/register', {
    leadPid: a.pid, cwd: 'A', reattach: true, replaceToken: old.token, registrationId: 'cleanup-1',
  });
  const fresh2 = await rawPost(port, token, '/client/register', {
    leadPid: a.pid, cwd: 'A', reattach: true, replaceToken: fresh1.token, registrationId: 'cleanup-2',
  });
  const replacementClean = !transport._clientsForTest.has(fresh1.token) &&
    transport._registrationReplaysForTest.size === 1;
  await rawPost(port, token, '/client/deregister', { token: fresh2.token });
  const deregisterClean = transport._registrationReplaysForTest.size === 0;
  const old3 = await rawPost(port, token, '/client/register', { leadPid: a.pid, cwd: 'A3' });
  await rawPost(port, token, '/client/register', {
    leadPid: a.pid, cwd: 'A3', reattach: true, replaceToken: old3.token, registrationId: 'cleanup-stop',
  });
  await transport.stop();
  check('reconnect: replacement, deregister, and stop clear all replay metadata',
    replacementClean && deregisterClean &&
    transport._clientsForTest.size === 0 && transport._registrationReplaysForTest.size === 0);
  try { a.kill(); } catch {}
}

// Client-only SSE races: immediate 200/end cycles consume the bounded budget;
// a late old response cannot start another token rotation; close waits for a
// delayed reconnect registration and removes its fresh token.
async function clientReconnectSafetyTest() {
  let registerCount = 0;
  let fatalReason = null;
  const flapping = await startTestServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/health') return sendTestJson(res, 200, { status: 'ok', pid: process.pid });
    if (url.pathname === '/client/register') {
      await readJsonBody(req);
      registerCount++;
      return sendTestJson(res, 200, { token: `flap-${registerCount}`, pid: process.pid });
    }
    if (url.pathname === '/client/deregister') { await readJsonBody(req); return sendTestJson(res, 200, { ok: true }); }
    if (url.pathname === '/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(': attached\n\n');
      setTimeout(() => res.end(), 10);
      return;
    }
    sendTestJson(res, 404, { error: 'not found' });
  });
  const flapClient = await attachToDaemon({
    discovery: { port: testPort(flapping), token: 'flap', pid: process.pid },
    onFatal: (reason) => { fatalReason = reason; },
  });
  await waitFor(() => fatalReason !== null, 8_000);
  check('client: repeated 200/end SSE reconnects are bounded',
    fatalReason !== null && registerCount === 6);
  await flapClient.close();
  await stopTestServer(flapping);

  let lateRegisters = 0;
  const lateServer = await startTestServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/health') return sendTestJson(res, 200, { status: 'ok', pid: process.pid });
    if (url.pathname === '/client/register') {
      await readJsonBody(req);
      lateRegisters++;
      return sendTestJson(res, 200, { token: `late-${lateRegisters}`, pid: process.pid });
    }
    if (url.pathname === '/client/deregister') { await readJsonBody(req); return sendTestJson(res, 200, { ok: true }); }
    if (url.pathname === '/events') return sendTestJson(res, 500, { error: 'test SSE should be intercepted' });
    sendTestJson(res, 404, { error: 'not found' });
  });
  const realHttpRequest = http.request;
  const fakeStreams = [];
  http.request = function interceptedSseRequest(options, callback) {
    if (!String(options?.path || '').startsWith('/events')) {
      return realHttpRequest.apply(this, arguments);
    }
    const fakeReq = new EventEmitter();
    fakeReq.destroy = () => {};
    fakeReq.end = () => {
      const fakeRes = new EventEmitter();
      fakeRes.statusCode = 200;
      fakeRes.setEncoding = () => {};
      fakeRes.resume = () => {};
      fakeStreams.push({ req: fakeReq, res: fakeRes });
      queueMicrotask(() => callback(fakeRes));
    };
    return fakeReq;
  };
  let lateClient = null;
  try {
    lateClient = await attachToDaemon({ discovery: { port: testPort(lateServer), token: 'late', pid: process.pid } });
    await waitFor(() => fakeStreams.length === 1, 500);
    fakeStreams[0].res.emit('end');
    await waitFor(() => lateRegisters === 2 && fakeStreams.length === 2, 2_500);
    fakeStreams[0].res.emit('error', new Error('late old SSE error'));
    await delay(100);
    check('client: late old-SSE events cannot rotate a newer token', lateRegisters === 2);
  } finally {
    http.request = realHttpRequest;
    await lateClient?.close();
  }
  await stopTestServer(lateServer);

  let closeRegisters = 0;
  let delayedRegisterResponse = null;
  const liveTokens = new Set();
  const closeServer = await startTestServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/health') return sendTestJson(res, 200, { status: 'ok', pid: process.pid });
    if (url.pathname === '/client/register') {
      await readJsonBody(req);
      closeRegisters++;
      const fresh = `close-${closeRegisters}`;
      liveTokens.add(fresh);
      if (closeRegisters === 2) { delayedRegisterResponse = { res, fresh }; return; }
      return sendTestJson(res, 200, { token: fresh, pid: process.pid });
    }
    if (url.pathname === '/client/deregister') {
      const body = await readJsonBody(req);
      liveTokens.delete(body.token);
      return sendTestJson(res, 200, { ok: true });
    }
    if (url.pathname === '/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(': attached\n\n');
      if (closeRegisters === 1) setTimeout(() => res.end(), 10);
      return;
    }
    sendTestJson(res, 404, { error: 'not found' });
  });
  const closeClient = await attachToDaemon({ discovery: { port: testPort(closeServer), token: 'close', pid: process.pid } });
  await waitFor(() => delayedRegisterResponse !== null, 2_500);
  const closing = closeClient.close('close during register');
  await delay(20);
  sendTestJson(delayedRegisterResponse.res, 200, { token: delayedRegisterResponse.fresh, pid: process.pid });
  await closing;
  check('client: close during re-register removes the fresh token',
    !liveTokens.has(delayedRegisterResponse.fresh) && liveTokens.size === 0);
  await stopTestServer(closeServer);
}

// End-to-end client path: the daemon commits replacement, but a proxy loses the
// register response after headers/partial JSON. request() must settle, and close
// must use the retained logical-registration identity to cancel the unknown
// fresh transport client before any later reconnect can revive it.
async function clientTruncatedReplacementCloseTest() {
  let cancellationObserved = false;
  const transport = createChannelDaemonTransport({
    handleCall: async () => ({ ok: true }),
    clientGraceMs: 2000, sweepMs: 5000, onClientsEmpty: () => {},
    log: (line) => { if (String(line).includes('replacement deregister')) cancellationObserved = true; },
  });
  const { port, token } = await transport.start();
  const client = await attachToDaemon({ discovery: { port, token, pid: process.pid }, cwd: 'truncated-client' });
  const initialToken = client.clientToken;
  const realHttpRequest = http.request;
  let replacementRequests = 0;
  let truncated = false;
  http.request = function truncateCommittedRegister(options, callback) {
    if (!String(options?.path || '').startsWith('/client/register')) {
      return realHttpRequest.apply(this, arguments);
    }
    replacementRequests++;
    const fakeReq = new EventEmitter();
    let payload = null;
    let inner = null;
    fakeReq.write = (chunk) => { payload = Buffer.from(chunk); };
    fakeReq.destroy = (error) => { try { inner?.destroy?.(error); } catch {} };
    fakeReq.end = () => {
      inner = realHttpRequest(options, (realRes) => {
        realRes.resume();
        realRes.once('end', () => {
          const fakeRes = new EventEmitter();
          fakeRes.statusCode = 200;
          fakeRes.setEncoding = () => {};
          fakeRes.resume = () => {};
          fakeRes.destroy = () => {};
          callback(fakeRes);
          fakeRes.emit('data', '{"token":"committed-but-truncated');
          truncated = true;
          queueMicrotask(() => {
            fakeRes.emit('aborted');
            fakeRes.emit('close');
          });
        });
      });
      inner.on('error', (error) => fakeReq.emit('error', error));
      if (payload) inner.write(payload);
      inner.end();
    };
    return fakeReq;
  };
  try {
    await waitFor(() => !!transport._clientsForTest.get(initialToken)?.sse, 1_000);
    transport._clientsForTest.get(initialToken)?.sse?.end();
    await waitFor(() => truncated && replacementRequests === 1 && transport._clientsForTest.size === 1, 2_500);
    const closeStarted = Date.now();
    await client.close('truncated replacement response');
    const closeElapsed = Date.now() - closeStarted;
    await delay(1_200);
    check('client: truncated committed replacement settles and close cancels unknown fresh client',
      closeElapsed < 1_000 &&
      cancellationObserved &&
      replacementRequests === 1 &&
      transport._clientsForTest.size === 0 &&
      transport._registrationReplaysForTest.size === 0 &&
      transport._resolveTargetForTest() === null);
  } finally {
    http.request = realHttpRequest;
    await client.close('truncated replacement cleanup');
    await transport.stop();
  }
}

// Worker-only attach races: auth rejection re-reads discovery instead of
// rejecting start(), a wrong but alive discovery PID is refused, and stop()
// waits for an in-flight register so it cannot publish a client afterward.
async function workerAttachSafetyTest() {
  const { createStandaloneChannelWorker } = await import('../src/standalone/channel-worker.mjs');

  const wrongPidServer = await startTestServer((req, res) => {
    if (new URL(req.url, 'http://127.0.0.1').pathname === '/health') return sendTestJson(res, 200, { status: 'ok', pid: process.pid });
    sendTestJson(res, 404, { error: 'not found' });
  });
  let wrongPidRejected = false;
  try {
    await attachToDaemon({ discovery: { port: testPort(wrongPidServer), token: 'wrong-pid', pid: process.pid + 100_000 } });
  } catch (err) { wrongPidRejected = err?.daemonDiscoveryStale === true; }
  check('client: alive but wrong discovery PID is rejected', wrongPidRejected);
  await stopTestServer(wrongPidServer);

  const authTmp = mkdtempSync(path.join(os.tmpdir(), 'mixdog-auth-attach-'));
  const authDiscovery = path.join(authTmp, 'channel-daemon.json');
  const goodToken = 'good-discovery-token';
  let rejectedRegisters = 0;
  let observerOnlyRegisters = true;
  const authServer = await startTestServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/health') return sendTestJson(res, 200, { status: 'ok', pid: process.pid });
    if (url.pathname === '/client/register') {
      const body = await readJsonBody(req);
      observerOnlyRegisters &&= body.reattach === true;
      if (req.headers['x-mixdog-daemon-token'] !== goodToken) {
        rejectedRegisters++;
        return sendTestJson(res, 403, { error: 'forbidden' });
      }
      return sendTestJson(res, 200, { token: 'auth-client', pid: process.pid });
    }
    if (url.pathname === '/client/deregister') { await readJsonBody(req); return sendTestJson(res, 200, { ok: true }); }
    if (url.pathname === '/events') { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write(': attached\n\n'); return; }
    sendTestJson(res, 404, { error: 'not found' });
  });
  const authPort = testPort(authServer);
  writeFileSync(authDiscovery, JSON.stringify({ pid: process.pid, port: authPort, token: 'stale-discovery-token' }));
  process.env.MIXDOG_RUNTIME_ROOT = authTmp;
  process.env.MIXDOG_DATA_DIR = authTmp;
  process.env.MIXDOG_CHANNEL_DAEMON_ENTRY = STUB_ENTRY;
  const authWorker = createStandaloneChannelWorker({ entry: STUB_ENTRY, rootDir: authTmp, dataDir: authTmp, cwd: authTmp });
  const publishGoodDiscovery = setTimeout(() => {
    writeFileSync(authDiscovery, JSON.stringify({ pid: process.pid, port: authPort, token: goodToken }));
  }, 250);
  await authWorker.start();
  clearTimeout(publishGoodDiscovery);
  check('worker: initial observer register 403 re-reads discovery and attaches without claim intent',
    rejectedRegisters > 0 && observerOnlyRegisters);
  await authWorker.stop();
  await stopTestServer(authServer);
  try { rmSync(authTmp, { recursive: true, force: true }); } catch {}

  const permanentTmp = mkdtempSync(path.join(os.tmpdir(), 'mixdog-auth-permanent-'));
  const permanentDiscovery = path.join(permanentTmp, 'channel-daemon.json');
  let permanentRejects = 0;
  const permanentServer = await startTestServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/health') return sendTestJson(res, 200, { status: 'ok', pid: process.pid });
    if (url.pathname === '/client/register') {
      await readJsonBody(req);
      permanentRejects++;
      return sendTestJson(res, 403, { error: 'forbidden' });
    }
    sendTestJson(res, 404, { error: 'not found' });
  });
  writeFileSync(permanentDiscovery, JSON.stringify({
    pid: process.pid, port: testPort(permanentServer), token: 'permanently-stale-token',
  }));
  process.env.MIXDOG_RUNTIME_ROOT = permanentTmp;
  process.env.MIXDOG_DATA_DIR = permanentTmp;
  const permanentWorker = createStandaloneChannelWorker({
    entry: STUB_ENTRY, rootDir: permanentTmp, dataDir: permanentTmp, cwd: permanentTmp,
  });
  const permanentStartedAt = Date.now();
  let permanentRejected = false;
  try { await permanentWorker.start(); } catch (err) {
    permanentRejected = /register rejected discovery auth 5 times/.test(err?.message || '');
  }
  const permanentElapsed = Date.now() - permanentStartedAt;
  check('worker: permanent register 403 uses bounded backoff and terminates',
    permanentRejected && permanentRejects === 5 && permanentElapsed >= 1000 && permanentElapsed < 6000);
  await permanentWorker.stop();
  await stopTestServer(permanentServer);
  try { rmSync(permanentTmp, { recursive: true, force: true }); } catch {}

  const stopTmp = mkdtempSync(path.join(os.tmpdir(), 'mixdog-stop-attach-'));
  const stopDiscovery = path.join(stopTmp, 'channel-daemon.json');
  let pendingRegister = null;
  const deregistered = new Set();
  const stopServer = await startTestServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/health') return sendTestJson(res, 200, { status: 'ok', pid: process.pid });
    if (url.pathname === '/client/register') { await readJsonBody(req); pendingRegister = res; return; }
    if (url.pathname === '/client/deregister') {
      const body = await readJsonBody(req);
      deregistered.add(body.token);
      return sendTestJson(res, 200, { ok: true });
    }
    if (url.pathname === '/events') { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write(': attached\n\n'); return; }
    sendTestJson(res, 404, { error: 'not found' });
  });
  const stopPort = testPort(stopServer);
  writeFileSync(stopDiscovery, JSON.stringify({ pid: process.pid, port: stopPort, token: 'stop-token' }));
  process.env.MIXDOG_RUNTIME_ROOT = stopTmp;
  process.env.MIXDOG_DATA_DIR = stopTmp;
  const stopWorker = createStandaloneChannelWorker({ entry: STUB_ENTRY, rootDir: stopTmp, dataDir: stopTmp, cwd: stopTmp });
  const startResult = stopWorker.start().then(() => 'started').catch(() => 'cancelled');
  await waitFor(() => pendingRegister !== null, 1_500);
  const stopping = stopWorker.stop('stop during attach');
  sendTestJson(pendingRegister, 200, { token: 'stop-fresh', pid: process.pid });
  const [stopped, startState] = await Promise.all([stopping, startResult]);
  check('worker: stop during attach cannot publish a client',
    stopped === false && startState === 'cancelled' && deregistered.has('stop-fresh'));
  await stopTestServer(stopServer);
  try { rmSync(stopTmp, { recursive: true, force: true }); } catch {}
}

// Fix coverage: (1) an SSE-reconnect re-register must NOT steal ownership;
// (2) a targeted 'superseded' emitted while the displaced client has no live
// stream is buffered and flushed when its stream (re)attaches.
async function reattachBufferTest() {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'mixdog-reattach-smoke-'));
  const discoveryPath = path.join(tmp, 'channel-daemon.json');
  const transport = createChannelDaemonTransport({
    handleCall: async () => ({ ok: true }),
    discoveryPath, clientGraceMs: 2000, sweepMs: 5000, onClientsEmpty: () => {},
    log: (m) => process.env.DAEMON_SMOKE_VERBOSE && console.log(`[reattach] ${m}`),
  });
  const { port, token } = await transport.start();
  const REMOTE = 'notifications/mixdog/remote';
  const s1 = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 60000)'], { stdio: 'ignore' });
  const s2 = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 60000)'], { stdio: 'ignore' });
  await delay(80);

  // (1) reconnect with the SAME leadPid: the pointer FOLLOWS to the fresh token
  // (its old dead-stream entry is dropped), never stealing from a DIFFERENT
  // owner. Register X (fresh) → owner; re-register reattach:true → pointer moves
  // to the new token and the old entry is gone (no dead-stream blackhole).
  const regX = await rawPost(port, token, '/client/register', { leadPid: s1.pid, cwd: 'X' });
  await delay(40);
  check('reattach: fresh register X becomes owner',
    transport._resolveTargetForTest()?.token === regX.token);
  const regReconnect = await rawPost(port, token, '/client/register', { leadPid: s1.pid, cwd: 'X', reattach: true });
  await delay(40);
  check('reattach: reconnect (same pid) pointer follows fresh token, old dropped',
    transport._resolveTargetForTest()?.token === regReconnect.token &&
    !transport._clientsForTest.has(regX.token));

  // (2) X's current entry never opened a stream; fresh register Y is only an
  // observer. Its explicit bind steals the seat, so X's targeted 'superseded'
  // is BUFFERED and delivered on late attach.
  const regY = await rawPost(port, token, '/client/register', { leadPid: s2.pid, cwd: 'Y' });
  await delay(40);
  check('reattach: fresh Y registration leaves the seat on X',
    transport._resolveTargetForTest()?.token === regReconnect.token);
  await rawPost(port, token, '/call', {
    token: regY.token, name: 'rebind_current_transcript',
    args: { transcriptPath: '/tmp/y.jsonl' }, callId: 'reattach-y-bind',
  });
  check('reattach: explicit Y bind steals the seat from X',
    transport._resolveTargetForTest()?.token === regY.token);
  const notX = [];
  const sseX = rawSse(port, token, regReconnect.token, (m) => notX.push(m));
  await waitFor(() => notX.some((m) => m?.method === REMOTE && m?.params?.state === 'superseded'), 1000);
  check('reattach: buffered superseded flushed to X after late SSE attach',
    notX.filter((m) => m?.method === REMOTE && m?.params?.state === 'superseded').length === 1);

  try { sseX.destroy(); } catch {}
  try { s1.kill(); } catch {}
  try { s2.kill(); } catch {}
  await transport.stop();
  try { rmSync(tmp, { recursive: true, force: true }); } catch {}
}

main().catch((err) => { console.error(err); process.exit(1); });

// Pointer-failover coverage: the pointer client dies (deregister) while a
// live client remains. The transport must move the pointer to the survivor
// (reason 'failover'), deliver the sticky 'acquired' badge to it, and
// re-dispatch the survivor's stored bind intent via the injected dispatchBind
// so the output forwarder rebinds to the survivor's transcript.
async function pointerFailoverTest() {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'mixdog-failover-smoke-'));
  const discoveryPath = path.join(tmp, 'channel-daemon.json');
  const REMOTE = 'notifications/mixdog/remote';
  const rebinds = []; // failover re-dispatches routed through dispatchBind
  const handleCall = async (name, args, ctx) => ({ ok: true, name, args, leadPid: ctx.leadPid });
  const dispatchBind = (name, args, ctx) => {
    rebinds.push({ name, args, leadPid: ctx.leadPid });
    return handleCall(name, args, ctx);
  };
  const transport = createChannelDaemonTransport({
    handleCall,
    dispatchBind,
    discoveryPath, clientGraceMs: 2000, sweepMs: 5000, onClientsEmpty: () => {},
    log: (m) => process.env.DAEMON_SMOKE_VERBOSE && console.log(`[failover] ${m}`),
  });
  const { port, token } = await transport.start();
  const discovery = { port, token, pid: process.pid };

  const sleeperA = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 60000)'], { stdio: 'ignore' });
  const sleeperB = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 60000)'], { stdio: 'ignore' });
  await delay(80);

  const notA = [];
  const notB = [];
  const clientA = await attachToDaemon({ discovery, leadPid: sleeperA.pid, cwd: 'A', onNotify: (m) => notA.push(m) });
  await clientA.call('rebind_current_transcript', { transcriptPath: '/tmp/a.jsonl' }); // A stores bind intent
  const clientB = await attachToDaemon({ discovery, leadPid: sleeperB.pid, cwd: 'B', onNotify: (m) => notB.push(m) });
  await clientB.call('rebind_current_transcript', { transcriptPath: '/tmp/b.jsonl' }); // B owner + bind intent
  await delay(120);
  check('failover: newest binder (B) owns the pointer', transport._resolveTargetForTest()?.leadPid === sleeperB.pid);

  const aBefore = notA.length;
  await clientB.close(); // pointer client dies → failover to survivor A
  await waitFor(() => transport._resolveTargetForTest()?.leadPid === sleeperA.pid, 1000);
  check('failover: pointer moves to surviving client (A)',
    transport._resolveTargetForTest()?.leadPid === sleeperA.pid);
  await waitFor(() => notA.slice(aBefore).some((m) => m?.method === REMOTE && m?.params?.state === 'acquired'), 1000);
  check('failover: survivor (A) receives the sticky acquired badge',
    notA.slice(aBefore).filter((m) => m?.method === REMOTE && m?.params?.state === 'acquired').length === 1);
  await waitFor(() => rebinds.some((r) => r.leadPid === sleeperA.pid), 1000);
  check('failover: survivor bind intent re-dispatched to its transcript',
    rebinds.some((r) => r.name === 'rebind_current_transcript'
      && r.args?.transcriptPath === '/tmp/a.jsonl' && r.leadPid === sleeperA.pid));

  await clientA.close();
  try { sleeperA.kill(); } catch {}
  try { sleeperB.kill(); } catch {}
  await transport.stop();
  try { rmSync(tmp, { recursive: true, force: true }); } catch {}
}

// Reattach-after-pointer-loss: the pointer client's SSE drops and it
// re-registers (reattach:true, SAME leadPid) with a FRESH token. The pointer
// must FOLLOW to the new token (old dead-stream entry dropped, no failover/
// self-superseded), and a notify must reach the NEW stream — not blackhole on
// the old entry.
async function pointerReconnectFollowsTest() {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'mixdog-reconnect-smoke-'));
  const discoveryPath = path.join(tmp, 'channel-daemon.json');
  const transport = createChannelDaemonTransport({
    handleCall: async () => ({ ok: true }),
    discoveryPath, clientGraceMs: 2000, sweepMs: 5000, onClientsEmpty: () => {},
    log: (m) => process.env.DAEMON_SMOKE_VERBOSE && console.log(`[reconnect] ${m}`),
  });
  const { port, token } = await transport.start();
  const s1 = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 60000)'], { stdio: 'ignore' });
  await delay(80);

  // Register X (fresh) → owner; open its SSE, then let the stream drop.
  const regX = await rawPost(port, token, '/client/register', { leadPid: s1.pid, cwd: 'X' });
  const notOld = [];
  const sseOld = rawSse(port, token, regX.token, (m) => notOld.push(m));
  await delay(60);
  try { sseOld.destroy(); } catch {}
  await delay(40);

  // Reconnect re-register (same leadPid) → fresh token; pointer must FOLLOW it.
  const regNew = await rawPost(port, token, '/client/register', { leadPid: s1.pid, cwd: 'X', reattach: true });
  await delay(40);
  check('reconnect: pointer follows the fresh reconnect token',
    transport._resolveTargetForTest()?.token === regNew.token && regNew.token !== regX.token);
  check('reconnect: dead old entry was dropped', !transport._clientsForTest.has(regX.token));

  // A notify must reach the NEW stream (no blackhole on the old dead entry).
  const notNew = [];
  const sseNew = rawSse(port, token, regNew.token, (m) => notNew.push(m));
  await delay(60);
  transport.notify('notifications/claude/channel', { content: 'to-reconnect' });
  await waitFor(() => notNew.some((m) => m?.params?.content === 'to-reconnect'), 1000);
  check('reconnect: notify reaches the new stream, not the dead old entry',
    notNew.some((m) => m?.params?.content === 'to-reconnect') &&
    !notOld.some((m) => m?.params?.content === 'to-reconnect'));

  try { sseNew.destroy(); } catch {}
  try { s1.kill(); } catch {}
  await transport.stop();
  try { rmSync(tmp, { recursive: true, force: true }); } catch {}
}
