#!/usr/bin/env node
// Records what the staged update of the Node CLI (`src/runtime/shared/staged-update.mjs`) decides for scripted data folders, so the
// Rust staged update (`mixdog-launch` `staged_update`) replays the same scenarios and is compared with it whole. The npm install the
// Node module runs is replaced by a stub `npm-cli.js` that lays the package down (npm itself is not exercised, and is not ported);
// the swap runs in a copy of `src/runtime/shared` placed at `<scratch>/node_modules/mixdog`, the layout a global install has, whose
// package folder each scenario lays out afresh. Recorded, per scenario, only what both implementations decide:
//   - refcount: the pid file a registered session leaves (its name and shape) and that unregistering removes it;
//   - markers:  `isStagedComplete` for no marker, a marker that is not JSON, a marker of another version, a marker whose payload
//               is missing, and a complete one;
//   - spawn:    `spawnStagedInstall` answering false for an empty version, for MIXDOG_DISABLE_STAGED_INSTALL, and for a version that
//               is staged already (the worker itself is never started);
//   - stage:    `runStagedInstall` for an empty version, a fresh version, a staged one, a fresh lock of a live owner, a lock of a
//               dead owner, a lock of a live owner over ten minutes old, a lock that is not a pid, and a marker of another version:
//               the outcome, the marker's version and whether the lock is left;
//   - swap:     `performPendingSwap` for nothing staged, an older, an equal, a newer, the best of several (ordering of versions
//               and prereleases), another live session, a pid file of a dead session, the two switches, attempts that never
//               completed (old and fresh), a marker whose payload is missing, a swap lock of a dead owner and a leftover backup:
//               whether it swapped, the version now live, the staging folders and live-session files left, the backups left.
// Run from the repository root:
//   node native/core/crates/mixdog-launch/tests/recorders/record-staged-update.mjs --tree <tree> [--check <golden.json>] [--scratch <folder>]
// Without --check it writes tests/goldens/staged-update.json; with it, it compares and exits 1 when the recording differs.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_GOLDEN = path.join(here, '..', 'goldens', 'staged-update.json');

function argument(name) {
  const at = process.argv.indexOf(name);
  return at >= 0 ? process.argv[at + 1] : null;
}
const tree = argument('--tree');
if (!tree) {
  console.error('usage: record-staged-update.mjs --tree <tree> [--check <golden.json>] [--scratch <folder>]');
  process.exit(2);
}
const check = argument('--check');
const scratch = argument('--scratch') || os.tmpdir();
fs.mkdirSync(scratch, { recursive: true });
const root = fs.mkdtempSync(path.join(scratch, 'staged-update-record-'));

const CURRENT = '1.5.0';
const DEAD = 2147483000;
const OTHER_LIVE = process.ppid;
const MARKER = '.staged-complete.json';

// The copy of the runtime the module is loaded from, in the layout of a global install.
const home = path.join(root, 'node_modules', 'mixdog');
fs.mkdirSync(path.join(home, 'src', 'runtime'), { recursive: true });
fs.cpSync(path.join(tree, 'src', 'runtime', 'shared'), path.join(home, 'src', 'runtime', 'shared'), { recursive: true });
const staged = await import(pathToFileURL(path.join(home, 'src', 'runtime', 'shared', 'staged-update.mjs')).href);

// A stub in place of npm: `config get registry` answers, `install mixdog@<v> --prefix <dir>` lays the package down.
const stubDir = path.join(root, 'stub');
fs.mkdirSync(stubDir, { recursive: true });
const stub = path.join(stubDir, 'npm-cli.js');
fs.writeFileSync(
  stub,
  `const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
if (args[0] === 'config') { process.stdout.write('https://registry.npmjs.org/\\n'); process.exit(0); }
const version = args[1].split('@').pop();
const prefix = args[args.indexOf('--prefix') + 1];
const pkg = path.join(prefix, 'node_modules', 'mixdog');
fs.mkdirSync(path.join(pkg, 'src'), { recursive: true });
fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: 'mixdog', version }));
fs.writeFileSync(path.join(pkg, 'src', 'cli.mjs'), '');
`,
);
process.env.npm_execpath = stub;
delete process.env.MIXDOG_DISABLE_STAGED_INSTALL;
delete process.env.MIXDOG_DISABLE_STAGED_SWAP;
delete process.env.MIXDOG_SWAP_REEXEC;

