#!/usr/bin/env node
// What Node's host (b6f10295a) answers the paired phone for the settings, updater, notification and feedback calls (unit PH-2,
// list 1 unit B), recorded from an exact export: the relay's own frame executor (`executeRemoteFrame` over `createRemoteMethods`,
// remote-methods.ts) with the real settings store over the real config module (`createDesktopOperations`, config.mjs), the real
// notification store and center (notification-preferences.ts, notification-center.ts) and the real relay push filter
// (`createRelayPushLanes`, remote-relay-push-lanes.ts). Per call the recording holds the params the phone sent, the frame the relay
// sent back, what the PC's window was asked to do, the events every paired phone received (the agent-settings and orchestration
// watches run on the forced change pass Node's in-process write starts, config.mjs notifyConfigChanged), the feedback the relay's
// endpoint received, and the whole state after it: `mixdog-config.json` and `notification-preferences.json`.
//
//   node --import apps/desktop/scripts/test-env.mjs --import apps/desktop/scripts/test-tsx.mjs \
//        benchmarks/rust-core/recorders/record-phone-settings.mjs --tree <git archive of b6f10295a with node_modules> [--only <group>]
//
// With `--replay <mixdogd.exe>` the same cases run through the phone's router and adapter (renderer/remote-protocol-settings.ts) on a
// phone paired behind a scripted relay with a built `mixdogd`, a stand-in PC window claiming the host role, and everything is compared
// with the recording, case by case: the frame, the window's requests, the events the phone's page heard, the feedback posts and the
// whole state (the core keeps the notification document as its config's `notifications` subtree, Node's file without `version`).
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, watch, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { register } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { commitStage, exactProductIdentity, importFrom, parseArgs, REPO_ROOT, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';
import { startRelay } from './lib/phone-relay-core.mjs';

const REF = 'b6f10295a2f698afc85332467192de28500bd146';
const FIXTURES = join(REPO_ROOT, 'apps', 'mobile', 'fixtures', 'phone-settings');
const WORK = process.env.PHONE_SETTINGS_WORK ?? join('D:\\mixdog-build\\tmp', `${REPO_ROOT.split(/[\\/]/).pop()}-phone-settings`);
const args = parseArgs();
const REPLAY = args.get('replay') ?? null;
const ONLY = args.get('only') ?? null;
const RECORDER_FILES = ['record-phone-settings.mjs', 'lib/common.mjs', 'lib/phone-relay-core.mjs'].map((file) => `benchmarks/rust-core/recorders/${file}`);
const recorderFiles = () =>
  RECORDER_FILES.map((path) => ({ path, sha256: createHash('sha256').update(readFileSync(join(REPO_ROOT, path), 'utf8').replaceAll('\r\n', '\n')).digest('hex') }));
const clone = (value) => JSON.parse(JSON.stringify(value ?? null));
const here = (path) => import(pathToFileURL(join(REPO_ROOT, path)).href);

// ── the world, the same for both products ──
/** The paired phone that calls (its relay credential) and another paired device. */
const PHONE_ID = '0123456789abcdef0123456789abcdef';
const OTHER_ID = 'fedcba9876543210fedcba9876543210';
/** When the notification store was first written: the phone was paired after it, the browser before. */
const MIGRATED_AT = Date.UTC(2026, 0, 1);
const PAIRED = [
  { id: PHONE_ID, name: 'Pixel 9 · Mixdog App', platform: 'Android', browser: 'Mixdog App', createdAt: Date.UTC(2026, 1, 2), lastSeenAt: Date.UTC(2026, 1, 3), online: true },
  { id: OTHER_ID, name: 'Windows · Chrome', platform: 'Windows', browser: 'Chrome', createdAt: Date.UTC(2025, 11, 1), lastSeenAt: Date.UTC(2025, 11, 2), online: false },
];
const PC_NAME = 'Fixture PC';
/** `mixdog-config.json` before the first case: a control already on (the install marker is kept when it goes off), the one-time
 *  defaults separation done and the shipped roles greeted, so neither product's startup rewrites the file before the first case. */
const SEED_CONFIG = {
  defaultsVersion: 2,
  desktop: { computerControl: true, keepAwake: false, defaultsSeparationVersion: 1 },
  agent: { autoClear: { minContextPercent: 10 } },
  agents: { greeted: ['advisor', 'front-worker', 'heavy-worker', 'reviewer', 'security', 'worker', 'writer'] },
};
const SEED_NOTIFICATIONS = { version: 1, migratedAt: MIGRATED_AT, devices: {}, overrides: [] };
/** What the PC's window answers (Electron's updater, theme and notifications), for Node's window requests and the core's host requests. */
const WINDOW = {
  displayPreferences: { theme: '  dark  ', language: 'ko', extra: true },
  updaterState: { status: 'ready', version: '9.9.9' },
  check: { status: 'up-to-date' },
  install: (confirmed) => (confirmed ? { status: 'installing', version: '9.9.9' } : { status: 'ready', version: '9.9.9', busy: true }),
  notificationStatus: { supported: true, idleSeconds: null },
  notificationTest: { ok: true },
};
const FEEDBACK = { id: '0F1E2D3C-4B5A-4978-8695-a4b3c2d1e0f9', kind: 'bug', message: '  The toggle did not stick.  ', replyTo: ' user@example.com ' };
/** The relay's `/feedback` answers, in order: accepted (the receipt names the posted id), then too many requests. */
const FEEDBACK_REPLIES = [(posted) => [202, { id: posted.id, status: 'accepted' }], () => [429, { error: 'rate limited' }]];

const FAR = Date.UTC(2100, 0, 1);
const GROUPS = {
  settings: [
    ['readSettings', []],
    ['updateSetting', ['keepAwake', true]],
    ['updateSetting', ['usagePinned', false]],
    ['updateSetting', ['autoClear', false]],
    ['updateSetting', ['autoCompact', false]],
    ['updateSetting', ['computerControl', false]],
    // Keys of the desktop settings the app knows that Node's relay refused to write.
    ['updateSetting', ['notificationVolume', true]],
    ['updateSetting', ['browserPermissions', true]],
    ['updateSetting', ['sessionAutoDeleteDays', true]],
    ['updateSetting', ['zoom', true]],
    ['readSettings', []],
  ],
  window: [
    ['readHostDisplayPreferences', []],
    ['getUpdaterState', []],
    ['checkForDesktopUpdate', []],
    ['showDesktopUpdate', [false]],
    ['showDesktopUpdate', [true]],
    ['submitFeedback', [FEEDBACK]],
    ['submitFeedback', [{ ...FEEDBACK, id: '11111111-2222-4333-8444-555555555555' }]],
    ['notifyProviderModelsChanged', [' 7c9e6679-7425-40de-944b-e07fc1f90ae7 ']],
  ],
  notifications: [
    ['getNotificationPreferences', []],
    ['setNotificationPreferences', [PHONE_ID, { scope: 'all' }]],
    ['setNotificationPreferences', ['pc', { quietHours: { enabled: true, start: '22:30' } }]],
    ['setNotificationPreferences', [OTHER_ID, { events: { finished: false }, taskbarFlash: true }]],
    ['setNotificationPreferences', ['someone-else', { scope: 'off' }]],
    ['listConversationNotifications', []],
    ['setConversationNotification', [{ kind: 'session', id: 's1' }, { mode: 'muted', until: FAR }]],
    ['setConversationNotification', [{ kind: 'agent', id: 'a1' }, { mode: 'always' }]],
    ['setConversationNotification', [{ kind: 'room', id: 'r1' }, { mode: 'muted', until: null }]],
    ['setConversationNotification', [{ kind: 'session', id: 's1' }, { mode: 'inherit' }]],
    ['listConversationNotifications', []],
    ['sendTestNotification', ['pc']],
    ['sendTestNotification', ['someone-else']],
    ['getNotificationPreferences', []],
  ],
};
if (ONLY !== null && !GROUPS[ONLY]) throw new Error(`--only takes one of ${Object.keys(GROUPS).join(', ')}, not ${ONLY}`);
const groups = ONLY ? [ONLY] : Object.keys(GROUPS);

/** The relay's feedback endpoint: what it received, in order, and the scripted answers. */
function feedbackEndpoint() {
  const posts = [];
  let next = 0;
  const handle = (req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      const posted = JSON.parse(body);
      posts.push({ method: req.method, path: req.url, contentType: req.headers['content-type'] ?? null, body: posted });
      const [status, reply] = FEEDBACK_REPLIES[next++ % FEEDBACK_REPLIES.length](posted);
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(reply));
    });
  };
  return { posts, handle };
}

