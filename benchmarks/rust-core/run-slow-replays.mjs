#!/usr/bin/env node
// Every slow replay of the phone page (apps/desktop/src/renderer/remote-protocol-*.slow.test.mjs, remote-shim-*.slow.test.mjs) against one
// built mixdogd, a few at a time, each in a temp folder of its own. Builds nothing: the core is the argument, built with
// `--features "terminal-lease-clock replay-controls"`. Prints one line per test and exits 1 on any failure, a deadline, a process the
// test left running, or a check of that which could not be made.
//   node benchmarks/rust-core/run-slow-replays.mjs <path to mixdogd.exe> [--jobs N]
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DESKTOP = fileURLToPath(new URL('../../apps/desktop/', import.meta.url));
// A replay over 5 minutes is a defect of its own; the deadline leaves room to see by how much.
const DEADLINE_MS = 15 * 60_000;
const SLOW_MS = 5 * 60_000;

/** Processes whose command line names a path inside `dir`: what a test started there and left behind. A listing that could not be made
 *  throws: it never reads as "nothing left". */
export function leftIn(dir, powershell = 'powershell.exe') {
  // With the separator, so a test's folder never matches a sibling whose name starts with it (`files` and `files-downloads`).
  const inside = `${dir}\\`.replace(/'/g, "''");
  const listed = spawnSync(
    powershell,
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `$ErrorActionPreference = 'Stop'; Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -and $_.CommandLine.Contains('${inside}') } | ForEach-Object { "$($_.ProcessId) $($_.Name)|started $($_.CreationDate.ToString('HH:mm:ss.fff')), parent $($_.ParentProcessId): $($_.CommandLine)" }`,
    ],
    { encoding: 'utf8', windowsHide: true, timeout: 60_000 }
  );
  if (listed.error || listed.status !== 0) {
    throw new Error(`the listing of the processes left in ${dir} failed: ${listed.error?.message ?? `exit ${listed.status}: ${listed.stderr.trim()}`}`);
  }
  return listed.stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => ({ short: line.split('|')[0], detail: line }));
}

/** Ends the process tree of `pid`; returns why it could not, or null. */
export function killTree(pid, taskkill = 'taskkill') {
  const ended = spawnSync(taskkill, ['/T', '/F', '/PID', String(pid)], { encoding: 'utf8', windowsHide: true, timeout: 30_000 });
  if (ended.error) return ended.error.message;
  // 128: the process had ended already.
  return ended.status === 0 || ended.status === 128 ? null : `exit ${ended.status}: ${(ended.stderr || ended.stdout).trim()}`;
}

/** Runs one test (`command args` in `cwd`) and settles with its result; never waits past `deadlineMs`, whatever ending it did. `dir` is
 *  the test's own folder (what is left running there is ended and counted), `log` where its output is written. */
export function runTest({ name, dir, log, command, args, cwd, env, deadlineMs = DEADLINE_MS, powershell, taskkill }) {
  const started = Date.now();
  return new Promise((done) => {
    const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let out = '';
    child.stdout.on('data', (chunk) => (out += chunk));
    child.stderr.on('data', (chunk) => (out += chunk));
    let settled = false;
    const settle = (problems) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const seconds = (Date.now() - started) / 1000;
      let left = [];
      try {
        left = leftIn(dir, powershell);
      } catch (error) {
        problems.push(error.message);
      }
      for (const { short } of left) {
        const why = killTree(Number(short.split(' ')[0]), taskkill);
        if (why) problems.push(`could not end ${short}: ${why}`);
      }
      if (left.length) problems.push(`left running: ${left.map(({ short }) => short).join(', ')}`);
      if (seconds * 1000 > SLOW_MS) problems.push('over 5 minutes');
      const count = (key) => Number(out.match(new RegExp(`^ℹ ${key} (\\d+)`, 'm'))?.[1] ?? NaN);
      writeFileSync(log, `${out}${left.length ? `\nleft running at ${new Date().toISOString()}:\n${left.map(({ detail }) => detail).join('\n')}\n` : ''}`);
      done({ name, pid: child.pid, tests: count('tests'), pass: count('pass'), fail: count('fail'), seconds, problems });
    };
    // The deadline settles the run as failed whatever the ending of the test's tree did.
    const timer = setTimeout(() => {
      const why = killTree(child.pid, taskkill);
      settle([`deadline of ${deadlineMs / 1000} s`, ...(why ? [`ending the test (pid ${child.pid}) failed: ${why}`] : [])]);
    }, deadlineMs);
    child.once('error', (error) => settle([`the test did not start: ${error.message}`]));
    child.once('exit', (code) => settle(code === 0 ? [] : [`exit ${code}`]));
  });
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
    return runTest({ name, dir, log: join(base, `${name}.log`), command: process.execPath, args, cwd: DESKTOP, env });
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