let counter = 0;
/** A data folder of its own for one scenario. */
function freshData() {
  const dir = path.join(root, 'data', String(counter++));
  fs.mkdirSync(dir, { recursive: true });
  process.env.MIXDOG_DATA_DIR = dir;
  return dir;
}
const stagingDir = (data, version) => path.join(data, 'staging', version);
const names = (dir) => {
  try {
    return fs.readdirSync(dir).sort();
  } catch {
    return [];
  }
};
const pidLabel = (name) => {
  const pid = Number.parseInt(name, 10);
  const label = pid === process.pid ? 'self' : pid === OTHER_LIVE ? 'other' : pid === DEAD ? 'dead' : 'unknown';
  return `${label}${name.slice(String(pid).length)}`;
};

/** Lays down a staged version: its package, and the marker unless `marker` is false. */
function stage(data, version, { marker = true, payload = true, markerVersion = version, age = 0 } = {}) {
  const verDir = stagingDir(data, version);
  const pkg = path.join(verDir, 'mixdog');
  fs.mkdirSync(path.join(pkg, 'src'), { recursive: true });
  if (payload) {
    fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: 'mixdog', version }));
    fs.writeFileSync(path.join(pkg, 'src', 'cli.mjs'), '');
  }
  if (marker) fs.writeFileSync(path.join(verDir, MARKER), JSON.stringify({ version: markerVersion, pkgDir: pkg, stagedAt: 1 }));
  if (age) {
    const when = new Date(Date.now() - age);
    fs.utimesSync(verDir, when, when);
  }
}

// ── refcount ──
const refcount = {};
{
  const data = freshData();
  staged.registerLiveSession();
  const files = names(path.join(data, 'live-sessions'));
  const text = fs.readFileSync(path.join(data, 'live-sessions', files[0]), 'utf8');
  refcount.registered = { files: files.map(pidLabel), content: /^\d+ \d+\n$/.test(text) && text.startsWith(`${process.pid} `) ? 'pid ms newline' : text };
  staged.registerLiveSession();
  refcount.registeredTwice = { files: names(path.join(data, 'live-sessions')).map(pidLabel) };
  staged.unregisterLiveSession();
  refcount.unregistered = { files: names(path.join(data, 'live-sessions')).map(pidLabel) };
  staged.unregisterLiveSession();
  refcount.unregisteredTwice = { files: names(path.join(data, 'live-sessions')).map(pidLabel) };
}

// ── markers ──
const markers = {};
{
  const data = freshData();
  markers.noMarker = staged.isStagedComplete('1.6.0');
  fs.mkdirSync(stagingDir(data, '1.6.0'), { recursive: true });
  fs.writeFileSync(path.join(stagingDir(data, '1.6.0'), MARKER), 'not json');
  markers.markerNotJson = staged.isStagedComplete('1.6.0');
  stage(data, '1.6.1', { markerVersion: '1.6.2' });
  markers.markerOfAnotherVersion = staged.isStagedComplete('1.6.1');
  stage(data, '1.6.3', { payload: false });
  markers.payloadMissing = staged.isStagedComplete('1.6.3');
  stage(data, '1.6.4');
  markers.complete = staged.isStagedComplete('1.6.4');
  markers.emptyVersion = staged.isStagedComplete('');
  markers.versionWithSpaces = staged.isStagedComplete(' 1.6.4 ');
}