const readJson = (path) => (existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null);

if (REPLAY) process.exit(await replay(REPLAY));

// ── Node's host ──
const tree = resolveTree(args);
const identity = exactProductIdentity(tree, REF);
rmSync(WORK, { recursive: true, force: true });
const DATA = join(WORK, 'data');
const USER_DATA = join(WORK, 'userdata');
for (const dir of [DATA, USER_DATA, join(WORK, 'home')]) mkdirSync(dir, { recursive: true });
Object.assign(process.env, { MIXDOG_HOME: join(WORK, 'home'), MIXDOG_DATA_DIR: DATA });
writeFileSync(join(DATA, 'mixdog-config.json'), JSON.stringify(SEED_CONFIG, null, 2));
const NOTIFICATION_FILE = join(USER_DATA, 'notification-preferences.json');
writeFileSync(NOTIFICATION_FILE, JSON.stringify(SEED_NOTIFICATIONS, null, 2));
const endpoint = feedbackEndpoint();
const server = createServer(endpoint.handle);
// A bind either succeeds or emits `error` at once; the error fails the recording.
await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    server.off('error', reject);
    resolve();
  });
});
// The relay's address: the feedback client posts to its `/feedback` (remote-relay-device.ts resolveRelayUrl).
process.env.MIXDOG_RELAY_URL = `ws://127.0.0.1:${server.address().port}`;

