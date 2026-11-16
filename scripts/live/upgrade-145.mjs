#!/usr/bin/env node
// Upgrade check: a packaged (unpacked or installed) Mixdog started on a 1.4.5-shaped profile.
//   node scripts/live/upgrade-145.mjs --app=<unpacked dir or Mixdog executable> --profile-vector=<dir> [--out=<dir>] [--iso-root=<dir>] [--backup-enabled] [--restart] [--keep]
//
// The vector directory holds `profile/` (the 1.4.5 Electron userData files), optionally `.mixdog/` (a 1.4.5 MIXDOG_HOME:
// `data/`, `projects.json`; the recorded one is native/core/fixtures/migration-145/.mixdog) and optionally `expect.json`:
//   { "projects": [<path>], "sshHosts": [<id>], "remoteHosts": [<id>], "notifications": true | {<key>: <value>}, "owedRevokes": [<key>] }
// With no explicit expectations, SSH ids and the saved-PC consumer's URL-derived ids/alias view come from the profile files. Both
// folders are copied under an isolated root (the vector is never written), the app is started on them with
// MIXDOG_DESKTOP_USER_DATA, and once the core serves the run asserts the migration markers (complete.json,
// profile-gen.json at the candidate's generation) and reads projects, SSH hosts, paired PCs, notification preferences and owed revokes
// back through core methods. Exits 0 when every check passes.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';

import { attachCore, isolatedEnv, isolatedPaths } from '../rust-core/lib/core-session.mjs';
import { endTree, spawnTree } from '../rust-core/lib/process-tree.mjs';
import { parseLiveArgs } from './lib/paths.mjs';

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
// The harness runs from the candidate checkout: keep the expected on-disk generation tied to its actual migrator.
export const GENERATION = Number(readFileSync(new URL('../../native/core/crates/mixdog-migrate/src/desktop_profile/supplement.rs', import.meta.url), 'utf8').match(/pub const GENERATION: u32 = (\d+);/)?.[1]);
if (!Number.isSafeInteger(GENERATION)) throw new Error('candidate profile migration generation is unavailable');
const MARKER_WAIT_MS = 120_000;

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
let desktopReader;
async function effectiveDesktopSettings(config) {
  // Use the same consumer as desktop readSettings, including its default semantics.
  desktopReader ??= (async () => {
    const requireDesktop = createRequire(new URL('../../apps/desktop/package.json', import.meta.url));
    const tsxPackage = requireDesktop.resolve('tsx/package.json');
    const api = readJson(tsxPackage).exports['./esm/api'].import.default;
    const { tsImport } = await import(new URL(api, pathToFileURL(tsxPackage)).href);
    return (await tsImport('../../apps/desktop/src/shared/desktop-settings.ts', { parentURL: import.meta.url, tsconfig: false })).desktopSettingsFromConfig;
  })();
  return (await desktopReader)(config);
}

/** The Mixdog executable of an unpacked folder (or the executable itself). */
export function findApp(app, { exists = existsSync, isDir = (p) => statSync(p).isDirectory(), platform = process.platform } = {}) {
  const path = resolve(app);
  if (!exists(path)) throw new Error(`the app does not exist: ${path}`);
  if (!isDir(path)) return path;
  const names = platform === 'win32' ? ['Mixdog.exe'] : platform === 'darwin' ? [join('Contents', 'MacOS', 'Mixdog'), 'Mixdog'] : ['mixdog', 'Mixdog'];
  const found = names.map((name) => join(path, name)).find((candidate) => exists(candidate));
  if (!found) throw new Error(`no Mixdog executable in ${path} (looked for ${names.join(', ')})`);
  return found;
}

/** The saved-host consumer's view (`mixdog-connections/remote_hosts.rs`), never the stored id or a raw URL hash.
 * Invalid automatic expectations are a fixture error before launch. A deliberately malformed-source vector can
 * supply explicit remoteHostRecords instead, to assert the consumer's intended recovery/filtering behavior. */
