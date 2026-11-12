#!/usr/bin/env node
// What Node's desktop (b6f10295a) does for every settings write its settings pages can make: the window's own IPC handlers
// (`registerWindowSettingsIpc`, ipc-window-settings.ts: updateSetting, setNotificationVolume, setBrowserPermissions,
// setSessionRetention, setZoomFactor, updateActivityRailPins) and the Markdown default view (`writeMarkdownDefaultView`, the
// operation ipc-file-dialogs.ts calls), over the real settings store and the real config module (config.mjs) on a scratch data
// directory. Per call the recording holds the answer or the thrown error, `mixdog-config.json` as bytes, the desktop events every
// attached client received (what the desktop's own windows and a second client got), the calls the window was made (zoom), the
// settings a second client reads afterwards and the saved pins it reads.
//
//   node --import apps/desktop/scripts/test-env.mjs --import apps/desktop/scripts/test-tsx.mjs \
//        benchmarks/rust-core/recorders/record-desktop-setting-writes.mjs --tree <b6f10295a tree with node_modules> [--only <group>]
//
// With `--replay <mixdogd.exe>` the same calls run through the real handlers over the desktop's operation lane
// (protocol/desktop-operation-route.ts) on a built core, one core per group, and everything is compared with the recording.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, watch, writeFileSync } from 'node:fs';
import { register } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { commitStage, exactProductIdentity, importFrom, parseArgs, REPO_ROOT, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';
import { recorderProvenance } from './lib/provenance.mjs';

const REF = 'b6f10295a2f698afc85332467192de28500bd146';
const RECORDER = 'benchmarks/rust-core/recorders/record-desktop-setting-writes.mjs';
const FIXTURES = join(REPO_ROOT, 'native', 'core', 'fixtures', 'desktop-setting-writes');
const WORK = process.env.DESKTOP_SETTING_WRITES_WORK ?? join('C:\\mixdog-build\\tmp', REPO_ROOT.split(/[\\/]/).pop(), 'desktop-setting-writes');
const args = parseArgs();
const REPLAY = args.get('replay') ?? null;
const ONLY = args.get('only') ?? null;
const clone = (value) => JSON.parse(JSON.stringify(value ?? null));
const here = (path) => import(pathToFileURL(join(REPO_ROOT, path)).href);

const onOffOn = (key) => [['updateSetting', key, true], ['updateSetting', key, false], ['updateSetting', key, true]];
const GREETED = ['advisor', 'front-worker', 'heavy-worker', 'reviewer', 'security', 'worker', 'writer'];
// A seed the core's start-up passes rewrite (the desktop section gets its separation marker, an agent section that is no object is
// normalised; Node runs those in the app's start-up) is compared from what that rewrite leaves: the replay snapshots are taken after the start.
const BASE = { defaultsVersion: 2, agents: { greeted: GREETED } };
const SITE = { origin: 'https://example.com', permission: 'geolocation', setting: 'allow' };
const SITES = (count) => Array.from({ length: count }, (_, i) => ({ origin: `https://site${i}.example.org`, permission: 'notifications', setting: 'block' }));
const ALL_PINS = ['sessions', 'agents', 'schedules', 'workflows', 'projects', 'extensions', 'skills'];
const KEYS = [
  'autoClear', 'autoCompact', 'keepAwake', 'runInBackground', 'usagePinned', 'usageRailShortLong', 'usageAccountsExpanded',
  'usageRailSlotsThree', 'usageRailSlotsAll', 'computerControl', 'computerObserveOnly', 'browserControl', 'browserAutoSignIn',
  'browserHidDevices', 'saveChatLogins', 'computerInstalled', 'browserInstalled',
];

// Each case names the branch it takes (b6f10295a): ipc-window-settings.ts `updateSetting` :224-235 (boolean first, then
// `requiredDesktopSettingKey`, ipc-validation.ts :2195-2217), settings-store.ts `update` :259-319 (`withFlag`, the marker kept
// before a control goes off, `autoClear` / `autoCompact` under `agent`), `updateNotificationVolume`,
// `updateBrowserPermissions`, `updateSessionRetention`, `updateZoom`, `updateActivityRailPins`; workspace-config.ts
// `writeMarkdownDefaultView`.
const MARKED = { defaultsSeparationVersion: 1 };
// A control already on before its install marker existed, a flag stored with the wrong type, a stored `false` marker.
const FLAGS_SEED = { ...BASE, desktop: { computerControl: true, keepAwake: false, ...MARKED, browserControl: true, browserInstalled: false, computerObserveOnly: 'x' }, agent: { autoClear: { minContextPercent: 10 } } };
const VALUES_SEED = {
  ...BASE,
  desktop: {
    ...MARKED,
    notificationVolume: 50,
    sessionAutoArchiveDays: 14,
    sessionAutoDeleteDays: 30,
    activityRailPins: { pins: ['sessions', 'agents'], revision: 3 },
    browserPermissions: { defaults: { notifications: 'block' }, sites: [SITE] },
    zoomFactor: 1.25,
  },
};
// What the core's start leaves of a seed that lacks the desktop marker or holds a malformed agent section (the app runs those passes in its start-up):
// the replay's core would rewrite the plain seed, so these groups start from the result and Node's recorded bytes stay the expectation.
const BOOTED = { ...BASE, desktop: MARKED };
const BOOTED_AGENT = { agents: {}, providers: {}, modelSettings: {}, webSearchRoute: null };
const GROUPS = {
  // Every flag, in the order of the list: on, off, on again; a control that was on before its marker existed.
  // (The config writer keeps 40 snapshots: a group stays under that, so each call's snapshots are comparable.)
  flags1: { seed: FLAGS_SEED, steps: KEYS.slice(0, 5).flatMap(onOffOn) },
  flags2: { seed: FLAGS_SEED, steps: KEYS.slice(5, 9).flatMap(onOffOn) },
  flags3: { seed: FLAGS_SEED, steps: KEYS.slice(9, 12).flatMap(onOffOn) },
  flags4: { seed: FLAGS_SEED, steps: KEYS.slice(12, 15).flatMap(onOffOn) },
  flags5: { seed: FLAGS_SEED, steps: KEYS.slice(15).flatMap(onOffOn) },
  controls: {
    seed: FLAGS_SEED,
    steps: [
      ['updateSetting', 'computerControl', false],
      ['updateSetting', 'computerControl', false],
      ['updateSetting', 'computerControl', true],
      ['updateSetting', 'browserControl', false],
      ['updateSetting', 'browserControl', true],
      ['updateSetting', 'computerInstalled', false],
      ['updateSetting', 'browserInstalled', false],
    ],
  },
  // What the IPC handler refuses before the store is reached.
  refused: {
    seed: { ...BASE, desktop: { defaultsSeparationVersion: 1, keepAwake: false } },
    steps: [
      ['updateSetting', 'bogus', true],
      ['updateSetting', 'zoom', true],
      ['updateSetting', 'notificationVolume', true],
      ['updateSetting', 'browserPermissions', true],
      ['updateSetting', 'sessionAutoDeleteDays', true],
      ['updateSetting', '', true],
      ['updateSetting', null, true],
      ['updateSetting', 5, true],
      ['updateSetting', 'keepAwake', 'yes'],
      ['updateSetting', 'keepAwake', null],
      ['updateSetting', 'keepAwake', 1],
      ['updateSetting', 'keepAwake'],
      ['updateSetting', 'bogus', 'yes'],
      ['updateSetting'],
      ['updateSetting', 'keepAwake', true],
    ],
  },
  // The agent section: `enabled` kept next to a neighbour under `autoClear`, `auto` under `compaction`. (The retired compaction keys are
  // the core's one-time migration at start, so a seed with them is no write's input.)
  agent: {
    seed: {
      ...BASE,
      desktop: MARKED,
      agent: { autoClear: { enabled: false, minContextPercent: 10 }, compaction: { auto: false, mode: 'x', summaryModel: 'm' } },
    },
    steps: [
      ['updateSetting', 'autoClear', true],
      ['updateSetting', 'autoClear', true],
      ['updateSetting', 'autoClear', false],
      ['updateSetting', 'autoCompact', true],
      ['updateSetting', 'autoCompact', false],
      ['updateSetting', 'autoCompact', false],
      ['updateSetting', 'autoCompact', true],
      ['updateSetting', 'autoClear', true],
    ],
  },
  // Stored values of the wrong type where a section belongs.
  odd: {
    seed: { ...BASE, agent: 7, desktop: MARKED },
    steps: [['updateSetting', 'keepAwake', false], ['updateSetting', 'autoCompact', false], ['updateSetting', 'computerControl', true], ['updateSetting', 'computerControl', false]],
  },
  odd2: {
    seed: { ...BASE, agent: BOOTED_AGENT, desktop: MARKED },
    steps: [['updateSetting', 'autoClear', false], ['updateSetting', 'autoCompact', false], ['updateSetting', 'usagePinned', false]],
  },
  // A config with neither section: the first write creates what it needs (a default value still leaves its section).
  empty: {
    seed: BOOTED,
    steps: [['updateSetting', 'keepAwake', true], ['updateSetting', 'keepAwake', false], ['updateSetting', 'autoClear', true], ['setNotificationVolume', 100], ['setNotificationVolume', 50]],
  },
  emptyAgent: { seed: BOOTED, steps: [['updateSetting', 'autoCompact', true], ['updateSetting', 'autoCompact', false]] },
  emptyVolume: { seed: BOOTED, steps: [['setNotificationVolume', 100], ['updateSetting', 'keepAwake', false]] },
  emptyRetention: { seed: BOOTED, steps: [['setSessionRetention', 'sessionAutoArchiveDays', 7]] },
  emptyPermissions: { seed: BOOTED, steps: [['setBrowserPermissions', {}]] },
  emptyPins: { seed: BOOTED, steps: [['updateActivityRailPins', ['agents'], true], ['updateActivityRailPins', ['agents'], true]] },
  emptyDesktop: {
    seed: { ...BASE, desktop: MARKED },
    steps: [['updateSetting', 'computerControl', false], ['updateSetting', 'computerControl', true], ['updateActivityRailPins', ['agents'], true]],
  },
  // The value keys: volume, retention, zoom, site permissions, rail pins, the Markdown view.
  volume: {
    seed: VALUES_SEED,
    steps: [
      ...[0, 1, 99, 100, 101, 250, 400, 401, -1, 1.5, '50', null, true, [], {}].map((v) => ['setNotificationVolume', v]),
      ['setNotificationVolume'],
    ],
  },
  retention: {
    seed: VALUES_SEED,
    steps: [
      ['setSessionRetention', 'sessionAutoArchiveDays', 0],
      ['setSessionRetention', 'sessionAutoArchiveDays', 1],
      ['setSessionRetention', 'sessionAutoArchiveDays', 7],
      ['setSessionRetention', 'sessionAutoArchiveDays', 14],
      ['setSessionRetention', 'sessionAutoArchiveDays', 30],
      ['setSessionRetention', 'sessionAutoArchiveDays', 90],
      ['setSessionRetention', 'sessionAutoArchiveDays', 5],
      ['setSessionRetention', 'sessionAutoArchiveDays', '7'],
      ['setSessionRetention', 'sessionAutoArchiveDays', null],
      ['setSessionRetention', 'sessionAutoDeleteDays', 0],
      ['setSessionRetention', 'sessionAutoDeleteDays', 7],
      ['setSessionRetention', 'sessionAutoDeleteDays', 30],
      ['setSessionRetention', 'sessionAutoDeleteDays', 90],
      ['setSessionRetention', 'sessionAutoDeleteDays', 1],
      ['setSessionRetention', 'sessionAutoDeleteDays', 14],
      ['setSessionRetention', 'bogus', 7],
      ['setSessionRetention', 'zoom', 1],
      ['setSessionRetention', null, 7],
      ['setSessionRetention', 'sessionAutoArchiveDays'],
      ['setSessionRetention'],
    ],
  },
  zoom: {
    seed: VALUES_SEED,
    steps: [
      ...[1, 1.001, 0.996, 1.25, 0.1, 0.2, 10, 10.01, 11, 0, -1, '1', null, true, [], {}].map((v) => ['setZoomFactor', v]),
      ['setZoomFactor'],
    ],
  },
  permissions: {
    seed: VALUES_SEED,
    steps: [
      ['setBrowserPermissions', { defaults: { notifications: 'allow' } }],
      ['setBrowserPermissions', { defaults: { notifications: 'block' }, sites: [SITE, SITE] }],
      ['setBrowserPermissions', { sites: [SITE, { ...SITE, embedder: 'https://b.example.org' }, { ...SITE, origin: 'not a url' }, null, 7] }],
      ['setBrowserPermissions', { defaults: { geolocation: 'bogus', fileSystem: 'ask', midi: 7 }, sites: [{ ...SITE, setting: 'maybe' }, { ...SITE, permission: 'bogus' }] }],
      ['setBrowserPermissions', { sites: SITES(300) }],
      ['setBrowserPermissions', { sites: SITES(301) }],
      ['setBrowserPermissions', { sites: SITES(2) }],
      ['setBrowserPermissions', {}],
      ['setBrowserPermissions', { defaults: {}, sites: [] }],
      ['setBrowserPermissions', { defaults: { notifications: 'allow' }, sites: [SITE], extra: 1 }],
      ['setBrowserPermissions', null],
      ['setBrowserPermissions', []],
      ['setBrowserPermissions', 'allow'],
      ['setBrowserPermissions', 7],
      ['setBrowserPermissions'],
    ],
  },
  railPins: {
    seed: VALUES_SEED,
    steps: [
      ['updateActivityRailPins', ['sessions', 'agents']],
      ['updateActivityRailPins', ALL_PINS],
      ['updateActivityRailPins', ALL_PINS],
      ['updateActivityRailPins', ['agents', 'sessions', 'agents']],
      ['updateActivityRailPins', []],
      ['updateActivityRailPins', ['source-control', 'search', 'webhooks', 'studio']],
      ['updateActivityRailPins', ['sessions'], true],
      ['updateActivityRailPins', ['agents'], false],
      ['updateActivityRailPins', ['nope']],
      ['updateActivityRailPins', ['sessions', 7]],
      ['updateActivityRailPins', 'sessions'],
      ['updateActivityRailPins', null],
      ['updateActivityRailPins', {}],
      ['updateActivityRailPins', ['agents'], 'yes'],
      ['updateActivityRailPins', ['agents'], 1],
      ['updateActivityRailPins', ['agents'], null],
    ],
  },
  markdown: {
    seed: VALUES_SEED,
    steps: [
      ['writeMarkdownDefaultView', 'rich'],
      ['writeMarkdownDefaultView', 'source'],
      ['writeMarkdownDefaultView', 'preview'],
      ['writeMarkdownDefaultView', 'bogus'],
      ['writeMarkdownDefaultView', null],
      ['writeMarkdownDefaultView', 7],
      ['writeMarkdownDefaultView', ''],
      ['writeMarkdownDefaultView', 'Rich'],
      ['writeMarkdownDefaultView', ['rich']],
      ['writeMarkdownDefaultView', { view: 'rich' }],
    ],
  },
  // Saved values equal to their defaults, stored values of the wrong type, and the first pins write.
  stored: {
    seed: { ...BASE, desktop: { defaultsSeparationVersion: 1, notificationVolume: '50', sessionAutoArchiveDays: 5, sessionAutoDeleteDays: '7', activityRailPins: 'x', browserPermissions: 7 } },
    steps: [
      ['setNotificationVolume', 100],
      ['setSessionRetention', 'sessionAutoArchiveDays', 7],
      ['setSessionRetention', 'sessionAutoDeleteDays', 90],
      ['updateActivityRailPins', ['agents'], true],
      ['setBrowserPermissions', { sites: [SITE] }],
      ['setBrowserPermissions', {}],
      ['updateActivityRailPins', ALL_PINS],
    ],
  },
  pins: {
    seed: { ...BASE, desktop: MARKED },
    steps: [
      ['updateActivityRailPins', ['agents'], true],
      ['updateActivityRailPins', ['sessions'], true],
      ['updateActivityRailPins', ALL_PINS, true],
      ['updateActivityRailPins', ALL_PINS, true],
    ],
  },
};
if (ONLY !== null && !GROUPS[ONLY]) throw new Error(`--only takes one of ${Object.keys(GROUPS).join(', ')}, not ${ONLY}`);
const groups = ONLY ? [ONLY] : Object.keys(GROUPS);
const SEED_TEXT = (seed) => `${JSON.stringify(seed, null, 2)}\n`;

/** The window of the handlers: what the zoom handler asks of it. */
function fakeWindow(log) {
  const webContents = {
    setZoomFactor: (factor) => log.push(['setZoomFactor', factor]),
    send: (channel, value) => log.push(['send', channel, clone(value)]),
    on() {},
    removeListener() {},
  };
  return { webContents, isDestroyed: () => false, setTitleBarOverlay: () => log.push(['setTitleBarOverlay']) };
}

const problem = (error) => ({ error: { name: error?.name ?? null, message: String(error?.message ?? error), ...(typeof error?.code === 'string' ? { code: error.code } : {}) } });

/** One call through the window's registered handler (or the operation the file-dialog handler makes); the answer or the error. */
async function call(driver, step) {
  const [channel, ...rest] = step;
  try {
    if (channel === 'writeMarkdownDefaultView') return { ok: clone(await driver.invoke('writeMarkdownDefaultView', [driver.userData, ...rest])) };
    return { ok: clone(await driver.ipc(channel, rest)) };
  } catch (error) {
    return problem(error);
  }
}

/** The window's handlers over `invokeDesktopOperation`; `settingsStore` is the Node local connection's (absent on a core connection). */
async function registerHandlers(driverState, { invoke, settingsStore, DESKTOP_IPC, registerWindowSettingsIpc, writesAnnounceThemselves = false }) {
  const handlers = new Map();
  const windowLog = [];
  const changed = [];
  registerWindowSettingsIpc({
    window: fakeWindow(windowLog),
    app: { quit() {} },
    host: { invokeCapability: async () => ({}), readCapabilities: async () => ({}), getSnapshot: () => null },
    handle: (channel, listener) => handlers.set(channel, listener),
    invokeDesktopOperation: invoke,
    ...(settingsStore ? { settingsStore } : {}),
    onDesktopSettingsChanged: (settings) => changed.push(clone(settings)),
    // Set by ipc.ts for a core connection (`Boolean(protocol)`); the Node local connection announces after its handler.
    writesAnnounceThemselves,
  });
  driverState.windowLog = windowLog;
  driverState.changed = changed;
  driverState.ipc = (channel, rest) => {
    const handler = handlers.get(DESKTOP_IPC[channel]);
    if (!handler) throw new Error(`no handler for ${channel}`);
    return handler({}, ...rest);
  };
}

const sameJson = (a, b) => isDeepStrictEqual(clone(a), clone(b));

/** The snapshots the config writer left (backups/user-data/<scope>/<time>-<number>-<kind>): their kinds, sorted; the time, the
 *  number (one counter for the whole process) and the scope's name depend on the run. */
function backupKinds(home) {
  const base = join(home, 'backups', 'user-data');
  if (!existsSync(base)) return [];
  return readdirSync(base)
    .flatMap((scope) => readdirSync(join(base, scope)))
    .map((name) => name.replace(/^\d{4}-\d\d-\d\dT[\d-]+Z-\d+-/, ''))
    .sort();
}

/** The kinds in `after` that `before` lacks (a multiset difference): what one call wrote. */
function addedKinds(before, after) {
  const left = [...before];
  return after.filter((kind) => {
    const at = left.indexOf(kind);
    if (at < 0) return true;
    left.splice(at, 1);
    return false;
  });
}

/** The core keeps Node's notification-preferences.json as the `notifications` subtree of its config, last in the file; the replay
 *  seeds it and takes it out, so the rest is compared as bytes. */
const withoutNotifications = (text) => (text === null ? null : text.replace(/,\n  "notifications": \{[\s\S]*?\n  \}(?=,\n|\n\})/, ''));

