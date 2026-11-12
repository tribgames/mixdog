// A. The state history of a conversation as Node's SessionHost publishes it (`subscribeSessionStates`: the input of each phone's mailbox,
// remote-relay-session-wiring.ts:203-207), before anything samples it. One case per process, in its own fresh world (environment,
// Node daemon, SessionHost) from the exact export of b6f10295a, run unchanged, with every input under the recorder's control:
//  - time and randomness (remote-protocol-chat-vclock.mjs) in this process and in every Node process of the daemon: frozen once the host
//    is attached, then moved only by the driver, to the next due timer or by a declared amount;
//  - the model endpoint gated (remote-protocol-chat-abort-provider.mjs `gated`): one write released at a time;
//  - the phone's calls (Node's remote-session-methods.ts table, as the phone's entry calls it), one at a time.
// Between two inputs the world is let SETTLE: every participant's event loop ran nothing of Node's for two turns, no short-lived request
// is pending, and every loopback connection between participants has been read up to what was written (the clock module's `quiet`).
//
//   node --import ./scripts/test-env.mjs --import ./scripts/test-tsx.mjs src/renderer/remote-protocol-chat-history.record.mjs <export dir> <real-turn-harness dir> <out file> <case>
import { asOwn, busyReport, childEnded, fenced, heldChanged, fireDue, freeze, install, markOwn, nextDue, quiet, realDeadline, realTimers, thaw, clockNow } from './remote-protocol-chat-vclock.mjs';

const [exportDir, harness, outFile, caseName] = process.argv.slice(2);
if (!caseName) throw new Error('usage: <export dir> <real-turn-harness dir> <out file> <case>');
install(`history:${caseName}:host`);

const { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } = await import('node:fs');
const net = await import('node:net');
const { join } = await import('node:path');
const { pathToFileURL } = await import('node:url');
const { ABORT_CASES, ASKED_PROJECT_FILE, DEVICES, HOOK_RULES, PROJECT_FILE } = await import('./remote-protocol-chat-abort-cases.mjs');
const { endLeftovers } = await import('./remote-protocol-chat-abort-procs.mjs');
const { startAbortProvider } = await import('./remote-protocol-chat-abort-provider.mjs');
const { NODE_COMMIT, verifyNodeExport } = await import('./remote-protocol-chat-node-export.mjs');

const c = ABORT_CASES.find((x) => x.name === caseName);
if (!c) throw new Error(`no case ${JSON.stringify(caseName)}`);
const filesVerified = verifyNodeExport(exportDir);
// The fixed instants the clocks are frozen at: Date and performance.now.
const EPOCH = 1_900_000_000_000;
const PERF_BASE = 10_000_000;
// How far the clock is moved after an input once its own work is done, so the session's frame clocks publish what it changed
// (frame-batched-store.mjs:11 16 ms, the daemon's publish interval) and nothing else is left waiting on a short timer.
const AFTER_INPUT_MS = 1_000;

const deadline = realDeadline(Number(process.env.HISTORY_DEADLINE_MS) || 300_000, () => `case ${caseName}; inputs so far: ${JSON.stringify(inputs.slice(-5))}; last settle round: ${JSON.stringify(lastRound)}`);
const inputs = [];
const history = [];
const roster = [];

