#!/usr/bin/env node
// Records what the process lifecycle ledger (`src/runtime/shared/process-lifecycle.mjs`) writes for scripted runs, so the Rust
// ledger (`mixdog-launch` `lifecycle`) replays the same runs and is compared with it whole. Every run is in a folder of its own
// under a temporary folder; what is recorded is the files it leaves, with the pid, the token, the times and the memory counters
// normalised (a pid is a label, a time is "is an ISO time", a counter is "is a number"):
//   - run:      begin, the identity upgrade (where the platform has one), a catchable fatal, finish. The marker after each step.
//   - finish:   the end's reason and exit code for the combinations of fatal and finish reasons, the unknown reason, a second
//               finish, the async finish.
//   - stale:    a start that finds the markers of a dead pid, of this pid with another token, of a live pid with another start
//               time, the legacy single marker, and one that is not JSON: what it records and which markers it removes.
//   - cap:      a ledger at its 64 KiB cap (rotation), an oversized ledger, an oversized retained generation, and a start that
//               reports several vanished markers into a ledger that has room for part of them.
// Run from the repository root:
//   node native/core/crates/mixdog-launch/tests/recorders/record-lifecycle.mjs --tree <tree> [--check <golden.json>] [--scratch <folder>]
// Without --check it writes tests/goldens/lifecycle.json; with it, it compares and exits 1 when the recording differs.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_GOLDEN = path.join(here, '..', 'goldens', 'lifecycle.json');
const MAX_BYTES = 64 * 1024;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function argument(name) {
  const at = process.argv.indexOf(name);
  return at >= 0 ? process.argv[at + 1] : null;
}
const tree = argument('--tree');
if (!tree) {
  console.error('usage: record-lifecycle.mjs --tree <tree> [--check <golden.json>] [--scratch <folder>]');
  process.exit(2);
}
const check = argument('--check');
const scratch = argument('--scratch') || os.tmpdir();
fs.mkdirSync(scratch, { recursive: true });
const root = fs.mkdtempSync(path.join(scratch, 'lifecycle-record-'));
const lifecycle = await import(pathToFileURL(path.join(tree, 'src/runtime/shared/process-lifecycle.mjs')).href);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(ok, ms, what) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (ok()) return;
    await sleep(20);
  }
  throw new Error(`timed out after ${ms}ms waiting for ${what}`);
}

const SELF = 'self';
const DEAD = 2147483000;
const SINGLE_MARKER_DEAD = 2147482999;
const isLinux = process.platform === 'linux';
const ownIdentity = isLinux
  ? { kind: 'linux-start-ticks', value: '1' }
  : { kind: 'start-seconds', value: 1, method: 'powershell' };
const deadIdentity = isLinux
  ? { kind: 'linux-start-ticks', value: '5' }
  : { kind: 'start-seconds', value: 1700000000, method: 'powershell' };

let counter = 0;
function freshDir() {
  counter += 1;
  return path.join(root, `run${counter}`, 'diagnostics');
}

// Labels for the pids a run meets: this process, its parent, the dead ones.
function labelOf(pid) {
  if (pid === process.pid) return SELF;
  if (pid === process.ppid) return 'parent';
  if (pid === DEAD) return 'dead';
  if (pid === SINGLE_MARKER_DEAD) return 'legacy';
  return String(pid);
}

function normalizeIdentity(identity) {
  if (identity === null || identity === undefined) return identity ?? 'absent';
  return {
    kind: identity.kind,
    method: identity.method === undefined ? 'absent' : identity.method === 'uptime' ? 'uptime' : 'os',
    value:
      identity.kind === 'linux-start-ticks'
        ? /^\d+$/.test(String(identity.value))
          ? 'ticks'
          : 'bad'
        : Number.isSafeInteger(identity.value) && identity.value > 0
          ? 'seconds'
          : 'bad',
  };
}

function normalizeEntry(entry) {
  const kind = (value) => (value === null ? 'null' : value === undefined ? 'absent' : typeof value);
  return {
    version: entry.version,
    timestamp: ISO.test(String(entry.timestamp)),
    pid: labelOf(entry.pid),
    ppid: kind(entry.ppid),
    reason: entry.reason,
    exitCode: entry.exitCode,
    memory: entry.memory === undefined ? 'absent' : typeof entry.memory.rss === 'number' ? 'rss' : 'empty',
    cwd: entry.cwd === undefined ? 'absent' : entry.cwd === process.cwd() ? '<cwd>' : entry.cwd,
  };
}

function readLines(file) {
  try {
    return fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line));
  } catch {
    return null;
  }
}

function markerName(name) {
  return name.replace(`${process.pid}-`, `${SELF}-`).replace(/-[0-9a-z]+-[0-9a-z]+\.json$/, '-<token>.json');
}

function listing(dir) {
  return fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [];
}

