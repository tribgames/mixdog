#!/usr/bin/env node
// What Node (b6f10295a) gave a paired phone's page for the activity rail pins, native push registration, desktop notices and the
// challenge flags, recorded from an exact export at the boundary the page's UI reads: the page's own DesktopApi (remote-shim-api.ts
// `createRemoteApi`) over its own dispatch (remote-shim-dispatch.ts), fed with the decrypted payloads Node's relay side made for it:
//   - calls: Node's own frame executor (remote-methods.ts `executeRemoteFrame`) over Node's own remote methods, desktop operations,
//     settings store and config module (pins), and Node's relay native push and its store (native push);
//   - pushes: Node's own push lanes (remote-relay-push-lanes.ts) over Node's own client registry, delivered as the relay's
//     `broadcastEncrypted` delivers them (remote-relay-delivery.ts:171-187: every client with a channel, in registry order);
//   - notices: Node's own notice host (desktop-notice-host.mjs) and sink (desktop-service.ts `desktopNoticeSink`) behind the service's
//     event bus (desktop-service.ts:719-733, not exported: its three lines are written out below);
//   - flags: Node's own relay capabilities and client lifecycle make the challenge, and Node's own page socket (remote-shim-socket.ts)
//     reads it over a real E2EE handshake in the phone world (lib/phone-world.mjs);
//   - approval answers: a notification's Allow / Deny from the page's native push host through Node's own remote methods and push
//     notifier, the answer each one handed the session host recorded with the page's result.
// Inputs are lib/phone-pushes-script.mjs, shared with the replay. Each scenario runs in its own process, all side by side.
//
//   node benchmarks/rust-core/recorders/record-phone-pushes.mjs --tree <git archive of b6f10295a with node_modules> [--only <scenario>]
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { wholeOutcome } from '../../../apps/desktop/src/renderer/test-support/whole-outcome.mjs';
import {
  REPO_ROOT,
  commitStage,
  exactProductIdentity,
  importFrom,
  parseArgs,
  recordingProvenance,
  resolveTree,
  stageSet,
  within,
  writeJson,
  writeSetManifest,
} from './lib/common.mjs';
import {
  APPROVAL_CASES,
  APPROVAL_DEVICE,
  APPROVAL_RACES,
  FIXED_NOW_MS,
  NATIVE_STEPS,
  NOTICE_RECONNECT_STEPS,
  NOTICE_STEPS,
  PHONES,
  PINS_STEPS,
  RACE_DEVICES,
  RELAY_NATIVE,
  RELAY_PLAIN,
  STALE_APPROVAL_ID,
} from './lib/phone-pushes-script.mjs';

const REF = 'b6f10295a2f698afc85332467192de28500bd146';
const SCENARIOS = ['flags-native', 'flags-plain', 'pins', 'native-push', 'notices', 'notice-reconnect', 'approval-answers', 'approval-races'];
const FIXTURES = join(REPO_ROOT, 'apps', 'mobile', 'fixtures', 'phone-pushes');
const WORK = join('D:\\mixdog-build\\tmp', `${REPO_ROOT.split(/[\\/]/).pop()}-phone-pushes`);
const args = parseArgs();
const tree = resolveTree(args);
const main = 'apps/desktop/src/main/';
const renderer = 'apps/desktop/src/renderer/';

/** Node's clock under the recording: one virtual reading, and a timer queue that must be empty when a scenario ends. */
function virtualClock() {
  const timers = new Map();
  let seq = 0;
  Date.now = () => FIXED_NOW_MS;
  globalThis.setTimeout = (fn, ms) => {
    timers.set(++seq, { fn, ms });
    return seq;
  };
  globalThis.clearTimeout = (id) => void timers.delete(id);
  return { pending: () => [...timers.values()].map((timer) => timer.ms) };
}