// ── the daemon's Node processes, controlled over loopback ───────────────────────────────────────────────────────────────────────────
const remotes = [];
let frozen = null;
const controlServer = asOwn(() => net.createServer((socket) => {
  markOwn(socket);
  const remote = { socket, role: '', pid: 0, n: 0, waiting: new Map(), buffer: '' };
  remote.call = (op, extra = {}) => new Promise((resolve) => {
    if (remote.ended) return resolve({ ended: true, ran: false, ranTypes: {}, sockets: [], due: null });
    const n = ++remote.n;
    remote.waiting.set(n, resolve);
    asOwn(() => socket.write(`${JSON.stringify({ op, n, ...extra })}\n`));
  });
  socket.on('data', (chunk) => {
    remote.buffer += chunk;
    for (let at = remote.buffer.indexOf('\n'); at >= 0; at = remote.buffer.indexOf('\n')) {
      const m = JSON.parse(remote.buffer.slice(0, at));
      remote.buffer = remote.buffer.slice(at + 1);
      if (m.op === 'hello') {
        remote.role = m.role;
        remote.pid = m.pid;
        remotes.push(remote);
        remotes.sort((a, b) => (a.role < b.role ? -1 : a.role > b.role ? 1 : a.pid - b.pid));
        // A process that joins a frozen world is frozen at the world's instant.
        if (frozen) remote.call('freeze', clockNow().virtual ? { epoch: clockNow().now, perfBase: clockNow().perf } : frozen);
        for (const check of [...helloWaiters]) check();
      } else remote.waiting.get(m.re)?.(m), remote.waiting.delete(m.re);
    }
  });
  // A process (or worker) that ended answers what it was asked as ended: nothing running, nothing pending, no sockets.
  socket.on('close', () => {
    remote.ended = true;
    const at = remotes.indexOf(remote);
    if (at >= 0) remotes.splice(at, 1);
    for (const resolve of remote.waiting.values()) resolve({ ended: true, ran: false, ranTypes: {}, sockets: [], due: null });
    remote.waiting.clear();
  });
  socket.on('error', () => {});
}));
await new Promise((resolve) => asOwn(() => controlServer.listen(0, '127.0.0.1', resolve)));