function expectedRemoteHost(row, index) {
  const invalid = (field) => new Error(`synthetic remote-hosts.json row ${index}: invalid ${field}; provide explicit remoteHostRecords for an intentional malformed-source case`);
  if (!row || typeof row.url !== 'string' || typeof row.name !== 'string') throw invalid('url/name');
  let parsed;
  try { parsed = new URL(row.url.trim()); } catch { throw invalid('pairing URL'); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
  if (!(parsed.protocol === 'https:' || (parsed.protocol === 'http:' && loopback)) || parsed.username || parsed.password) throw invalid('pairing URL');
  const route = /^\/d\/([^/]+)\/?$/i.exec(parsed.pathname);
  const device = route?.[1];
  if (!device || !/^(?:[0-9a-f]{32,64}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.test(device)) throw invalid('device route');
  const url = `${parsed.origin}/d/${device.toLowerCase()}/`;
  const label = (text) => {
    let units = 0, kept = '';
    for (const character of text) {
      units += character.length;
      if (units > 80) break;
      kept += character;
    }
    return kept;
  };
  const alias = typeof row.alias === 'string' ? label(row.alias.trim()) : '';
  return {
    id: createHash('sha256').update(url).digest('hex').slice(0, 16),
    url,
    name: alias || label(row.name),
    // Missing addedAt is assigned by the real reader's clock; do not invent an expected timestamp.
    ...(Number.isFinite(row.addedAt) ? { addedAt: row.addedAt } : {}),
    lastConnectedAt: Number.isFinite(row.lastConnectedAt) ? row.lastConnectedAt : null,
  };
}

/** What the vector directory holds: its profile, its MIXDOG_HOME (or null) and what a start must read back. */
export function loadVector(dir, { exists = existsSync, read = readJson } = {}) {
  const root = resolve(dir);
  const profile = join(root, 'profile');
  if (!exists(profile)) throw new Error(`the vector has no profile/ folder: ${root}`);
  const home = exists(join(root, '.mixdog')) ? join(root, '.mixdog') : null;
  const expect = exists(join(root, 'expect.json')) ? read(join(root, 'expect.json')) : {};
  if (!expect.sshHosts && exists(join(profile, 'ssh-hosts.json'))) expect.sshHosts = read(join(profile, 'ssh-hosts.json')).hosts.map((host) => host.id);
  if (!expect.remoteHosts && !expect.remoteHostRecords && exists(join(profile, 'remote-hosts.json'))) {
    const hosts = read(join(profile, 'remote-hosts.json')).hosts;
    if (!Array.isArray(hosts)) throw new Error('synthetic remote-hosts.json: hosts must be an array to derive expectations');
    expect.remoteHostRecords = hosts.map(expectedRemoteHost);
  }
  if (!expect.restore && exists(join(profile, 'server-windows.json'))) expect.restore = { enabled: read(join(profile, 'server-windows.json')).enabled !== false };
  return { root, profile, home, expect };
}

/** Every migration marker the run requires, each with the reason it fails. */
export function markerProblems(dataDir, read = readJson) {
  const problems = [];
  let complete;
  try {
    complete = read(join(dataDir, 'migration', 'complete.json'));
  } catch (error) {
    problems.push(`migration/complete.json: ${error.message}`);
  }
  const unexpected = (complete?.kinds?.data?.quarantined_unexpected ?? 0) + (complete?.kinds?.desktopProfile?.quarantined_unexpected ?? 0);
  if (complete && unexpected !== 0) problems.push(`complete.json records ${unexpected} unexpectedly quarantined item(s)`);
  try {
    const gen = read(join(dataDir, 'migration', 'profile-gen.json'));
    if (gen.generation !== GENERATION) problems.push(`profile-gen.json is at generation ${gen.generation}, not ${GENERATION}`);
  } catch (error) {
    problems.push(`migration/profile-gen.json: ${error.message}`);
  }
  return problems;
}

/** The expected ids a list of `{id}` rows lacks. */
export const missingIds = (want, rows) => {
  const have = new Set((Array.isArray(rows) ? rows : []).map((row) => row?.id));
  return (want ?? []).filter((id) => !have.has(id));
};

/** Expected keys are compared structurally; the error names the path, never credential/config values. */
export function subsetProblems(actual, expected, path = '') {
  if (expected && typeof expected === 'object' && !Array.isArray(expected)) {
    return Object.entries(expected).flatMap(([key, value]) => subsetProblems(actual?.[key], value, path ? `${path}.${key}` : key));
  }
  return isDeepStrictEqual(actual, expected) ? [] : [path || '<root>'];
}

export function upgradeEnvironment(paths, backupEnabled = false) {
  return isolatedEnv(paths, { MIXDOG_SKIP_USER_DATA_BACKUP: backupEnabled ? '0' : '1', MIXDOG_USER_DATA_BACKUP_ROOT: join(paths.root, 'user-data-backups'), MIXDOG_RELAY_URL: 'off' });
}

export function backupProblems({ manifest, config, dataDir, instanceId, expected = {} }) {
  const problems = [];
  if (typeof manifest?.dataDir !== 'string' || resolve(manifest.dataDir) !== resolve(dataDir)) problems.push('backup dataDir');
  if (!instanceId || manifest?.instanceId !== instanceId) problems.push('backup incarnation');
  if (!manifest?.reason || !manifest?.createdAt) problems.push('backup completion metadata');
  if (!config || typeof config !== 'object') problems.push('backup config');
  else problems.push(...subsetProblems(config, expected).map((key) => `backup config ${key}`));
  return problems;
}

/** Hash only regular synthetic-vector files; a link could otherwise escape the owned copy into a real profile. */
export function vectorDigest(vector) {
  const entries = {};
  const visit = (directory, prefix) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name), relative = `${prefix}/${entry.name}`;
      if (entry.isSymbolicLink()) throw new Error(`profile vector contains a link: ${relative}`);
      if (entry.isDirectory()) visit(path, relative);
      else if (entry.isFile()) entries[relative] = createHash('sha256').update(readFileSync(path)).digest('hex');
      else throw new Error(`profile vector contains a non-file: ${relative}`);
    }
  };
  visit(vector.profile, 'profile');
  if (vector.home) visit(vector.home, '.mixdog');
  return entries;
}

