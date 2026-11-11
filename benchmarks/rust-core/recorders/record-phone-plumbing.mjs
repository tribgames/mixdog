#!/usr/bin/env node
// What Node's relay (b6f10295a) does with the paired phone's relay plumbing calls (list 1 unit G: `setForeground`,
// `setScreenSessions`, `setVisualizePanels`, `remotePerfPaint`, `reportConnectionTimeline`), recorded from an exact export: the
// relay's own per-client call dispatch (`createRelayClientCallDispatch`, remote-relay-client-calls.ts) over a client state its own
// registry made (`createRelayClientRegistry`, remote-relay-clients.ts), each call sent as the phone's page sent it (`fire`: a frame
// `{method, params}` with no id, after JSON). Per call the recording holds what the phone received (Node answers none of them), and
// what the leg's state then decides:
//  - `viewing`: the sessions whose visualize panel the phone counts as viewing (`clientViewsSessionLane`, the visualize lane), which
//    the core publishes as `hostState.remoteViewing`;
//  - `credential` and `browser`: the sessions a push is held back for, for the paired credential (native and relay Web Push) and for
//    a browser id (direct Web Push) (`legShowsSession` of remote-transport/foreground.ts on a live leg, matched by
//    `credentialId` / `browserId` as remote-relay-session-wiring.ts:131-160 does).
//
//   node --import apps/desktop/scripts/test-env.mjs --import apps/desktop/scripts/test-tsx.mjs \
//        benchmarks/rust-core/recorders/record-phone-plumbing.mjs --tree <git archive of b6f10295a with node_modules> [--only]
//
// With `--replay <mixdogd.exe>` the same calls go through the phone's router and adapter (renderer/remote-protocol-screen.ts) on a
// phone paired behind a scripted relay with a built `mixdogd`; what the phone receives and `hostState.remoteViewing` (read by a second,
// local connection) are compared with the recording whole. The push columns are not readable over the protocol: the Rust test
// mixdog-core-domains notify::screen::tests::the_phones_plumbing_calls_decide_what_nodes_relay_decided replays them on the core's
// registry.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, watch } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { commitStage, exactProductIdentity, importFrom, parseArgs, REPO_ROOT, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';
import { recorderProvenance } from './lib/provenance.mjs';

const REF = 'b6f10295a2f698afc85332467192de28500bd146';
const RECORDER = 'benchmarks/rust-core/recorders/record-phone-plumbing.mjs';
const FIXTURES = join(REPO_ROOT, 'apps', 'mobile', 'fixtures', 'phone-plumbing');
const args = parseArgs();
const REPLAY = args.get('replay') ?? null;
const ONLY = args.has('only');
const here = (path) => import(pathToFileURL(join(REPO_ROOT, path)).href);
const PHONE_ID = '0123456789abcdef0123456789abcdef';
const CREDENTIAL = 'cred-a';

/** The phone's calls, as its page fired them (b6f10295a remote-shim-dispatch.ts:259/:268, remote-shim-sync.ts, remote-shim-calls.ts
 *  `fire`), including the arguments a page leaves out and the items `filterSessionIds` drops. */
const CALLS = [
  ['setScreenSessions', [['s1']]],
  ['setForeground', [true, 'browser-a']],
  ['setVisualizePanels', [['s2']]],
  ['setForeground', [false]],
  ['setScreenSessions', [['s1', 's3']]],
  ['setForeground', []],
  ['setScreenSessions', []],
  ['setScreenSessions', [['s1', 's1', 'bad id!', 123, null, '', 's2']]],
  ['setVisualizePanels', []],
  ['setVisualizePanels', [['s2', 7, 's3', 'bad id!']]],
  ['setForeground', [true, 'x'.repeat(70)]],
  ['setForeground', [true, 5]],
  ['setForeground', ['no']],
  ['setForeground', [null]],
  ['setScreenSessions', ['s1']],
  ['remotePerfPaint', ['s1:1', 12.5]],
  ['reportConnectionTimeline', ['phase=open@0 state=ready@12 issue=none@3']],
  ['reportConnectionTimeline', []],
  ['setForeground', [false, 'browser-a']],
  ['setVisualizePanels', [['s1']]],
  ['setForeground', [true, 'browser-b']],
];
/** The sessions and browser ids each step is asked about. An empty browser id is no subscription's key. */
const SESSIONS = ['s1', 's2', 's3', '7', '123', 'bad id!'];
const BROWSERS = ['browser-a', 'browser-b', 'x'.repeat(64), 'x'.repeat(70)];

