import { spawn } from 'node:child_process';
import { appendFile, mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { availableParallelism, tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { FAILURE_RECORDS_ENV, spawnLedgerPath } from './test-failure-records.mjs';
import { classifyRerunOutcomes, formatFailureSummary } from './test-failure-summary.mjs';

const SUMMARY_REPORTER = new URL('./test-summary-reporter.mjs', import.meta.url).href;
const SPAWN_LEDGER = new URL('./test-spawn-ledger.mjs', import.meta.url).href;

// A whole-suite run passes ~700 paths to one node process. Windows caps a
// command line at 32767 characters (CreateProcess) and POSIX caps argv+env at
// ARG_MAX, so the file list is spawned in batches that stay under the cap
// instead of dying with spawn ENAMETOOLONG before any test runs.
export const ARG_BUDGET = process.platform === 'win32' ? 30_000 : 1_000_000;

const HEAP_FLAG = /^--(?:max-old-space-size|max-semi-space-size)=\d+$/;

// An argument costs its own characters plus the separator and its quotes.
const argCost = (arg) => arg.length + 3;

// Full logs are kept for reading after the run; older ones are stale.
const TEST_LOG_PREFIX = 'mixdog-test-output-';
const TEST_LOG_RETENTION_MS = 3 * 24 * 60 * 60 * 1000;

async function pruneStaleTestLogs(root) {
  let names = [];
  try {
    names = await readdir(root);
  } catch {
    return;
  }
  const cutoff = Date.now() - TEST_LOG_RETENTION_MS;
  for (const name of names) {
    if (!name.startsWith(TEST_LOG_PREFIX)) continue;
    const path = join(root, name);
    try {
      if ((await stat(path)).mtimeMs < cutoff) await rm(path, { recursive: true, force: true });
    } catch {
      /* another run may own or be removing it */
    }
  }
}

// Batches keep the file order Node was given; a single path larger than the
// budget still gets its own batch rather than being dropped. An empty list
// stays one batch: Node's own discovery is what an argument-less run means.
export function chunkFileArgs(fileArgs, budget) {
  const chunks = [[]];
  let cost = 0;
  for (const file of fileArgs) {
    const current = chunks.at(-1);
    if (current.length > 0 && cost + argCost(file) > budget) {
      chunks.push([file]);
      cost = argCost(file);
      continue;
    }
    current.push(file);
    cost += argCost(file);
  }
  return chunks;
}

const positiveInt = (value) => {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
};

// `node --test` defaults to availableParallelism()-1 file processes. Precedence:
// an explicit --test-concurrency flag, then MIXDOG_TEST_CONCURRENCY; with
// neither, Node's default (cores-1) stands. Returns the flag to add, or null.
export function testConcurrencyArg(nodeArgs, env = process.env) {
  if (nodeArgs.some(concurrencyFlag)) return null;
  const explicit = positiveInt(env.MIXDOG_TEST_CONCURRENCY);
  return explicit ? `--test-concurrency=${explicit}` : null;
}

// Every test file process is bounded: node:test fails a file (and records it
// like any other failure) that is still running after --test-timeout, so a hang
// costs minutes instead of waiting for the batch watchdog. A --test-timeout
// flag wins, then MIXDOG_TEST_TIMEOUT_MS (0 turns the bound off), then the
// caller's default. Returns the flag to add, or null.
export function testTimeoutArg(nodeArgs, env = process.env, defaultMs = DEFAULT_TEST_TIMEOUT_MS) {
  if (nodeArgs.some((arg) => arg === '--test-timeout' || arg.startsWith('--test-timeout='))) return null;
  const raw = env.MIXDOG_TEST_TIMEOUT_MS;
  if (raw !== undefined && String(raw).trim() === '0') return null;
  const ms = positiveInt(raw) ?? defaultMs;
  return ms ? `--test-timeout=${ms}` : null;
}

const concurrencyFlag = (arg) => arg === '--test-concurrency' || arg.startsWith('--test-concurrency=');

// The file-process count a run was given (flag or env), else Node's default.
function concurrencyOf(runArgs, fileArgs) {
  const args = [...runArgs, ...fileArgs];
  const index = args.findIndex(concurrencyFlag);
  const value = index < 0 ? null : positiveInt(args[index].includes('=') ? args[index].split('=')[1] : args[index + 1]);
  return value ?? Math.max(1, availableParallelism() - 1);
}

function withoutConcurrency(args) {
  return args.filter((arg, i) => !concurrencyFlag(arg) && !(i > 0 && args[i - 1] === '--test-concurrency'));
}

// What keeps a test process off the signed-in user's machine state.
export function testIsolationEnv(scratchDir) {
  return {
    TEMP: scratchDir,
    TMP: scratchDir,
    TMPDIR: scratchDir,
    // A fixture must never write into the signed-in app's data (~/.mixdog):
    // schedule/webhook logs, design-library bindings and the like resolve the
    // default data dir. The desktop preload already does this per process.
    MIXDOG_DATA_DIR: join(scratchDir, 'data'),
    // Any session a test composes would otherwise read the real home's
    // AGENTS.md / CLAUDE.md whenever the stored setting is on; tests that
    // exercise the feature clear this and pass their own home.
    MIXDOG_BOOT_INSTRUCTION_FILES: '0',
  };
}

export const DEFAULT_TEST_TIMEOUT_MS = 120_000;
export const LONG_TEST_TIMEOUT_MS = 600_000;

/** Per-file timeout default for explicitly named files: a `.slow`/`.live`/
 *  `.electron` test file keeps its lane's long bound (scripts/test.mjs laneOf)
 *  even when run outside the lane runner. */
export function explicitFilesTimeoutMs(fileArgs) {
  return fileArgs.some((arg) => /\.(slow|live|electron)\.test\.mjs$/.test(String(arg)))
    ? LONG_TEST_TIMEOUT_MS
    : DEFAULT_TEST_TIMEOUT_MS;
}

// A batch that has not exited by then is killed with its process tree and
// fails the run; MIXDOG_TEST_BATCH_TIMEOUT_MS overrides the default.
const DEFAULT_BATCH_TIMEOUT_MS = 60 * 60 * 1000;
const minutes = (ms) => Number((ms / 60_000).toFixed(2));

// Runs a helper command to completion and returns its stdout.
function capture(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    let out = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      out += chunk;
    });
    child.on('error', (error) => {
      console.error(`${command} failed: ${error.message}`);
      resolve('');
    });
    child.on('close', () => resolve(out));
  });
}