function verifyBackups(backupRoot, dataDir, expected) {
  const instanceId = readJson(join(dataDir, '.mixdog-user-data.json')).instanceId;
  const manifests = readdirSync(backupRoot, { recursive: true }).map(String).filter((name) => name.replaceAll('\\', '/').endsWith('/backup.json'));
  const failures = [];
  for (const relative of manifests) {
    const file = join(backupRoot, relative);
    const configFile = join(file, '..', 'mixdog-config.json');
    let manifest, config;
    try {
      manifest = readJson(file);
      config = existsSync(configFile) ? readJson(configFile) : null;
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      failures.push('incomplete or malformed backup');
      continue;
    }
    const problems = backupProblems({ manifest, config, dataDir, instanceId, expected });
    if (!problems.length) return `${manifests.length} completed backup(s), matching configuration retained`;
    failures.push(...problems);
  }
  throw new Error(`no matching complete owned backup: ${[...new Set(failures)].join(', ') || 'no manifests'}`);
}

/** The checks of one start: each reads a thing back through the core. */
export function checksFor({ expect, dataDir, backupRoot, performWrite = false }) {
  const list = [
    {
      name: 'migration markers',
      run: async () => {
        const deadline = Date.now() + MARKER_WAIT_MS;
        let problems = markerProblems(dataDir);
        while (problems.length && Date.now() < deadline) {
          await sleep(500);
          problems = markerProblems(dataDir);
        }
        if (problems.length) throw new Error(problems.join('; '));
        return `complete.json and profile-gen.json (generation ${GENERATION})`;
      },
    },
    {
      name: 'projects',
      run: async ({ core }) => {
        const result = await core.call('project/list', {});
        const rows = Array.isArray(result) ? result : result?.projects ?? [];
        const paths = new Set(rows.map((row) => row.path ?? row.projectPath));
        const missing = (expect.projects ?? []).filter((path) => !paths.has(path));
        if (missing.length) throw new Error(`project/list lacks ${missing.join(', ')}`);
        return `${(expect.projects ?? []).length} project(s)`;
      },
    },
    {
      name: 'SSH hosts',
      run: async ({ core }) => {
        const rows = await core.call('connections/ssh/list', {});
        const missing = missingIds(expect.sshHosts, rows);
        if (missing.length) throw new Error(`connections/ssh/list lacks ${missing.join(', ')}`);
        for (const record of expect.sshHostRecords ?? []) {
          const differ = subsetProblems(rows.find((row) => row.id === record.id), record);
          if (differ.length) throw new Error(`connections/ssh/list differs at ${record.id}: ${differ.join(', ')}`);
        }
        return `${(expect.sshHosts ?? []).length} host(s)`;
      },
    },
    {
      name: 'notification preferences',
      run: async ({ core }) => {
        if (!expect.notifications) return 'not expected';
        const state = await core.call('notify/state', {});
        const stored = state?.notifications;
        if (!stored || typeof stored !== 'object') throw new Error('notify/state holds no notification preferences');
        if (typeof expect.notifications === 'object') {
          const differ = Object.keys(expect.notifications).filter((key) => key !== 'devices' && !isDeepStrictEqual(stored[key], expect.notifications[key]));
          if (expect.notifications.devices) {
            const expectedDevices = expect.notifications.devices;
            for (const id of new Set([...Object.keys(expectedDevices), ...Object.keys(stored.devices ?? {})])) {
              if (!isDeepStrictEqual(stored.devices?.[id], expectedDevices[id])) differ.push(`devices.${id}`);
            }
          }
          if (differ.length) throw new Error(`notify/state differs at ${differ.join(', ')}`);
        }
        return 'stored';
      },
    },
    {
      name: 'owed revokes',
      run: async ({ core }) => {
        if (!expect.owedRevokes?.length) return 'none expected';
        const readiness = await core.call('pcAccess/readiness', {});
        const owed = new Set(readiness?.owed?.keys ?? []);
        const missing = expect.owedRevokes.filter((key) => !owed.has(key));
        if (missing.length) throw new Error(`pcAccess/readiness no longer owes ${missing.join(', ')}`);
        return `${expect.owedRevokes.length} owed`;
      },
    },
  ];
  if (expect.remoteHosts?.length || expect.remoteHostRecords?.length) {
    list.push({
      name: 'paired PCs',
      run: async ({ core }) => {
        const rows = await core.call('remoteHosts/list', {});
        const missing = missingIds(expect.remoteHosts, rows);
        if (missing.length) throw new Error(`remoteHosts/list lacks ${missing.join(', ')}`);
        for (const record of expect.remoteHostRecords ?? []) {
          const differ = subsetProblems(rows.find((row) => row.id === record.id), record);
          if (differ.length) throw new Error(`remoteHosts/list differs at ${record.id}: ${differ.join(', ')}`);
        }
        return `${rows.length} PC(s)`;
      },
    });
  }
  if (expect.restore) list.push({ name: 'server window preferences', run: async ({ core }) => {
    const value = await core.call('connections/restore/get', {});
    const differ = subsetProblems(value, expect.restore);
    if (differ.length) throw new Error(`connections/restore/get differs at ${differ.join(', ')}`);
    return 'stored and consumed';
  } });
  if (expect.config) list.push({ name: 'effective configuration', run: async ({ core }) => {
    const result = await core.call('config/read', { keys: Object.keys(expect.config) });
    const differ = subsetProblems(result.config, expect.config);
    if (differ.length) throw new Error(`config/read differs at ${differ.join(', ')}`);
    return 'effective values retained';
  } });
  if (expect.desktopSettings) list.push({ name: 'effective desktop settings', run: async ({ core }) => {
    const result = await core.call('config/read', { keys: ['agent', 'desktop'] });
    if (!result?.config || typeof result.config.desktop !== 'object' || !result.config.desktop) throw new Error('config/read holds no desktop section');
    const differ = subsetProblems(await effectiveDesktopSettings(result.config), expect.desktopSettings);
    if (differ.length) throw new Error(`desktop settings differ at ${differ.join(', ')}`);
    return 'desktop consumer applied fixture settings';
  } });
  if (expect.editorSettings) list.push({ name: 'effective editor settings', run: async ({ core, workspace }) => {
    const value = await core.call('projectFs/readEditorSettings', { root: workspace, rel: 'synthetic.ts' });
    const differ = subsetProblems(value, expect.editorSettings);
    if (differ.length) throw new Error(`editor settings differ at ${differ.join(', ')}`);
    return 'JSONC settings applied';
  } });
  if (performWrite && expect.configWrite) list.push({ name: 'unrelated configuration write', run: async ({ core }) => {
    await core.call('config/value/write', expect.configWrite);
    return 'fixture-requested write completed';
  } });
  if (expect.storedConfig) list.push({ name: 'stored configuration sentinels', run: async ({ read = readJson }) => {
    const stored = read(join(dataDir, 'mixdog-config.json'));
    const differ = subsetProblems(stored, expect.storedConfig);
    for (const path of expect.storedConfigAbsent ?? []) {
      const parts = path.split('.');
      const key = parts.pop();
      const parent = parts.reduce((value, part) => value?.[part], stored);
      if (parent && Object.hasOwn(parent, key)) differ.push(`${path} must be absent`);
    }
    if (differ.length) throw new Error(`stored configuration differs at ${differ.join(', ')}`);
    return 'known and unknown fixture keys retained';
  } });
  if (backupRoot) list.push({ name: 'owned configuration backup', run: async () => verifyBackups(backupRoot, dataDir, expect.backupConfig ?? expect.storedConfig ?? {}) });
  return list;
}