const work = join(process.env.TEMP ?? REPO_ROOT, 'phone-plumbing');
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });

if (REPLAY) process.exit(await replay(REPLAY));

const tree = resolveTree(args);
const identity = exactProductIdentity(tree, REF);
const main = (name) => importFrom(tree, `apps/desktop/src/main/${name}.ts`);
const { createRelayClientRegistry, clientViewsSessionLane } = await main('remote-relay-clients');
const { createRelayClientCallDispatch } = await main('remote-relay-client-calls');
const { legShowsSession } = await main('remote-transport/foreground');
const { createRemotePaintProbeTracker } = await importFrom(tree, 'apps/desktop/src/shared/remote-performance.ts');
const { REMOTE_VISUALIZE_LANE } = await importFrom(tree, 'apps/desktop/src/shared/visualize.ts');

const envelopes = [];
const registry = createRelayClientRegistry({
  host: { setVisibleSessionsForSource: async () => true },
  sendEnvelope: (envelope) => envelopes.push(envelope),
  frameBudgetBytes: 1 << 20,
  onClientCountChanged() {},
  onEmpty() {},
});
const client = registry.open('client-a', {}, CREDENTIAL);
// What the E2EE handshake leaves: the channel is open.
clearTimeout(client.handshakeTimer);
client.channel = {};
const sent = [];
const dispatch = createRelayClientCallDispatch({
  host: {},
  methods: {},
  attached: (id, state) => registry.attached(id, state),
  live: () => true,
  sendEncryptedFrame: async (_id, payload) => {
    sent.push(payload);
  },
  // The PC issues paint probes only with its perf flag on (remote-relay-session-state.ts); off, as a user's PC runs.
  acknowledgePaintProbe: createRemotePaintProbeTracker({ enabled: false }).acknowledgeFrame,
  resyncClient() {},
  recordCall() {},
  browserStreams: { subscribe() {}, unsubscribe() {}, acknowledge() {} },
  browserTabs: { watch() {} },
});
const pcLog = [];
const steps = [];
for (const [call, params] of CALLS) {
  const frame = JSON.stringify({ method: call, params });
  const [error, info] = [console.error, console.info];
  console.error = (line) => pcLog.push({ step: steps.length, method: 'error', line: String(line) });
  console.info = (line) => pcLog.push({ step: steps.length, method: 'info', line: String(line) });
  try {
    const outcome = await dispatch('client-a', client, JSON.parse(frame), Buffer.byteLength(frame));
    await outcome.execution;
  } finally {
    [console.error, console.info] = [error, info];
  }
  // A live leg (authenticated within the stale window): the push rule of a transport leg and of a legacy leg agree on it.
  const shows = (sessionId) => legShowsSession({ ...client, liveAt: 0 }, sessionId, 0);
  steps.push({
    call,
    params: JSON.parse(JSON.stringify(params)),
    frames: sent.splice(0),
    // Every session Node counts the phone as viewing (any other id is no panel it reported), in the order of its set.
    viewing: [...(client.visualizePanelSessionIds ?? [])].filter((id) => clientViewsSessionLane(client, id, REMOTE_VISUALIZE_LANE)),
    credential: SESSIONS.filter((id) => client.credentialId === CREDENTIAL && shows(id)),
    browser: Object.fromEntries(BROWSERS.map((browserId) => [browserId, SESSIONS.filter((id) => client.browserId === browserId && shows(id))])),
  });
}
registry.clear();

