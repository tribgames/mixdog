#!/usr/bin/env node
// Every slow replay of the phone page (apps/desktop/src/renderer/remote-protocol-*.slow.test.mjs, remote-shim-*.slow.test.mjs) against one
// built mixdogd, a few at a time, each in a temp folder of its own. Builds nothing: the core is the argument, built with
// `--features "terminal-lease-clock replay-controls"`. Prints one line per test and exits 1 on any failure, a deadline, a process the
// test left running, or an ending of its processes that failed. Each test runs in a Windows job of the runner's own
// (recorders/lib/process-job.mjs), and only that job's processes are ever ended: none is found by a listing, a name or a pid.
//   node benchmarks/rust-core/run-slow-replays.mjs <path to mixdogd.exe> [--jobs N]
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { openJob, spawnInJob } from './recorders/lib/process-job.mjs';

const DESKTOP = fileURLToPath(new URL('../../apps/desktop/', import.meta.url));
// A replay over 5 minutes is a defect of its own; the deadline leaves room to see by how much.
const DEADLINE_MS = 15 * 60_000;
const SLOW_MS = 5 * 60_000;
/** How long the job's guard may take for each of its answers. */
const ANSWER_MS = 10_000;
/** How long what a test left behind may take to end by itself once it exited (tsx's esbuild service ends when its pipe closes). */
const LEFT_GRACE_MS = 10_000;

/** Runs one test (`command args` in `cwd`) in a job of its own and settles with its result. Its ending (the job's processes ended and
 *  the job closed) has one deadline of its own after the test's, so the run settles by `deadlineMs` plus that, whatever the ending did.
 *  `log` is where its output is written; `started` (tests only) is told the job and the test's process once it runs. */
export async function runTest({ name, log, command, args, cwd, env, deadlineMs = DEADLINE_MS, answerMs = ANSWER_MS, started: told }) {
  const started = Date.now();
  let out = '';
  const problems = [];
  const result = (pid) => {
    const seconds = (Date.now() - started) / 1000;
    if (seconds * 1000 > SLOW_MS) problems.push('over 5 minutes');
    const count = (key) => Number(out.match(new RegExp(`^ℹ ${key} (\\d+)`, 'm'))?.[1] ?? NaN);
    writeFileSync(log, `${out}${problems.length ? `\n${problems.join('\n')}\n` : ''}`);
    return { name, pid, tests: count('tests'), pass: count('pass'), fail: count('fail'), seconds, problems };
  };
  let job;
  try {
    job = await openJob(`the slow replay ${name}`, { answerMs });
  } catch (error) {
    problems.push(`its job could not be made: ${error.message}`);
    return result(null);
  }
  let child = null;
  let ended;
  try {
    child = await spawnInJob(job, command, args, { cwd, env });
    child.stdout.on('data', (chunk) => (out += chunk));
    child.stderr.on('data', (chunk) => (out += chunk));
    told?.({ job, child });
    ended = await new Promise((done) => {
      const timer = setTimeout(() => done({ timedOut: true }), deadlineMs);
      child.once('exit', (code) => {
        clearTimeout(timer);
        done({ code });
      });
    });
    problems.push(...(ended.timedOut ? [`deadline of ${deadlineMs / 1000} s`] : ended.code === 0 ? [] : [`exit ${ended.code}`]));
  } catch (error) {
    ended = { timedOut: true };
    problems.push(`the test did not start: ${error.message}`);
  }
  // Past the test's deadline what is in the job is ended at once; otherwise it is given the grace first and counted as left running.
  const grace = ended.timedOut ? 0 : LEFT_GRACE_MS;
  const until = Date.now() + grace + 4 * answerMs;
  try {
    const left = await job.end(grace, until - 2 * answerMs);
    if (left > 0 && !ended.timedOut) problems.push(`left running: ${left} process(es), ended with its job`);
  } catch (error) {
    problems.push(`ending its job: ${error.message}`);
  }
  await job.close(until).catch((error) => problems.push(`closing its job: ${error.message}`));
  return result(child?.pid ?? null);
}

async function main() {
  const args = process.argv.slice(2);
  const jobsAt = args.indexOf('--jobs');
  const jobs = jobsAt >= 0 ? Number(args.splice(jobsAt, 2)[1]) : 3;
  const exe = args[0] && resolve(args[0]);
  if (!exe || !existsSync(exe) || !(jobs >= 1)) {
    console.error('usage: node benchmarks/rust-core/run-slow-replays.mjs <path to mixdogd.exe> [--jobs N]');
    process.exit(2);
  }
  const renderer = join(DESKTOP, 'src', 'renderer');
  const tests = readdirSync(renderer)
    .filter((name) => /^remote-(protocol|shim)-.*\.slow\.test\.mjs$/.test(name))
    .sort();
  const base = mkdtempSync(join(tmpdir(), 'slow-replays-'));
  const run = (name) => {
    const dir = join(base, name.replace(/\.slow\.test\.mjs$/, ''));
    mkdirSync(join(dir, 'tmp'), { recursive: true });
    const env = {
      ...process.env,
      MIXDOGD_BIN: exe,
      TEMP: join(dir, 'tmp'),
      TMP: join(dir, 'tmp'),
      TMPDIR: join(dir, 'tmp'),
      PHONE_FILES_REPLAY_WORLDS: join(dir, 'files-worlds'),
      // The live terminal replay's trace, kept beside its log for a failure's diagnosis.
      PHONE_TERMINAL_KEEP_TRACE: join(dir, 'terminal-trace.json'),
    };
    const args = ['--import', './scripts/test-env.mjs', '--import', './scripts/test-tsx.mjs', '--test', '--test-reporter=spec', `src/renderer/${name}`];
    return runTest({ name, log: join(base, `${name}.log`), command: process.execPath, args, cwd: DESKTOP, env });
  };
  const started = Date.now();
  const results = [];
  const report = (result) => {
    results.push(result);
    const status = result.problems.length ? 'FAIL' : 'ok  ';
    console.log(`${status} ${result.name}  ${result.pass}/${result.tests} pass  ${result.seconds.toFixed(1)} s${result.problems.length ? `  (${result.problems.join('; ')})` : ''}`);
  };
  // The live terminal replay runs alone first: where a PTY's chunks fall against the relay's 16 ms window decides the order of output and
  // activity changes, and Node's 50 runs were recorded on an otherwise idle machine; beside the database replays the console's chunks
  // arrive later and the core shows orders Node's rule gives for that timing but its recording never had.
  const ALONE = 'remote-protocol-terminal.slow.test.mjs';
  if (tests.includes(ALONE)) report(await run(ALONE));
  const queue = tests.filter((name) => name !== ALONE);
  await Promise.all(
    Array.from({ length: Math.min(jobs, queue.length) }, async () => {
      while (queue.length) report(await run(queue.shift()));
    })
  );
  const failed = results.filter((result) => result.problems.length);
  console.log(`${results.length} slow replays, ${failed.length} failed, ${((Date.now() - started) / 1000).toFixed(1)} s; logs in ${base}`);
  process.exit(failed.length ? 1 : 0);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) await main();
