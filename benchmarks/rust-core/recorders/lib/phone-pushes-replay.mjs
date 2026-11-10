// The replay of record-phone-pushes.mjs: the same steps (lib/phone-pushes-script.mjs) played on the phone's page as it runs on the core
// (`createRemoteApi` over the protocol router and the bundle's adapters, on a protocol client), every value the page's UI was given
// compared whole with what Node gave it (apps/mobile/fixtures/phone-pushes/golden.json).
//   - flags, pins and native push run against a freshly started, built mixdogd behind a scripted relay with paired phones
//     (lib/phone-relay-core.mjs); the PC's own window is a loopback connection writing through the desktop's own route
//     (`config/value/write` on `desktop.activityRailPins`, desktop-operation-route.ts);
//   - notices run against a scripted core: the core raises a notice only from a provider's refused sign-in, a failed conversation save,
//     the keychain or a downloaded update, none of which a replay can cause, so the script plays the core's own rule for them
//     (mixdog-core-domains notify/desktop_notice.rs: a raise publishes the `notice` entry of its key once until a clear removes it; a
//     connection's snapshot holds the entries standing) in the core's frame shape (mixdog-core-base state/mod.rs `update_json`).
// Each scenario has its own core, data dir and relay port; all run side by side.
import { readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { pathToFileURL } from 'node:url';
import { wholeOutcome } from '../../../../apps/desktop/src/renderer/test-support/whole-outcome.mjs';
import { REPO_ROOT, within } from './common.mjs';
import { killTree, startCore } from './phone-files-replay.mjs';
import { startRelay } from './phone-relay-core.mjs';
import { FIXED_NOW_MS, NATIVE_STEPS, NOTICE_RECONNECT_STEPS, NOTICE_STEPS, PHONES, PINS_STEPS, RELAY_NATIVE, RELAY_PLAIN } from './phone-pushes-script.mjs';

const WORLDS = join('D:\\mixdog-build\\tmp', `${basename(REPO_ROOT)}-phone-pushes-replay`);
const here = (path) => import(pathToFileURL(join(REPO_ROOT, path)).href);
const VERSION = JSON.parse(readFileSync(join(REPO_ROOT, 'apps', 'desktop', 'package.json'), 'utf8')).version;

/** The adapters the phone bundle holds (remote-shim-adapters.ts: every `remote-protocol-<group>.ts` that exports one). */
const BUNDLE = ['files', 'notifications', 'settings', 'terminal'];

/** What the core offers a phone is the table's (native/core/crates/mixdog-app-protocol/src/remote_flags.json): a flag whose calls are
 *  not all served for a phone, or that waits on more, is off, and the table names each missing call and who brings it. */
const FLAG_TABLE = JSON.parse(readFileSync(join(REPO_ROOT, 'native', 'core', 'crates', 'mixdog-app-protocol', 'src', 'remote_flags.json'), 'utf8')).flags;
const peerKey = (flag) => `peer${flag[0].toUpperCase()}${flag.slice(1)}`;
/** Per page flag the table holds off: its calls still waiting, with their owners, and what else waits. */
const WAITING = Object.fromEntries(
  Object.entries(FLAG_TABLE).flatMap(([flag, { calls, unserved }]) => {
    const missing = Object.entries(calls).filter(([, how]) => !how.method).map(([call, how]) => `${call}: ${how.owner}`);
    if (unserved) missing.push(unserved);
    return missing.length ? [[peerKey(flag), missing]] : [];
  })
);
/** Node's view-sync flag (the browser's own hello, remote-relay-client-lifecycle.ts:256, not a challenge flag): the protocol's thread
 *  feeds replace it by design, so the page has no such flag. */
const NODE_ONLY_FLAGS = ['peerViewSync'];

function differences(a, b, path = '') {
  if (isDeepStrictEqual(a, b)) return [];
  if (a && b && typeof a === 'object' && typeof b === 'object' && Array.isArray(a) === Array.isArray(b)) {
    return [...new Set([...Object.keys(a), ...Object.keys(b)])].flatMap((key) => differences(a[key], b[key], path ? `${path}.${key}` : key));
  }
  return [path || '(root)'];
}

/** What each phone heard, in its own order: two phones are two connections, so which of them hears a step first is not ordered. */
function byPhone(heard) {
  const phones = {};
  for (const { phone, ...rest } of heard) (phones[phone] ??= []).push(rest);
  return phones;
}

const outcome = (promise) => promise.then((value) => wholeOutcome(value), (error) => wholeOutcome(error));

function browserGlobals() {
  const define = (key, value) => Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  // The router arms each call's deadline on the page's timers; the replay compares answers, so its window never fires one.
  define('window', Object.assign(new EventTarget(), { setTimeout: () => 0, clearTimeout() {}, Event, CustomEvent }));
  define('document', { visibilityState: 'visible', cookie: '', documentElement: { dataset: {} }, getElementById: () => null });
  define('localStorage', { getItem: () => null, setItem() {}, removeItem() {} });
  define('location', { origin: 'https://relay.test', pathname: '/', href: 'https://relay.test/' });
}

/** Resolves once `cond()` holds for the client's store; one deadline, named after what it waits for. */
const until = (client, cond, what) =>
  within(
    what,
    new Promise((resolve) => {
      if (cond()) return resolve();
      const off = client.store.subscribe(() => {
        if (!cond()) return;
        off();
        resolve();
      });
    })
  );

/** The phone's page on `client`: its context, router and DesktopApi, wired as remote-shim-phone.ts wires them. */
async function phonePage(client) {
  const { createProtocolRouter } = await here('apps/desktop/src/renderer/remote-shim-protocol.ts');
  const { createRemoteApi } = await here('apps/desktop/src/renderer/remote-shim-api.ts');
  const { createRemoteShimContext } = await here('apps/desktop/src/renderer/remote-shim-state.ts');
  const adapters = await Promise.all(BUNDLE.map(async (group) => (await here(`apps/desktop/src/renderer/remote-protocol-${group}.ts`)).adapter));
  const ctx = createRemoteShimContext();
  const host = { ctx, client: () => client, declareLane() {}, onClient: (listener) => (listener(client), () => {}) };
  const router = createProtocolRouter(adapters, { host, started: async () => {}, synced: async () => {}, probe() {}, silentSince: () => false });
  const fanOut = (listeners, value) => {
    for (const listener of [...listeners]) listener(value);
  };
  Object.assign(ctx, {
    fanOut,
    connect: async () => {},
    invoke: router.call,
    call: router.call,
    fire: router.fire,
    readCatalog: (_catalog, method) => router.call(method, []),
    phone: { start: async () => {}, synced: async () => {}, refreshScreen() {} },
    laneSubscription: (_lane, listeners, listener) => (listeners.add(listener), () => listeners.delete(listener)),
  });
  router.install();
  return { ctx, api: createRemoteApi(ctx), router };
}

/** A protocol client that has attached the app feed and folded its snapshot. */
async function attached(connect, options) {
  const client = await connect(options);
  const snapshot = new Promise((resolve) => {
    const off = client.store.subscribe((change) => {
      if (change.type !== 'appSnapshot') return;
      off();
      resolve();
    });
  });
  await client.subscribeApp();
  await within('the app snapshot after app/subscribe', snapshot);
  return client;
}

/** One core behind a relay that declares `caps`; `run(world)` plays a scenario on it. */
async function withCore(exe, name, caps, run) {
  const relay = await startRelay({ repoRoot: REPO_ROOT, clients: [], capabilities: caps });
  const coreRoot = join(WORLDS, name);
  // The instant this script's core reads as now (not the files replay's).
  const core = await startCore(exe, coreRoot, relay, true, { MIXDOG_FIXED_NOW_MS: String(FIXED_NOW_MS) });
  const clients = [];
  try {
    const { connect, sessionReducer } = await here('packages/protocol-client/src/index.ts');
    const { createWsConnector } = await here('apps/desktop/src/main/protocol/ws-connector.ts');
    const { relayE2EEPairingMaterial } = await here('apps/desktop/src/shared/remote-e2ee.ts');
    const base = {
      target: { id: 'core' },
      clientInfo: { name: 'mixdog-phone', title: 'Mixdog Phone', version: VERSION, kind: 'phone' },
      capabilities: { optOutNotificationMethods: [], experimentalApi: false },
      threadReducer: sessionReducer,
      // The client sleeps only on its reconnect ladder; the replay never drops a connection, so a drop fails it instead of waiting.
      clock: { sleep: () => Promise.reject(new Error('the replay dropped its connection')) },
      random: Math.random,
    };
    await relay.leg();
    const pairing = relayE2EEPairingMaterial(JSON.parse(readFileSync(join(core.dataDir, 'relay-e2ee.json'), 'utf8')));
    const world = {
      core,
      relay,
      /** A paired phone behind the relay, with its page; `options` replace the client's (its clock, for one that comes back). */
      phone: async (key, options = {}) => {
        const connector = await relay.openPhone(`client-${key}`, PHONES[key], pairing);
        const client = await attached(connect, { ...base, connector, ...options });
        clients.push(client);
        return { client, ...(await phonePage(client)) };
      },
      /** The PC's own window: a loopback connection. */
      desktop: async () => {
        const client = await attached(connect, {
          ...base,
          connector: createWsConnector(async () => core.endpoint),
          clientInfo: { ...base.clientInfo, name: 'mixdog-replay-window', kind: 'desktop' },
        });
        clients.push(client);
        return client;
      },
    };
    return await run(world);
  } finally {
    for (const client of clients) client.close?.();
    // Its files are removed afterwards: the scenario ends once the process has exited and let go of them (killTree waits for it).
    try {
      await killTree(core.child);
    } finally {
      relay.close();
    }
  }
}

/** The first file named `file` under `dir` (the core's own layout), parsed. */
function storedFile(dir, file) {
  for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile() && entry.name === file) return JSON.parse(readFileSync(join(entry.parentPath ?? entry.path, entry.name), 'utf8'));
  }
  return null;
}