if (ONLY) {
  const text = `${JSON.stringify({ steps, pcLog, envelopes }, null, 2)}\n`;
  await new Promise((written, failed) => process.stdout.write(text, (error) => (error ? failed(error) : written())));
  process.exit(0);
}
const out = stageSet(FIXTURES);
writeJson(join(out, 'golden.json'), {
  note: "Node relay's handling of a paired phone's setForeground, setScreenSessions, setVisualizePanels, remotePerfPaint and reportConnectionTimeline: per call what the phone received (frames), the sessions the phone counts as viewing a visualize panel of (viewing), and the sessions a push is held back for, for its credential (credential) and per browser id (browser). pcLog is what Node wrote to its own log.",
  credential: CREDENTIAL,
  sessions: SESSIONS,
  browsers: BROWSERS,
  steps,
  pcLog,
  envelopes,
});
writeSetManifest(out, {
  set: 'phone-plumbing',
  recorder: RECORDER,
  command: `node --import apps/desktop/scripts/test-env.mjs --import apps/desktop/scripts/test-tsx.mjs ${RECORDER} --tree <git archive of ${REF} with node_modules>`,
  identity,
  extra: {
    steps: steps.length,
    ...recorderProvenance(import.meta.url),
    entry: {
      runs: 'createRelayClientCallDispatch (remote-relay-client-calls.ts) over a client state of createRelayClientRegistry (remote-relay-clients.ts), the paint probe tracker of shared/remote-performance.ts (perf flag off), clientViewsSessionLane and legShowsSession (remote-transport/foreground.ts)',
      notRun:
        "the relay transport (encryption, admission: the client's channel is set as the handshake leaves it) and the method table: none of these calls reaches it but remotePerfPaint, which has no id and is no method, so the empty table answers it as the full one does (executeRemoteFrame: no id, no answer)",
    },
    comparison: {
      replay:
        "each step whole except the push columns: the call, the frames the phone received, the whole published hostState.remoteViewing value (read by a local connection once the phone has had an answer to a later request) against { sessionIds: Node's viewing }, and the PC's console lines so far (Node's pcLog against every `[console.<method>]` row the core wrote to <data>/daemon.log since the phone's first call); after the last step the core is stopped (which flushes its log) and the whole log is compared again",
      rustTest: 'credential, browser and viewing per step: mixdog-core-domains notify::screen::tests::the_phones_plumbing_calls_decide_what_nodes_relay_decided, on the core registry',
      pushRule: "the push columns ask legShowsSession of a live leg; Node's legacy leg rule (remote-relay-session-wiring.ts legacyLegShows: !background && screenSessionIds.has) is the same answer",
      normalized: {
        viewingOrder:
          "Node's viewing is its visualizePanelSessionIds set in insertion order, the core publishes the set sorted: both are sorted before comparing (the replay and the Rust test). No page sees the order: the one reader of hostState.remoteViewing asks membership (apps/desktop/src/main/protocol/section-reads.ts visualizeRemoteViewing), as Node's viewsSessionLane answered one session at a time",
        logDestination:
          "Node's console.info ran in the desktop main process, which hosted the relay; the relay is the core's, so the line is the core's console.info, written as `[<ISO>] [console.info] <line>` to daemon.log (DaemonLog::console, as the rooms log): the replay compares the method and the line, not the time stamp",
        clientId: "the replay opens the phone's relay leg as Node's recorded leg was named (client-a): the line names the relay client id's first 8 units",
      },
      notCompared: {
        emptyBrowserId: "a browser id '' is no push subscription's key (a subscription is keyed by the id the phone generated), so it is not asked",
      },
    },
  },
});
commitStage(out, FIXTURES);
console.log(`phone-plumbing: ${steps.length} steps`);
process.exit(0);