// ── spawn (the cases that start nothing) ──
const spawn = {};
{
  const data = freshData();
  spawn.emptyVersion = staged.spawnStagedInstall('');
  process.env.MIXDOG_DISABLE_STAGED_INSTALL = '1';
  spawn.disabled = staged.spawnStagedInstall('9.9.9');
  delete process.env.MIXDOG_DISABLE_STAGED_INSTALL;
  stage(data, '1.6.0');
  spawn.alreadyStaged = staged.spawnStagedInstall('1.6.0');
}

// ── stage ──
const stageRuns = {};
const outcome = (result) => (result.inProgress ? 'in-progress' : result.alreadyStaged ? 'already-staged' : result.ok ? 'staged' : `failed: ${result.error}`);
async function stageScenario(name, version, prepare) {
  const data = freshData();
  const verDir = stagingDir(data, version.trim());
  if (prepare) prepare(data, verDir);
  const result = await staged.runStagedInstall(version);
  let markerVersion = null;
  try {
    markerVersion = JSON.parse(fs.readFileSync(path.join(verDir, MARKER), 'utf8')).version;
  } catch {}
  stageRuns[name] = { outcome: outcome(result), markerVersion, lockLeft: fs.existsSync(path.join(verDir, '.staging.lock')) };
}
const writeLock = (verDir, text, age = 0) => {
  fs.mkdirSync(verDir, { recursive: true });
  const lock = path.join(verDir, '.staging.lock');
  fs.writeFileSync(lock, text);
  if (age) {
    const when = new Date(Date.now() - age);
    fs.utimesSync(lock, when, when);
  }
};
await stageScenario('emptyVersion', '');
await stageScenario('fresh', '1.6.0');
await stageScenario('alreadyStaged', '1.6.0', (data) => stage(data, '1.6.0'));
await stageScenario('lockOfLiveOwner', '1.6.0', (data, verDir) => writeLock(verDir, `${process.pid} ${Date.now()}`));
await stageScenario('lockOfDeadOwner', '1.6.0', (data, verDir) => writeLock(verDir, `${DEAD} ${Date.now()}`));
await stageScenario('lockOfLiveOwnerOverTenMinutes', '1.6.0', (data, verDir) => writeLock(verDir, `${process.pid} 1`, 11 * 60 * 1000));
await stageScenario('lockOfLiveOwnerUnderTenMinutes', '1.6.0', (data, verDir) => writeLock(verDir, `${process.pid} 1`, 9 * 60 * 1000));
await stageScenario('lockThatIsNotAPid', '1.6.0', (data, verDir) => writeLock(verDir, 'garbage'));
await stageScenario('markerOfAnotherVersion', '1.6.0', (data) => stage(data, '1.6.0', { markerVersion: '1.6.1' }));
await stageScenario('versionWithSpaces', ' 1.6.2 ');