/** A page of Node's phone: its context, its dispatch and its DesktopApi; `call` hands a frame to `execute` and the answer to the dispatch. */
async function nodePage(execute, log, name) {
  const State = await importFrom(tree, `${renderer}remote-shim-state.ts`);
  const { installRemoteDispatch } = await importFrom(tree, `${renderer}remote-shim-dispatch.ts`);
  const { createRemoteApi } = await importFrom(tree, `${renderer}remote-shim-api.ts`);
  const ctx = State.createRemoteShimContext();
  let nextId = 0;
  Object.assign(ctx, {
    settleCallCredit() {},
    call: (method, params = []) =>
      new Promise((resolve, reject) => {
        const id = (nextId += 1);
        ctx.pending.set(id, { resolve, reject });
        void execute(JSON.stringify({ id, method, params })).then((reply) => {
          log.push({ phone: name, frame: reply });
          ctx.handleMessage(reply, true);
        });
      }),
  });
  installRemoteDispatch(ctx);
  return { ctx, api: createRemoteApi(ctx), deliver: (payload) => (log.push({ phone: name, frame: payload }), ctx.handleMessage(payload, true)) };
}

/** The relay's delivery of a push: every client with a channel that the lane includes (remote-relay-delivery.ts:171-187). */
const broadcaster = (registry, pages) => (payload, _droppable, include = () => true) => {
  for (const [clientId, state] of registry.clients) if (state.channel && include(state)) pages.get(clientId)?.deliver(payload);
};

function browserGlobals() {
  const define = (key, value) => Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  define('window', Object.assign(new EventTarget(), { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout, Event, CustomEvent }));
  define('document', { visibilityState: 'visible', cookie: '', documentElement: { dataset: {} }, getElementById: () => null });
  define('localStorage', { getItem: () => null, setItem() {}, removeItem() {} });
  define('location', { origin: 'https://relay.test', pathname: '/', href: 'https://relay.test/' });
}

/** The page's view of a call: its answer or its error, whole. */
const outcome = (promise) => promise.then((value) => wholeOutcome(value), (error) => wholeOutcome(error));

async function pins(dir) {
  const clock = virtualClock();
  browserGlobals();
  const config = await importFrom(tree, 'src/runtime/shared/config.mjs');
  const { createDesktopOperations } = await importFrom(tree, `${main}desktop-operations.ts`);
  const { createRemoteMethods, executeRemoteFrame } = await importFrom(tree, `${main}remote-methods.ts`);
  const { createRelayPushLanes } = await importFrom(tree, `${main}remote-relay-push-lanes.ts`);
  const { createRelayClientRegistry } = await importFrom(tree, `${main}remote-relay-clients.ts`);
  const listeners = new Set();
  const operations = createDesktopOperations({ userDataPath: join(dir, 'userdata'), loadConfig: async () => config, emit: (event) => listeners.forEach((l) => l(event)) });
  const host = { invokeDesktopOperation: operations.invoke, subscribeDesktopEvents: (l) => (listeners.add(l), () => listeners.delete(l)) };
  const registry = createRelayClientRegistry({ host: {}, sendEnvelope() {}, onClientCountChanged() {}, onEmpty() {} });
  const pages = new Map();
  const frames = [];
  const lanes = createRelayPushLanes({ clients: registry.clients, subscribeDesktopEvents: host.subscribeDesktopEvents, broadcastEncrypted: broadcaster(registry, pages) });
  const heard = [];
  let step = -1;
  const connect = async (name) => {
    const methods = createRemoteMethods({ host }, { credentialId: () => PHONES[name] });
    const page = await nodePage((raw) => executeRemoteFrame(methods, raw), frames, name);
    page.api.subscribeActivityRailPins((state) => heard.push({ step, phone: name, state }));
    registry.open(name, {}, PHONES[name]).channel = {};
    pages.set(name, page);
    for (const frame of lanes.joinFrames()) page.deliver(frame);
  };
  await connect('a');
  await connect('b');
  const answers = [];
  for (step = 0; step < PINS_STEPS.length; step += 1) {
    const { by, op, pins: list } = PINS_STEPS[step];
    if (op === 'connect') await connect(by);
    else if (by === 'desktop') answers.push({ step, outcome: await outcome(operations.invoke('updateActivityRailPins', [list])) });
    else if (op === 'read') answers.push({ step, outcome: await outcome(pages.get(by).api.readActivityRailPins()) });
    else answers.push({ step, outcome: await outcome(pages.get(by).api.updateActivityRailPins(list)) });
  }
  const persisted = JSON.parse(readFileSync(join(dir, 'data', 'mixdog-config.json'), 'utf8')).desktop?.activityRailPins ?? null;
  lanes.dispose();
  await operations.dispose();
  return { answers, heard, frames, persisted, timers: clock.pending() };
}