async function flagsOn(exe, name, caps) {
  const { peerFlagsOf } = await here('apps/mobile/src/phone-capabilities.ts');
  return withCore(exe, name, caps, async (world) => {
    const phone = await world.phone('a');
    return peerFlagsOf(phone.client.server.capabilities);
  });
}

/** The page's flags on the core against Node's: every flag the table serves is Node's; a flag it holds off is off on the core, Node's value
 *  and what it waits for named beside it. Any other difference, a flag on that the table holds off included, is a difference. */
function compareFlags(node, core) {
  const expected = Object.fromEntries(Object.entries(node.peer).filter(([key]) => !NODE_ONLY_FLAGS.includes(key)));
  const waiting = {};
  for (const [key, missing] of Object.entries(WAITING)) {
    waiting[key] = { node: expected[key], missing };
    expected[key] = key === 'peerBrowserWebrtc' ? 0 : false;
  }
  return { node: expected, core, waiting };
}

async function pins(exe) {
  return withCore(exe, 'pins', RELAY_PLAIN, async (world) => {
    const desktop = await world.desktop();
    const pages = { a: await world.phone('a'), b: await world.phone('b') };
    const heard = [];
    const answers = [];
    let step = -1;
    const listen = (key) => pages[key].api.subscribeActivityRailPins((state) => heard.push({ step, phone: key, state }));
    listen('a');
    listen('b');
    // After each step the window flips one other desktop flag: once a phone's store shows the flip, every frame the step published
    // reached it (the app feed is ordered), so what it was told for the step is all it heard.
    let marker = false;
    const barrier = async () => {
      marker = !marker;
      await desktop.call('config/value/write', { path: 'desktop.usageRailShortLong', value: marker });
      for (const [key, page] of Object.entries(pages)) {
        await until(page.client, () => (page.client.store.section('config', 'desktop')?.value?.usageRailShortLong ?? false) === marker, `phone ${key} hears the step ${step} barrier`);
      }
    };
    const { storedPinsState } = await here('apps/desktop/src/shared/activity-rail-pins.ts');
    for (step = 0; step < PINS_STEPS.length; step += 1) {
      const { by, op, pins: list } = PINS_STEPS[step];
      if (op === 'connect') {
        pages[by] = await world.phone(by);
        listen(by);
      } else if (by === 'desktop') {
        // desktop-operation-route.ts: `updateActivityRailPins` is this write, its answer the stored state.
        answers.push({ step, outcome: await outcome(desktop.call('config/value/write', { path: 'desktop.activityRailPins', value: list }).then((reply) => storedPinsState(reply.values[0]))) });
      } else if (op === 'read') answers.push({ step, outcome: await outcome(pages[by].api.readActivityRailPins()) });
      else answers.push({ step, outcome: await outcome(pages[by].api.updateActivityRailPins(list)) });
      await barrier();
    }
    const persisted = storedFile(world.core.dataDir, 'mixdog-config.json')?.desktop?.activityRailPins ?? null;
    return { answers, heard, persisted };
  });
}