if (REPLAY) process.exit(await replay(REPLAY));

// ── Node's desktop ──
const tree = resolveTree(args);
const identity = exactProductIdentity(tree, REF);
const main = (name) => importFrom(tree, `apps/desktop/src/main/${name}.ts`);
const config = await importFrom(tree, 'src/runtime/shared/config.mjs');
const { DESKTOP_IPC } = await importFrom(tree, 'apps/desktop/src/shared/contract.ts');
const { registerWindowSettingsIpc } = await main('ipc-window-settings');
const { createDesktopOperations } = await main('desktop-operations');
const { watchAgentSettings } = await main('agent-settings-watch');
const { watchConfiguredOrchestrationMode } = await main('orchestration-mode-watch');

const cases = [];
for (const group of groups) {
  const root = join(WORK, 'node', group);
  rmSync(root, { recursive: true, force: true });
  const DATA = join(root, 'data');
  const USER_DATA = join(root, 'userdata');
  for (const dir of [DATA, USER_DATA, join(root, 'home')]) mkdirSync(dir, { recursive: true });
  Object.assign(process.env, { MIXDOG_HOME: join(root, 'home'), MIXDOG_DATA_DIR: DATA });
  const file = join(DATA, 'mixdog-config.json');
  const { seed, steps } = GROUPS[group];
  if (seed !== null) writeFileSync(file, SEED_TEXT(seed));
  // Every in-process config write starts one forced change pass (config.mjs notifyConfigChanged, a trailing 100 ms debounce):
  // the watches hear it after the call answered. The pass is run once the call settled, for every call that wrote.
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
  let events = [];
  const publish = (name, value) => events.push({ name, value: clone(value) });
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
  const driver = { userData: USER_DATA, invoke: (name, operationArgs) => operations.invoke(name, operationArgs) };
  await registerHandlers(driver, { invoke: driver.invoke, settingsStore: operations.settingsStore, DESKTOP_IPC, registerWindowSettingsIpc });
  for (const step of steps) {
    events = [];
    driver.windowLog.length = 0;
    driver.changed.length = 0;
    const writes = configWrites;
    const snapshotsBefore = backupKinds(join(root, 'home'));
    const outcome = await call(driver, step);
    // The notification the handler sends once the write answered is a floating promise: it settles before the pass runs.
    await new Promise((settled) => setImmediate(settled));
    if (configWrites !== writes) for (const listener of [...passListeners]) listener();
    cases.push({
      group,
      step: clone(step),
      outcome,
      events: clone(events),
      window: clone(driver.windowLog),
      changed: clone(driver.changed),
      files: { config: existsSync(file) ? readFileSync(file, 'utf8') : null, snapshots: addedKinds(snapshotsBefore, backupKinds(join(root, 'home'))) },
      second: { settings: clone(await operations.settingsStore.read()), pins: clone(await operations.settingsStore.readActivityRailPins()) },
    });
  }
  await operations.dispose?.();
}

