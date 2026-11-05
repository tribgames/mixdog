#!/usr/bin/env node
// DS-CFG-1 golden twin: Node `desktopSettingsFromConfig` and the `DesktopSettingsStore` writes over
// 200 deterministic config files (fake data only). Each entry holds the config, the settings view
// of Node, the retention policy and activity-rail pins it reads, and the outcome of one store write
// (resulting config and view, or the error). The Rust `Config` must reproduce all of it.
//
//   node --experimental-transform-types --import benchmarks/rust-core/recorders/lib/ts-register.mjs \
//        benchmarks/rust-core/recorders/record-desktop-settings.mjs --tree <dir>
import { join } from 'node:path';
import { FIXTURES_ROOT, importFrom, parseArgs, refreshSetManifest, resolveTree, writeJson } from './lib/common.mjs';

const tree = resolveTree(parseArgs());
const { DesktopSettingsStore, desktopSettingsFromConfig } = await importFrom(tree, 'apps/desktop/src/main/settings-store.ts');

let seed = 0x5eed1234;
const rnd = () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const pick = (list) => list[Math.floor(rnd() * list.length)];
const chance = (p) => rnd() < p;
const shuffle = (list) => list.map((v) => [rnd(), v]).sort((a, b) => a[0] - b[0]).map((p) => p[1]);

const FLAGS = ['keepAwake', 'runInBackground', 'usagePinned', 'usageRailShortLong', 'usageAccountsExpanded', 'usageRailSlotsThree', 'usageRailSlotsAll', 'computerControl', 'computerObserveOnly', 'browserControl', 'browserAutoSignIn', 'browserHidDevices', 'saveChatLogins', 'computerInstalled', 'browserInstalled'];
const PIN_IDS = ['sessions', 'agents', 'schedules', 'workflows', 'projects', 'extensions', 'skills', 'source-control', 'search', 'webhooks', 'studio'];
const KINDS = ['notifications', 'geolocation', 'clipboard-write', 'clipboard-read', 'media:video', 'media:audio', 'midi', 'midiSysex', 'idle-detection', 'top-level-storage-access', 'window-management', 'speaker-selection', 'fileSystem'];
const SETTINGS = ['allow', 'ask', 'block'];
const ORIGINS = ['https://example.com', 'https://a.example.org', 'http://localhost:3000', 'https://example.com:443', 'ftp://x.test', 'not a url', 'https://B.example.com', 'https://xn--bcher-kva.example'];
const junk = () => pick([null, 'x', 7, true, [], {}, 3.5, -1]);

const site = () => ({
  origin: pick(ORIGINS),
  ...(chance(0.3) ? { embedder: pick(ORIGINS) } : {}),
  permission: chance(0.9) ? pick(KINDS) : 'bogus',
  setting: chance(0.9) ? pick(SETTINGS) : 'maybe',
});
const policy = () => ({
  ...(chance(0.6) ? { defaults: Object.fromEntries(KINDS.filter(() => chance(0.4)).map((k) => [k, chance(0.9) ? pick(SETTINGS) : junk()])) } : {}),
  ...(chance(0.7) ? { sites: Array.from({ length: Math.floor(rnd() * 5) }, () => (chance(0.9) ? site() : junk())) } : {}),
});
const pins = () => {
  const state = chance(0.5) ? { pins: shuffle(PIN_IDS).slice(0, 1 + Math.floor(rnd() * 8)) } : {};
  if (chance(0.85)) state.revision = 1 + Math.floor(rnd() * 9);
  if (chance(0.1)) state.pins = [...(state.pins ?? []), 'unknown'];
  return state;
};

function makeDesktop() {
  const desktop = {};
  for (const flag of FLAGS) if (chance(0.25)) desktop[flag] = chance(0.85) ? chance(0.5) : junk();
  if (chance(0.3)) desktop.notificationVolume = chance(0.8) ? Math.floor(rnd() * 401) : pick([401, -1, 1.5, '50', null]);
  if (chance(0.3)) desktop.sessionAutoArchiveDays = chance(0.7) ? pick([0, 1, 7, 14, 30, 90]) : pick([5, '7', null, 91]);
  if (chance(0.3)) desktop.sessionAutoDeleteDays = chance(0.7) ? pick([0, 7, 30, 90]) : pick([1, '7', null, 14]);
  if (chance(0.3)) desktop.activityRailPins = pins();
  if (chance(0.3)) desktop.browserPermissions = chance(0.9) ? policy() : junk();
  if (chance(0.15)) desktop.browserCookieAutoImport = { enabled: chance(0.5), profileId: 'Default' };
  if (chance(0.1)) desktop.zoomFactor = 1.25;
  return shuffle(Object.entries(desktop)).reduce((o, [k, v]) => ((o[k] = v), o), {});
}