async function nativePush(dir) {
  const clock = virtualClock();
  browserGlobals();
  const { createRemoteMethods, executeRemoteFrame } = await importFrom(tree, `${main}remote-methods.ts`);
  const { createRelayConnectionCaps } = await importFrom(tree, `${main}remote-relay-capabilities.ts`);
  const { createRelayNativePush } = await importFrom(tree, `${main}remote-relay-native-push.ts`);
  const { createNativePushStore } = await importFrom(tree, `${main}native-push-store.ts`);
  const { createNativePushHost } = await importFrom(tree, `${renderer}native-push-bridge.ts`);
  const relay = [];
  const store = createNativePushStore(join(dir, 'userdata'));
  const native = createRelayNativePush({ store, platforms: () => caps.relayNativePlatforms(), sendEnvelope: (envelope) => relay.push(envelope), connected: () => true });
  const caps = createRelayConnectionCaps({ clientCount: () => 0, broadcastEncrypted() {}, rebindNativePush: native.rebindAll });
  caps.handleRelayCapabilities(RELAY_NATIVE);
  const frames = [];
  const pages = {};
  for (const name of ['a', 'b']) {
    const methods = createRemoteMethods(
      { host: {}, nativePush: { platforms: () => caps.relayNativePlatforms(), register: native.register, remove: native.remove } },
      { credentialId: () => PHONES[name] }
    );
    pages[name] = await nodePage((raw) => executeRemoteFrame(methods, raw), frames, name);
  }
  const answers = [];
  for (const [step, { by, op, input, token }] of NATIVE_STEPS.entries()) {
    const page = pages[by];
    const call = op === 'register' ? createNativePushHost(page.ctx).register(input) : page.ctx.call('removeNativePush', token === undefined ? [] : [token]);
    answers.push({ step, outcome: await outcome(call), relay: relay.splice(0), stored: await store.list() });
  }
  const persisted = JSON.parse(readFileSync(join(dir, 'userdata', 'remote-native-push.json'), 'utf8'));
  return { answers, frames, persisted, timers: clock.pending() };
}

async function notices() {
  const clock = virtualClock();
  browserGlobals();
  const host = await importFrom(tree, 'src/runtime/shared/desktop-notice-host.mjs');
  const { desktopNoticeSink } = await importFrom(tree, `${main}desktop-service.ts`);
  const { createRelayPushLanes } = await importFrom(tree, `${main}remote-relay-push-lanes.ts`);
  const { createRelayClientRegistry } = await importFrom(tree, `${main}remote-relay-clients.ts`);
  const registry = createRelayClientRegistry({ host: {}, sendEnvelope() {}, onClientCountChanged() {}, onEmpty() {} });
  const pages = new Map();
  const frames = [];
  // The service's event bus (desktop-service.ts:719-733): the window (attached: `emit` delivered it), then every subscriber.
  const listeners = new Set();
  const emit = () => true;
  const publish = (name, value) => {
    const delivered = emit({ kind: 'desktop-event', name, value }) !== false;
    for (const listener of listeners) listener({ name, value });
    return delivered;
  };
  const lanes = createRelayPushLanes({ clients: registry.clients, subscribeDesktopEvents: (l) => (listeners.add(l), () => listeners.delete(l)), broadcastEncrypted: broadcaster(registry, pages) });
  const unregister = host.registerDesktopNoticeSink(desktopNoticeSink(emit, publish));
  const shown = [];
  let step = -1;
  const connect = async (name) => {
    const page = await nodePage(async () => undefined, frames, name);
    page.api.subscribeDesktopNotices((notice) => shown.push({ step, phone: name, notice }));
    registry.open(name, {}, PHONES[name]).channel = {};
    pages.set(name, page);
    for (const frame of lanes.joinFrames()) page.deliver(frame);
  };
  await connect('a');
  const raised = [];
  for (step = 0; step < NOTICE_STEPS.length; step += 1) {
    const { op, key, code, params, phone } = NOTICE_STEPS[step];
    if (op === 'connect') await connect(phone);
    else if (op === 'clear') host.clearDesktopNotice(key);
    else raised.push({ step, raised: host.raiseDesktopNotice(key, code, params) });
  }
  unregister();
  lanes.dispose();
  return { shown, raised, frames, timers: clock.pending() };
}