if (ONLY) {
  const text = `${JSON.stringify(cases, null, 2)}\n`;
  await new Promise((written, failed) => process.stdout.write(text, (error) => (error ? failed(error) : written())));
  process.exit(0);
}
const stage = stageSet(FIXTURES);
writeJson(join(stage, 'golden.json'), {
  note: 'Node desktop (b6f10295a): per settings write the answer or error, mixdog-config.json as text, the desktop events every attached client received, the calls the window was made, what the change hook was given, and what a second client reads afterwards.',
  seeds: Object.fromEntries(groups.map((group) => [group, GROUPS[group].seed])),
  cases,
});
writeSetManifest(stage, {
  set: 'desktop-setting-writes',
  recorder: RECORDER,
  command: `node --import apps/desktop/scripts/test-env.mjs --import apps/desktop/scripts/test-tsx.mjs ${RECORDER} --tree <git archive of ${REF} with node_modules>`,
  identity,
  extra: {
    cases: cases.length,
    ...recorderProvenance(import.meta.url),
    entry: {
      runs: 'registerWindowSettingsIpc (ipc-window-settings.ts) with the settings store of createDesktopOperations over config.mjs (the local connection), and the operations writeMarkdownDefaultView and updateActivityRailPins of createDesktopOperations',
      notRun: "the Electron window (a stand-in answers the zoom calls), config.mjs's own debounce timer and file watch (the forced pass an in-process write starts is run when the call settled), and the notification store",
    },
    exclusions: {
      markdownDefaultViewFile: "Node keeps the Markdown default view in <userData>/User/settings.json (a JSONC structural edit); the core keeps it as the config key desktop.editor.markdownDefaultView (editorcfg.rs user scope). For this call the replay compares the answer, the events and what a second client reads, and that the view the core stored is the one Node answered; the config bytes and snapshots are not compared",
      errorName: "a refusal is compared by its message: the window's handler rethrows the error and Electron hands the page the text; Node's class (TypeError, RangeError for the 300-site limit) is not kept across a core connection",
      notificationsSubtree: "the core keeps Node's notification-preferences.json as the `notifications` subtree of mixdog-config.json; the replay seeds it (last key) and takes it out of the bytes it compares",
      snapshots: "the snapshot kinds each call wrote (backups/user-data), as a multiset: the file names carry the time, one process-wide counter and the scope's hash",
      activityRailPinsEvent: "Node raised 'activity-rail-pins-changed' from its operation; on a core connection the pins reach a client as the config section it reads (`readActivityRailPins`), so the replay compares what the second client reads, not that event",
    },
  },
});
commitStage(stage, FIXTURES);
console.log(`desktop-setting-writes: ${cases.length} cases`);
process.exit(0);