function makeConfig(i) {
  const config = {};
  if (i % 7 !== 0) config.desktop = i % 11 === 0 ? junk() : makeDesktop();
  if (chance(0.5)) {
    const agent = {};
    if (chance(0.4)) agent.autoClear = chance(0.8) ? { enabled: chance(0.5) } : junk();
    if (chance(0.4)) agent.compaction = chance(0.8) ? { ...(chance(0.5) ? { auto: chance(0.5) } : {}), ...(chance(0.2) ? { enabled: chance(0.5) } : {}), ...(chance(0.3) ? { summaryModel: 'fake-model' } : {}) } : junk();
    config.agent = agent;
  }
  if (chance(0.5)) config.providers = { fakeprovider: { apiKey: 'fake-credential-not-real', accounts: [{ id: 'a1' }] } };
  if (chance(0.3)) config.notifications = { migratedAt: 1, devices: {}, overrides: [] };
  if (chance(0.3)) config.channels = { discord: { token: 'fake-token-not-real' } };
  return Object.fromEntries(shuffle(Object.entries(config)));
}

const WRITES = [
  () => ['update', pick(['autoClear', 'autoCompact', ...FLAGS]), chance(0.5)],
  () => ['updateNotificationVolume', pick([0, 100, 250, 400, 401, 1.5, -1, '5'])],
  () => ['updateSessionRetention', pick(['sessionAutoArchiveDays', 'sessionAutoDeleteDays', 'bogus']), pick([0, 1, 7, 14, 30, 90, 5])],
  () => ['updateBrowserPermissions', policy()],
  () => ['updateActivityRailPins', chance(0.8) ? shuffle(PIN_IDS).slice(0, Math.floor(rnd() * 9)) : pick([['sessions', 'agents', 'schedules', 'workflows', 'projects', 'extensions', 'skills'], ['nope'], 'x']), chance(0.5)],
  () => ['updateZoom', pick([1, 1.25, 'bad'])],
];

const entries = [];
for (let i = 0; i < 200; i += 1) {
  const config = makeConfig(i);
  let write = pick(WRITES)();
  // The legacy-key cleanup of `autoCompact` is the one-time migration's job, not the runtime's.
  if (write[1] === 'autoCompact' && Object.keys(config.agent?.compaction ?? {}).some((k) => k !== 'auto')) write = ['update', 'keepAwake', false];
  if (write[0] === 'updateBrowserPermissions' && (config.desktop?.browserPermissions?.sites?.length ?? 0) > 300) write = ['update', 'keepAwake', false];

  let state = structuredClone(config);
  const module = {
    readConfig: () => state,
    updateConfigAsync: async (fn) => {
      state = fn(structuredClone(state));
      return state;
    },
  };
  const store = new DesktopSettingsStore({ loadConfig: async () => module });
  const expect = {
    settings: desktopSettingsFromConfig(config),
    retention: await store.readSessionRetention(),
    pins: await store.readActivityRailPins(),
    cookieAutoImport: await store.readBrowserCookieAutoImport(),
  };
  let after;
  try {
    const [op, ...args] = write;
    const result = await store[op](...args);
    after = { ok: result ?? null, config: state, settings: desktopSettingsFromConfig(state), pins: await store.readActivityRailPins() };
  } catch (error) {
    after = { error: { name: error?.name ?? null, message: String(error?.message ?? error) } };
  }
  entries.push({ id: i, config, expect, write: { op: write[0], args: write.slice(1) }, after });
}

writeJson(join(FIXTURES_ROOT, 'desktop', 'settings', 'config-twin.json'), { domain: 'settings-config-twin', recorder: 'benchmarks/rust-core/recorders/record-desktop-settings.mjs', entries });
refreshSetManifest(join(FIXTURES_ROOT, 'desktop'), tree);
console.log(`recorded ${entries.length} configs`);