/** A notice raised while a phone is away (NOTICE_RECONNECT_STEPS): the same host, sink and lanes as `notices`; the relay's client leaves
 *  the registry when its socket closes (remote-relay-clients.ts `remove`) and comes back with the join frames (`joinFrames`) on the same
 *  page; the keychain's failure raises its notice through the host registry exactly as keychain-cjs.cjs:56-58 does. */
async function noticeReconnect() {
  const clock = virtualClock();
  browserGlobals();
  const host = await importFrom(tree, 'src/runtime/shared/desktop-notice-host.mjs');
  const { desktopNoticeSink } = await importFrom(tree, `${main}desktop-service.ts`);
  const { createRelayPushLanes } = await importFrom(tree, `${main}remote-relay-push-lanes.ts`);
  const { createRelayClientRegistry } = await importFrom(tree, `${main}remote-relay-clients.ts`);
  const registry = createRelayClientRegistry({ host: {}, sendEnvelope() {}, onClientCountChanged() {}, onEmpty() {} });
  const pages = new Map();
  const frames = [];
  const listeners = new Set();
  const emit = () => true;
  const publish = (name, value) => {
    const delivered = emit({ kind: 'desktop-event', name, value }) !== false;
    for (const listener of listeners) listener({ name, value });
    return delivered;
  };
  const lanes = createRelayPushLanes({ clients: registry.clients, subscribeDesktopEvents: (l) => (listeners.add(l), () => listeners.delete(l)), broadcastEncrypted: broadcaster(registry, pages) });
  const unregister = host.registerDesktopNoticeSink(desktopNoticeSink(emit, publish));
  const shown = [];
  let step = -1;
  const attach = (name) => {
    registry.open(name, {}, PHONES[name]).channel = {};
    for (const frame of lanes.joinFrames()) pages.get(name).deliver(frame);
  };
  for (const name of ['a', 'b']) {
    const page = await nodePage(async () => undefined, frames, name);
    page.api.subscribeDesktopNotices((notice) => shown.push({ step, phone: name, notice }));
    pages.set(name, page);
    attach(name);
  }
  for (step = 0; step < NOTICE_RECONNECT_STEPS.length; step += 1) {
    const { op, phone } = NOTICE_RECONNECT_STEPS[step];
    if (op === 'drop') registry.remove(phone);
    else if (op === 'reconnect') attach(phone);
    else globalThis[Symbol.for('mixdog.desktopNoticeHost.v1')]?.raise?.('secret-storage', 'secret-storage-failed');
  }
  unregister();
  lanes.dispose();
  return { shown, frames, timers: clock.pending() };
}

/** A notification's Allow / Deny: Node's own push notifier (push-notifier.ts: the approval each session shows, from its state) and
 *  remote methods (remote-session-methods.ts `answerApprovalNotification`), called by the page's own native push host
 *  (native-push-bridge.ts `answerApproval`). The session host is scripted as the runtime answers (`finishToolApproval`: true once for the
 *  approval the session waits on, then the session shows none); each answer it was handed is recorded. */