// Kills a process and every descendant still linked to it. On POSIX a batch
// leads its own process group (spawned detached), so the group goes with it.
async function killTree(pid) {
  if (process.platform === 'win32') {
    await capture('taskkill', ['/T', '/F', '/PID', String(pid)]);
    return;
  }
  for (const target of [-pid, pid]) {
    try {
      process.kill(target, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
}

// Every live process: { pid, ppid, created (epoch ms), exe ('' when unknown) }.
// POSIX ps only reports elapsed seconds, so its creation times are ±1 s.
async function processSnapshot() {
  if (process.platform === 'win32') {
    const out = await capture('powershell', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      "Get-CimInstance Win32_Process | Where-Object CreationDate | ForEach-Object { '{0} {1} {2} {3}' -f $_.ProcessId, $_.ParentProcessId, ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds(), $_.ExecutablePath }",
    ]);
    return out
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const [pid, ppid, created, ...exe] = line.split(' ');
        return { pid: Number(pid), ppid: Number(ppid), created: Number(created), exe: exe.join(' ') };
      });
  }
  const now = Date.now();
  const out = await capture('ps', ['-A', '-o', 'pid=,ppid=,etime=']);
  return out
    .split('\n')
    .map((line) => line.trim().split(/\s+/))
    .filter((fields) => fields.length === 3)
    .map(([pid, ppid, etime]) => {
      // [[dd-]hh:]mm:ss
      const [days, clock] = etime.includes('-') ? etime.split('-') : ['0', etime];
      const seconds = clock.split(':').reduce((total, part) => total * 60 + Number(part), Number(days) * 86_400);
      return { pid: Number(pid), ppid: Number(ppid), created: now - seconds * 1000, exe: '' };
    });
}

const CLOCK_SLACK_MS = 2000;

