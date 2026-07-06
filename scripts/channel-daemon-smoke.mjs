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
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
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
let failures = 0;
function check(label, cond) {
  const ok = !!cond;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
}

async function main() {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'mixdog-daemon-smoke-'));
  const discoveryPath = path.join(tmp, 'channel-daemon.json');
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

  // (3) LAST-WINS register: the NEWEST registrant (B) steals the ownership seat,
  // so an inbound notify targets B — NOT the first registrant. (Under the old
  // first-wins model this went to A.)
  transport.notify('notifications/claude/channel', { content: 'to-B' });
  await delay(120);
  check('notify #1 targets newest registrant (B) only',
    notB.length === 1 && notB[0]?.params?.content === 'to-B' && notA.length === 0);

  // (4) bind-intent call moves the pointer back to A.
  await clientA.call('rebind_current_transcript', { transcriptPath: '/tmp/a.jsonl' });
  transport.notify('notifications/claude/channel', { content: 'to-A' });
  await delay(120);
  check('notify #2 delivered to A only after rebind',
    notA.length === 1 && notA[0]?.params?.content === 'to-A' && notB.length === 1);

  // (fix 1) idempotent replay: two /call with the SAME callId (a retried
  // transport failure) must run the non-idempotent side-effect exactly once.
  const dupId = 'dup-call-1';
  const [d1, d2] = await Promise.all([
    clientA.call('reply', { n: 1 }, { callId: dupId }),
    clientA.call('reply', { n: 1 }, { callId: dupId }),
  ]);
  check('idempotent replay: same callId → exactly one side-effect',
    sideEffects === 1 && d1?.ok === true && d2?.ok === true);

  // (targeted) the 'acquired' badge goes ONLY to the current owner (pointer=A
  // after the rebind), never broadcast — a displaced/non-owner TUI (B) must not
  // light its remote badge. Still sticky for a late owner attach (below).
  const remoteBefore = { A: notA.length, B: notB.length };
  transport.notify('notifications/mixdog/remote', { state: 'acquired' });
  await delay(120);
  const gotA = notA.slice(remoteBefore.A).filter((m) => m?.method === 'notifications/mixdog/remote');
  const gotB = notB.slice(remoteBefore.B).filter((m) => m?.method === 'notifications/mixdog/remote');
  check('remote-state acquired targets owner (A) only, not broadcast',
    gotA.length === 1 && gotB.length === 0);

  // A late client that registers becomes the NEWEST owner (steals the pointer),
  // so on attach it replays the sticky 'acquired' badge for itself.
  const notC = [];
  const clientC = await attachToDaemon({ discovery, leadPid: process.pid, cwd: 'C', onNotify: (m) => notC.push(m) });
  await waitFor(() => notC.some((m) => m?.method === 'notifications/mixdog/remote'), 1000);
  check('late owner receives replayed remote-state on attach',
    notC.filter((m) => m?.method === 'notifications/mixdog/remote' && m?.params?.state === 'acquired').length === 1);
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
  // 'acquired' emitted via that sink reaches the transport and replays to a
  // late client — the exact daemon-mode path a raw process.send would drop.
  const { sendNotifyToParent } = createParentBridge({ getInstanceId: () => 'smoke' });
  setChannelNotifySink((method, params) => transport.notify(method, params));
  sendNotifyToParent('notifications/mixdog/remote', { state: 'acquired' });
  await delay(60);
  const notE = [];
  const clientE = await attachToDaemon({ discovery, leadPid: process.pid, cwd: 'E', onNotify: (m) => notE.push(m) });
  await waitFor(() => notE.some((m) => m?.method === 'notifications/mixdog/remote'), 1000);
  check('daemon-mode acquire via notify sink reaches transport + replays',
    notE.filter((m) => m?.method === 'notifications/mixdog/remote' && m?.params?.state === 'acquired').length === 1);
  await clientE.close();
  setChannelNotifySink(null);

  // (5) deregister both → self-shutdown fires after the client grace window.
  await clientA.close();
  await clientB.close();
  await delay(600);
  check('daemon self-shutdown fired after last client left', clientsEmptyFired === true);

  await transport.stop();
  try { rmSync(tmp, { recursive: true, force: true }); } catch {}

  await flipTest();
  await pointerStealTest();
  await reattachBufferTest();
  await pointerFailoverTest();
  await pointerReconnectFollowsTest();

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
  const { readDaemonDiscovery } = await import('../src/standalone/channel-daemon-client.mjs');
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

  // (fix 1) daemon death mid-session: SIGKILL it, then the surviving client's
  // next call must transparently respawn + re-attach (bounded retry inside
  // execute) — no TUI process restart.
  const beforeKill = readDaemonDiscovery(discFile);
  if (beforeKill?.pid) { try { process.kill(beforeKill.pid, 'SIGKILL'); } catch {} }
  await delay(400);
  let recovered = false;
  try { recovered = (await wA.execute('reply', { after: 'kill' }))?.ok === true; } catch {}
  const afterKill = readDaemonDiscovery(discFile);
  check('flip: call transparently respawns+reattaches after daemon death',
    recovered === true && !!afterKill?.pid && afterKill.pid !== beforeKill?.pid);

  await wA.stop();
  await wB.stop();
  await delay(700);
  const disc = readDaemonDiscovery(discFile);
  check('flip: daemon self-shutdown after last TUI detaches', disc === null);
  try { rmSync(tmp, { recursive: true, force: true }); } catch {}
}

// Last-wins ownership steal coverage with DISTINCT alive leadPids (two sleeper
// child processes) — the only way to observe the targeted 'superseded' frame,
// which is skipped when old/new client share a leadPid (same-TUI rebind).
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
  await delay(150); // B registers → steals the seat, A gets targeted superseded

  check('steal: newest registrant (B) becomes the owner pointer',
    transport._resolveTargetForTest()?.leadPid === sleeperB.pid);
  check('steal: displaced owner (A) got a TARGETED superseded on register',
    notA.filter((m) => m?.method === REMOTE && m?.params?.state === 'superseded').length === 1);
  check('steal: new owner (B) got no superseded',
    notB.filter((m) => m?.method === REMOTE).length === 0);

  // 'acquired' now targets the owner (B) only — never broadcast to A.
  transport.notify(REMOTE, { state: 'acquired' });
  await delay(120);
  check('steal: acquired targets owner (B) only, not broadcast',
    notB.filter((m) => m?.params?.state === 'acquired').length === 1 &&
    notA.filter((m) => m?.params?.state === 'acquired').length === 0);

  // A bind-intent /call from A steals the seat back → B (displaced) superseded.
  await clientA.call('activate_channel_bridge', {});
  await delay(120);
  check('steal: bind /call moves pointer back to A',
    transport._resolveTargetForTest()?.leadPid === sleeperA.pid);
  check('steal: displaced owner (B) got targeted superseded on bind /call',
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

  // (2) X's current entry never opened a stream; a fresh register Y steals the
  // seat → X's targeted 'superseded' is BUFFERED, then delivered on late attach.
  const regY = await rawPost(port, token, '/client/register', { leadPid: s2.pid, cwd: 'Y' });
  await delay(40);
  check('reattach: fresh Y steals the seat from X',
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