function markerFiles(api) {
  return fs.existsSync(api.markerDir)
    ? fs
        .readdirSync(api.markerDir)
        .sort()
        .map(markerName)
    : [];
}

function ownMarker(api) {
  if (!fs.existsSync(api.markerPath)) return null;
  const marker = JSON.parse(fs.readFileSync(api.markerPath, 'utf8'));
  return {
    version: marker.version,
    timestamp: ISO.test(String(marker.timestamp)),
    pid: labelOf(marker.pid),
    ppid: typeof marker.ppid,
    token: /^[0-9a-z]+-[0-9a-z]+$/.test(String(marker.token)),
    processIdentity: normalizeIdentity(marker.processIdentity),
  };
}

// The ledger as a list of normalized entries: the retained generation first, then the current file.
function ledgerEntries(api, { onlyReasons = true } = {}) {
  const lines = [...(readLines(`${api.ledgerPath}.1`) ?? []), ...(readLines(api.ledgerPath) ?? [])];
  return lines.filter((entry) => !onlyReasons || entry.reason !== undefined).map(normalizeEntry);
}

function sizes(api) {
  const size = (file) => (fs.existsSync(file) ? fs.statSync(file).size : null);
  // The retained generation's exact size follows the length of the lines in it, which differs between the runtimes (the memory counters).
  const previous = size(`${api.ledgerPath}.1`);
  return {
    ledgerWithinCap: (size(api.ledgerPath) ?? 0) <= MAX_BYTES,
    previous: previous === null ? null : previous === 0 ? 0 : previous <= MAX_BYTES ? 'within' : 'over',
  };
}

function seedMarker(dir, spec) {
  const pid = { self: process.pid, parent: process.ppid, dead: DEAD, legacy: SINGLE_MARKER_DEAD }[spec.pid];
  const file = spec.legacy ? path.join(dir, 'process-lifecycle.active.json') : path.join(dir, 'process-lifecycle.active', spec.file);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (spec.raw !== undefined) {
    fs.writeFileSync(file, spec.raw);
    return;
  }
  const identity = spec.identity === 'own' ? ownIdentity : deadIdentity;
  fs.writeFileSync(file, `${JSON.stringify({ version: 1, timestamp: '2026-01-01T00:00:00.000Z', pid, ppid: 5, token: spec.token, processIdentity: identity })}\n`);
}

const begin = (directory) => lifecycle.beginProcessLifecycle({ directory, configureReports: false });