async function approvalAnswers() {
  const clock = virtualClock();
  browserGlobals();
  const { normalizeToolApprovalRequest } = await importFrom(tree, 'src/tui/session/tool-approval-request.mjs');
  const { createPushNotifier } = await importFrom(tree, `${main}push-notifier.ts`);
  const { createRemoteMethods, executeRemoteFrame } = await importFrom(tree, `${main}remote-methods.ts`);
  const { createNativePushHost } = await importFrom(tree, `${renderer}native-push-bridge.ts`);
  const notifier = createPushNotifier({ store: {}, isEnabled: () => false, readFinalAnswer: async () => null, isClientForeground: () => false });
  const waiting = new Map();
  let handed = [];
  const host = {
    invokeDesktopOperation: async () => undefined,
    resolveToolApprovalForSession: async (sessionId, id, decision) => {
      handed.push(decision);
      if (waiting.get(sessionId) !== id) return false;
      waiting.delete(sessionId);
      notifier.onSessionState({ sessionId, snapshot: { toolApproval: null } });
      return true;
    },
  };
  const methods = createRemoteMethods({ host, approvalNotifications: notifier }, { credentialId: () => PHONES.a, deviceName: async () => APPROVAL_DEVICE });
  const frames = [];
  const page = await nodePage((raw) => executeRemoteFrame(methods, raw), frames, 'a');
  const phone = createNativePushHost(page.ctx);
  const cases = [];
  for (const [index, { name, input, steps }] of APPROVAL_CASES.entries()) {
    const sessionId = `sess_approval_${index}`;
    const id = String(index + 1);
    const toolApproval = normalizeToolApprovalRequest({ ...input, sessionId }, id, null);
    waiting.set(sessionId, id);
    notifier.onSessionState({ sessionId, snapshot: { toolApproval } });
    const answers = [];
    for (const { action, stale } of steps) {
      handed = [];
      const answered = await outcome(phone.answerApproval(sessionId, stale ? STALE_APPROVAL_ID : id, action));
      answers.push({ action, stale: stale === true, outcome: answered, decided: handed });
    }
    cases.push({ name, call: 'answerApprovalNotification', input, toolApproval, answers });
  }
  return { cases, frames, timers: clock.pending() };
}

/** Two answers to one approval reaching the session together (APPROVAL_RACES): the phones answer as in `approvalAnswers`, the PC's card
 *  through the session host's own path. The host serializes answers per session with its own lock (session-host-lifecycle.ts:1086-1102,
 *  session-lifecycle-locks.ts) and the runtime takes the first for the approval it waits on (`finishToolApproval`: true once, then the
 *  session shows none). The first answer is held inside the lock until the second waits behind it (the lock's own `contended`), so the
 *  two meet at the session as they would in the race; what each phone was shown and the decision the session took are recorded. */
async function approvalRaces() {
  const clock = virtualClock();
  browserGlobals();
  const { normalizeToolApprovalRequest } = await importFrom(tree, 'src/tui/session/tool-approval-request.mjs');
  const { createPushNotifier } = await importFrom(tree, `${main}push-notifier.ts`);
  const { createRemoteMethods, executeRemoteFrame } = await importFrom(tree, `${main}remote-methods.ts`);
  const { SessionLifecycleLocks } = await importFrom(tree, `${main}session-lifecycle-locks.ts`);
  const { createNativePushHost } = await importFrom(tree, `${renderer}native-push-bridge.ts`);
  const notifier = createPushNotifier({ store: {}, isEnabled: () => false, readFinalAnswer: async () => null, isClientForeground: () => false });
  const locks = new SessionLifecycleLocks();
  const waiting = new Map();
  let took = [];
  let held = Promise.resolve();
  let reached = () => {};
  const host = {
    invokeDesktopOperation: async () => undefined,
    resolveToolApprovalForSession: (sessionId, id, decision) => {
      const answer = locks.run(sessionId, async () => {
        await held;
        if (waiting.get(sessionId) !== id) return false;
        waiting.delete(sessionId);
        notifier.onSessionState({ sessionId, snapshot: { toolApproval: null } });
        took.push(decision);
        return true;
      });
      reached();
      return answer;
    },
  };
  const frames = [];
  const phones = {};
  const pages = {};
  for (const name of ['a', 'b']) {
    const methods = createRemoteMethods({ host, approvalNotifications: notifier }, { credentialId: () => PHONES[name], deviceName: async () => RACE_DEVICES[name] });
    pages[name] = await nodePage((raw) => executeRemoteFrame(methods, raw), frames, name);
    phones[name] = createNativePushHost(pages[name].ctx);
  }
  const input = APPROVAL_CASES[0].input;
  const cases = [];
  for (const [index, { name, race, then = [] }] of APPROVAL_RACES.entries()) {
    const sessionId = `sess_race_${index}`;
    const id = String(index + 1);
    waiting.set(sessionId, id);
    notifier.onSessionState({ sessionId, snapshot: { toolApproval: normalizeToolApprovalRequest({ ...input, sessionId }, id, null) } });
    took = [];
    const answer = ({ by, action, card }) => {
      if (by === 'desktop') return host.resolveToolApprovalForSession(sessionId, id, { approved: true, device: RACE_DEVICES.desktop });
      if (card) return outcome(pages[by].api.resolveToolApprovalForSession(sessionId, id, card));
      return outcome(phones[by].answerApproval(sessionId, id, action));
    };
    // The first answer is held at the session until every other one has reached the host and waits behind it.
    let release;
    held = race.length > 1 ? new Promise((resolve) => (release = resolve)) : Promise.resolve();
    const answers = [];
    for (const step of race) {
      const arrived = new Promise((resolve) => (reached = resolve));
      answers.push(answer(step));
      await arrived;
    }
    if (race.length > 1) {
      if (!locks.contended(sessionId)) throw new Error(`${name}: the answers do not meet at the session`);
      release();
    }
    const results = await Promise.all(answers);
    held = Promise.resolve();
    const shown = race.map((step, at) => ({ ...step, ...(step.by === 'desktop' ? {} : { outcome: results[at] }) }));
    for (const step of then) shown.push({ ...step, outcome: await answer(step) });
    cases.push({ name, raced: race.length, shown, took });
  }
  return { cases, frames, timers: clock.pending() };
}