/** The world is settled: in one round every participant was quiet with nothing run, and no loopback bytes are in flight between them. */
async function settle(what) {
  let fencedRound = false;
  for (;;) {
    const rounds = await deadline.race(Promise.all([quiet(), ...remotes.map((r) => r.call('quiet'))]), `the world to settle (${what})`);
    const sockets = rounds.flatMap((r, i) => r.sockets.map((s) => ({ ...s, owner: i })));
    const inFlight = sockets.filter((s) => {
      const peer = sockets.find((q) => q.local === s.remote && q.remote === s.local);
      if (peer) return peer.read !== s.written;
      // A connection to the model endpoint the host has not accepted yet (its 'connection' comes on real time): its bytes are in flight.
      // Once accepted, its answer is the recorder's own gate.
      if (s.remote === providerPort) return true;
      // A peer outside every clock (postgres) answers on real time: wait for its answer.
      return s.awaiting;
    });
    // Named pipes: everything the clients of a pipe wrote, its server side read, and the other way round (both sides among the participants).
    const pipes = new Map();
    for (const p of rounds.flatMap((r) => r.pipes ?? [])) {
      const [name, side] = [p.key.slice(0, p.key.lastIndexOf(' ')), p.key.slice(p.key.lastIndexOf(' ') + 1)];
      const t = pipes.get(name) ?? { client: { read: 0, written: 0 }, server: { read: 0, written: 0 } };
      t[side].read += p.read;
      t[side].written += p.written;
      pipes.set(name, t);
    }
    const pipesInFlight = [...pipes].filter(([, t]) => (t.client.read || t.client.written) && (t.server.read || t.server.written) && (t.client.written !== t.server.read || t.server.written !== t.client.read)).map(([name, t]) => ({ name, ...t }));
    // Messages between a thread and its parent (vclock.mjs installThreads): posted on one side, not yet handled on the other.
    const threads = new Map();
    for (const c of rounds.flatMap((r) => r.threads ?? [])) {
      const t = threads.get(c.key) ?? { sent: 0, handled: 0 };
      threads.set(c.key, { sent: t.sent + c.sent, handled: t.handled + c.handled });
    }
    const threadsInFlight = [...threads].filter(([, t]) => t.sent !== t.handled).map(([key, t]) => ({ key, ...t }));
    pipesInFlight.push(...threadsInFlight);
    // A Node child started but not yet joined (its start is on real time): its hello is awaited (the next round's call waits for it).
    const unjoined = rounds.flatMap((r) => r.nodeChildren ?? []).filter((pid) => !remotes.some((r) => r.pid === pid));
    // Participants waiting on a detached child they read (the daemon's supervisor): their clocks are held (vclock.mjs installChildren).
    held = new Set(rounds.map((r, i) => (r.holding ? (i ? remotes[i - 1] : 'host') : null)).filter(Boolean));
    lastRound = { ran: rounds.map((r, i) => [i ? remotes[i - 1]?.role : 'host', r.ranTypes]), inFlight, pipesInFlight, unjoined, provider: sockets.filter((s) => s.remote === providerPort || s.local === providerPort) };
    if (process.env.HISTORY_BODIES) trace.push({ what, clock: clockNow().perf - PERF_BASE, ...lastRound });
    // Either the child joins (hello) or it ends (its spawner reports it no more on the next round).
    if (unjoined.length) {
      fencedRound = false;
      const ended = Promise.race([childEnded(unjoined), ...remotes.map((r) => r.call('childEnded', { pids: unjoined }))]);
      await deadline.race(Promise.race([joined(unjoined), ended]), `Node children ${unjoined.join(', ')} to join the clock (${what})`);
      continue;
    }
    if (rounds.some((r) => r.ran) || inFlight.length || pipesInFlight.length) { fencedRound = false; continue; }
    // Quiet but for the OS's directory events: fenced once (vclock.mjs FENCE), then one more round must be quiet.
    const watched = [...new Set(rounds.flatMap((r) => r.watched ?? []))].filter((dir) => existsSync(dir));
    if (fencedRound || !watched.length) return;
    const names = {};
    for (const dir of watched) {
      // The pid keeps the fences of worlds side by side apart in the directories they share (the source tree, the temp folder).
      names[dir] = `.vclock-fence-${process.pid}-${(fences += 1)}`;
      writeFileSync(join(dir, names[dir]), '');
    }
    // The fences stay on disk until every watcher was told: a watcher opened after its fence was written finds it there (vclock.mjs).
    await deadline.race(Promise.all([fenced(names), ...remotes.map((r) => r.call('fenced', { names }))]), `the directory watchers to be told of the fence (${what}): ${watched.join(', ')}`);
    for (const dir of watched) rmSync(join(dir, names[dir]), { force: true });
    fencedRound = true;
  }
}
/** Resolves once every pid has said hello, or has ended (a child that ended before joining is reported no more by its spawner). */
const helloWaiters = new Set();
function joined(pids) {
  return new Promise((resolve) => {
    const check = () => {
      const alive = pids.filter((pid) => { try { process.kill(pid, 0); return true; } catch { return false; } });
      if (alive.every((pid) => remotes.some((r) => r.pid === pid))) { helloWaiters.delete(check); resolve(); }
    };
    helloWaiters.add(check);
    check();
  });
}
let fences = 0;
let lastRound = null;
let providerPort = 0;
const trace = [];
let held = new Set();
async function nextDueAll() {
  const free = remotes.filter((r) => !held.has(r));
  const dues = [held.has('host') ? null : nextDue(), ...(await Promise.all(free.map((r) => r.call('nextDue')))).map((m) => m.due)].filter((d) => d !== null);
  return dues.length ? Math.min(...dues) : null;
}
/** Every clock to `at`, firing what is due there: this process first, then each daemon process in role order, settling after each. A
 *  held clock stays where it is (its due timers fire once it is released, at the instant the others reached). */
