#!/usr/bin/env node
// Local pre-push check. Mirrors the test legs of .github/workflows/release-gate.yml
// (jobs: runtime, runtime-slow, desktop, desktop-tests fast/slow, shipped-history).
// It MUST be updated together with that workflow whenever those commands change.
// Up front it runs the released-section changelog check the desktop fast lane
// asserts (changelog-locales.test.mjs; Deploy's plan adds the Unreleased
// section) and stops if it fails. Everything else runs from one shared pool of
// workers (scripts/lib/gate-scheduler.mjs): every test lane is cut into shards
// of its own files (each run with the lane's own npm script command), and the
// desktop build + daemon end-to-end test, the patch smoke and the gate's
// shipped-history job (build-shipped-history.mjs --check; needs a full clone, a
// shallow one keeps the committed file) are units of the same pool. A failed
// shipped-history check stops new starts, so the gate still ends early on it.
// The whole run is at below-normal priority so the desktop stays responsive.
// Not covered locally: runtime-macos, computer-backend (cargo + Linux X11),
// desktop-tests `computer` lane (windows-latest, src/main/computer/ only),
// relay (apps/relay tests), graph (cargo test), patch (cargo test of the
// checked-out engine), browser-import (windows-latest cargo test of the Chrome
// importer against a fetched upstream checkout), mobile-scripts (Python
// unittest). The gate's path
// filtering is not applied: every check and leg always runs. Run `npm ci`
// (root and apps/desktop) first.
// Usage: npm run gate:local [-- --test-concurrency=<workers>]
// (MIXDOG_TEST_CONCURRENCY also sets the pool size; default: half the cores, at most 8).
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_ESTIMATE_MS,
  gateTestBudget,
  measuredFileTimes,
  planShards,
  readTimingHistory,
  runPool,
  saveTimingHistory,
} from './lib/gate-scheduler.mjs';
import { pruneStaleTempDirs, removeTempDirSync } from './lib/stale-temp.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const started = Date.now();
const budget = gateTestBudget(process.argv.slice(2));
// Inherited by every process the gate starts (Windows and POSIX alike).
os.setPriority(os.constants.priority.PRIORITY_BELOW_NORMAL);

if (spawnSync('node scripts/check-changelog-locales.mjs', { cwd: root, stdio: 'inherit', shell: true }).status !== 0) {
  console.error('[gate:local] pre-check failed: node scripts/check-changelog-locales.mjs');
  process.exit(1);
}

// Warning-level: a stale model list never blocks the gate.
if (
  spawnSync('node scripts/check-model-recommendations.mjs', { cwd: root, stdio: 'inherit', shell: true }).status !== 0
) {
  console.warn('[gate:local] warning: model recommendations stale or invalid (not blocking)');
}

const build = spawnSync('npm run build:spawn:test', { cwd: root, stdio: 'inherit', shell: true });
if (build.status !== 0) {
  console.error('[gate:local] build:spawn:test failed');
  process.exit(1);
}

// Each run owns its log directory, so concurrent runs never touch each other's
// logs and the paths the summary prints stay valid after any outcome. Log
// directories are kept until they go stale; a resources directory a killed
// run left behind goes the same way. Both are swept at start.
const LOG_PREFIX = 'mixdog-gate-local-';
const RESOURCE_PREFIX = 'mixdog-gate-resources-';
pruneStaleTempDirs([LOG_PREFIX, RESOURCE_PREFIX]);
const logDir = fs.mkdtempSync(path.join(os.tmpdir(), LOG_PREFIX));
const resourceDir = fs.mkdtempSync(path.join(os.tmpdir(), RESOURCE_PREFIX));

// Measured times live in the repository's common git dir, so every worktree
// and snapshot of the repo plans from the same history. Keys: a test file's
// repo-relative path, or `cmd:` + a command unit's commands. Timings only
// plan the run: without them (no git dir, unreadable or invalid history) the
// gate plans from default estimates.
const commonDir = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
  cwd: root,
  encoding: 'utf8',
});
const historyPath =
  commonDir.status === 0 ? path.join(commonDir.stdout.trim(), 'mixdog-gate-timings.json') : null;
