#!/usr/bin/env node
// Records what the launcher's crash capture (`packages/protocol-client/src/launch/crash-capture/*.mjs`) does with scripted inputs, so the
// Rust capture (`mixdog-launch` `crash_capture`) replays them and is compared with it whole:
//   - paths:      where the captures live for a given data folder or environment (`daemonCrashCaptureDir`, `daemonDataDir`);
//   - sidecars:   a boot's capture driven by a script of steps (begin, the core writing to fd 2, track, ready, exit, a spawn error, the
//                 core writing its own block into the sidecar), on a scripted clock and nonce; after each step the sidecar and the
//                 files in the directory, and at the end the launcher's log and the failure summary;
//   - retention:  `pruneDaemonCrashCaptures` over a directory laid out from a list of boots, with a set of live pids: what it answers
//                 and what is left (names and sizes).
// Run from the repository root:
//   node native/core/crates/mixdog-launch/tests/recorders/record-crash-capture.mjs --tree <tree> [--check <golden.json>] [--scratch <folder>]
// Without --check it writes tests/goldens/crash-capture.json; with it, it compares and exits 1 when the recording differs.
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_GOLDEN = path.join(here, '..', 'goldens', 'crash-capture.json');

function argument(name) {
  const at = process.argv.indexOf(name);
  return at >= 0 ? process.argv[at + 1] : null;
}
const tree = argument('--tree');
if (!tree) {
  console.error('usage: record-crash-capture.mjs --tree <tree> [--check <golden.json>] [--scratch <folder>]');
  process.exit(2);
}
const check = argument('--check');
// Where the recording lays out its temporary folders (the system's temporary folder by default).
const scratch = argument('--scratch') || os.tmpdir();
fs.mkdirSync(scratch, { recursive: true });
const launch = (name) => import(pathToFileURL(path.join(tree, 'packages/protocol-client/src/launch/crash-capture', name)).href);
const { daemonCrashCaptureDir, daemonDataDir } = await launch('paths.mjs');
const { beginDaemonSpawnCapture } = await launch('spawn-capture.mjs');
const { pruneDaemonCrashCaptures } = await launch('retention.mjs');

const slash = (text) => String(text).replaceAll('\\', '/');