// ── the replay: the phone's router and adapter over a built core ──
async function replay(exe) {
  const { startCore, killTree, answered, exitWithin } = await import('./lib/phone-files-replay.mjs');
  const { startRelay } = await import('./lib/phone-relay-core.mjs');
  const golden = JSON.parse(readFileSync(join(FIXTURES, 'golden.json'), 'utf8'));
  const manifest = JSON.parse(readFileSync(join(FIXTURES, 'MANIFEST.json'), 'utf8'));
  const provenance = recorderProvenance(import.meta.url);
  if (!isDeepStrictEqual(manifest.inputs, provenance.inputs) || manifest.recorderSha256 !== provenance.recorderSha256) {
    throw new Error('the recording was made by another recorder than this one: record again before comparing');
  }
  const relay = await startRelay({ repoRoot: REPO_ROOT, clients: [], capabilities: { textFrames: 1, maxFrameBytes: 1048576 } });
  let core = null;
  let phone = null;
  let window = null;
  try {
    core = await startCore(exe, join(work, 'core'), relay);
    const { connect, sessionReducer } = await here('packages/protocol-client/src/index.ts');
    const { createWsConnector } = await here('apps/desktop/src/main/protocol/ws-connector.ts');
    await answered("the core's relay leg", relay.leg());
    const { relayE2EEPairingMaterial } = await here('apps/desktop/src/shared/remote-e2ee.ts');
    const pairing = relayE2EEPairingMaterial(JSON.parse(readFileSync(join(core.dataDir, 'relay-e2ee.json'), 'utf8')));
    // The relay client id Node's leg had: the timeline's log line names its first 8 units.
    const leg = await answered("the paired phone's relay connection", relay.openPhone('client-a', PHONE_ID, pairing));
    // Every frame the core sends the phone, in order.
    const received = [];
    const connector = { open: (target, sink) => leg.open(target, { frame: (text) => (received.push(text), sink.frame(text)), closed: (code, reason) => sink.closed(code, reason) }) };
    const base = {
      target: { id: 'core' },
      clientInfo: { name: 'mixdog-phone', title: 'Mixdog Phone', version: '1.4.5', kind: 'phone' },
      capabilities: { optOutNotificationMethods: [], experimentalApi: false },
      threadReducer: sessionReducer,
      clock: { sleep: () => Promise.reject(new Error('the replay dropped a connection')) },
      random: Math.random,
    };
    phone = await answered("the phone's connection (initialize)", connect({ ...base, connector }));
    window = await answered('the local connection (initialize)', connect({ ...base, connector: createWsConnector(async () => core.endpoint), clientInfo: { ...base.clientInfo, name: 'mixdog-replay-reader' } }));
    await answered('app/subscribe of the local connection', window.subscribeApp());
    // The whole published `hostState.remoteViewing` value. Node's set is in insertion order, the core's sorted; the order is no
    // page's (a reader asks membership: section-reads.ts visualizeRemoteViewing), so Node's is sorted before comparing (MANIFEST).
    const viewing = () => window.store.section('hostState', 'remoteViewing')?.value ?? null;
    const published = (ids) => ({ sessionIds: [...ids].sort() });
    // The core's `console.*` lines in daemon.log written since the phone's first call, as Node's pcLog holds them.
    const logPath = join(core.dataDir, 'daemon.log');
    const logText = () => (existsSync(logPath) ? readFileSync(logPath, 'utf8') : '');
    const logFrom = logText().length;
    const consoleLines = () =>
      logText()
        .slice(logFrom)
        .split(/\r?\n/u)
        .map((row) => /^\[[^\]]+\] \[console\.(\w+)\] (.*)$/u.exec(row))
        .filter(Boolean)
        .map(([, method, line]) => ({ method, line }));
    // Resolves once daemon.log holds `count` console lines. The core's drainer appends each batch through a handle it opens and closes
    // for that batch (mixdog-statefile publish.rs `append_file`, daemon_log.rs `drain`), and the close is what a Windows directory watch
    // reports, so the watch on the data folder is woken by the core's write itself. Registered before the first look: a write between
    // the look and the wait still wakes it. One deadline, which fails the replay naming the step.
    const logReaches = (count, label) =>
      new Promise((resolve, reject) => {
        const finish = (error) => {
          clearTimeout(deadline);
          watcher.close();
          error ? reject(error) : resolve();
        };
        const look = () => consoleLines().length >= count && (finish(), true);
        const watcher = watch(core.dataDir, () => void look());
        const deadline = setTimeout(() => finish(new Error(`${label}: the core's daemon.log did not reach ${count} console line(s) within 10 s (it has ${consoleLines().length})`)), 10_000);
        look();
      });
    const viewingBecomes = (expected) =>
      new Promise((resolve) => {
        const settle = () => {
          if (!isDeepStrictEqual(viewing(), expected)) return false;
          off();
          clearTimeout(deadline);
          resolve();
          return true;
        };
        const off = window.store.subscribe(() => void settle());
        // One deadline: past it the step is compared as it stands.
        const deadline = setTimeout(() => (off(), resolve()), 10_000);
        settle();
      });

    globalThis.window = { setTimeout: () => 0, clearTimeout() {} };
    const notified = [];
    const scoped = new Proxy(phone, { get: (target, prop) => (prop === 'notify' ? (method, params) => (notified.push(params), target.notify(method, params)) : Reflect.get(target, prop)) });
    const { adapter } = await here('apps/desktop/src/renderer/remote-protocol-screen.ts');
    const { createProtocolRouter } = await here('apps/desktop/src/renderer/remote-shim-protocol.ts');
    const host = { ctx: { browserId: PHONE_ID }, client: () => scoped, declareLane() {} };
    const router = createProtocolRouter([adapter], { host, started: async () => {}, synced: async () => {}, probe() {}, silentSince: () => false });
    const { runQueued } = await here('apps/desktop/src/renderer/remote-protocol-queue.ts');

    const differences = [];
    for (const [index, node] of golden.steps.entries()) {
      received.splice(0);
      router.fire(node.call, node.params);
      // The fire runs on the connection's queue; a later entry of the same queue has run once it has (remote-protocol-queue.ts).
      await answered(`${node.call} on the phone's queue`, runQueued(host.ctx, node.call, [], async () => undefined));
      // A later request of the phone has its answer: the core has taken every frame the phone sent before it.
      const barrier = await answered('the barrier request', phone.call('project/list', {}).then(() => 'answered', () => 'refused'));
      const frames = received.splice(0).map((text) => JSON.parse(text)).filter((message) => !('id' in message) || message.id === undefined);
      await viewingBecomes(published(node.viewing));
      const nodeLog = golden.pcLog.filter((entry) => entry.step <= index).map(({ method, line }) => ({ method, line }));
      await logReaches(nodeLog.length, `#${index} ${node.call}`);
      const step = { call: node.call, params: node.params, frames, viewing: viewing(), pcLog: consoleLines() };
      const want = { call: node.call, params: node.params, frames: node.frames, viewing: published(node.viewing), pcLog: nodeLog };
      if (!isDeepStrictEqual(step, want)) differences.push({ label: `#${index} ${node.call} ${JSON.stringify(node.params).slice(0, 120)} (barrier ${barrier})`, node: want, core: step });
    }
    // A stop flushes the log: nothing the core wrote late escapes the comparison.
    phone.close?.();
    window.close?.();
    const exited = exitWithin(core.child, 120_000, `the core (pid ${core.child.pid}) asked to stop`);
    const stopped = spawnSync(exe, ['ctl', 'stop', '--when-idle', '--reason', 'userStop'], { env: core.env, encoding: 'utf8', timeout: 60_000, windowsHide: true });
    if (stopped.error || stopped.status !== 0) throw new Error(`mixdogd ctl stop failed: ${stopped.error?.message ?? `exit ${stopped.status}: ${stopped.stderr}`}`);
    await exited;
    const finalLog = golden.pcLog.map(({ method, line }) => ({ method, line }));
    if (!isDeepStrictEqual(consoleLines(), finalLog)) differences.push({ label: 'pcLog after the core stopped', node: finalLog, core: consoleLines() });
    console.log(`phone-plumbing replay over ${exe}: ${golden.steps.length} steps compared, ${notified.length} notifications sent, ${differences.length} differ`);
    for (const entry of differences) {
      console.log(`DIFF ${entry.label}`);
      console.log(`   node: ${JSON.stringify(entry.node).slice(0, 500)}`);
      console.log(`   core: ${JSON.stringify(entry.core).slice(0, 500)}`);
    }
    return differences.length ? 1 : 0;
  } finally {
    phone?.close?.();
    window?.close?.();
    if (core) await killTree(core.child);
    relay.close();
  }
}