/** Runs each check once, in order; a thrown error is that check's failure and the next one still runs. */
export async function runChecks(checks, ctx, log = console.log) {
  const results = [];
  for (const check of checks) {
    const started = Date.now();
    let result;
    try {
      result = { name: check.name, ok: true, detail: await check.run(ctx) };
    } catch (error) {
      result = { name: check.name, ok: false, detail: error instanceof Error ? error.message : String(error) };
    }
    result.ms = Date.now() - started;
    results.push(result);
    log(`${result.ok ? 'ok  ' : 'FAIL'} ${result.name} (${result.ms} ms) ${result.detail}`);
  }
  return results;
}

async function main() {
  const args = parseLiveArgs(process.argv.slice(2));
  if (typeof args.app !== 'string' || typeof args['profile-vector'] !== 'string') {
    throw new Error('usage: --app=<unpacked or installed Mixdog> --profile-vector=<dir> [--out=<dir>] [--iso-root=<dir>] [--keep]');
  }
  const exe = findApp(args.app);
  const vector = loadVector(args['profile-vector']);
  const sourceBefore = vectorDigest(vector);
  const isoRoot = resolve(typeof args['iso-root'] === 'string' ? args['iso-root'] : join(tmpdir(), `mixdog-upgrade-145-${process.pid}`));
  if (existsSync(isoRoot) && readdirSync(isoRoot).length) throw new Error(`the isolated root is not empty: ${isoRoot}`);
  const paths = isolatedPaths(isoRoot);
  const userData = join(paths.appData, 'Mixdog');
  for (const dir of [paths.runtimeRoot, paths.localAppData, paths.tmp, paths.workspace]) mkdirSync(dir, { recursive: true });
  cpSync(vector.profile, userData, { recursive: true });
  if (vector.home) cpSync(vector.home, paths.mixdogHome, { recursive: true });
  mkdirSync(paths.dataDir, { recursive: true });

  const out = typeof args.out === 'string' ? resolve(args.out) : join(tmpdir(), `mixdog-upgrade-145-out-${process.pid}`);
  mkdirSync(out, { recursive: true });
  const backupEnabled = args['backup-enabled'] === true;
  if (backupEnabled && !Object.keys(vector.expect.backupConfig ?? vector.expect.storedConfig ?? {}).length) {
    throw new Error('--backup-enabled requires nonempty backupConfig or storedConfig expectations in the synthetic vector');
  }
  const passes = args.restart === true ? 2 : 1;
  let results = [];
  let failure = null;
  for (let pass = 0; pass < passes; pass++) {
    // Only this harness's empty-owned runtime is used; after ending its process tree a stale discovery must not satisfy the next wait.
    if (pass) rmSync(join(paths.runtimeRoot, 'daemon.json'), { force: true });
    const child = spawnTree(exe, [], { env: upgradeEnvironment(paths, backupEnabled), cwd: paths.root, stdio: 'ignore' });
    let core = null;
    try {
      core = await attachCore({ runtimeRoot: paths.runtimeRoot, clientName: 'upgrade-145', mainWindowId: `upgrade-145-${pass}`, timeoutMs: 180_000 });
      const checks = checksFor({ expect: vector.expect, dataDir: paths.dataDir, backupRoot: backupEnabled ? join(paths.root, 'user-data-backups') : undefined, performWrite: pass === 0 });
      results.push(...(await runChecks(checks, { core, workspace: paths.workspace })).map((result) => ({ ...result, pass: pass + 1 })));
    } catch (error) {
      failure = error;
    } finally {
      try { await core?.close(); } catch {}
      try { await endTree(child); } catch (error) { failure ??= error; }
    }
    if (failure || results.some((result) => !result.ok)) break;
  }
  try {
    if (!isDeepStrictEqual(vectorDigest(vector), sourceBefore)) throw new Error('the immutable source vector changed');
  } catch (error) { failure ??= error; }
  writeFileSync(join(out, 'source-manifest.json'), `${JSON.stringify(sourceBefore, null, 2)}\n`);
  writeFileSync(join(out, 'summary.json'), `${JSON.stringify({ app: exe, vector: vector.root, backupEnabled, requestedPasses: passes, checks: results, failure: failure ? String(failure.message ?? failure) : null }, null, 2)}\n`);
  const logs = join(paths.dataDir, 'logs');
  if (existsSync(logs)) cpSync(logs, join(out, 'logs'), { recursive: true });
  if (!args.keep) rmSync(isoRoot, { recursive: true, force: true, maxRetries: 5 });
  if (failure) {
    console.error(failure.stack ?? String(failure));
    process.exit(1);
  }
  process.exit(results.every((r) => r.ok) ? 0 : 1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