// ---------------------------------------------------------------------------------------------------------------------------------
// Paths
const pathCases = [
  { given: { dataDir: 'data' } },
  { given: { dataDir: 'a/b' } },
  { given: { env: { MIXDOG_DATA_DIR: 'x' } } },
  { given: { env: { MIXDOG_HOME: 'h' } } },
  { given: { env: { MIXDOG_DATA_DIR: '', MIXDOG_HOME: 'h' } } },
  { given: { env: { MIXDOG_DATA_DIR: 'x', MIXDOG_HOME: 'h' } } },
];
const paths = pathCases.map(({ given }) => {
  const dir = given.dataDir ? daemonCrashCaptureDir({ dataDir: given.dataDir }) : daemonCrashCaptureDir({ env: given.env });
  const data = given.dataDir ? null : daemonDataDir(given.env);
  return { given, captureDir: slash(path.relative(process.cwd(), dir)), dataDir: data === null ? null : slash(path.relative(process.cwd(), data)) };
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Sidecars
const T0 = Date.UTC(2026, 10, 14, 3, 4, 5, 678);
const LAUNCHER_PID = 4242;
const NONCE = 'c0de';

const lines = (...rows) => `${rows.join('\n')}\n`;
const sidecarScripts = [
  {
    name: 'ready-then-crash',
    steps: [
      { op: 'begin' },
      { op: 'stderr', text: lines('boot line', 'TypeError: boom', 'tail line') },
      { op: 'track', pid: 100, detached: true },
      { op: 'clock', ms: T0 + 50 },
      { op: 'ready' },
      { op: 'clock', ms: T0 + 950 },
      { op: 'exit', code: 1, signal: null },
      { op: 'summary' },
    ],
  },
  {
    name: 'contender-that-lost-the-claim',
    steps: [{ op: 'begin' }, { op: 'track', pid: 101, detached: true }, { op: 'clock', ms: T0 + 20 }, { op: 'exit', code: 0, signal: null }, { op: 'summary' }],
  },
  {
    name: 'clean-exit-of-a-core-that-served',
    steps: [{ op: 'begin' }, { op: 'track', pid: 102, detached: false }, { op: 'clock', ms: T0 + 10 }, { op: 'ready' }, { op: 'clock', ms: T0 + 5000 }, { op: 'exit', code: 0, signal: null }],
  },
  {
    name: 'exit-with-bytes-on-fd-2',
    steps: [{ op: 'begin' }, { op: 'track', pid: 103, detached: true }, { op: 'stderr', text: 'something was said\n' }, { op: 'clock', ms: T0 + 30 }, { op: 'exit', code: 0, signal: null }],
  },
  {
    name: 'killed-by-a-signal',
    steps: [{ op: 'begin' }, { op: 'track', pid: 104, detached: true }, { op: 'clock', ms: T0 + 700 }, { op: 'exit', code: null, signal: 'SIGKILL' }, { op: 'summary' }],
  },
  {
    name: 'terminated-by-its-parent',
    steps: [{ op: 'begin' }, { op: 'track', pid: 105, detached: true }, { op: 'clock', ms: T0 + 700 }, { op: 'exit', code: 0x40010004, signal: null }],
  },
  {
    name: 'console-close',
    steps: [{ op: 'begin' }, { op: 'track', pid: 106, detached: true }, { op: 'clock', ms: T0 + 700 }, { op: 'exit', code: 0xc000013a, signal: null }],
  },
  {
    name: 'spawn-error-nothing-written',
    steps: [{ op: 'begin' }, { op: 'clock', ms: T0 + 5 }, { op: 'spawnError', message: 'spawn mixdogd ENOENT' }, { op: 'summary' }],
  },
  {
    name: 'spawn-error-after-bytes',
    steps: [{ op: 'begin' }, { op: 'stderr', text: 'the loader said this\n' }, { op: 'clock', ms: T0 + 5 }, { op: 'spawnError', message: '  spawn   mixdogd\n EACCES ' }],
  },
  {
    name: 'core-wrote-its-own-exit',
    steps: [
      { op: 'begin' },
      { op: 'track', pid: 107, detached: true },
      { op: 'clock', ms: T0 + 40 },
      { op: 'ready' },
      { op: 'coreWrites', patch: { daemonExit: { reason: 'shutdown: fatal boot error (exited with code 2)', code: 2, signal: null, error: null, at: '2026-11-14T03:04:06.000Z', uptimeMs: 1000, rssBytes: 1, heapUsedBytes: 2 }, exitReason: 'shutdown: fatal boot error (exited with code 2)' } },
      { op: 'clock', ms: T0 + 1000 },
      { op: 'exit', code: 2, signal: null },
    ],
  },
  {
    name: 'ready-twice-and-exit-twice',
    steps: [{ op: 'begin' }, { op: 'track', pid: 108, detached: true }, { op: 'clock', ms: T0 + 40 }, { op: 'ready' }, { op: 'clock', ms: T0 + 80 }, { op: 'ready' }, { op: 'clock', ms: T0 + 90 }, { op: 'exit', code: 3, signal: null }, { op: 'clock', ms: T0 + 99 }, { op: 'exit', code: 4, signal: null }],
  },
  {
    name: 'a-mirror-longer-than-its-bound',
    steps: [{ op: 'begin' }, { op: 'track', pid: 109, detached: true }, { op: 'stderr', text: 'line-0000\n', repeat: 2000 }, { op: 'clock', ms: T0 + 40 }, { op: 'ready' }, { op: 'stderr', text: 'after ready\n' }, { op: 'clock', ms: T0 + 60 }, { op: 'exit', code: 9, signal: null }],
  },
  ...[
    ['summary-without-an-error-line', lines('starting', 'non-fatal: ignored', 'still going')],
    ['summary-error-class-line', lines('starting', '  RangeError [ERR_OUT_OF_RANGE]: too far  ', 'later')],
    ['summary-bare-error-line', lines('Error', 'later')],
    ['summary-fatal-abort', lines('boot', 'FATAL ERROR: Reached heap limit', 'later')],
    ['summary-fatal-word', lines('boot', 'a fatal boot error occurred', 'later')],
    ['summary-word-containing-fatal', lines('boot', 'nonfatal event', 'infatal')],
    ['summary-crlf-and-blank-lines', 'first\r\n\r\n   \r\nlast line\r\n'],
    ['summary-long-line', `${'x'.repeat(600)} fatal ${'y'.repeat(10)}\n`],
    ['summary-nothing-on-fd-2', ''],
  ].map(([name, text]) => ({
    name,
    steps: [{ op: 'begin' }, { op: 'track', pid: 110, detached: true }, { op: 'stderr', text }, { op: 'summary' }],
  })),
];

function summarizeLog(log) {
  return log.length <= 12 ? log : { count: log.length, head: log.slice(0, 3), tail: log.slice(-2) };
}

function runSidecarScript(script) {
  const dir = fs.mkdtempSync(path.join(scratch, 'launch-capture-'));
  const norm = (text) => (text === null || text === undefined ? text : slash(String(text).split(dir).join('<dir>')));
  try {
    const clock = { ms: T0 };
    const log = [];
    const seen = [];
    let capture = null;
    const files = () => fs.readdirSync(dir).sort();
    const sidecar = () => {
      if (!capture?.recordPath || !fs.existsSync(capture.recordPath)) return null;
      return JSON.parse(fs.readFileSync(capture.recordPath, 'utf8'));
    };
    for (const step of script.steps) {
      const out = { ...step };
      switch (step.op) {
        case 'begin':
          capture = beginDaemonSpawnCapture({ launcher: 'core', log: (line) => log.push(line), dir, launcherPid: LAUNCHER_PID, now: () => clock.ms, prune: false, nonce: () => NONCE });
          out.stem = capture.stem;
          break;
        case 'clock':
          clock.ms = step.ms;
          break;
        case 'stderr':
          if (capture.capturePath) fs.appendFileSync(capture.capturePath, step.text.repeat(step.repeat ?? 1));
          break;
        case 'track': {
          const child = new EventEmitter();
          child.pid = step.pid;
          capture.track(child, { detached: step.detached });
          break;
        }
        case 'ready':
          capture.noteReady();
          break;
        case 'exit':
          capture.noteExit({ code: step.code, signal: step.signal });
          break;
        case 'spawnError':
          capture.noteSpawnError(new Error(step.message));
          break;
        case 'coreWrites': {
          const current = sidecar();
          fs.writeFileSync(capture.recordPath, JSON.stringify({ ...current, ...step.patch }));
          break;
        }
        case 'summary': {
          const summary = capture.summary();
          out.summary = { ...summary, stderrPath: summary.stderrPath ? path.basename(summary.stderrPath) : null };
          break;
        }
        default:
          throw new Error(`unknown step ${step.op}`);
      }
      out.record = sidecar();
      out.files = files();
      seen.push(out);
    }
    return { name: script.name, steps: seen, log: summarizeLog(log.map(norm)) };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const sidecars = sidecarScripts.map(runSidecarScript);

// ---------------------------------------------------------------------------------------------------------------------------------
// Retention
const BASE = Date.UTC(2026, 10, 13, 12, 0, 0);
const done = '2026-11-13T00:00:00.000Z';
const exited = (pid) => ({ pid, exitedAt: done });
const KIB = 1024;
const stemOf = (n, pid = 1, nonce = '00aa') => `daemon-20261113-${String(n).padStart(6, '0')}-${pid}-${nonce}`;

const retentionCases = [
  {
    name: 'budget-states-and-debris',
    alive: [7, 8, 31],
    boots: [
      ...Array.from({ length: 10 }, (_, n) => ({ stem: stemOf(n), record: exited(1), raw: 100, ageSec: 1000 + n })),
      { stem: 'daemon-20261113-010000-2-00bb', record: { pid: 2, exitedAt: null }, raw: 300 * KIB, ageSec: 10 },
      { stem: 'daemon-20261113-020000-7-00cc', record: { pid: 7, exitedAt: null }, raw: 100, ageSec: 5000 },
      { stem: 'daemon-20261113-030000-8-00dd', record: { pid: null, launcherPid: 8 }, raw: 100, ageSec: 5000 },
      { stem: 'daemon-20261113-040000-9-00ee', record: { pid: null, launcherPid: 9 }, raw: 100, ageSec: 5000 },
      { stem: 'daemon-20261113-050000-9-00ff', record: 'not json', raw: 100, ageSec: 5000 },
      { stem: 'daemon-20261113-060000-9-0a0a', record: null, raw: 100, ageSec: 5000 },
    ],
    extras: [
      { name: 'notes.txt', bytes: 4 },
      { name: 'daemon-20261113-000000-9-00aa.json.mixdog-tmp-abc123', bytes: 4 },
      { name: '.daemon-20261113-000000-9-00aa.json.0f0f.tmp', bytes: 4 },
      { name: 'daemon-20261113-000000-31-00aa.json.mixdog-tmp-def456', bytes: 4 },
      { name: 'daemon-20261113-000000-0-00aa.json.mixdog-tmp-0', bytes: 4 },
    ],
  },
  {
    name: 'byte-budget-drops-the-oldest-after-trimming',
    alive: [],
    boots: Array.from({ length: 8 }, (_, n) => ({ stem: stemOf(n, 3, '00ab'), record: exited(3), raw: 300 * KIB, ageSec: 100 + n * 10 })),
    extras: [],
  },
  {
    name: 'the-newest-completed-boot-survives-alone',
    alive: [],
    boots: [
      { stem: stemOf(1, 4, '00ac'), record: exited(4), raw: 900 * KIB, ageSec: 10 },
      { stem: stemOf(2, 4, '00ad'), record: exited(4), raw: 10, ageSec: 20 },
    ],
    extras: [],
  },
  {
    name: 'nothing-there',
    alive: [],
    boots: [],
    extras: [],
  },
];

function layout(dir, spec) {
  const at = (ageSec) => new Date(BASE - ageSec * 1000);
  const stamp = (file, ageSec) => fs.utimesSync(file, at(ageSec), at(ageSec));
  for (const boot of spec.boots) {
    const raw = path.join(dir, `${boot.stem}.err.log`);
    fs.writeFileSync(raw, Buffer.alloc(boot.raw, 'x'));
    stamp(raw, boot.ageSec);
    if (boot.record !== null) {
      const sidecar = path.join(dir, `${boot.stem}.json`);
      fs.writeFileSync(sidecar, typeof boot.record === 'string' ? boot.record : JSON.stringify(boot.record));
      stamp(sidecar, boot.ageSec);
    }
  }
  for (const extra of spec.extras) fs.writeFileSync(path.join(dir, extra.name), Buffer.alloc(extra.bytes, 'e'));
}

function runRetention(spec) {
  const dir = fs.mkdtempSync(path.join(scratch, 'launch-retention-'));
  try {
    layout(dir, spec);
    const alive = new Set(spec.alive);
    const result = pruneDaemonCrashCaptures({ dir, pidAlive: (pid) => alive.has(pid) });
    const remaining = fs
      .readdirSync(dir)
      .sort()
      .map((name) => {
        const size = fs.statSync(path.join(dir, name)).size;
        const head = name.endsWith('.err.log') ? fs.readFileSync(path.join(dir, name)).subarray(0, 60).toString('utf8').split('\n')[0] : null;
        return { name, size, head: head?.startsWith('[capture trimmed') ? head : null };
      });
    return { ...spec, result, remaining };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const retention = retentionCases.map(runRetention);

const golden = {
  note: 'what the launcher crash capture (spawn-capture.mjs, retention.mjs, paths.mjs, daemon-exit-record.mjs describeExit) does with scripted inputs; mixdog-launch tests/crash_capture_twin.rs replays it',
  paths,
  sidecars,
  retention,
};
const text = `${JSON.stringify(golden, null, 2)}\n`;

if (check) {
  const expected = fs.readFileSync(check, 'utf8').replaceAll('\r\n', '\n');
  if (expected !== text) {
    const a = expected.split('\n');
    const b = text.split('\n');
    const at = a.findIndex((line, n) => line !== b[n]);
    console.error(`record-crash-capture: ${check} differs from the recording at line ${at + 1}:\n  file:      ${a[at]}\n  recording: ${b[at]}`);
    process.exit(1);
  }
  console.log(`record-crash-capture: ${check} matches the recording`);
} else {
  fs.mkdirSync(path.dirname(DEFAULT_GOLDEN), { recursive: true });
  fs.writeFileSync(DEFAULT_GOLDEN, text);
  console.log(`record-crash-capture: wrote ${DEFAULT_GOLDEN}`);
}
