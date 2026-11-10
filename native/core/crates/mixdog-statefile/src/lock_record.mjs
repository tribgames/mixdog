// Records Node b6f10295a's shared file lock (`src/runtime/shared/file-lock.mjs`, `withFileLock`) timing out on a lock
// another holder keeps: the error's whole text and code, and the waits it took (`lockRetryDelayMs`, file-lock.mjs:351-356)
// before it gave up. The lock is a file that names no owner (so no pid is in the text) and is younger than the stale age.
// Cases: the holder's age at the error just under, at and just over half a millisecond (`Math.round`,
// file-lock.mjs:155-166); and timeouts whose deadline falls inside a wait, of a whole and of a fractional number of
// milliseconds, so the last wait is the remaining time cut short, a fraction where the deadline is one.
//
// Fixed inputs: `Date.now()` is a virtual clock starting at T (a small instant, so a file time near it keeps 100 ns
// precision as a double); every timer is virtual, recorded with the delay asked for and fired at once, the clock moved
// by that delay rounded up to a whole millisecond (a Node timer of 23.5 ms fires once 24 whole milliseconds of
// `Date.now()` passed: its duration is compared with whole-millisecond loop time); `Math.random()` is 0.5. The lock
// path is relative to the run directory (the process's working directory), as the message prints it as given.
// Usage: node lock_record.mjs --tree <git archive export of b6f10295a, with node_modules>
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..', '..', '..', '..');
const commonPath = join(repo, 'benchmarks/rust-core/recorders/lib/common.mjs');
const { commitStage, exactProductIdentity, importFrom, parseArgs, resolveTree, sha256, stageSet, writeJson, writeSetManifest } = await import(pathToFileURL(commonPath).href);

const COMMIT = 'b6f10295a2f698afc85332467192de28500bd146';
const finalDir = join(repo, 'native/core/fixtures/shared-file-lock');
const recorder = relative(repo, fileURLToPath(import.meta.url)).replaceAll('\\', '/');
const tree = resolveTree(parseArgs());
const identity = exactProductIdentity(tree, COMMIT);
const { withFileLock } = await importFrom(tree, 'src/runtime/shared/file-lock.mjs');

const T = 1_000_000;
const cases = [
  // The error is read at T + 1 (the attempt at T, a wait of 1 ms, the attempt at the deadline): the file's time is
  // T + 1 minus the age.
  ...[['under', 0.4999], ['at', 0.5], ['over', 0.5001]].map(([name, ageMs]) => ({ name: `holder-age-just-${name}-half-a-millisecond`, timeoutMs: 1, mtimeMs: T + 1 - ageMs })),
  { name: 'a-whole-timeout-cut-inside-a-wait', timeoutMs: 300, mtimeMs: T },
  { name: 'a-fractional-timeout-cut-inside-a-wait', timeoutMs: 300.25, mtimeMs: T },
  { name: 'a-fractional-timeout-cut-inside-the-second-wait', timeoutMs: 60.5, mtimeMs: T },
  // The process clock a fraction past a millisecond: `Date.now()` is its whole milliseconds, and the age is that minus
  // the file's fractional time (file-lock.mjs:159). Read at the clock's T + 1 + fraction.
  { name: 'clock-0.9-past-a-millisecond-age-99.8', timeoutMs: 1, mtimeMs: T + 1 - 99.8, clockFractionMs: 0.9 },
  { name: 'clock-0.3-past-a-millisecond-age-99.4', timeoutMs: 1, mtimeMs: T + 1 - 99.4, clockFractionMs: 0.3 },
  // The stale threshold read on `Date.now()` (file-lock.mjs:290): at the last attempt (T + 1) 0.5 ms short of the stale
  // age by `Date.now()`, 0.2 ms past it by the process clock, so it is not reclaimed.
  { name: 'stale-threshold-on-date-now-not-the-fractional-clock', timeoutMs: 1, staleMs: 1000, mtimeMs: T - 1000 + 1.5, clockFractionMs: 0.7 },
];

const runDir = fs.mkdtempSync(join(tmpdir(), 'shared-file-lock-'));
process.chdir(runDir);
// The process clock, a fraction kept; `Date.now()` is its whole milliseconds as Node's is.
let virtualNow = T;
Date.now = () => Math.floor(virtualNow);
Math.random = () => 0.5;
let sleeps = [];
const realSetImmediate = setImmediate;
globalThis.setTimeout = (fn, ms, ...rest) => {
  sleeps.push(ms);
  realSetImmediate(() => {
    virtualNow += Math.ceil(ms);
    fn(...rest);
  });
  return { ref() {}, unref() {}, hasRef: () => true };
};

const recorded = [];
for (const [i, spec] of cases.entries()) {
  const lockPath = `case-${i + 1}/state.json.lock`;
  fs.mkdirSync(dirname(lockPath), { recursive: true });
  fs.writeFileSync(lockPath, '');
  fs.utimesSync(lockPath, spec.mtimeMs / 1000, spec.mtimeMs / 1000);
  const mtimeNs = fs.statSync(lockPath, { bigint: true }).mtimeNs;
  const clockFractionMs = spec.clockFractionMs ?? 0;
  virtualNow = T + clockFractionMs;
  sleeps = [];
  let outcome;
  try {
    await withFileLock(lockPath, () => 'entered', { timeoutMs: spec.timeoutMs, ...(spec.staleMs === undefined ? {} : { staleMs: spec.staleMs }) });
    outcome = { entered: true };
  } catch (error) {
    outcome = { message: error.message, code: error.code ?? null };
  }
  recorded.push({
    name: spec.name, lockPath, timeoutMs: spec.timeoutMs, staleMs: spec.staleMs ?? null, clockFractionMs, mtimeNs: String(mtimeNs),
    sleeps, atMs: Date.now() - T, outcome,
  });
  console.log(`${spec.name}: ${JSON.stringify(sleeps)} -> ${outcome.message ?? 'entered'}`);
}
process.chdir(tmpdir());
fs.rmSync(runDir, { recursive: true, force: true });

const stage = stageSet(finalDir, ['node-recorded.json', 'MANIFEST.json']);
writeJson(join(stage, 'node-recorded.json'), { t: T, cases: recorded });
const extra = {
  scripts: { 'benchmarks/rust-core/recorders/lib/common.mjs': sha256(fs.readFileSync(commonPath)) },
  recorderSha256: sha256(fs.readFileSync(fileURLToPath(import.meta.url))),
  runtime: { node: process.version, electron: process.versions.electron ?? null },
};
writeSetManifest(stage, { set: 'shared-file-lock', recorder, command: `node ${recorder} --tree <b6f10295a export>`, identity, extra });
commitStage(stage, finalDir);
console.log(`${recorded.length} cases recorded from ${COMMIT}`);
process.exit(0);