if (!historyPath) console.warn(`[gate:local] warning: no git common dir, timings not kept: ${commonDir.stderr}`);
const history = historyPath ? readTimingHistory(historyPath) : {};
const measured = {};

// Each test lane runs its package's own npm script command, given shard files
// as filters (scripts/test.mjs), without npm or a shell between: a shell's
// command line could not hold a shard's paths.
const testLanes = [
  { name: 'runtime', pkg: '.', script: 'test', speed: 'fast' },
  { name: 'runtime-slow', pkg: '.', script: 'test:slow', speed: 'slow' },
  { name: 'desktop-tests-fast', pkg: 'apps/desktop', script: 'test', speed: 'fast' },
  { name: 'desktop-tests-slow', pkg: 'apps/desktop', script: 'test:slow', speed: 'slow' },
].map((lane) => {
  const dir = path.join(root, lane.pkg);
  const command = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).scripts[lane.script];
  const [program, ...args] = command.split(/\s+/);
  if (program !== 'node') throw new Error(`${lane.pkg}/package.json "${lane.script}" must be a node command: ${command}`);
  const list = spawnSync(process.execPath, [...args, '--list'], { cwd: dir, encoding: 'utf8' });
  if (list.status !== 0) throw new Error(`${command} --list failed: ${list.stderr}`);
  const files = list.stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => line.replace(/^\S+\s+/, ''));
  const key = (file) => path.posix.join(lane.pkg, file);
  return { ...lane, dir, args, files, key, estimateOf: (file) => history[key(file)] ?? DEFAULT_ESTIMATE_MS[lane.speed] };
});
const lanesByName = new Map(testLanes.map((lane) => [lane.name, lane]));
const commandUnits = [
  { lane: 'shipped-history', cmds: ['node scripts/build-shipped-history.mjs --check'], stopOnFail: true },
  { lane: 'runtime', cmds: ['npm run smoke:patch'] },
  // Only the daemon end-to-end test reads the build (apps/desktop/out); no
  // test lane does, so the build shares the pool with them.
  { lane: 'desktop', cmds: ['npm run build --prefix apps/desktop', 'npm run test:daemon:e2e --prefix apps/desktop'] },
].map((unit) => {
  const key = `cmd:${unit.cmds.join(' && ')}`;
  return { ...unit, key, estimate: history[key] ?? DEFAULT_ESTIMATE_MS.command };
});
const units = [...planShards(testLanes, budget), ...commandUnits];
const laneCounts = new Map();
for (const unit of units) {
  laneCounts.set(unit.lane, (laneCounts.get(unit.lane) ?? 0) + 1);
  unit.id = `${unit.lane}.${laneCounts.get(unit.lane)}`;
}
const laneNames = [...laneCounts.keys()];
const laneLog = (name) => path.join(logDir, `${name}.log`);

// Every unit is one worker: a shard runs its files one at a time.
const env = { ...process.env, MIXDOG_TEST_CONCURRENCY: '1', MIXDOG_TEST_OOXML_CACHE_DIR: resourceDir };
function run(command, args, options, fd) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { ...options, env, windowsHide: true, stdio: ['ignore', fd, fd] });
    child.on('error', (error) => {
      fs.writeSync(fd, `${error.stack}\n`);
      resolve(1);
    });
    child.on('close', (code) => resolve(code ?? 1));
  });
}

const TIMING_REPORTER = new URL('./lib/gate-timing-reporter.mjs', import.meta.url).href;
async function runShard(unit, fd) {
  const lane = lanesByName.get(unit.lane);
  const timings = path.join(logDir, `${unit.id}.timings.jsonl`);
  const args = [...lane.args, `--test-reporter=${TIMING_REPORTER}`, `--test-reporter-destination=${timings}`];
  fs.writeSync(fd, `\n$ (${lane.pkg}) node ${[...args, ...unit.files].join(' ')}\n`);
  const code = await run(process.execPath, [...args, ...unit.files], { cwd: lane.dir }, fd);
  const reported = Object.fromEntries(
    (fs.existsSync(timings) ? fs.readFileSync(timings, 'utf8') : '')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const { file, ms } = JSON.parse(line);
        return [file, ms];
      })
  );
  fs.rmSync(timings, { force: true });
  for (const [file, ms] of Object.entries(measuredFileTimes(unit.files, reported, Date.now() - unit.start))) {
    measured[lane.key(file)] = Math.round(ms);
  }
  return code === 0;
}