const main = (name) => importFrom(tree, `apps/desktop/src/main/${name}.ts`);
const config = await importFrom(tree, 'src/runtime/shared/config.mjs');
const { createRemoteMethods, executeRemoteFrame } = await main('remote-methods');
const { createDesktopOperations } = await main('desktop-operations');
const { createNotificationPreferencesStore } = await main('notification-preferences');
const { createNotificationCenter } = await main('notification-center');
const { createRelayPushLanes } = await main('remote-relay-push-lanes');
const { watchAgentSettings } = await main('agent-settings-watch');
const { watchConfiguredOrchestrationMode } = await main('orchestration-mode-watch');

// Every in-process config write starts one forced change pass (config.mjs notifyConfigChanged, a trailing 100 ms debounce): the
// watches below hear it after the call answered. The pass is run here once the call settled, for every call that wrote.
let configWrites = 0;
const passListeners = new Set();
const configModule = {
  readConfig: config.readConfig,
  secretChangeTokens: config.secretChangeTokens,
  updateConfigAsync: (updater) => {
    configWrites += 1;
    return config.updateConfigAsync(updater);
  },
  subscribeConfigChange: (listener) => {
    passListeners.add(listener);
    return () => passListeners.delete(listener);
  },
};
// The desktop event bus (desktop-service.ts createDesktopEventBus): every event reaches the relay's push lanes, whose filter decides
// what each paired phone receives.
const busListeners = new Set();
const publish = (name, value) => {
  for (const listener of busListeners) listener({ name, value });
};
const phoneFrames = [];
const lanes = createRelayPushLanes({
  clients: new Map([['phone', { lanes: new Set() }]]),
  broadcastEncrypted: (payload) => phoneFrames.push(clone(payload)),
  subscribeDesktopEvents: (listener) => {
    busListeners.add(listener);
    return () => busListeners.delete(listener);
  },
});
watchAgentSettings(configModule, publish);
watchConfiguredOrchestrationMode(configModule, publish);
const operations = createDesktopOperations({
  userDataPath: USER_DATA,
  packaged: false,
  resourcesPath: '',
  appPath: join(tree, 'apps', 'desktop'),
  loadConfig: async () => configModule,
  emit: ({ name, value }) => publish(name, value),
});
const store = createNotificationPreferencesStore({
  filePath: NOTIFICATION_FILE,
  readLegacy: async () => ({ turnNotifications: true, mutedAgents: [] }),
  onChange: () => publish('settings-changed', { scope: 'notifications' }),
});
await store.ready();
// What the PC's window was asked to do (reads of its state are not requests to act).
const hostCalls = [];
const windowRequest = async (method, requestArgs) => {
  if (method === 'updaterState') return WINDOW.updaterState;
  if (method === 'displayPreferences') return WINDOW.displayPreferences;
  if (method === 'updaterCheck') {
    hostCalls.push({ method, args: clone(requestArgs) });
    return WINDOW.check;
  }
  if (method === 'updaterInstall') {
    hostCalls.push({ method, args: clone(requestArgs) });
    return WINDOW.install(requestArgs[0] === true);
  }
  throw new Error(`the window is not scripted for ${method}`);
};
const center = createNotificationCenter({
  store,
  pcName: () => PC_NAME,
  listClients: async () => clone(PAIRED),
  pushRegistrations: async () => new Set(),
  pcSupported: async () => WINDOW.notificationStatus.supported,
  sendPcTest: async () => {
    hostCalls.push({ method: 'notificationTest', args: [] });
    return WINDOW.notificationTest;
  },
  sendDeviceTest: async () => {
    throw new Error('no case tests a paired device');
  },
});
const host = {
  invokeDesktopOperation: (name, operationArgs) =>
    center.handles(name) ? center.invoke(name, operationArgs) : operations.invoke(name, operationArgs),
};
const methods = createRemoteMethods(
  {
    host,
    userDataPath: USER_DATA,
    settingsStore: operations.settingsStore,
    onDesktopSettingsChanged: () => undefined,
    hostRequest: windowRequest,
  },
  { credentialId: () => PHONE_ID, connectionId: () => 'relay-connection-1' }
);