// ── the replay: the window's handlers over the desktop's operation lane and a built core ──
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
  const provenance = recorderProvenance(import.meta.url);
  if (!isDeepStrictEqual(manifest.inputs, provenance.inputs) || manifest.recorderSha256 !== provenance.recorderSha256) {
    throw new Error('the recording was made by another recorder than this one: record again before comparing');
  }
  const { DESKTOP_IPC } = await here('apps/desktop/src/shared/contract.ts');
  const { registerWindowSettingsIpc } = await here('apps/desktop/src/main/ipc-window-settings.ts');
  const { parseDiscovery } = await here('apps/desktop/src/main/protocol/discovery.ts');
  const { connect, sessionReducer } = await here('packages/protocol-client/src/index.ts');
  const { createWsConnector } = await here('apps/desktop/src/main/protocol/ws-connector.ts');
  const { createProtocolConnection } = await here('apps/desktop/src/main/protocol/connection.ts');
  const { createOperationLane, watchAnnouncements } = await here('apps/desktop/src/main/protocol/desktop-operation-route.ts');
  const differences = [];
  let compared = 0;
  for (const group of groups) {
    const root = join(WORK, 'core', group);
    rmSync(root, { recursive: true, force: true });
    for (const dir of ['runtime', 'data', 'home', 'config']) mkdirSync(join(root, dir), { recursive: true });
    const { seed } = GROUPS[group];
    const configFile = join(root, 'data', 'mixdog-config.json');
    if (seed !== null) writeFileSync(configFile, SEED_TEXT({ ...seed, notifications: { migratedAt: 1, devices: {}, overrides: [] } }));
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (key.startsWith('MIXDOG_')) delete env[key];
    Object.assign(env, { MIXDOG_RUNTIME_ROOT: join(root, 'runtime'), MIXDOG_DATA_DIR: join(root, 'data'), MIXDOG_HOME: join(root, 'home'), MIXDOG_CONFIG_DIR: join(root, 'config') });
    const runtimeManifest = join(exe, '..', 'js-runtime.json');
    if (!existsSync(runtimeManifest)) writeFileSync(runtimeManifest, JSON.stringify({ program: process.execPath, packageRoot: REPO_ROOT }));
    const child = spawn(exe, ['serve'], { env, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    let stderr = '';
    child.stderr.on('data', (chunk) => (stderr += chunk));
    const clients = [];
    try {
      const endpoint = await discovered(child, join(root, 'runtime'), parseDiscovery, () => stderr);
      const base = {
        target: { id: 'core' },
        connector: createWsConnector(async () => endpoint),
        clientInfo: { name: 'mixdog-replay-window', title: 'Mixdog', version: '1.4.5', kind: 'desktop' },
        capabilities: { optOutNotificationMethods: [], experimentalApi: false },
        threadReducer: sessionReducer,
        clock: { sleep: () => Promise.reject(new Error('the replay dropped its connection')) },
        random: Math.random,
      };
      const window = await connect({ ...base, capabilities: { ...base.capabilities, host: { browser: false, visualize: false, notifications: false, systemProxy: false, power: false, media: false, updater: false, files: false } } });
      clients.push(window);
      await window.call('host/claim', { hostId: 'replay-window' });
      const secondClient = await connect({ ...base, clientInfo: { ...base.clientInfo, name: 'mixdog-replay-second' } });
      clients.push(secondClient);
      const attach = async (client) => {
        const protocol = createProtocolConnection({ open: async () => client });
        const heard = [];
        watchAnnouncements(protocol, (name, value) => heard.push({ name, value: clone(value) }));
        await protocol.start();
        return { protocol, heard, lane: createOperationLane({ protocol }) };
      };
      const desktop = await attach(window);
      const second = await attach(secondClient);
      // The end of a case at each client: a mark the window publishes after the call answered; the feed is one ordered stream.
      let marks = 0;
      const holdsMark = (client, mark) => isDeepStrictEqual(client.store.section('hostState', 'browserTabs')?.value, { replayMark: mark });
      const untilMarked = (client, mark, label) =>
        new Promise((resolve, reject) => {
          if (holdsMark(client, mark)) return resolve();
          const timer = setTimeout(() => {
            off();
            reject(new Error(`${label}: the end-of-case mark ${mark} did not reach the client within 30 s`));
          }, 30_000);
          const off = client.store.subscribe(() => {
            if (!holdsMark(client, mark)) return;
            clearTimeout(timer);
            off();
            resolve();
          });
        });
      const caseEnd = async (label) => {
        const mark = ++marks;
        await window.call('host/state/set', { key: 'browserTabs', value: { replayMark: mark } });
        await Promise.all([window, secondClient].map((client) => untilMarked(client, mark, label)));
      };
      const driver = { userData: join(root, 'userdata'), invoke: (name, operationArgs) => desktop.lane.invoke(name, operationArgs) };
      await registerHandlers(driver, { invoke: driver.invoke, settingsStore: undefined, DESKTOP_IPC, registerWindowSettingsIpc, writesAnnounceThemselves: true });
      const wanted = golden.cases.filter((entry) => entry.group === group);
      for (const [index, expected] of wanted.entries()) {
        desktop.heard.length = 0;
        second.heard.length = 0;
        driver.windowLog.length = 0;
        driver.changed.length = 0;
        const snapshotsBefore = backupKinds(join(root, 'home'));
        const outcome = await call(driver, expected.step);
        const label = `${group} #${index} ${JSON.stringify(expected.step).slice(0, 100)}`;
        await caseEnd(label);
        const got = {
          outcome,
          events: clone(desktop.heard),
          window: clone(driver.windowLog),
          changed: clone(driver.changed),
          files: { config: existsSync(configFile) ? withoutNotifications(readFileSync(configFile, 'utf8')) : null, snapshots: addedKinds(snapshotsBefore, backupKinds(join(root, 'home'))) },
          second: { settings: clone(await second.lane.invoke('readSettings', [])), pins: clone(await second.lane.invoke('readActivityRailPins', [])) },
        };
        // Declared in the manifest (exclusions.activityRailPinsEvent): the pins reach a core client as a config section.
        const events = expected.events.filter((event) => event.name !== 'activity-rail-pins-changed');
        // Declared in the manifest (exclusions.errorName): the window gets the message; Node's class (TypeError, RangeError) is not kept.
        const messageOf = (result) => (result.error ? { error: { message: result.error.message } } : result);
        got.outcome = messageOf(got.outcome);
        const node = { outcome: messageOf(expected.outcome), events, window: expected.window, changed: expected.changed, files: expected.files, second: expected.second };
        got['events.secondClient'] = clone(second.heard);
        node['events.secondClient'] = events;
        // Declared in the manifest (exclusions.markdownDefaultViewFile): Node's view is in another file, so the config's bytes are not
        // compared; the view the core stored must be the one Node answered.
        if (expected.step[0] === 'writeMarkdownDefaultView') {
          const stored = JSON.parse(got.files.config ?? '{}').desktop?.editor?.markdownDefaultView;
          got.files = { markdownDefaultView: stored ?? null };
          node.files = { markdownDefaultView: expected.outcome.ok };
        }
        compared += 1;
        for (const field of Object.keys(node)) {
          if (!sameJson(node[field], got[field])) differences.push({ label, field, node: node[field], core: got[field] });
        }
      }
    } finally {
      for (const client of clients) client.close?.();
      spawnSync('taskkill', ['/T', '/F', '/PID', String(child.pid)], { stdio: 'ignore', windowsHide: true, timeout: 30_000 });
    }
  }
  if (args.get('diff-out')) writeFileSync(args.get('diff-out'), JSON.stringify(differences));
  console.log(`desktop-setting-writes replay over ${exe}: ${compared} cases compared, ${differences.length} fields differ`);
  for (const entry of differences) {
    console.log(`DIFF ${entry.label} ${entry.field}`);
    console.log(`   node: ${JSON.stringify(entry.node).slice(0, 700)}`);
    console.log(`   core: ${JSON.stringify(entry.core).slice(0, 700)}`);
  }
  return differences.length ? 1 : 0;
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
