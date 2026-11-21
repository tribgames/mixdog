import { spawn } from 'node:child_process';
import { appendFile, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { availableParallelism, tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pruneStaleTempDirs } from './stale-temp.mjs';
import { FAILURE_RECORDS_ENV, spawnLedgerPath } from './test-failure-records.mjs';
import { classifyRerunOutcomes, formatFailureSummary } from './test-failure-summary.mjs';

const SUMMARY_REPORTER = new URL('./test-summary-reporter.mjs', import.meta.url).href;
const SPAWN_LEDGER = new URL('./test-spawn-ledger.mjs', import.meta.url).href;

// Windows caps a command line at 32767 characters (CreateProcess); POSIX caps argv+env at ARG_MAX.
export const ARG_BUDGET = process.platform === 'win32' ? 30_000 : 1_000_000;

const HEAP_FLAG = /^--(?:max-old-space-size|max-semi-space-size)=\d+$/;

// An argument costs its own characters plus the separator and its quotes.
const argCost = (arg) => arg.length + 3;

const TEST_LOG_PREFIX = 'mixdog-test-output-';
const TEST_FAILURES_PREFIX = 'mixdog-test-failures-';
const TEST_SCRATCH_PREFIX = 'mixdog-test-scratch-';
export const RUNNER_TEMP_PREFIXES = [TEST_LOG_PREFIX, TEST_FAILURES_PREFIX, TEST_SCRATCH_PREFIX];
// Printed first by every run; the local gate finds a dead unit's log by it.
export const FULL_LOG_LABEL = 'Full test log: ';

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

// A --test-timeout flag wins, then MIXDOG_TEST_TIMEOUT_MS (0 turns the bound off), then the
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
  let value = null;
  if (index >= 0) value = positiveInt(args[index].includes('=') ? args[index].split('=')[1] : args[index + 1]);
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
    // Config writes back the data dir up beside the home (~/.mixdog/backups),
    // not inside it, so the private data dir alone leaves them in the real one.
    MIXDOG_USER_DATA_BACKUP_ROOT: join(scratchDir, 'backups'),
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

async function loadKillProcessTrees() {
  const { killProcessTrees } = await import('../../src/runtime/agent/orchestrator/mcp/child-tree.mjs');
  return killProcessTrees;
}

async function killTree(pid) {
  if (process.platform === 'win32') {
    await (await loadKillProcessTrees())([pid]);
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

// Windows reports creation to the microsecond; POSIX ps only whole elapsed seconds.
// Windows reuses a freed pid within milliseconds, so a 2 s window there claimed another run's process.
const clockSlackMs = (platform) => (platform === 'win32' ? 50 : 2000);

// The processes a run owns: live anchors, the orphans of exited anchors, every descendant, and anything
// executing from scratchDir. An anchor is { pid, before, since, exited? }: the clock around its spawn
// and when its exit was seen. A pid alone never identifies a process: a live holder was created within
// the anchor's spawn, an orphan while its anchor lived, a descendant after its parent.
export function ownedProcesses(snapshot, anchors, { scratchDir, platform = process.platform }) {
  const slack = clockSlackMs(platform);
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
  for (const { pid, before, since, exited } of anchors) {
    const holder = byPid.get(pid);
    if (holder && exited === undefined && holder.created >= before - slack && holder.created <= since + slack) {
      claim(holder);
      continue;
    }
    for (const orphan of childrenOf.get(pid) ?? []) {
      if (
        orphan.created >= before - slack &&
        orphan.created <= (exited ?? Number.POSITIVE_INFINITY) + slack &&
        (!holder || orphan.created < holder.created)
      )
        claim(orphan);
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
      if (entry.created >= parent.created - slack) claim(entry);
    }
  }
  return [...owned.values()];
}

// One anchor per recorded spawn (scripts/lib/test-spawn-ledger.mjs): its
// "<pid> <before> <since>" line, with "<exited>" from the line that repeats
// it once the exit was seen.
async function readSpawnLedger(path) {
  const text = await readFile(path, 'utf8').catch(() => '');
  const spawns = new Map();
  for (const line of text.split('\n').filter(Boolean)) {
    const [pid, before, since, exited] = line.split(' ').map(Number);
    const key = `${pid} ${before} ${since}`;
    spawns.set(key, { ...(spawns.get(key) ?? { pid, before, since }), ...(exited ? { exited } : {}) });
  }
  return [...spawns.values()];
}

// A process a test leaves running must not outlive its batch: it can hold a
// port, a database, or files in the scratch root the run removes at the end.
// `batch` is the batch's own anchor, its exit already seen.
async function reapLeftovers(child, { batch, ledger, scratchDir }) {
  // The batch itself has exited: only its process group can remain.
  if (process.platform !== 'win32' && child.pid) {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      /* the group is empty */
    }
  }
  const anchors = [...(child.pid ? [batch] : []), ...(await readSpawnLedger(ledger))];
  await killOwned(anchors, { scratchDir });
}

async function killOwned(anchors, { scratchDir }) {
  // Every owned process ran when the snapshot was taken.
  const snapshotAt = Date.now();
  const leftovers = ownedProcesses(await processSnapshot(), anchors, { scratchDir });
  if (leftovers.length === 0) return;
  const pids = leftovers.map((entry) => entry.pid);
  console.error(`Killing ${pids.length} process(es) a test left running: ${pids.join(' ')}`);
  if (process.platform === 'win32') {
    await (await loadKillProcessTrees())(pids, { aliveAt: snapshotAt });
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

// Resolves { code, hung, pid } once the batch exited and its leftovers are gone.
// `scratchDir` '' = leave the scratch-root sweep to the caller (side-by-side batches).
function spawnBatch(args, env, { files, ledger, scratchDir, timeoutMs }) {
  return new Promise((resolve) => {
    const before = Date.now();
    const child = spawn(process.execPath, args, { stdio: 'inherit', env, detached: process.platform !== 'win32' });
    const since = Date.now();
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
      const batch = { pid: child.pid, before, since, exited: Date.now() };
      clearTimeout(watchdog);
      for (const signal of signals) process.off(signal, forward);
      await reapLeftovers(child, { batch, ledger, scratchDir });
      resolve({ code: hung ? 1 : code, hung, pid: child.pid });
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
async function removeTempDir(dir) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await rm(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt === 5) {
        console.error(`Test temp dir left behind (${error.code}): ${dir}`);
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

// `coverage`: every batch inherits one fresh NODE_V8_COVERAGE directory, folded into a single artifact.
// `rerunFailed` (0 = off): re-runs the failed files up to n times; a test that passes on a re-run is
// flaky and does not fail the run, one that fails every re-run exits 1.
// `testTimeoutMs`: the per-file --test-timeout default (see testTimeoutArg).
export async function runNodeTests(nodeArgs, fileArgs, options = {}) {
  pruneStaleTempDirs(RUNNER_TEMP_PREFIXES);
  const outputDir = await mkdtemp(join(tmpdir(), TEST_LOG_PREFIX));
  const logPath = join(outputDir, 'full.log');
  console.error(`${FULL_LOG_LABEL}${logPath}`);
  // Failure records live outside the log directory: the log directory holds
  // exactly one merged log, and these records are an internal artifact.
  const failureDir = await mkdtemp(join(tmpdir(), TEST_FAILURES_PREFIX));
  // macOS aliases /var to /private/var, and child tools report the resolved cwd.
  const scratchDir = await realpath(await mkdtemp(join(tmpdir(), TEST_SCRATCH_PREFIX)));
  let status = 1;
  try {
    status = await executeRun(nodeArgs, fileArgs, options, { logPath, failureDir, scratchDir });
  } finally {
    await removeTempDir(failureDir);
    // Leftover processes are already killed; what a process outside the run
    // still holds stays behind.
    await removeTempDir(scratchDir);
    // A throw keeps the log too: the run did not pass.
    if (status === 0) await removeTempDir(outputDir);
  }
}

// The runner's argv and how the files split into batches that fit the argument budget.
function planBatches(nodeArgs, fileArgs, { argBudget, testTimeoutMs }, logPath) {
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
  return { runArgs, batches, overlapped, batchRunArgs };
}

// Re-runs the files that failed, up to `rerunFailed` times, merging each attempt's log into the run's.
async function rerunFailures({ failures, rerunFailed, runArgs, childEnv, batchOptions, logPath, failureDir, hung }) {
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
  return { attempts, lastAttemptStatus };
}

// Runs the batches side by side and merges their logs and failure records in batch order.
async function runBatches(
  { batches, overlapped, batchRunArgs },
  { childEnv, batchOptions, logPath, failureDir, scratchDir }
) {
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
  // Peers were still running while each batch exited, so the scratch root is swept once, here.
  if (overlapped) await killOwned([], { scratchDir });
  for (const [index, outcome] of outcomes.entries()) {
    const batchLog = batchLogOf(index);
    if (outcome.hung) hung.push(outcome.hung);
    if (batchLog !== logPath) {
      await appendFile(logPath, await readFile(batchLog));
      await rm(batchLog, { force: true });
    }
    failures.push(...(await readFailureRecords(batchFailuresOf(index))));
    if (status === 0) status = outcome.code;
  }
  return { outcomes, failures, hung, status };
}

function batchSpawnSettings(nodeArgs, { coverageDir, scratchDir }) {
  // Node 24's test runner drops V8 flags from each test process's execArgv; the environment still reaches it.
  const heapOptions = nodeArgs.filter((arg) => HEAP_FLAG.test(arg));
  const nodeOptions = [process.env.NODE_OPTIONS, ...heapOptions].filter(Boolean).join(' ');
  const childEnv = (recordsPath) => ({
    ...process.env,
    ...testIsolationEnv(scratchDir),
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
  return { childEnv, batchOptions };
}

async function executeRun(
  nodeArgs,
  fileArgs,
  { argBudget = ARG_BUDGET, coverage = false, rerunFailed = 0, testTimeoutMs = DEFAULT_TEST_TIMEOUT_MS },
  { logPath, failureDir, scratchDir }
) {
  const { runArgs, batches, overlapped, batchRunArgs } = planBatches(
    nodeArgs,
    fileArgs,
    { argBudget, testTimeoutMs },
    logPath
  );
  const coverageDir = coverage ? await mkdtemp(join(tmpdir(), 'mixdog-v8-coverage-')) : '';
  const { childEnv, batchOptions } = batchSpawnSettings(nodeArgs, { coverageDir, scratchDir });
  const {
    outcomes,
    failures,
    hung,
    status: batchStatus,
  } = await runBatches(
    { batches, overlapped, batchRunArgs },
    { childEnv, batchOptions, logPath, failureDir, scratchDir }
  );
  let status = batchStatus;

  const { attempts, lastAttemptStatus } = await rerunFailures({
    failures,
    rerunFailed,
    runArgs,
    childEnv,
    batchOptions,
    logPath,
    failureDir,
    hung,
  });
  const { failed, flaky } = classifyRerunOutcomes(failures, attempts);
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

  if (coverageDir) {
    const { reportCoverage } = await import('./coverage.mjs');
    await reportCoverage(coverageDir);
    await rm(coverageDir, { recursive: true, force: true });
  }
  const pids = outcomes.filter((outcome) => outcome.code !== 0 && outcome.pid).map((outcome) => outcome.pid);
  process.stdout.write(`\n${formatFailureSummary({ failed, flaky, rerunFailed, hung, exitCode: status, pids })}`);
  return status;
}