async function nativePush(exe) {
  return withCore(exe, 'native-push', RELAY_NATIVE, async (world) => {
    const { createNativePushHost } = await here('apps/desktop/src/renderer/native-push-bridge.ts');
    const pages = { a: await world.phone('a'), b: await world.phone('b') };
    const before = world.relay.envelopes.length;
    let seen = before;
    const answers = [];
    for (const [step, { by, op, input, token }] of NATIVE_STEPS.entries()) {
      const page = pages[by];
      const call = op === 'register' ? createNativePushHost(page.ctx).register(input) : page.ctx.call('removeNativePush', token === undefined ? [] : [token]);
      const result = await outcome(call);
      // The core hands the relay its bind or unbind before the answer, on the same socket: what reached the relay by now is all of it.
      const relay = world.relay.envelopes.slice(seen).filter((envelope) => String(envelope.type).startsWith('native-push'));
      seen = world.relay.envelopes.length;
      answers.push({ step, outcome: result, relay, stored: storedFile(world.core.dataDir, 'remote-native-push.json')?.subscriptions ?? [] });
    }
    return { answers, persisted: storedFile(world.core.dataDir, 'remote-native-push.json') };
  });
}

/** A notice raised while a phone is away (NOTICE_RECONNECT_STEPS) on the built core: phone a's socket drops at the relay, the keychain
 *  fails while it is away (the store's `secrets` folder is a file, so the OAuth client secret of an `mcp/addMcpServer` from the PC's
 *  window cannot be written to the keychain: the tracked store raises `secret-storage`, mixdog-secrets status.rs `note_failure`, before
 *  anything connects), and a comes back on the same client, which
 *  resumes its app subscription from its cursor. After each step the window flips a desktop flag; a phone whose store shows the flip has
 *  folded everything the step published before it (the app feed is ordered). */