// ── swap ──
const swapRuns = {};
const liveFile = path.join(home, 'package.json');
function layHome(version) {
  fs.rmSync(home, { recursive: true, force: true });
  fs.mkdirSync(path.join(home, 'src'), { recursive: true });
  fs.writeFileSync(liveFile, JSON.stringify({ name: 'mixdog', version }));
  fs.writeFileSync(path.join(home, 'src', 'cli.mjs'), '');
  for (const name of names(path.dirname(home))) if (name.startsWith('mixdog.old-')) fs.rmSync(path.join(path.dirname(home), name), { recursive: true, force: true });
}
function swapScenario(name, prepare, env = {}) {
  const data = freshData();
  layHome(CURRENT);
  if (prepare) prepare(data);
  for (const [key, value] of Object.entries(env)) process.env[key] = value;
  const swapped = staged.performPendingSwap();
  for (const key of Object.keys(env)) delete process.env[key];
  swapRuns[name] = {
    swapped,
    live: JSON.parse(fs.readFileSync(liveFile, 'utf8')).version,
    staging: names(path.join(data, 'staging')),
    sessions: names(path.join(data, 'live-sessions')).map(pidLabel),
    backups: names(path.dirname(home)).filter((entry) => entry.startsWith('mixdog.old-')).length,
  };
}
const session = (data, pid) => {
  fs.mkdirSync(path.join(data, 'live-sessions'), { recursive: true });
  fs.writeFileSync(path.join(data, 'live-sessions', `${pid}.pid`), `${pid} 1\n`);
};
swapScenario('nothingStaged');
swapScenario('older', (data) => stage(data, '1.4.0'));
swapScenario('equal', (data) => stage(data, '1.5.0'));
swapScenario('newer', (data) => stage(data, '1.6.0'));
swapScenario('bestOfSeveral', (data) => {
  stage(data, '1.9.0');
  stage(data, '1.10.0');
  stage(data, '1.5.1-rc.1');
});
swapScenario('prereleaseOfTheNextVersion', (data) => stage(data, '1.5.1-rc.1'));
swapScenario('prereleaseBelowCurrent', (data) => stage(data, '1.5.0-rc.1'));
swapScenario('prereleaseBeatsNothingButLosesToRelease', (data) => {
  stage(data, '1.6.0-rc.2');
  stage(data, '1.6.0');
});
swapScenario('anotherLiveSession', (data) => {
  stage(data, '1.6.0');
  session(data, OTHER_LIVE);
});
swapScenario('deadSessionFile', (data) => {
  stage(data, '1.6.0');
  session(data, DEAD);
});
swapScenario('ownSessionFile', (data) => {
  stage(data, '1.6.0');
  session(data, process.pid);
});
swapScenario('swapSwitchedOff', (data) => stage(data, '1.6.0'), { MIXDOG_DISABLE_STAGED_SWAP: '1' });
swapScenario('afterASwap', (data) => stage(data, '1.6.0'), { MIXDOG_SWAP_REEXEC: '1' });
swapScenario('incompleteAttempts', (data) => {
  stage(data, '1.7.0', { marker: false, age: 2 * 60 * 60 * 1000 });
  stage(data, '1.8.0', { marker: false });
});
swapScenario('payloadMissing', (data) => stage(data, '1.6.0', { payload: false }));
swapScenario('markerNotJson', (data) => {
  fs.mkdirSync(stagingDir(data, '1.6.0'), { recursive: true });
  fs.writeFileSync(path.join(stagingDir(data, '1.6.0'), MARKER), 'not json');
});
swapScenario('swapLockOfDeadOwner', (data) => {
  stage(data, '1.6.0');
  fs.mkdirSync(path.join(data, 'staging'), { recursive: true });
  fs.writeFileSync(path.join(data, 'staging', '.swap.lock'), `${DEAD} ${Date.now()}`);
});
swapScenario('leftoverBackup', (data) => {
  fs.mkdirSync(path.join(path.dirname(home), 'mixdog.old-1'), { recursive: true });
  fs.writeFileSync(path.join(path.dirname(home), 'mixdog.old-1', 'x'), '');
});
swapScenario('leftoverBackupAfterASwap', (data) => {
  stage(data, '1.6.0');
  fs.mkdirSync(path.join(path.dirname(home), 'mixdog.old-1'), { recursive: true });
});

const recording = { refcount, markers, spawn, stage: stageRuns, swap: swapRuns };
const text = `${JSON.stringify(recording, null, 2)}\n`;
let code = 0;
if (check) {
  const expected = fs.readFileSync(check, 'utf8').replace(/\r\n/g, '\n');
  if (expected !== text) {
    console.error(`record-staged-update: the recording differs from ${check}`);
    const want = JSON.parse(expected);
    for (const section of Object.keys(recording)) {
      for (const key of Object.keys(recording[section])) {
        if (JSON.stringify(recording[section][key]) !== JSON.stringify(want[section]?.[key])) console.error(`  ${section}.${key}: ${JSON.stringify(recording[section][key])} (golden ${JSON.stringify(want[section]?.[key])})`);
      }
    }
    code = 1;
  }
} else {
  fs.writeFileSync(DEFAULT_GOLDEN, text);
}
fs.rmSync(root, { recursive: true, force: true });
process.exit(code);