const cases = [];
let frameId = 0;
for (const group of groups) {
  for (const [name, params] of GROUPS[group]) {
    hostCalls.length = 0;
    phoneFrames.length = 0;
    endpoint.posts.length = 0;
    const writes = configWrites;
    const { id: _id, ...frame } = clone(await executeRemoteFrame(methods, JSON.stringify({ id: ++frameId, method: name, params })));
    if (configWrites !== writes) for (const listener of [...passListeners]) listener();
    cases.push({
      group,
      name,
      params: clone(params),
      frame,
      hostCalls: clone(hostCalls),
      events: clone(phoneFrames),
      feedback: clone(endpoint.posts),
      state: { config: readJson(join(DATA, 'mixdog-config.json')), notifications: readJson(NOTIFICATION_FILE) },
    });
  }
}
lanes.dispose();
await operations.dispose?.();
server.close();

if (ONLY) {
  const text = `${JSON.stringify(cases, null, 2)}\n`;
  await new Promise((written, failed) => process.stdout.write(text, (error) => (error ? failed(error) : written())));
  process.exit(0);
}
const stage = stageSet(FIXTURES);
writeJson(join(stage, 'golden.json'), {
  note: 'Node host (b6f10295a) answers to a paired phone for the settings, updater, notification and feedback calls: per call the relay frame, what the PC window was asked to do, the frames every paired phone received, the posts the relay feedback endpoint received, and mixdog-config.json and notification-preferences.json after it.',
  world: { phone: PHONE_ID, paired: PAIRED, pcName: PC_NAME, seedConfig: SEED_CONFIG, seedNotifications: SEED_NOTIFICATIONS, window: { ...WINDOW, install: [WINDOW.install(false), WINDOW.install(true)] } },
  cases,
});
writeSetManifest(stage, {
  set: 'phone-settings',
  recorder: 'benchmarks/rust-core/recorders/record-phone-settings.mjs',
  command: `node --import apps/desktop/scripts/test-env.mjs --import apps/desktop/scripts/test-tsx.mjs benchmarks/rust-core/recorders/record-phone-settings.mjs --tree <git archive of ${REF} with node_modules>`,
  identity,
  extra: {
    node: process.version,
    cases: cases.length,
    recorderFiles: recorderFiles(),
    entry: {
      runs: 'executeRemoteFrame over createRemoteMethods (remote-methods.ts:828, :1256) with the settings store of createDesktopOperations over config.mjs, the notification store and center, and createRelayPushLanes for what each paired phone received',
      notRun:
        "the relay transport (encryption, admission), the window process (its answers are the WINDOW script), config.mjs's own debounce timer and file watch (the forced pass an in-process write starts is run when the call settled), and a paired device's push channel",
    },
    syntheticInput: {
      window: 'Electron answers (updater, theme, OS notifications), the same script answers the core replay through host requests',
      feedback: 'the relay /feedback endpoint answers 202 with a receipt naming the posted id, then 429',
    },
  },
});
commitStage(stage, FIXTURES);
console.log(`phone-settings: ${cases.length} cases`);
process.exit(0);

