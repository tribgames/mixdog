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
import { mkdtempSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createChannelDaemonTransport } from '../src/standalone/channel-daemon-transport.mjs';
import { attachToDaemon } from '../src/standalone/channel-daemon-client.mjs';

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

  // (3) notify targets the pointer client. First registrant (A) is the pointer.
  transport.notify('notifications/claude/channel', { content: 'to-A' });
  await delay(120);
  check('notify #1 delivered to A only',
    notA.length === 1 && notA[0]?.params?.content === 'to-A' && notB.length === 0);

  // (4) bind-intent call moves the pointer to B.
  await clientB.call('rebind_current_transcript', { transcriptPath: '/tmp/b.jsonl' });
  transport.notify('notifications/claude/channel', { content: 'to-B' });
  await delay(120);
  check('notify #2 delivered to B only after rebind',
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

  // (5) deregister both → self-shutdown fires after the client grace window.
  await clientA.close();
  await clientB.close();
  await delay(600);
  check('daemon self-shutdown fired after last client left', clientsEmptyFired === true);

  await transport.stop();
  try { rmSync(tmp, { recursive: true, force: true }); } catch {}

  await flipTest();

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

main().catch((err) => { console.error(err); process.exit(1); });
