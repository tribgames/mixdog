#!/usr/bin/env node
// Golden twin of the desktop's one-time `desktop` section separation, `DesktopSettingsStore.separateDefaults`
// (apps/desktop/src/main/settings-store.ts), which the daemon takes over at K1: `mixdog-core-config`
// `config/desktop_separation.rs`.
//
// Each case is a config file as an older or current install left it. Node's real functions run in Node's order:
// the daemon's boot (`loadConfig`, whose `ensureDefaultsSeparated` is the core pass), then the desktop's
// `separateDefaults` at app-ready, then `separateDefaults` once more (the version gate). The fixture keeps the file after
// each step, the backup folders each step made and what `separateDefaults` returned. The desktop store is the real
// TypeScript module, loaded through the tsx of the tree. Every folder is a fresh temp one before any Mixdog module is
// imported.
//
//   node benchmarks/rust-core/recorders/record-desktop-separation.mjs --tree <git checkout at --commit, with node_modules> --commit <40-hex>
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { FIXTURES_ROOT, commitCheckoutIdentity, commitStage, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

const cli = parseArgs();
const tree = resolveTree(cli);
const commit = cli.get('commit');
if (!commit) throw new Error('--commit <40-hex> is required');
const identity = commitCheckoutIdentity(tree, commit);
const outDir = cli.get('out') ?? join(FIXTURES_ROOT, 'desktop-separation');
const stage = stageSet(outDir);

const work = mkdtempSync(join(tmpdir(), 'desktop-separation-'));
const dir = (name) => {
  const path = join(work, name);
  mkdirSync(path, { recursive: true });
  return path;
};
const home = dir('home');
process.env.MIXDOG_HOME = home;
process.env.MIXDOG_BACKUP_DIR = dir('backup');
process.env.MIXDOG_SKIP_USER_DATA_BACKUP = '1';
process.env.MIXDOG_CONFIG_READ_TTL_MS = '0';
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.APPDATA = dir('appdata');
process.env.LOCALAPPDATA = dir('localappdata');
for (const name of Object.keys(process.env)) if (/^ANTHROPIC_DEFAULT_.*_MODEL$/.test(name)) delete process.env[name];

const { loadConfig } = await importFrom(tree, 'src/runtime/agent/orchestrator/config.mjs');
const { tsImport } = await import(pathToFileURL(join(tree, 'apps', 'desktop', 'node_modules', 'tsx', 'dist', 'esm', 'api', 'index.mjs')).href);
const { DesktopSettingsStore } = await tsImport(pathToFileURL(join(tree, 'apps', 'desktop', 'src', 'main', 'settings-store.ts')).href, import.meta.url);
const store = new DesktopSettingsStore({ appPath: join(tree, 'apps', 'desktop') });

const ALL_DEFAULTS = { keepAwake: true, runInBackground: true, usagePinned: true, usageRailShortLong: false, usageAccountsExpanded: false, usageRailSlotsThree: false, usageRailSlotsAll: false, computerControl: false, computerObserveOnly: false, browserControl: false, browserAutoSignIn: true, browserHidDevices: false, saveChatLogins: true };
const FLIPPED = Object.fromEntries(Object.entries(ALL_DEFAULTS).map(([key, value]) => [key, !value]));
const SEVEN = ['sessions', 'agents', 'schedules', 'workflows', 'projects', 'extensions', 'skills'];
const route = { provider: 'openai', model: 'gpt-x' };
const json = (root) => JSON.stringify(root, null, 2);
const desktop = (value, rest = {}) => ({ ...rest, desktop: value, defaultsVersion: 2 });

const CASES = [
  { name: 'defaults-present', text: json(desktop({ ...ALL_DEFAULTS, computerInstalled: false, browserInstalled: false, notificationVolume: 50, sessionAutoArchiveDays: 30 }, { agent: { providers: { openai: { enabled: true } } } })) },
  { name: 'non-defaults', text: json(desktop({ ...FLIPPED, computerInstalled: true, browserInstalled: true, notificationVolume: 0, browserPermissions: { camera: 'deny' } })) },
  { name: 'mixed-with-dead-keys', text: json(desktop({ keepAwake: true, zoomFactor: 1.25, runInBackground: false, git: { token: 'x' }, usagePinned: true, other: { nested: [1, 2] }, computerControl: true, browserControl: false })) },
  { name: 'dead-keys-only', text: json(desktop({ zoomFactor: 1, git: {} })) },
  { name: 'already-separated', text: json(desktop({ keepAwake: true, defaultsSeparationVersion: 1, zoomFactor: 1 })) },
  { name: 'newer-version', text: json(desktop({ keepAwake: false, runInBackground: true, defaultsSeparationVersion: 2 })) },
  { name: 'marker-float', text: json(desktop({ keepAwake: true, defaultsSeparationVersion: 1.5 })) },
  { name: 'marker-zero', text: json(desktop({ defaultsSeparationVersion: 0, keepAwake: true, runInBackground: false })) },
  { name: 'marker-string', text: json(desktop({ keepAwake: true, defaultsSeparationVersion: '1', usagePinned: false })) },
  { name: 'marker-null', text: json(desktop({ keepAwake: true, defaultsSeparationVersion: null })) },
  { name: 'marker-true', text: json(desktop({ defaultsSeparationVersion: true, saveChatLogins: true })) },
  { name: 'marker-negative', text: json(desktop({ defaultsSeparationVersion: -1, browserAutoSignIn: true })) },
  { name: 'no-desktop-section', text: json({ defaultsVersion: 2, agent: { providers: { openai: { enabled: true } } } }) },
  { name: 'no-desktop-section-unmarked', text: json({ agent: { providers: { openai: { enabled: true } } } }) },
  { name: 'desktop-string', text: json(desktop('compact')) },
  { name: 'desktop-array', text: json(desktop([{ keepAwake: true }])) },
  { name: 'desktop-null', text: json(desktop(null)) },
  { name: 'desktop-empty', text: json(desktop({})) },
  { name: 'malformed-values', text: json(desktop({ keepAwake: 'true', runInBackground: 1, usagePinned: null, usageRailShortLong: 0, usageAccountsExpanded: 'false', usageRailSlotsThree: [], usageRailSlotsAll: {}, computerControl: 'no', computerObserveOnly: 0, browserControl: null, browserAutoSignIn: 1, browserHidDevices: '', saveChatLogins: 'yes', zoomFactor: 'big', git: 'x' })) },
  { name: 'pins-default-list', text: json(desktop({ activityRailPins: { pins: SEVEN, revision: 4 }, keepAwake: true })) },
  { name: 'pins-first-historical-list', text: json(desktop({ activityRailPins: { pins: ['sessions', 'agents', 'schedules', 'workflows', 'projects'], revision: 1 } })) },
  { name: 'pins-second-historical-list', text: json(desktop({ activityRailPins: { pins: ['sessions', 'agents', 'schedules', 'workflows', 'projects', 'extensions'] } })) },
  { name: 'pins-custom-list', text: json(desktop({ activityRailPins: { pins: ['agents', 'sessions'], revision: 2 } })) },
  { name: 'pins-reordered-default', text: json(desktop({ activityRailPins: { pins: [...SEVEN].reverse(), revision: 2 } })) },
  { name: 'pins-default-plus-one', text: json(desktop({ activityRailPins: { pins: [...SEVEN, 'search'], revision: 2 } })) },
  { name: 'pins-revision-only', text: json(desktop({ activityRailPins: { revision: 3 } })) },
  { name: 'pins-not-a-list', text: json(desktop({ activityRailPins: { pins: 'sessions', revision: 3 } })) },
  { name: 'pins-not-an-object', text: json(desktop({ activityRailPins: SEVEN })) },
  { name: 'pins-non-string-entries', text: json(desktop({ activityRailPins: { pins: [1, 2, 3, 4, 5], revision: 1 } })) },
  { name: 'empty-object-file', text: '{}' },
  { name: 'missing-file', text: null },
  { name: 'unmarked-legacy-with-desktop', text: json({ agent: { disabledAgents: ['worker', 'reviewer', 'custom'], autoClear: { enabled: true, minContextPercent: 10 }, update: { auto: true }, agents: { worker: route, explore: route } }, channels: { webhook: { enabled: true, port: 3333 } }, outputStyle: ' simple ', desktop: { ...ALL_DEFAULTS, zoomFactor: 1, git: {}, keepAwake: true } }) },
  { name: 'unmarked-legacy-no-desktop', text: json({ agent: { disabledAgents: ['worker'], recap: { enabled: true } }, outputStyle: 'simple' }) },
  { name: 'version-one-with-desktop', text: json({ defaultsVersion: 1, agent: { enabledAgents: ['worker'], agents: { debugger: route, mine: route } }, desktop: { keepAwake: true, runInBackground: false } }) },
  { name: 'non-canonical-top-level', text: json(desktop({ keepAwake: true }, { autoClear: { enabled: true }, compaction: { auto: true }, shell: { path: '/bin/zsh' }, mcpServers: { a: {} } })) },
  { name: 'generated-marker', text: json({ _generated: true, defaultsVersion: 2, desktop: { keepAwake: true, runInBackground: false } }) },
  { name: 'key-order', text: json({ zeta: 1, desktop: { b: 1, keepAwake: true, defaultsSeparationVersion: 'old', a: 2, runInBackground: true }, alpha: { x: 1 }, defaultsVersion: 2 }) },
  { name: 'no-desktop-section-other-subtrees', text: json({ defaultsVersion: 2, agent: { providers: { openai: { enabled: true } } }, notifications: { migratedAt: 5 } }) },
  { name: 'byte-order-mark', text: `\uFEFF${json(desktop({ keepAwake: true, runInBackground: false }))}` },
  { name: 'compact-text', text: JSON.stringify(desktop({ keepAwake: true, runInBackground: false, zoomFactor: 2 })) },
  { name: 'unicode-and-numbers', text: json(desktop({ keepAwake: true, label: '한국어 "quote" \\ \u2028', big: 12345678901234567890, small: 1e-7, neg: -0, volume: 1.0 })) },
];

const MASK = /\d{4}-\d{2}-\d{2}T[\d-]+Z/;
const read = (path) => (existsSync(path) ? readFileSync(path, 'utf8') : null);
const backupsOf = (data) => {
  const root = join(data, 'backups');
  return existsSync(root) ? readdirSync(root).sort().map((name) => ({ folder: name, name: name.replace(MASK, '<iso>'), text: read(join(root, name, 'mixdog-config.json')) })) : [];
};

const results = [];
for (const [index, item] of CASES.entries()) {
  const data = dir(`data-${index}`);
  process.env.MIXDOG_DATA_DIR = data;
  const file = join(data, 'mixdog-config.json');
  if (item.text !== null) writeFileSync(file, item.text);
  loadConfig({ secrets: false });
  const afterCore = read(file);
  const coreBackups = backupsOf(data);
  // The desktop asks later than the daemon: a later instant, so the two folders never share a name.
  const first = await store.separateDefaults(data, new Date(Date.now() + 60_000));
  const afterDesktop = read(file);
  const allBackups = backupsOf(data);
  const second = await store.separateDefaults(data, new Date(Date.now() + 120_000));
  results.push({
    name: item.name,
    inputText: item.text,
    afterCore,
    ran: [first, second],
    final: afterDesktop,
    finalAfterSecond: read(file),
    backups: allBackups.map(({ folder, name, text }) => ({ source: coreBackups.some((made) => made.folder === folder) ? 'core' : 'desktop', name, text })),
    backupsAfterSecond: backupsOf(data).length,
  });
}

// A separation that fails: the backup folder cannot be made (`<data>/backups` is a file). At app-ready the desktop's
// `index.ts` catches it and writes `defaults-separation-failed` to its diagnostics log (`createDesktopDiagnostics`), then
// goes on; nothing is saved, so the marker stays unset and the next start retries. The line is written by the real
// diagnostics module with a fixed clock and context; a later start (the file removed) is recorded too.
const { createDesktopDiagnostics } = await tsImport(pathToFileURL(join(tree, 'apps', 'desktop', 'src', 'main', 'desktop-diagnostics.ts')).href, import.meta.url);
const FAILING = [
  { name: 'backup-root-is-a-file', text: json(desktop({ keepAwake: true, runInBackground: false, zoomFactor: 1, git: {} }, { agent: { providers: { openai: { enabled: true } } } })) },
  { name: 'backup-root-is-a-file-no-desktop-section', text: json({ defaultsVersion: 2, agent: { providers: { openai: { enabled: true } } } }) },
];
const portable = (text, data) => text.split(`${data}\\`).join('<data>/').split(`${data}/`).join('<data>/');
const failures = [];
for (const [index, item] of FAILING.entries()) {
  const data = dir(`data-failing-${index}`);
  process.env.MIXDOG_DATA_DIR = data;
  const file = join(data, 'mixdog-config.json');
  writeFileSync(file, item.text);
  loadConfig({ secrets: false });
  const afterCore = read(file);
  writeFileSync(join(data, 'backups'), 'not a directory');
  let thrown = null;
  try {
    await store.separateDefaults(data, new Date(Date.now() + 60_000));
  } catch (error) {
    thrown = error;
  }
  if (!thrown) throw new Error(`${item.name}: the separation did not fail`);
  // What `index.ts` does with it.
  const message = thrown instanceof Error ? thrown.message : String(thrown);
  const logFile = join(data, 'logs', 'desktop-diagnostics.jsonl');
  const log = createDesktopDiagnostics(logFile, { appVersion: '1.4.5', packaged: true, bootId: 'boot', platform: 'win32', arch: 'x64', pid: 4242 }, { now: () => new Date(Date.UTC(2026, 0, 2, 3, 4, 5, 678)) });
  log.write('defaults-separation-failed', { message });
  await log.flush();
  const written = JSON.parse(read(logFile));
  written.message = portable(written.message, data);
  const line = `${JSON.stringify(written)}\n`;
  const afterFailure = read(file);
  rmSync(join(data, 'backups'));
  const retried = await store.separateDefaults(data, new Date(Date.now() + 120_000));
  failures.push({
    name: item.name,
    inputText: item.text,
    afterCore,
    error: { name: thrown.name, code: thrown.code ?? null, message: portable(message, data) },
    diagnosticLine: line,
    afterFailure,
    retried,
    afterRetry: read(file),
    backupsAfterRetry: backupsOf(data).map(({ name, text }) => ({ name, text })),
  });
}

writeJson(join(stage, 'twin.json'), { cases: results, failures });
writeSetManifest(stage, {
  set: 'desktop-separation',
  recorder: 'benchmarks/rust-core/recorders/record-desktop-separation.mjs',
  command: `node benchmarks/rust-core/recorders/record-desktop-separation.mjs --tree <git checkout of ${commit}> --commit ${commit}`,
  identity,
});
commitStage(stage, outDir);
rmSync(work, { recursive: true, force: true });
console.log(`desktop-separation: ${results.length} cases -> ${outDir}`);
