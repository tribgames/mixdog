#!/usr/bin/env node
// Golden twin of what the desktop's settings writes threw and returned in Node (`DesktopSettingsStore`,
// apps/desktop/src/main/settings-store.ts): the exact thrown class and message of the three refused writes
// (site-permission limit, pin revision exhausted, automatic cookie import) and the saved config the locked
// `updateConfigAsync` returned for a successful write. The Rust `config/value/write` must answer the same text
// and carry the same saved config in its reply.
//
//   node --experimental-transform-types --import benchmarks/rust-core/recorders/lib/ts-register.mjs \
//        benchmarks/rust-core/recorders/record-desktop-write-errors.mjs --tree <dir>
import { join } from 'node:path';
import { FIXTURES_ROOT, importFrom, parseArgs, refreshSetManifest, resolveTree, writeJson } from './lib/common.mjs';

const tree = resolveTree(parseArgs());
const { DesktopSettingsStore, desktopSettingsFromConfig } = await importFrom(tree, 'apps/desktop/src/main/settings-store.ts');

const sites = (count) => Array.from({ length: count }, (_, i) => ({ origin: `https://s${i}.example.com`, permission: 'notifications', setting: 'allow' }));
const policy = (count) => ({ defaults: {}, sites: sites(count) });
const base = { defaultsVersion: 2 };
const withDesktop = (desktop) => ({ ...base, desktop });
const MAX_SAFE = Number.MAX_SAFE_INTEGER;

const CASES = [
  { name: 'permissions-301-sites', config: base, op: 'updateBrowserPermissions', args: [policy(301)] },
  { name: 'permissions-300-sites', config: base, op: 'updateBrowserPermissions', args: [policy(300)] },
  { name: 'permissions-shrink-past-limit', config: withDesktop({ browserPermissions: policy(305) }), op: 'updateBrowserPermissions', args: [policy(303)] },
  { name: 'permissions-grow-past-limit', config: withDesktop({ browserPermissions: policy(305) }), op: 'updateBrowserPermissions', args: [policy(306)] },
  { name: 'pins-revision-exhausted', config: withDesktop({ activityRailPins: { revision: MAX_SAFE } }), op: 'updateActivityRailPins', args: [['agents'], false] },
  { name: 'pins-revision-last-safe', config: withDesktop({ activityRailPins: { revision: MAX_SAFE - 1 } }), op: 'updateActivityRailPins', args: [['agents'], false] },
  { name: 'pins-initialize-if-missing-exhausted', config: withDesktop({ activityRailPins: { revision: MAX_SAFE } }), op: 'updateActivityRailPins', args: [['agents'], true] },
  { name: 'pins-first-write', config: base, op: 'updateActivityRailPins', args: [['agents', 'sessions'], false] },
  { name: 'cookie-enabled-not-boolean', config: base, op: 'updateBrowserCookieAutoImport', args: [{ enabled: 'yes', profileId: 'Default' }] },
  { name: 'cookie-profile-not-string', config: base, op: 'updateBrowserCookieAutoImport', args: [{ enabled: false, profileId: 5 }] },
  { name: 'cookie-profile-missing', config: base, op: 'updateBrowserCookieAutoImport', args: [{ enabled: true }] },
  { name: 'cookie-profile-too-long', config: base, op: 'updateBrowserCookieAutoImport', args: [{ enabled: false, profileId: 'x'.repeat(121) }] },
  { name: 'cookie-profile-120', config: base, op: 'updateBrowserCookieAutoImport', args: [{ enabled: false, profileId: 'x'.repeat(120) }] },
  { name: 'cookie-too-long-with-separator', config: base, op: 'updateBrowserCookieAutoImport', args: [{ enabled: false, profileId: `${'x'.repeat(120)}/` }] },
  { name: 'cookie-enabled-empty-profile', config: base, op: 'updateBrowserCookieAutoImport', args: [{ enabled: true, profileId: '' }] },
  { name: 'cookie-slash', config: base, op: 'updateBrowserCookieAutoImport', args: [{ enabled: false, profileId: 'a/b' }] },
  { name: 'cookie-backslash', config: base, op: 'updateBrowserCookieAutoImport', args: [{ enabled: true, profileId: 'a\\b' }] },
  { name: 'cookie-off', config: base, op: 'updateBrowserCookieAutoImport', args: [{ enabled: false, profileId: '' }] },
  { name: 'cookie-on', config: base, op: 'updateBrowserCookieAutoImport', args: [{ enabled: true, profileId: 'Profile 1' }] },
  { name: 'flag-saved-config', config: withDesktop({ keepAwake: false }), op: 'update', args: ['keepAwake', true] },
  { name: 'auto-clear-saved-config', config: { ...base, agent: { autoClear: { enabled: true, minContextPercent: 10 } } }, op: 'update', args: ['autoClear', false] },
  { name: 'volume-saved-config', config: base, op: 'updateNotificationVolume', args: [50] },
  { name: 'retention-saved-config', config: base, op: 'updateSessionRetention', args: ['sessionAutoDeleteDays', 30] },
];

const results = [];
for (const item of CASES) {
  let state = structuredClone(item.config);
  const module = {
    readConfig: () => state,
    updateConfigAsync: async (fn) => {
      state = fn(structuredClone(state));
      return state;
    },
  };
  const store = new DesktopSettingsStore({ loadConfig: async () => module });
  let after;
  try {
    const result = await store[item.op](...item.args);
    after = { ok: result ?? null, config: state, settings: desktopSettingsFromConfig(state) };
  } catch (error) {
    after = { error: { name: error?.name ?? null, message: String(error?.message ?? error) }, config: state };
  }
  results.push({ name: item.name, config: item.config, write: { op: item.op, args: item.args }, after });
}

writeJson(join(FIXTURES_ROOT, 'desktop', 'settings', 'write-errors-twin.json'), { domain: 'settings-write-errors-twin', recorder: 'benchmarks/rust-core/recorders/record-desktop-write-errors.mjs', entries: results });
refreshSetManifest(join(FIXTURES_ROOT, 'desktop'), tree);
console.log(`recorded ${results.length} writes`);