async function fireAll(at, what) {
  // A move of the clocks is an input of its own: a replay moves its side's clock here, between the same inputs.
  if (at !== clockNow().perf) inputs.push({ at: history.length, clock: at - PERF_BASE, input: 'clock' });
  if (!held.has('host')) {
    fireDue(at);
    await settle(`${what}: this process's timers at ${at - PERF_BASE}`);
  }
  for (const r of [...remotes]) {
    if (held.has(r)) continue;
    await deadline.race(r.call('fire', { at }), `${r.role} to fire its timers at ${at - PERF_BASE}`);
    await settle(`${what}: ${r.role}'s timers at ${at - PERF_BASE}`);
  }
}
/** The model endpoint's held writes, released one at a time with the world settled after each. */
async function releaseProvider(what) {
  for (let released = provider.releaseNext(); released; released = provider.releaseNext()) {
    inputs.push({ at: history.length, clock: clockNow().perf - PERF_BASE, input: 'provider write', ...released });
    await settle(`${what}: after the model endpoint's write ${released.step} of ${released.prompt}`);
  }
}
/** Runs the world: settle, release the endpoint, and, until `until()` holds (or for `budget` virtual ms when there is none), move the
 *  clocks to the next due timer. With `until`, a budget passed first is a failure naming `what`. */
async function run(what, { until, budget = AFTER_INPUT_MS } = {}) {
  const start = clockNow().perf;
  for (;;) {
    await settle(what);
    await releaseProvider(what);
    if (until?.()) return;
    const due = await nextDueAll();
    if ((due === null || due > start + budget) && held.size) {
      // Nothing else can move: what a held participant waits on comes from outside the clocks.
      await deadline.race(Promise.race([...held].map((p) => (p === 'host' ? heldChanged() : p.call('heldChanged')))), `a detached child to answer (${what})`);
      continue;
    }
    if (due === null || due > start + budget) {
      if (until) throw new Error(`${caseName}: ${what} did not happen within ${budget} virtual ms`);
      await fireAll(start + budget, what);
      await settle(what);
      return;
    }
    await fireAll(due, what);
  }
}

// ── the world ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const hload = (name) => import(pathToFileURL(join(harness, 'lib', name)).href);
process.env.HARNESS_ENV_ROOT = join(harness, 'run', `env-history-${caseName}`);
const { daemonEnv, isolatedPaths } = await hload('env.mjs');
const envPaths = isolatedPaths();
const project = join(envPaths.workspace, 'a');
rmSync(envPaths.envRoot, { recursive: true, force: true });
for (const d of [envPaths.dataDir, envPaths.runtimeRoot, envPaths.appData, envPaths.localAppData, envPaths.tmp, envPaths.workspace, project]) mkdirSync(d, { recursive: true });
writeFileSync(join(project, PROJECT_FILE.name), PROJECT_FILE.text);
writeFileSync(join(project, ASKED_PROJECT_FILE.name), ASKED_PROJECT_FILE.text);
writeFileSync(join(envPaths.dataDir, 'hooks.json'), JSON.stringify(HOOK_RULES));
const provider = await startAbortProvider({ gated: true });
providerPort = Number(new URL(provider.baseURL).port);
writeFileSync(join(envPaths.dataDir, 'mixdog-config.json'), JSON.stringify({ agent: { providers: { 'custom-harness': { type: 'custom', schemaVersion: 2, name: 'harness', protocol: 'openai-chat', baseURL: provider.baseURL, auth: 'none', enabled: true, modelOverrides: { 'harness-model': { manual: true } } } } } }));
const route = { provider: 'custom-harness', model: 'harness-model' };
const plain = (value) => JSON.parse(JSON.stringify(value));
for (const key of Object.keys(process.env)) if (/^MIXDOG_/i.test(key)) delete process.env[key];
Object.assign(process.env, daemonEnv(envPaths));
// Every Node process of the daemon loads the clock module first and reports to this process.
process.env.NODE_OPTIONS = `--import=${new URL('./remote-protocol-chat-vclock.mjs', import.meta.url).href}`;
process.env.VCLOCK_PORT = String(controlServer.address().port);
process.env.VCLOCK_SEED = `history:${caseName}`;
// The top of supervisor.mjs's range (PG_PORT_MIN 55432 .. PG_PORT_MAX 55632): its bottom is where the machine's own stores are. The range
// lies inside Windows' ephemeral ports, so a case's own port may be held by some loopback connection's local end: then a spare from the
// top of the range is claimed (an exclusively created file per port, removed at the end) among the cases side by side.
const portFree = (port) => new Promise((resolve) => {
  const probe = asOwn(() => net.createServer());
  markOwn(probe);
  probe.once('error', () => resolve(false));
  probe.listen({ port, host: '127.0.0.1', exclusive: true }, () => probe.close(() => resolve(true)));
});
const claimsDir = join(harness, 'run', 'pg-port-claims');
mkdirSync(claimsDir, { recursive: true });
let pgClaim = null;
let pgPort = 55600 + ABORT_CASES.findIndex((k) => k.name === caseName);
if (!(await portFree(pgPort))) {
  pgPort = 0;
  for (let spare = 55600 + ABORT_CASES.length; spare <= 55632 && !pgPort; spare += 1) {
    const claim = join(claimsDir, String(spare));
    try { writeFileSync(claim, String(process.pid), { flag: 'wx' }); } catch { continue; }
    if (await portFree(spare)) { pgPort = spare; pgClaim = claim; } else rmSync(claim, { force: true });
  }
  if (!pgPort) throw new Error(`${caseName}: no free memory-store port: ${55600 + ABORT_CASES.findIndex((k) => k.name === caseName)} and every spare up to 55632 are held`);
}
process.on('exit', () => { if (pgClaim) rmSync(pgClaim, { force: true }); });
process.env.VCLOCK_PG_PORT = String(pgPort);
process.execArgv = [];