async function noticeReconnect(exe) {
  return withCore(exe, 'notice-reconnect', RELAY_PLAIN, async (world) => {
    const desktop = await world.desktop();
    // Phone a's way back: its reconnect ladder waits here until the script lets it come back.
    let comeBack;
    const away = new Promise((resolve) => (comeBack = resolve));
    const pages = { a: await world.phone('a', { clock: { sleep: () => away } }), b: await world.phone('b') };
    const shown = [];
    let step = -1;
    for (const key of ['a', 'b']) pages[key].api.subscribeDesktopNotices((notice) => shown.push({ step, phone: key, notice }));
    const connected = new Set(['a', 'b']);
    let marker = false;
    const barrier = async () => {
      marker = !marker;
      await desktop.call('config/value/write', { path: 'desktop.usageRailShortLong', value: marker });
      for (const key of connected) {
        const { client } = pages[key];
        await until(client, () => (client.store.section('config', 'desktop')?.value?.usageRailShortLong ?? false) === marker, `phone ${key} hears the step ${step} barrier`);
      }
    };
    for (step = 0; step < NOTICE_RECONNECT_STEPS.length; step += 1) {
      const { op, phone } = NOTICE_RECONNECT_STEPS[step];
      if (op === 'drop') {
        connected.delete(phone);
        world.relay.dropPhone(`client-${phone}`);
      } else if (op === 'reconnect') {
        const { client } = pages[phone];
        const back = new Promise((resolve) => {
          const off = client.on((event) => {
            if (event.type !== 'status' || event.status.state !== 'ready') return;
            off();
            resolve();
          });
        });
        comeBack();
        await within(`phone ${phone} comes back`, back);
        connected.add(phone);
      } else {
        writeFileSync(join(world.core.dataDir, 'secrets'), '');
        // An op id is a UUIDv7 (mixdog-app-protocol OpId).
        const opId = `018f0000-0000-7000-8000-${step.toString(16).padStart(12, '0')}`;
        const input = { name: `notice-${step}`, url: 'http://127.0.0.1:9/mcp', oauthClientId: 'client', oauthClientSecret: 'secret' };
        await desktop.call('mcp/addMcpServer', { opId, input }).then(
          () => {
            throw new Error('the keychain write went through: the step has no failure to raise');
          },
          () => {}
        );
      }
      await barrier();
    }
    return { shown };
  });
}

