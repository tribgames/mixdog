#!/usr/bin/env node
// Upgrade check: a packaged (unpacked or installed) Mixdog started on a 1.4.5-shaped profile.
//   node scripts/live/upgrade-145.mjs --app=<unpacked dir or Mixdog executable> --profile-vector=<dir> [--out=<dir>] [--iso-root=<dir>] [--keep]
//
// The vector directory holds `profile/` (the 1.4.5 Electron userData files), optionally `data/` (a 1.4.5 data directory,
// the recorded one of mixdog-migrate/tests/vectors/migration-145) and optionally `expect.json`:
//   { "projects": [<path>], "sshHosts": [<id>], "remoteHosts": [<id>], "notifications": true, "owedRevokes": [<key>] }
// With no `sshHosts` (or `remoteHosts`) entry the ids of profile/ssh-hosts.json (remote-hosts.json) are expected. Both
// folders are copied under an isolated root (the vector is never written), the app is started on them with
// MIXDOG_DESKTOP_USER_DATA, and once the core serves the run asserts the migration markers (complete.json,
// profile-gen.json at generation 2) and reads projects, SSH hosts, paired PCs, notification preferences and owed revokes
// back through core methods. Exits 0 when every check passes.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { attachCore, isolatedEnv, isolatedPaths } from '../rust-core/lib/core-session.mjs';
import { endTree, spawnTree } from '../rust-core/lib/process-tree.mjs';
import { parseLiveArgs } from './lib/paths.mjs';

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
const GENERATION = 2;
const MARKER_WAIT_MS = 120_000;

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));

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

/** What the vector directory holds: its profile, its data directory (or null) and what a start must read back. */
export function loadVector(dir, { exists = existsSync, read = readJson } = {}) {
  const root = resolve(dir);
  const profile = join(root, 'profile');
  if (!exists(profile)) throw new Error(`the vector has no profile/ folder: ${root}`);
  const data = exists(join(root, 'data')) ? join(root, 'data') : null;
  const expect = exists(join(root, 'expect.json')) ? read(join(root, 'expect.json')) : {};
  if (!expect.sshHosts && exists(join(profile, 'ssh-hosts.json'))) expect.sshHosts = read(join(profile, 'ssh-hosts.json')).hosts.map((host) => host.id);
  if (!expect.remoteHosts && exists(join(profile, 'remote-hosts.json'))) expect.remoteHosts = read(join(profile, 'remote-hosts.json')).hosts.map((host) => host.id);
  return { root, profile, data, expect };
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

/** The checks of one start: each reads a thing back through the core. */
export function checksFor({ expect, dataDir }) {
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
        const text = JSON.stringify(await core.call('project/list', {}));
        const missing = (expect.projects ?? []).filter((path) => !text.includes(JSON.stringify(path).slice(1, -1)));
        if (missing.length) throw new Error(`project/list lacks ${missing.join(', ')}`);
        return `${(expect.projects ?? []).length} project(s)`;
      },
    },
    {
      name: 'SSH hosts',
      run: async ({ core }) => {
        const missing = missingIds(expect.sshHosts, await core.call('connections/ssh/list', {}));
        if (missing.length) throw new Error(`connections/ssh/list lacks ${missing.join(', ')}`);
        return `${(expect.sshHosts ?? []).length} host(s)`;
      },
    },
    {
      name: 'notification preferences',
      run: async ({ core }) => {
        if (!expect.notifications) return 'not expected';
        const state = await core.call('notify/state', {});
        if (!state?.notifications || typeof state.notifications !== 'object') throw new Error('notify/state holds no notification preferences');
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
  if (expect.remoteHosts?.length) {
    list.push({
      name: 'paired PCs',
      run: async ({ core }) => {
        const text = JSON.stringify(await core.call('remoteAccess/state', {}));
        const missing = expect.remoteHosts.filter((id) => !text.includes(id));
        if (missing.length) throw new Error(`remoteAccess/state lacks ${missing.join(', ')}`);
        return `${expect.remoteHosts.length} PC(s)`;
      },
    });
  }
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
  const isoRoot = resolve(typeof args['iso-root'] === 'string' ? args['iso-root'] : join(tmpdir(), `mixdog-upgrade-145-${process.pid}`));
  if (existsSync(isoRoot) && readdirSync(isoRoot).length) throw new Error(`the isolated root is not empty: ${isoRoot}`);
  const paths = isolatedPaths(isoRoot);
  const userData = join(paths.appData, 'Mixdog');
  for (const dir of [paths.runtimeRoot, paths.localAppData, paths.tmp, paths.workspace]) mkdirSync(dir, { recursive: true });
  cpSync(vector.profile, userData, { recursive: true });
  if (vector.data) cpSync(vector.data, paths.dataDir, { recursive: true });
  else mkdirSync(paths.dataDir, { recursive: true });

  const out = typeof args.out === 'string' ? resolve(args.out) : join(tmpdir(), `mixdog-upgrade-145-out-${process.pid}`);
  mkdirSync(out, { recursive: true });
  const child = spawnTree(exe, [], { env: isolatedEnv(paths), cwd: paths.root, stdio: 'ignore', windowsHide: false });
  let core = null;
  let results = [];
  let failure = null;
  try {
    core = await attachCore({ runtimeRoot: paths.runtimeRoot, clientName: 'upgrade-145', timeoutMs: 180_000 });
    results = await runChecks(checksFor({ expect: vector.expect, dataDir: paths.dataDir }), { core });
  } catch (error) {
    failure = error;
  } finally {
    try {
      core?.close();
    } catch {}
    await endTree(child).catch((error) => console.error(error.message));
  }
  writeFileSync(join(out, 'summary.json'), `${JSON.stringify({ app: exe, vector: vector.root, checks: results, failure: failure ? String(failure.message ?? failure) : null }, null, 2)}\n`);
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