// The processes this run owns, out of a snapshot: an anchor (the batch, or a
// child a test process recorded in its spawn ledger) still alive under its
// pid, the orphans an exited anchor left (they still name it as their parent;
// a later process that reuses its pid only has younger children), every
// descendant of those, and anything executing from the run's scratch root
// (e.g. the postgres the memory runtime downloads into MIXDOG_DATA_DIR).
// Command-line text never makes a process the run's: an editor or terminal
// opened on the scratch root is not.
export function ownedProcesses(snapshot, anchors, { batchStart, scratchDir, platform = process.platform }) {
  const byPid = new Map(snapshot.map((entry) => [entry.pid, entry]));
  const childrenOf = new Map();
  for (const entry of snapshot) childrenOf.set(entry.ppid, [...(childrenOf.get(entry.ppid) ?? []), entry]);
  const owned = new Map();
  const queue = [];
  const claim = (entry) => {
    if (entry.pid === process.pid || owned.has(entry.pid)) return;
    owned.set(entry.pid, entry);
    queue.push(entry);
  };
  for (const { pid, since } of anchors) {
    const holder = byPid.get(pid);
    if (holder && holder.created >= batchStart - CLOCK_SLACK_MS && holder.created <= since + CLOCK_SLACK_MS) {
      claim(holder);
      continue;
    }
    for (const orphan of childrenOf.get(pid) ?? []) {
      if (orphan.created >= since - CLOCK_SLACK_MS && (!holder || orphan.created < holder.created)) claim(orphan);
    }
  }
  const fold = (path) => (platform === 'win32' ? path.toLowerCase() : path);
  // An empty scratchDir skips the sweep: batches running side by side share
  // one scratch root, so one batch's exit must not claim its peers' processes.
  const scratchPrefix = scratchDir ? fold(join(scratchDir, '/')) : null;
  if (scratchPrefix)
    for (const entry of snapshot) if (entry.exe && fold(entry.exe).startsWith(scratchPrefix)) claim(entry);
  while (queue.length > 0) {
    const parent = queue.pop();
    for (const entry of childrenOf.get(parent.pid) ?? []) {
      if (entry.created >= parent.created - CLOCK_SLACK_MS) claim(entry);
    }
  }
  return [...owned.values()];
}

async function readSpawnLedger(path) {
  const text = await readFile(path, 'utf8').catch(() => '');
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [pid, since] = line.split(' ').map(Number);
      return { pid, since };
    });
}

// A process a test leaves running must not outlive its batch: it can hold a
// port, a database, or files in the scratch root the run removes at the end.
async function reapLeftovers(child, { batchStart, ledger, scratchDir }) {
  // The batch itself has exited: only its process group can remain.
  if (process.platform !== 'win32' && child.pid) {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      /* the group is empty */
    }
  }
  const anchors = [...(child.pid ? [{ pid: child.pid, since: batchStart }] : []), ...(await readSpawnLedger(ledger))];
  await killOwned(anchors, { batchStart, scratchDir });
}

async function killOwned(anchors, { batchStart, scratchDir }) {
  const leftovers = ownedProcesses(await processSnapshot(), anchors, { batchStart, scratchDir });
  if (leftovers.length === 0) return;
  const pids = leftovers.map((entry) => entry.pid);
  console.error(`Killing ${pids.length} process(es) a test left running: ${pids.join(' ')}`);
  if (process.platform === 'win32') {
    await capture('taskkill', ['/T', '/F', ...pids.flatMap((pid) => ['/PID', String(pid)])]);
    return;
  }
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
}

// Resolves { code, hung } once the batch exited and its leftovers are gone.
// `scratchDir` '' = leave the scratch-root sweep to the caller (side-by-side batches).
function spawnBatch(args, env, { files, ledger, scratchDir, timeoutMs }) {
  return new Promise((resolve) => {
    const batchStart = Date.now();
    const child = spawn(process.execPath, args, { stdio: 'inherit', env, detached: process.platform !== 'win32' });
    let hung = '';
    const watchdog = setTimeout(() => {
      hung = `hung after ${minutes(timeoutMs)} min: ${files.join(' ') || '(discovered files)'}`;
      console.error(`Test batch ${hung}; killing its process tree`);
      void killTree(child.pid);
    }, timeoutMs);
    // A detached POSIX batch no longer gets the terminal's signals itself.
    const forward = (signal) => {
      try {
        process.kill(-child.pid, signal);
      } catch {
        /* already gone */
      }
    };
    const signals = process.platform === 'win32' ? [] : ['SIGINT', 'SIGTERM'];
    for (const signal of signals) process.on(signal, forward);
    const settle = async (code) => {
      clearTimeout(watchdog);
      for (const signal of signals) process.off(signal, forward);
      await reapLeftovers(child, { batchStart, ledger, scratchDir });
      resolve({ code: hung ? 1 : code, hung });
    };
    child.on('error', (error) => {
      console.error(error);
      void settle(1);
    });
    child.on('exit', (code, signal) => void settle(code ?? (signal ? 1 : 0)));
  });
}

// rm's own maxRetries re-walks the tree on every nested retry, so one held
// file a few directories down multiplied its delay into hours. Each pass here
// is a single bounded walk.
async function removeScratch(dir) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await rm(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt === 5) {
        console.error(`Test scratch left behind (${error.code}): ${dir}`);
        return;
      }
      await delay(200 * attempt);
    }
  }
}