const load = (path) => import(pathToFileURL(join(exportDir, 'apps/desktop/src', path)).href);
const { SessionHost } = await load('main/session-host.ts');
const sessionClient = await import(pathToFileURL(join(exportDir, 'src/standalone/session-client.mjs')).href);
const { createSessionProtocolClient } = await import(pathToFileURL(join(exportDir, 'src/standalone/session-protocol.mjs')).href);
const { createDesktopRuntime } = await import(pathToFileURL(join(exportDir, 'src/standalone/daemon-desktop-runtime.mjs')).href);
const { createPushNotifier } = await load('main/push-notifier.ts');
const { sessionRemoteMethods } = await load('main/remote-session-methods.ts');

let discovery;
let host;
let failure = null;
try {
  // The memory store's runtime (postgres) is installed from the network on first use (runtime-fetcher.mjs ensureRuntime): an input
  // from outside every clock and outside the machine. It is copied in from an installed one instead (HISTORY_PG_RUNTIME, a
  // `<dataDir>/runtime` folder of the same bundled manifest version), which ensureRuntime takes as its cache hit (`cachedRuntimeDir`).
  if (!process.env.HISTORY_PG_RUNTIME) throw new Error('HISTORY_PG_RUNTIME: an installed <dataDir>/runtime folder to copy in');
  cpSync(process.env.HISTORY_PG_RUNTIME, join(envPaths.dataDir, 'runtime'), { recursive: true });
  // The memory store's postgres boots on real time (process.mjs startAndWaitReady polls its readiness every 250 ms of the clock), an
  // input from outside every clock: booted here first, on real time, by Node's own supervisor, so the daemon attaches to a ready
  // instance (supervisor.mjs ensurePgInstance, the existing-postmaster path) and its readiness is not raced against the virtual clock.
  const { ensurePgInstance } = await import(pathToFileURL(join(exportDir, 'src/runtime/memory/lib/pg/supervisor.mjs')).href);
  await deadline.race(ensurePgInstance(envPaths.dataDir), 'the memory store\'s postgres');
  // From here on time is the recorder's: the daemon and every Node process it starts begin frozen at the world's instant (VCLOCK_AT), so
  // their start-up is driven by the same clock as the rest of the case, never raced against real time.
  frozen = { epoch: EPOCH, perfBase: PERF_BASE };
  freeze(EPOCH, PERF_BASE);
  /** A call of this process's that the world must run for: run until it settles. */
  const drive = async (promise, what) => {
    let outcome = null;
    promise.then((value) => { outcome = { value }; }, (error) => { outcome = { error }; });
    await run(what, { until: () => outcome !== null, budget: 120_000 });
    if (outcome.error) throw outcome.error;
    return outcome.value;
  };
  discovery = await drive(sessionClient.ensureDaemon({ cwd: envPaths.workspace, attempts: 1, readyTimeoutMs: 60_000 }), 'the Node daemon');
  const runtime = {
    ...createDesktopRuntime({ getLocalSessionBridge: () => null }),
    attachSessionClient: async (options) => {
      const attached = await sessionClient.attachSession({ discovery, cwd: envPaths.workspace, onFrame: (frame) => options.onFrame(frame), onFatal: options.onFatal });
      return createSessionProtocolClient({ call: (name, args, callOptions) => attached.call(name, args, callOptions), close: (reason) => attached.close(reason) });
    },
  };
  host = await drive(SessionHost.create({ userDataPath: envPaths.appData, resourcesPath: envPaths.workspace, appPath: envPaths.workspace, packaged: false }, runtime), 'the session host');
  // The history: every session state the host publishes, whole, in order (an equal one included: the host published it).
  host.subscribeSessionStates((update) => history.push({ sessionId: update.sessionId, frameSource: update.frameSource ?? null, snapshot: plain(update.snapshot ?? null) }));
  // The thread list as a phone's relay hears it (remote-relay-catalog.ts, `subscribeSessions`), each publication with the clock it came
  // at: the host's catalog clock (session-host-catalog.ts:170-180 scheduleCatalogRefresh, a 400 ms debounce no sooner than 2 s after the
  // last refresh) runs on the recorder's clock.
  host.subscribeSessions((sessions) => roster.push({ at: history.length, clock: clockNow().perf - PERF_BASE, sessions: plain(sessions) }));
  const notifier = createPushNotifier({ store: {}, isEnabled: () => false, readFinalAnswer: async () => null, isClientForeground: () => false });
  host.subscribeSessionStates((update) => notifier.onSessionState(update));
  const approvalNotifications = {
    approvalAllowDecision: (sessionId, approvalId) => notifier.approvalAllowDecision(sessionId, approvalId),
    approvalPointerOnly: (sessionId, approvalId) => notifier.approvalPointerOnly(sessionId, approvalId),
  };
  const phones = new Map();
  const phone = (device) => {
    if (!phones.has(device)) phones.set(device, sessionRemoteMethods(host, { deviceName: async () => device }, undefined, approvalNotifications));
    return phones.get(device);
  };

  await run('the attached world');

  /** One input: a call of the phone's table (or the host's), the world run until its reply and then for AFTER_INPUT_MS. */
  // Several invokes are one input: all are made in the same tick, in order, and their replies recorded in that order (`<label> <n>`).
  const calls = async (label, invokes) => {
    inputs.push({ at: history.length, clock: clockNow().perf - PERF_BASE, input: label });
    const outcomes = invokes.map(() => null);
    invokes.forEach((invoke, n) => invoke().then((reply) => { outcomes[n] = { reply: plain(reply ?? null) }; }, (error) => { outcomes[n] = { error: String(error?.message ?? error) }; }));
    await run(`the reply to ${label}`, { until: () => outcomes.every((o) => o !== null), budget: 120_000 });
    for (const [n, outcome] of outcomes.entries()) history.push({ kind: 'reply', input: invokes.length > 1 ? `${label} ${n + 1}` : label, ...outcome });
    await run(`the world after ${label}`);
    return outcomes;
  };
  const call = async (label, invoke) => (await calls(label, [invoke]))[0];
  const submitter = phone(c.submitter ?? DEVICES.a);
  const canceller = phone(c.canceller ?? c.submitter ?? DEVICES.a);
  await call('host.startProject', () => host.startProject(project));
  const submit = { id: `sub-${c.name}`, ...(c.pasted ? { pastedTexts: c.pasted } : {}), ...(c.submit ?? {}) };
  const accepted = await call('phone.submitNewTask', () => submitter.submitNewTask([c.prompt, submit, { projectPath: project, route }]));
  const id = accepted.reply?.sessionId;
  if (!id) throw new Error(`${caseName}: submitNewTask answered ${JSON.stringify(accepted)}`);
  const turnRequest = (nth = 1) => () => provider.requests.filter((r) => (r.held || r.asked) && r.prompt.includes(c.prompt)).length >= nth;
  if (c.ready !== 'completed') await run('the model endpoint to receive the turn', { until: turnRequest(), budget: 120_000 });
  const shown = () => history.filter((h) => h.sessionId === id).at(-1)?.snapshot;
  if (c.ready === 'approval' || c.ready === 'ask') await run('the approval to be shown', { until: () => Boolean(shown()?.toolApproval), budget: 120_000 });
  if (c.ready === 'completed') await run('the turn to end on its own', { until: () => shown()?.busy === false && (shown()?.stats?.turns ?? 0) >= 1, budget: 120_000 });
  await run('the world after the turn reached its state');
  if (c.then) await call('phone.submitToSession', () => submitter.submitToSession([id, c.then, { id: `sub-${c.name}-2` }]));
  let shownId;
  for (const [n, step] of (c.notify ?? []).entries()) {
    const approvalId = step.id === 'shown' ? (shownId ??= String(shown()?.toolApproval?.id ?? '')) : step.id;
    if (!approvalId) throw new Error(`${caseName}: no approval is shown for notification answer ${n}`);
    await call(`phone.answerApprovalNotification ${n} ${step.action} ${step.id}`, () => submitter.answerApprovalNotification([id, approvalId, step.action]));
  }
  // Any state published since the Stop that closes the turn(s): a requeued runtime turn is busy again in the next one.
  const closedAt = history.length;
  if (c.stop && c.twice) await calls('phone.abortSession twice', [() => canceller.abortSession([id, c.stop]), () => canceller.abortSession([id, c.stop])]);
  else if (c.stop) await call('phone.abortSession', () => canceller.abortSession([id, c.stop]));
  const turns = c.then ? 2 : 1;
  const closed = () => history.slice(closedAt).some((h) => h.sessionId === id && h.snapshot?.busy === false && (h.snapshot?.stats?.turns ?? 0) >= turns) || (shown()?.busy === false && (shown()?.stats?.turns ?? 0) >= turns);
  await run('the turn(s) to close', { until: closed, budget: 120_000 });
  if (c.requeued) await run('the requeued turn to reach the model endpoint', { until: turnRequest(2), budget: 120_000 });
  if (c.again) await call('phone.abortSession again', () => canceller.abortSession([id, c.again]));
  await run('the world after the case', { budget: 5_000 });
  if (c.requeued) await call('host.deleteSession', () => host.deleteSession(id));

  // Values that are the run's own and not Node's behaviour, replaced by what they are: the process ids and loopback ports.
  const own = new Map([[String(process.pid), '<pid:host>'], [String(discovery.pid), '<pid:daemon>'], [new URL(provider.baseURL).port, '<port:model>'], [String(discovery.port), '<port:daemon>']]);
  for (const r of remotes) if (!own.has(String(r.pid))) own.set(String(r.pid), `<pid:${r.role}>`);
  // A number equal to one is its label; inside a string, the digits standing alone are.
  const pattern = new RegExp(`(?<![0-9])(${[...own.keys()].join('|')})(?![0-9])`, 'g');
  const relabel = (value) => {
    if (typeof value === 'number' && own.has(String(value))) return own.get(String(value));
    if (typeof value === 'string') return value.replace(pattern, (m) => own.get(m));
    if (Array.isArray(value)) return value.map(relabel);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [relabel(k), relabel(v)]));
    return value;
  };
  const manifest = { commit: NODE_COMMIT, exact: true, filesVerified, node: process.version, epoch: EPOCH, perfBase: PERF_BASE, afterInputMs: AFTER_INPUT_MS, replaced: [...own.values()] };
  writeFileSync(outFile, `${JSON.stringify(relabel({ manifest, name: caseName, id, inputs, history: history.filter((h) => h.kind === 'reply' || h.sessionId === id), roster }), null, 1)}\n`);
  // The model endpoint's request bodies, for finding what made two runs differ (not part of the recording).
  if (process.env.HISTORY_BODIES) writeFileSync(`${outFile}.trace.json`, `${trace.map((t) => JSON.stringify(t)).join('\n')}\n`);
  if (process.env.HISTORY_BODIES) writeFileSync(`${outFile}.bodies.json`,`${JSON.stringify(relabel(provider.requests.map((r) => JSON.parse(r.raw || '{}'))), null, 1)}\n`);
  console.log(`${caseName}: ${history.length} states and replies, ${inputs.length} inputs`);
} catch (error) {
  failure = error;
  // What was published up to the failure (not a recording).
  writeFileSync(`${outFile}.failed.json`, `${JSON.stringify({ inputs, history }, null, 1)}\n`);
  // What each participant was doing when the world did not settle.
  const reports = await Promise.race([Promise.all(remotes.map((r) => r.call('report').then((m) => [r.role, r.pid, m]))), new Promise((resolve) => realTimers.setTimeout(() => resolve('no report within 5 s'), 5_000))]);
  console.error(JSON.stringify({ host: busyReport(), remotes: reports }).slice(0, 6000));
  // Who listens at the far end of a connection still owed an answer (a peer outside the participants).
  const owed = (lastRound?.inFlight ?? []).map((s) => s.remote);
  if (owed.length) {
    const { execFileSync } = await import('node:child_process');
    const table = execFileSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8', windowsHide: true });
    for (const port of owed) {
      // The far end's own socket: the row whose local address is that port (listening, or the accepted connection).
      const pid = table.split('\n').find((line) => line.trim().split(/\s+/)[1]?.endsWith(`:${port}`))?.trim().split(/\s+/).at(-1);
      const cl = pid ? execFileSync('powershell', ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine`], { encoding: 'utf8', windowsHide: true }).trim() : '';
      console.error(`owed peer :${port} held by pid ${pid ?? 'none'}: ${cl.slice(0, 400)}\n${table.split('\n').filter((line) => line.includes(`:${port} `)).join('\n')}`);
    }
  }
} finally {
  // Teardown runs on real time again: the host's and the daemon's own shutdown waits.
  thaw();
  for (const r of [...remotes]) await r.call('thaw').catch(() => {});
  const ending = realDeadline(90_000, () => `ending the world of ${caseName}`);
  try {
    try {
      if (host) await ending.race(host.dispose(), 'the host to dispose');
    } finally {
      if (discovery) await ending.race(sessionClient.shutdownDaemon(discovery, { waitForExit: true, timeoutMs: 60_000 }), 'the Node daemon to exit');
    }
  } catch (error) {
    failure ??= error;
  } finally {
    ending.clear();
    endLeftovers(Number(discovery?.pid) || 0, envPaths.envRoot);
    deadline.clear();
    await provider.close();
    controlServer.close();
  }
}
if (failure) {
  console.error(failure?.stack ?? failure);
  process.exit(1);
}
process.exit(0);