async function flags(relayCaps) {
  const { createPhoneWorld, nodeDialect } = await import('./lib/phone-world.mjs');
  const { createRelayConnectionCaps } = await importFrom(tree, `${main}remote-relay-capabilities.ts`);
  const { createRelayClientLifecycle } = await importFrom(tree, `${main}remote-relay-client-lifecycle.ts`);
  const caps = createRelayConnectionCaps({ clientCount: () => 0, broadcastEncrypted() {}, rebindNativePush() {} });
  caps.handleRelayCapabilities(relayCaps);
  const sent = [];
  const lifecycle = createRelayClientLifecycle({
    clients: { open: () => true },
    e2eeIdentity: {},
    pairing: {},
    relayBinaryFrames: caps.relayBinaryFrames,
    viewSyncSupported: () => true,
    nativePushSupported: () => caps.relayNativePlatforms().length > 0,
    relayRoutingCapsPayload: () => ({}),
    sendEnvelope: (payload) => sent.push(payload),
    sendEncryptedFrame: async () => {},
    dispatchClientCall: async () => ({}),
    resyncClient: () => {},
  });
  lifecycle.open('phone', PHONES.a);
  const world = await createPhoneWorld({ tree, dialect: nodeDialect, installed: false });
  const E2EE = await importFrom(tree, 'apps/desktop/src/shared/remote-e2ee.ts');
  const challenge = JSON.parse(sent[0].data);
  const handshakeKeys = new Set(Object.keys(E2EE.createRelayE2EEChallenge()));
  const offered = Object.fromEntries(Object.entries(challenge).filter(([key]) => !handshakeKeys.has(key)));
  const State = await importFrom(tree, `${renderer}remote-shim-state.ts`);
  const { installRemotePairing } = await importFrom(tree, `${renderer}remote-shim-pairing.ts`);
  const { installRemoteLiveness } = await importFrom(tree, `${renderer}remote-shim-liveness.ts`);
  const { installRemoteSocket } = await importFrom(tree, `${renderer}remote-shim-socket.ts`);
  const ctx = State.createRemoteShimContext();
  installRemotePairing(ctx);
  installRemoteLiveness(ctx);
  installRemoteSocket(ctx);
  Object.assign(ctx, { ensureClientRegistration: async () => {}, handleMessage: () => {}, fire: () => {}, createTransportMedia: () => ({ receive: () => false, close() {} }) });
  globalThis.window.addEventListener(State.REMOTE_SECURE_CHANNEL_READY_EVENT, () => world.log({ ev: 'ready' }));
  void ctx.connect();
  await world.waitFor((event) => event.ev === 'socket');
  await world.accept(offered);
  await world.waitFor((event) => event.ev === 'ready');
  const peer = Object.fromEntries(Object.keys(ctx).filter((key) => key.startsWith('peer')).sort().map((key) => [key, ctx[key]]));
  return { offered, peer };
}