// The failure reporter writes one JSON line per failed test; a spawn that
// died before Node opened its destination leaves no file at all.
async function readFailureRecords(path) {
  const text = await readFile(path, 'utf8').catch(() => '');
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

// Both discovery and explicit-file runs use the same output contract. Node
// still owns test selection, diagnostics, skip/todo counts and exit status;
// a batched run keeps one full log and fails on the first failing batch.
//
// With `coverage`, every batch inherits one fresh NODE_V8_COVERAGE directory,
// so V8 writes a dump per test process into it and the batches fold into a
// single artifact. Without it nothing here changes — not the spawn options,
// not the environment, not the output.
//
// `rerunFailed` (default 0 = off) re-runs the files that failed, up to n
// times. A test that passes on a re-run is reported as flaky and, because the
// flag was passed, does not fail the run; a test that fails every re-run
// still exits 1. Every run ends with the failure summary block, so a filtered
// log can still name what failed.
//
// `testTimeoutMs` is the per-file --test-timeout default (see testTimeoutArg).
export async function runNodeTests(
  nodeArgs,
  fileArgs,
  { argBudget = ARG_BUDGET, coverage = false, rerunFailed = 0, testTimeoutMs = DEFAULT_TEST_TIMEOUT_MS } = {}
) {
  await pruneStaleTestLogs(tmpdir());
  const logPath = join(await mkdtemp(join(tmpdir(), TEST_LOG_PREFIX)), 'full.log');
  console.error(`Full test log: ${logPath}`);
  // Failure records live outside the log directory: the log directory holds
  // exactly one merged log, and these records are an internal artifact.
  const failureDir = await mkdtemp(join(tmpdir(), 'mixdog-test-failures-'));
  // Test processes get a private temp root that is removed after the run, so
  // every fixture directory a test forgets to delete goes with it instead of
  // piling up in the system temp directory.
  const scratchDir = await mkdtemp(join(tmpdir(), 'mixdog-test-scratch-'));
  // The explicit entry also accepts Node options alongside its file paths.
  const concurrencyArg = testConcurrencyArg([...nodeArgs, ...fileArgs]);
  const timeoutArg = testTimeoutArg([...nodeArgs, ...fileArgs], process.env, testTimeoutMs);
  const runArgs = [
    ...nodeArgs,
    ...(concurrencyArg ? [concurrencyArg] : []),
    ...(timeoutArg ? [timeoutArg] : []),
    // Node's test runner passes --import on to every test file process.
    `--import=${SPAWN_LEDGER}`,
    `--test-reporter=${SUMMARY_REPORTER}`,
    '--test-reporter-destination=stdout',
    '--test-reporter=spec',
  ];
  const fixedCost =
    argCost(process.execPath) +
    runArgs.reduce((total, arg) => total + argCost(arg), 0) +
    argCost(`--test-reporter-destination=${logPath}`) +
    argCost('.999') + // the per-batch log suffix
    argCost('--test-concurrency=999'); // the per-batch share when batches overlap
  const batches = chunkFileArgs(fileArgs, Math.max(argBudget - fixedCost, 1));
  // Batches run side by side (a sequential second batch idled the machine
  // behind the first one's slowest file), so the run's concurrency is split
  // across them instead of multiplied.
  const overlapped = batches.length > 1;
  const totalConcurrency = overlapped ? concurrencyOf(runArgs, fileArgs) : 0;
  const batchRunArgs = () => {
    if (!overlapped) return runArgs;
    const share = Math.max(1, Math.ceil(totalConcurrency / batches.length));
    return [...withoutConcurrency(runArgs), `--test-concurrency=${share}`];
  };
  const coverageDir = coverage ? await mkdtemp(join(tmpdir(), 'mixdog-v8-coverage-')) : '';
  // Node 24's test runner rebuilds each test process's execArgv from its option
  // table and drops V8 flags on the way, so a heap cap passed to the runner no
  // longer reached a test (a 128 MB cap ran with the default 4 GB). The
  // environment still reaches every test process.
  const heapOptions = nodeArgs.filter((arg) => HEAP_FLAG.test(arg));
  const nodeOptions = [process.env.NODE_OPTIONS, ...heapOptions].filter(Boolean).join(' ');
  // Failure records travel by environment, not argv: the command line is
  // already budgeted, and a third reporter would warn about listeners.
  const childEnv = (recordsPath) => ({
    ...process.env,
    ...testIsolationEnv(scratchDir),
    // Only the immutable validator binary is shared; fixture data stays private.
    // A gate supplies one directory across lanes; a standalone run owns its own.
    MIXDOG_TEST_OOXML_CACHE_DIR: process.env.MIXDOG_TEST_OOXML_CACHE_DIR || join(scratchDir, 'ooxml-cache'),
    [FAILURE_RECORDS_ENV]: recordsPath,
    ...(coverageDir ? { NODE_V8_COVERAGE: coverageDir } : {}),
    ...(nodeOptions ? { NODE_OPTIONS: nodeOptions } : {}),
  });
  const batchOptions = (files, recordsPath, sweepScratch = true) => ({
    files,
    ledger: spawnLedgerPath(recordsPath),
    scratchDir: sweepScratch ? scratchDir : '',
    timeoutMs: positiveInt(process.env.MIXDOG_TEST_BATCH_TIMEOUT_MS) ?? DEFAULT_BATCH_TIMEOUT_MS,
  });
  let status = 0;
  const failures = [];
  const hung = [];
  const batchLogOf = (index) => (batches.length === 1 ? logPath : `${logPath}.${index + 1}`);
  const batchFailuresOf = (index) => join(failureDir, `batch-${index + 1}.jsonl`);
  const outcomes = await Promise.all(
    batches.map((batch, index) =>
      spawnBatch(
        [...batchRunArgs(), `--test-reporter-destination=${batchLogOf(index)}`, ...batch],
        childEnv(batchFailuresOf(index)),
        batchOptions(batch, batchFailuresOf(index), !overlapped)
      )
    )
  );
  // Peers were still running while each batch exited, so the scratch root's
  // own processes (e.g. a postgres a test started) are swept once, here.
  if (overlapped) await killOwned([], { batchStart: Date.now(), scratchDir });
  // Logs and records merge in batch order, whatever order the batches finished.
  for (const [index, outcome] of outcomes.entries()) {
    const batchLog = batchLogOf(index);
    const batchFailures = batchFailuresOf(index);
    const { code } = outcome;
    if (outcome.hung) hung.push(outcome.hung);
    if (batchLog !== logPath) {
      await appendFile(logPath, await readFile(batchLog));
      await rm(batchLog, { force: true });
    }
    failures.push(...(await readFailureRecords(batchFailures)));
    if (status === 0) status = code;
  }

  const attempts = [];
  let lastAttemptStatus = 0;
  let pending = failures;
  for (let attempt = 1; attempt <= rerunFailed && pending.length > 0; attempt += 1) {
    const files = [...new Set(pending.map((record) => record.file))];
    console.error(`Re-running ${files.length} failed file(s): attempt ${attempt}/${rerunFailed}`);
    const attemptLog = `${logPath}.rerun-${attempt}`;
    const attemptFailures = join(failureDir, `rerun-${attempt}.jsonl`);
    const outcome = await spawnBatch(
      [...runArgs, `--test-reporter-destination=${attemptLog}`, ...files],
      childEnv(attemptFailures),
      batchOptions(files, attemptFailures)
    );
    lastAttemptStatus = outcome.code;
    if (outcome.hung) hung.push(outcome.hung);
    await appendFile(logPath, await readFile(attemptLog));
    await rm(attemptLog, { force: true });
    attempts.push({ files, failures: await readFailureRecords(attemptFailures) });
    pending = classifyRerunOutcomes(failures, attempts).failed;
  }
  const { failed, flaky } = classifyRerunOutcomes(failures, attempts);
  // Flaky tolerance applies only to an ordinary test-failure exit that the
  // re-runs fully explained: nothing failed twice and the last re-run itself
  // came back clean.
  // A hung batch is never explained by re-runs.
  if (
    rerunFailed > 0 &&
    status === 1 &&
    hung.length === 0 &&
    failed.length === 0 &&
    flaky.length > 0 &&
    lastAttemptStatus === 0
  )
    status = 0;
  process.exitCode = status;

  await rm(failureDir, { recursive: true, force: true });
  // Leftover processes are already killed; what a process outside the run
  // still holds stays behind.
  await removeScratch(scratchDir);
  if (coverageDir) {
    const { reportCoverage } = await import('./coverage.mjs');
    await reportCoverage(coverageDir);
    await rm(coverageDir, { recursive: true, force: true });
  }
  // Last line of the run, after every reporter and the coverage report.
  process.stdout.write(`\n${formatFailureSummary({ failed, flaky, rerunFailed, hung, exitCode: status })}`);
}