/** The core's `notice` section as the script plays it, served to each phone over a scripted connector. */
function noticeCore() {
  const entries = new Map();
  const raised = new Set();
  const revisions = new Map();
  const sinks = new Set();
  const publish = (key, value) => {
    revisions.set(key, (revisions.get(key) ?? 0) + 1);
    const update = { section: 'notice', key, revision: revisions.get(key), ...(value === undefined ? { removed: true } : { value }) };
    if (value === undefined) entries.delete(key);
    else entries.set(key, update);
    for (const sink of sinks) sink.push('notice/updated', update);
  };
  return {
    raise(key, code, params) {
      if (raised.has(key)) return false;
      raised.add(key);
      publish(key, { key, code, params });
      return true;
    },
    clear(key) {
      if (raised.delete(key)) publish(key, undefined);
    },
    /** The last app-feed seq each connection was sent (a connection's own feed position). */
    sent: [],
    connector(initializeResult) {
      const sent = this.sent;
      return {
      async open(_target, sink) {
        const index = sent.push(0) - 1;
        const own = {
          push: (method, params) => sink.frame(JSON.stringify({ method, params, feed: { id: 'app', epoch: 'e', seq: (sent[index] += 1) } })),
        };
        // The core's attach (mixdog-core-base feed `attach`): the snapshot stands at S, live events start at S + 1 (`startSeq`, `liveSeq`).
        const at = (sent[index] += 1);
        return {
          send(text) {
            const frame = JSON.parse(text);
            if (frame.id === undefined) return;
            const reply = (result) => queueMicrotask(() => sink.frame(JSON.stringify({ id: frame.id, result })));
            if (frame.method === 'initialize') return reply(initializeResult);
            if (frame.method === 'app/subscribe') {
              reply({ subscription: { id: 's', mode: 'snapshot', epoch: 'e', startSeq: at + 1, liveSeq: at + 1 } });
              queueMicrotask(() => {
                sink.frame(JSON.stringify({ method: 'app/snapshot', params: { sections: [...entries.values()] }, feed: { id: 'app', epoch: 'e', seq: at } }));
                sinks.add(own);
              });
              return;
            }
            reply({});
          },
          close() {},
        };
      },
      };
    },
  };
}

async function notices() {
  const { connect, sessionReducer } = await here('packages/protocol-client/src/index.ts');
  const options = JSON.parse(readFileSync(join(REPO_ROOT, 'packages', 'protocol-client', 'conformance', 'options.json'), 'utf8'));
  const core = noticeCore();
  const base = {
    target: { id: 'core' },
    connector: core.connector({ ...options.initializeResult, serverVersion: VERSION, connection: { origin: 'relay', device: 'Mixdog Phone' } }),
    clientInfo: { name: 'mixdog-phone', title: 'Mixdog Phone', version: VERSION, kind: 'phone' },
    capabilities: { optOutNotificationMethods: [], experimentalApi: false },
    threadReducer: sessionReducer,
    clock: { sleep: () => Promise.reject(new Error('the replay dropped its connection')) },
    random: Math.random,
  };
  const shown = [];
  const raised = [];
  let step = -1;
  const clients = [];
  const connectPhone = async (key) => {
    const client = await attached(connect, base);
    clients.push(client);
    const page = await phonePage(client);
    page.api.subscribeDesktopNotices((notice) => shown.push({ step, phone: key, notice }));
  };
  try {
    await connectPhone('a');
    for (step = 0; step < NOTICE_STEPS.length; step += 1) {
      const { op, key, code, params, phone } = NOTICE_STEPS[step];
      if (op === 'connect') await connectPhone(phone);
      else if (op === 'clear') core.clear(key);
      else raised.push({ step, raised: core.raise(key, code, params) });
      // Every frame a step published was handed over at once; each client folds it on its feed chain: it is done when its store stands at
      // the last seq its connection was sent.
      for (const [index, client] of clients.entries()) {
        await until(client, () => client.store.app?.seq === core.sent[index], `phone ${index} folds step ${step}`);
      }
    }
  } finally {
    for (const client of clients) client.close?.();
  }
  return { shown, raised };
}

/** Plays every scenario (or `only`), each beside the others; returns the differences per scenario. */
export async function replayPushes({ exe, golden, only }) {
  browserGlobals();
  rmSync(WORLDS, { recursive: true, force: true });
  const node = golden.scenarios;
  const cases = {
    'flags-native': async () => compareFlags(node['flags-native'], await flagsOn(exe, 'flags-native', RELAY_NATIVE)),
    'flags-plain': async () => compareFlags(node['flags-plain'], await flagsOn(exe, 'flags-plain', RELAY_PLAIN)),
    pins: async () => {
      const { answers, heard, persisted } = node.pins;
      const core = await pins(exe);
      return { node: { answers, heard: byPhone(heard), persisted }, core: { ...core, heard: byPhone(core.heard) } };
    },
    'native-push': async () => {
      const { answers, persisted } = node['native-push'];
      return { node: { answers, persisted }, core: await nativePush(exe) };
    },
    notices: async () => {
      const { shown, raised } = node.notices;
      return { node: { shown, raised }, core: await notices() };
    },
    'notice-reconnect': async () => ({ node: { shown: node['notice-reconnect'].shown }, core: await noticeReconnect(exe) }),
  };
  const names = only ? [only] : Object.keys(cases);
  try {
    const results = await Promise.all(names.map((name) => cases[name]()));
    return Object.fromEntries(names.map((name, index) => [name, { ...results[index], paths: differences(results[index].node, results[index].core) }]));
  } finally {
    rmSync(WORLDS, { recursive: true, force: true });
  }
}