if (args.has('scenario')) {
  const name = args.get('scenario');
  const dir = join(WORK, name);
  rmSync(dir, { recursive: true, force: true });
  for (const sub of ['data', 'config', 'home', 'userdata']) mkdirSync(join(dir, sub), { recursive: true });
  Object.assign(process.env, { MIXDOG_DATA_DIR: join(dir, 'data'), MIXDOG_CONFIG_DIR: join(dir, 'config'), MIXDOG_HOME: join(dir, 'home'), MIXDOG_SKIP_USER_DATA_BACKUP: '1' });
  const run = {
    'flags-native': () => flags(RELAY_NATIVE),
    'flags-plain': () => flags(RELAY_PLAIN),
    pins: () => pins(dir),
    'native-push': () => nativePush(dir),
    notices: () => notices(),
    'notice-reconnect': () => noticeReconnect(),
    'approval-answers': () => approvalAnswers(),
    'approval-races': () => approvalRaces(),
  }[name];
  const trace = await run();
  process.stdout.write(`\n@@TRACE@@${JSON.stringify(trace)}\n`);
  process.exit(0);
}

/** One scenario in its own process (the page and the notice host keep module state), with a deadline that ends its process tree. */
function runChild(name) {
  const child = spawn(
    process.execPath,
    [
      '--import',
      pathToFileURL(join(REPO_ROOT, 'apps', 'desktop', 'scripts', 'test-env.mjs')).href,
      '--import',
      pathToFileURL(join(REPO_ROOT, 'apps', 'desktop', 'scripts', 'test-tsx.mjs')).href,
      fileURLToPath(import.meta.url),
      '--tree',
      tree,
      '--scenario',
      name,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }
  );
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => (stdout += chunk));
  child.stderr.on('data', (chunk) => (stderr += chunk));
  const ended = new Promise((resolve) => child.once('close', resolve));
  return within(`scenario ${name}`, ended).then(
    (status) => {
      const at = stdout.lastIndexOf('@@TRACE@@');
      if (status !== 0 || at < 0) throw new Error(`${name} failed (${status}):\n${stdout.slice(-2000)}\n${stderr.slice(-4000)}`);
      return JSON.parse(stdout.slice(at + '@@TRACE@@'.length));
    },
    (error) => {
      spawn('taskkill', ['/T', '/F', '/PID', String(child.pid)], { stdio: 'ignore', windowsHide: true });
      throw error;
    }
  );
}

const only = args.get('only');
const names = only ? [only] : SCENARIOS;
const traces = await Promise.all(names.map(runChild));
const scenarios = Object.fromEntries(names.map((name, index) => [name, traces[index]]));
for (const [name, trace] of Object.entries(scenarios)) console.log(`${name}: ${JSON.stringify(trace).length} bytes`);
if (only) {
  console.log(JSON.stringify(scenarios, null, 2));
  process.exit(0);
}
const out = stageSet(FIXTURES);
writeJson(join(out, 'golden.json'), {
  note: 'Node b6f10295a: what a paired phone\'s page got for the rail pins, native push registration, desktop notices, the challenge flags and a notification\'s Allow / Deny (see record-phone-pushes.mjs); inputs in lib/phone-pushes-script.mjs.',
  scenarios,
});
writeSetManifest(out, {
  set: 'phone-pushes',
  recorder: 'benchmarks/rust-core/recorders/record-phone-pushes.mjs',
  command: `node benchmarks/rust-core/recorders/record-phone-pushes.mjs --tree <git archive of ${REF} (src, apps) with node_modules>`,
  identity: exactProductIdentity(tree, REF),
  extra: {
    scenarios: names,
    provenance: {
      recorder: 'benchmarks/rust-core/recorders/record-phone-pushes.mjs',
      ...recordingProvenance('benchmarks/rust-core/recorders/record-phone-pushes.mjs', [
      'benchmarks/rust-core/recorders/lib/common.mjs',
      'benchmarks/rust-core/recorders/lib/phone-pushes-script.mjs',
      'benchmarks/rust-core/recorders/lib/phone-world.mjs',
      'apps/desktop/src/renderer/test-support/whole-outcome.mjs',
      ]),
    },
  },
});
commitStage(out, FIXTURES);
rmSync(WORK, { recursive: true, force: true });
process.exit(0);