// ── the replay: the phone's router and adapter over a built core ──
async function replay(exe) {
  // The client's method table is this tree's `@mixdog/protocol`, whatever a shared node_modules links that name to.
  const ownProtocol = pathToFileURL(join(REPO_ROOT, 'packages', 'protocol', 'src', 'index.ts')).href;
  register(
    `data:text/javascript,${encodeURIComponent(
      `export const resolve = (specifier, context, next) => specifier === '@mixdog/protocol' ? { url: ${JSON.stringify(ownProtocol)}, shortCircuit: true } : next(specifier, context);`
    )}`
  );
  const golden = JSON.parse(readFileSync(join(FIXTURES, 'golden.json'), 'utf8'));
  const manifest = JSON.parse(readFileSync(join(FIXTURES, 'MANIFEST.json'), 'utf8'));
  if (!isDeepStrictEqual(manifest.recorderFiles, recorderFiles())) throw new Error('the recording was made by another recorder than this one: record again before comparing');
  const coreRoot = join(WORK, 'core');
  rmSync(WORK, { recursive: true, force: true });
  for (const dir of ['runtime', 'data', 'home', 'config']) mkdirSync(join(coreRoot, dir), { recursive: true });
  const { notifications: seedNotifications } = { notifications: SEED_NOTIFICATIONS };
  const { version: _version, ...seedDoc } = seedNotifications;
  writeFileSync(join(coreRoot, 'data', 'mixdog-config.json'), JSON.stringify({ ...SEED_CONFIG, notifications: seedDoc }, null, 2));
  writeFileSync(join(coreRoot, 'data', 'remote-activated.json'), '{"activatedAt":1}');
  const endpoint = feedbackEndpoint();
  const relay = await startRelay({ repoRoot: REPO_ROOT, clients: clone(PAIRED), capabilities: { textFrames: 1, maxFrameBytes: 1048576 }, http: endpoint.handle });
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('MIXDOG_')) delete env[key];
  Object.assign(env, {
    MIXDOG_RUNTIME_ROOT: join(coreRoot, 'runtime'),
    MIXDOG_DATA_DIR: join(coreRoot, 'data'),
    MIXDOG_HOME: join(coreRoot, 'home'),
    MIXDOG_CONFIG_DIR: join(coreRoot, 'config'),
    MIXDOG_RELAY_URL: `ws://127.0.0.1:${relay.port}`,
  });
  const runtimeManifest = join(exe, '..', 'js-runtime.json');
  if (!existsSync(runtimeManifest)) writeFileSync(runtimeManifest, JSON.stringify({ program: process.execPath, packageRoot: REPO_ROOT }));
  const child = spawn(exe, ['serve'], { env, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  let stderr = '';
  child.stderr.on('data', (chunk) => (stderr += chunk));
  const clients = [];
  try {
    const { parseDiscovery } = await here('apps/desktop/src/main/protocol/discovery.ts');
    const endpointOf = await discovered(child, join(coreRoot, 'runtime'), parseDiscovery, () => stderr);
    const { connect, sessionReducer } = await here('packages/protocol-client/src/index.ts');
    const { createWsConnector } = await here('apps/desktop/src/main/protocol/ws-connector.ts');
    const base = {
      target: { id: 'core' },
      connector: createWsConnector(async () => endpointOf),
      clientInfo: { name: 'mixdog-phone', title: 'Mixdog Phone', version: '1.4.5', kind: 'phone' },
      capabilities: { optOutNotificationMethods: [], experimentalApi: false },
      threadReducer: sessionReducer,
      // The client sleeps only on its reconnect ladder; the replay never drops a connection, so a drop fails it instead.
      clock: { sleep: () => Promise.reject(new Error('the replay dropped its connection')) },
      random: Math.random,
    };
    // The PC's window: claims the host role and answers the updater and notification requests from the WINDOW script.
    const hostCalls = [];
    const window = await connect({
      ...base,
      clientInfo: { ...base.clientInfo, name: 'mixdog-replay-window', kind: 'desktop' },
      capabilities: {
        optOutNotificationMethods: [],
        experimentalApi: false,
        host: { browser: false, visualize: false, notifications: true, systemProxy: false, power: false, media: false, updater: true, files: false },
      },
    });
    clients.push(window);
    window.on((event) => {
      if (event.type === 'notification' && event.notification?.method === 'host/notification/show') {
        const shown = event.notification.params ?? {};
        hostCalls.push(shown.title === 'Mixdog' && shown.body === 'Notifications from Mixdog appear like this.' ? { method: 'notificationTest', args: [] } : { method: 'host/notification/show', args: [clone(shown)] });
        return;
      }
      if (event.type !== 'serverRequest') return;
      const { id, method, params } = event.request;
      if (method === 'host/notification/status') return window.respond(id, { result: WINDOW.notificationStatus });
      if (method === 'host/update/command' && params?.action === 'check') {
        hostCalls.push({ method: 'updaterCheck', args: [] });
        return window.respond(id, { result: WINDOW.check });
      }
      if (method === 'host/update/command' && params?.action === 'install') {
        hostCalls.push({ method: 'updaterInstall', args: [params.confirmed === true] });
        return window.respond(id, { result: WINDOW.install(params.confirmed === true) });
      }
      window.respond(id, { error: { code: -32601, message: `${method} is not scripted` } });
    });
    await window.call('host/claim', { hostId: 'replay-window' });
    await window.call('host/state/set', { key: 'displayPreferences', value: WINDOW.displayPreferences });
    window.notify('host/update/report', { state: WINDOW.updaterState });
    await window.call('remoteAccess/setName', { name: PC_NAME });

    await relay.leg();
    const { relayE2EEPairingMaterial } = await here('apps/desktop/src/shared/remote-e2ee.ts');
    const pairing = relayE2EEPairingMaterial(JSON.parse(readFileSync(join(coreRoot, 'data', 'relay-e2ee.json'), 'utf8')));
    const phone = await connect({ ...base, connector: await relay.openPhone('client-settings', PHONE_ID, pairing) });
    clients.push(phone);
    // The page holds the app feed's sections (the phone shim subscribes on start); the snapshot is folded before the adapter wires,
    // so only changes after it are events.
    const snapshot = new Promise((resolve) => {
      const off = phone.store.subscribe((change) => {
        if (change.type !== 'appSnapshot') return;
        off();
        resolve();
      });
    });
    await phone.subscribeApp();
    await snapshot;
    // The page's listeners: what it heard, as the relay frames Node sent it.
    const heard = [];
    const listening = (event) => new Set([(payload) => heard.push(clone({ event, payload }))]);
    const ctx = {
      browserId: PHONE_ID,
      fanOut: (listeners, value) => {
        for (const listener of listeners) listener(value);
      },
      settingsChangedListeners: listening('settings-changed'),
      updaterListeners: listening('updater-state-changed'),
      providerModelsListeners: listening('provider-models-changed'),
      phone: { start: async () => phone },
    };
    globalThis.window = { setTimeout: () => 0, clearTimeout() {} };
    const { adapter } = await here('apps/desktop/src/renderer/remote-protocol-settings.ts');
    const { createProtocolRouter } = await here('apps/desktop/src/renderer/remote-shim-protocol.ts');
    const host = { ctx, client: () => phone, declareLane() {}, onClient: (listener) => (listener(phone), () => undefined) };
    const router = createProtocolRouter([adapter], { host, started: async () => {}, synced: async () => {}, probe() {}, silentSince: () => false });
    router.install();
    // The state the core settled on: its config file, with the notification document as Node's file held it.
    const configFile = join(coreRoot, 'data', 'mixdog-config.json');
    const coreState = () => {
      const { notifications, ...rest } = readJson(configFile) ?? {};
      return { config: rest, notifications: notifications === undefined ? null : { version: 1, ...notifications } };
    };
    // The phone has heard every change of the case when what it holds of each published subtree is what the file holds.
    const settled = () => {
      const file = readJson(configFile) ?? {};
      return ['desktop', 'agent', 'notifications'].every((key) => isDeepStrictEqual(phone.store.section('config', key)?.value, file[key]));
    };
    const untilSettled = (label) =>
      new Promise((resolve, reject) => {
        if (settled()) return resolve();
        const timer = setTimeout(() => {
          off();
          reject(new Error(`${label}: the phone did not hear the config change within 30 s`));
        }, 30_000);
        const off = phone.store.subscribe(() => {
          if (!settled()) return;
          clearTimeout(timer);
          off();
          resolve();
        });
      });

    const wanted = golden.cases.filter((entry) => groups.includes(entry.group));
    const differences = [];
    for (const [index, expected] of wanted.entries()) {
      hostCalls.length = 0;
      heard.length = 0;
      endpoint.posts.length = 0;
      let frame;
      try {
        frame = { ok: true, value: clone(await router.call(expected.name, clone(expected.params))) };
      } catch (error) {
        frame = { ok: false, error: error.message, ...(typeof error.code === 'string' && error.code ? { errorCode: error.code } : {}) };
      }
      const label = `#${index} ${expected.name} ${JSON.stringify(expected.params).slice(0, 80)}`;
      await untilSettled(label);
      const got = { frame, hostCalls: clone(hostCalls), events: clone(heard), feedback: clone(endpoint.posts), state: coreState() };
      const node = { frame: expected.frame, hostCalls: expected.hostCalls, events: expected.events.map((entry) => ({ event: entry.event, payload: entry.payload })), feedback: expected.feedback, state: expected.state };
      for (const field of Object.keys(node)) {
        if (!isDeepStrictEqual(node[field], got[field])) differences.push({ label, field, node: node[field], core: got[field] });
      }
    }
    console.log(`phone-settings replay over ${exe}: ${wanted.length} cases compared, ${differences.length} differ`);
    for (const entry of differences) {
      console.log(`DIFF ${entry.label} ${entry.field}`);
      console.log(`   node: ${JSON.stringify(entry.node).slice(0, 600)}`);
      console.log(`   core: ${JSON.stringify(entry.core).slice(0, 600)}`);
    }
    return differences.length ? 1 : 0;
  } finally {
    for (const client of clients) client.close?.();
    spawnSync('taskkill', ['/T', '/F', '/PID', String(child.pid)], { stdio: 'ignore', windowsHide: true, timeout: 30_000 });
    relay.close();
  }
}

/** The core is up when it has written its discovery file: the watch wakes the wait on the directory's change or the child's exit. */
async function discovered(child, dir, parseDiscovery, stderr) {
  const file = join(dir, 'daemon.json');
  let stirred = false;
  let wake = null;
  const stir = () => {
    stirred = true;
    wake?.();
  };
  const watcher = watch(dir, stir);
  child.once('exit', stir);
  const deadline = setTimeout(stir, 120_000);
  const started = Date.now();
  try {
    for (;;) {
      stirred = false;
      if (child.exitCode !== null) throw new Error(`mixdogd exited ${child.exitCode}:\n${stderr()}`);
      if (Date.now() - started > 120_000) throw new Error('mixdogd did not write its discovery file within 120 s');
      try {
        return parseDiscovery(readFileSync(file, 'utf8'));
      } catch {
        if (!stirred) await new Promise((resolve) => (wake = resolve));
      }
    }
  } finally {
    clearTimeout(deadline);
    watcher.close();
  }
}