async function runCommands(unit, fd) {
  let ok = true;
  for (const cmd of unit.cmds) {
    fs.writeSync(fd, `\n$ ${cmd}\n`);
    if ((await run(cmd, [], { cwd: root, shell: true }, fd)) !== 0) {
      ok = false;
      break;
    }
  }
  measured[unit.key] = Date.now() - unit.start;
  return ok;
}

let finished = 0;
async function runUnit(unit) {
  const part = path.join(logDir, `${unit.id}.part.log`);
  const fd = fs.openSync(part, 'w');
  unit.start = Date.now();
  let ok = false;
  try {
    ok = await (unit.files ? runShard(unit, fd) : runCommands(unit, fd));
  } finally {
    fs.closeSync(fd);
    unit.end = Date.now();
    fs.appendFileSync(laneLog(unit.lane), fs.readFileSync(part));
    fs.rmSync(part);
  }
  console.log(
    `[gate:local] ${ok ? 'ok  ' : 'FAIL'} ${unit.id} ${((unit.end - unit.start) / 1000).toFixed(1)}s (${++finished}/${units.length})`
  );
  return ok;
}

console.log(
  `[gate:local] ${units.length} units on ${budget} workers at below-normal priority; timings: ${historyPath}; logs: ${logDir}`
);
let notStarted = [];
try {
  notStarted = await runPool(units, budget, runUnit);
} finally {
  removeTempDirSync(resourceDir);
  // The next run plans from these; work this run did not reach keeps its old time.
  const keys = [...testLanes.flatMap((lane) => lane.files.map(lane.key)), ...commandUnits.map((unit) => unit.key)];
  const next = Object.fromEntries(
    keys.filter((key) => (measured[key] ?? history[key]) !== undefined).map((key) => [key, measured[key] ?? history[key]])
  );
  const saveError = historyPath && saveTimingHistory(historyPath, next);
  if (saveError) console.warn(`[gate:local] warning: timings not saved (${saveError.message})`);
}

console.log('\n=== gate:local summary ===');
for (const name of laneNames) {
  const laneUnits = units.filter((unit) => unit.lane === name);
  const ran = laneUnits.filter((unit) => unit.end);
  const status = ran.some((unit) => !unit.ok) ? 'FAIL' : ran.length < laneUnits.length ? 'NOT RUN' : 'PASS';
  const span = ran.length ? Math.max(...ran.map((u) => u.end)) - Math.min(...ran.map((u) => u.start)) : 0;
  const work = ran.reduce((sum, unit) => sum + unit.end - unit.start, 0);
  console.log(
    `${status}  ${name}  ${(span / 1000).toFixed(1)}s (${(work / 1000).toFixed(1)}s worker time, ${ran.length}/${laneUnits.length} units)  ${laneLog(name)}`
  );
  if (status !== 'FAIL') continue;
  const lines = fs
    .readFileSync(laneLog(name), 'utf8')
    .split(/\r?\n/)
    .filter((l) => /\[failure-summary\] (?:RUN FAILED|HUNG|FAILED|FLAKY)/.test(l));
  for (const l of lines) console.log(`    ${l}`);
}
if (notStarted.length) console.log(`Stopped after a failed ${units.find((u) => u.stopOnFail && u.ok === false).lane} check: ${notStarted.length} unit(s) not run`);
console.log(
  'Not covered locally: runtime-macos, computer-backend, desktop-tests computer lane (Windows-only), relay, graph, patch, browser-import, mobile-scripts'
);
console.log(`Total: ${((Date.now() - started) / 1000).toFixed(1)}s`);
process.exit(units.every((unit) => unit.ok) ? 0 : 1);