// ---------------------------------------------------------------------------------------------------------------------------------
// run: the markers across a run, and the identity upgrade
async function recordRun() {
  const dir = freshDir();
  const api = begin(dir);
  await sleep(150);
  const out = { platform: process.platform, afterBegin: { files: listing(dir), markers: markerFiles(api), marker: ownMarker(api), ledger: ledgerEntries(api) } };
  if (!isLinux) {
    await until(() => JSON.parse(fs.readFileSync(api.markerPath, 'utf8')).processIdentity?.method !== 'uptime', 8000, 'the identity upgrade');
    out.afterUpgrade = { marker: ownMarker(api) };
  }
  out.fatal = lifecycle.recordCatchableFatal(7);
  out.finish = lifecycle.finishProcessLifecycle('clean-shutdown', 0);
  if (out.finish !== true) throw new Error('finish did not complete');
  out.end = { files: listing(dir), markers: markerFiles(api), ledger: ledgerEntries(api) };
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// finish: the reason and the exit code an end carries
const finishCases = [
  { name: 'fatal then clean', fatal: 7, finish: ['clean-shutdown', 0] },
  { name: 'fatal then forced', fatal: 7, finish: ['forced-cleanup', 9] },
  { name: 'unknown reason', finish: ['bogus', 3] },
  { name: 'process-start as the reason', finish: ['process-start', 4] },
  { name: 'clean', finish: ['clean-shutdown', 0], again: true },
  { name: 'async fatal', finishAsync: ['catchable-fatal-error', 2] },
  { name: 'async clean after fatal', fatal: 5, finishAsync: ['clean-shutdown', 0] },
];

async function recordFinish() {
  const out = [];
  for (const spec of finishCases) {
    const api = begin(freshDir());
    await sleep(100);
    const result = { name: spec.name };
    if (spec.fatal !== undefined) result.fatal = lifecycle.recordCatchableFatal(spec.fatal);
    if (spec.finish) result.finish = lifecycle.finishProcessLifecycle(...spec.finish);
    if (spec.finishAsync) result.finish = await lifecycle.finishProcessLifecycleAsync(...spec.finishAsync);
    if (spec.again) {
      result.finishAgain = lifecycle.finishProcessLifecycle('forced-cleanup', 1);
      result.fatalAfter = lifecycle.recordCatchableFatal(1);
    }
    if (result.finish !== true) throw new Error(`finish did not complete in case ${spec.name}`);
    result.markers = markerFiles(api);
    result.ledger = ledgerEntries(api);
    out.push(result);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// stale: a start that finds markers
const staleSeeds = [
  { file: 'dead-tok.json', pid: 'dead', token: 'tok', identity: 'dead' },
  { file: 'self-old.json', pid: 'self', token: 'old', identity: 'dead' },
  { file: 'parent-live.json', pid: 'parent', token: 'live', identity: 'own' },
  { legacy: true, pid: 'legacy', token: 'legacy', identity: 'dead' },
  { file: 'junk.json', raw: 'this is not json' },
  { file: 'notes.txt', raw: 'not a marker either' },
];

async function recordStale() {
  const dir = freshDir();
  for (const spec of staleSeeds) seedMarker(dir, spec);
  const api = begin(dir);
  // The start, then one record per marker whose process is gone: the four that are reaped.
  await until(() => ledgerEntries(api).length >= 5, 15000, 'the vanished markers to be recorded');
  await sleep(200);
  const files = fs.readdirSync(api.markerDir).sort().map(markerName);
  const legacyLeft = fs.existsSync(path.join(dir, 'process-lifecycle.active.json'));
  const finish = lifecycle.finishProcessLifecycle('clean-shutdown', 0);
  const entries = ledgerEntries(api);
  return {
    seeds: staleSeeds,
    first: entries[0],
    rest: entries.slice(1).sort((a, b) => {
      const [x, y] = [`${a.pid}:${a.reason}`, `${b.pid}:${b.reason}`];
      return x < y ? -1 : x > y ? 1 : 0;
    }),
    markersWhileRunning: files,
    legacyLeft,
    finish,
    markersAfter: markerFiles(api),
  };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// cap: the 64 KiB bound
function seedLedgerFile(file, bytes) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const head = '{"seed":true,"pad":"';
  const tail = '"}\n';
  fs.writeFileSync(file, `${head}${'p'.repeat(bytes - head.length - tail.length)}${tail}`);
}

const capCases = [
  { name: 'ledger at the cap', ledger: MAX_BYTES - 10 },
  { name: 'ledger with room', ledger: 1000 },
  { name: 'ledger oversized', ledger: MAX_BYTES + 5000 },
  { name: 'retained generation oversized', ledger: 1000, previous: MAX_BYTES + 5000 },
  { name: 'vanished markers into a nearly full ledger', ledger: MAX_BYTES - 450, seeds: ['dead', 'legacy'] },
];

async function recordCap() {
  const out = [];
  for (const spec of capCases) {
    const dir = freshDir();
    seedLedgerFile(path.join(dir, 'process-lifecycle.jsonl'), spec.ledger);
    if (spec.previous) seedLedgerFile(path.join(dir, 'process-lifecycle.jsonl.1'), spec.previous);
    for (const [index, label] of (spec.seeds ?? []).entries()) {
      seedMarker(dir, label === 'legacy' ? { legacy: true, pid: 'legacy', token: 'legacy', identity: 'dead' } : { file: `${label}-${index}.json`, pid: label, token: `t${index}`, identity: 'dead' });
    }
    const api = begin(dir);
    await until(() => ledgerEntries(api).length >= 1 + (spec.seeds ?? []).length, 10000, 'the entries');
    await sleep(100);
    lifecycle.recordCatchableFatal(1);
    lifecycle.finishProcessLifecycle('clean-shutdown', 0);
    const entries = ledgerEntries(api);
    const seedLines = (file) => (readLines(file) ?? []).filter((entry) => entry.seed === true).length;
    out.push({
      name: spec.name,
      sizes: sizes(api),
      seedInLedger: seedLines(api.ledgerPath),
      seedInPrevious: seedLines(`${api.ledgerPath}.1`),
      reasons: entries.map((entry) => `${entry.pid}:${entry.reason}`).sort(),
      first: entries[0].reason,
    });
  }
  return out;
}

const recording = { run: await recordRun(), finish: await recordFinish(), stale: await recordStale(), cap: await recordCap() };
fs.rmSync(root, { recursive: true, force: true });

const text = `${JSON.stringify(recording, null, 2)}\n`;
if (check) {
  const expected = JSON.parse(fs.readFileSync(check, 'utf8'));
  const differences = [];
  const walk = (a, b, at) => {
    if (JSON.stringify(a) === JSON.stringify(b)) return;
    if (a && b && typeof a === 'object' && typeof b === 'object') {
      for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) walk(a[key], b[key], `${at}.${key}`);
      return;
    }
    differences.push(at);
  };
  walk(recording, expected, '$');
  if (differences.length > 0) {
    console.error(`the recording differs from ${check} at: ${differences.slice(0, 20).join(', ')}`);
    process.exit(1);
  }
  console.log('the recording matches the golden');
} else {
  fs.writeFileSync(DEFAULT_GOLDEN, text);
  console.log(`wrote ${DEFAULT_GOLDEN}`);
}
