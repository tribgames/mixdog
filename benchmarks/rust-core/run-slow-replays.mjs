#!/usr/bin/env node
// Every slow replay of the phone page (apps/desktop/src/renderer/remote-protocol-*.slow.test.mjs, remote-shim-*.slow.test.mjs) against one
// built mixdogd, a few at a time, each in a temp folder of its own. Builds nothing: the core is the argument, built with
// `--features "terminal-lease-clock replay-controls"`. Prints one line per test and exits 1 on any failure, a deadline, or a process the
// test left running.
//   node benchmarks/rust-core/run-slow-replays.mjs <path to mixdogd.exe> [--jobs N]
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DESKTOP = fileURLToPath(new URL('../../apps/desktop/', import.meta.url));
// A replay over 5 minutes is a defect of its own; the deadline leaves room to see by how much.
const DEADLINE_MS = 15 * 60_000;
const SLOW_MS = 5 * 60_000;

const args = process.argv.slice(2);
const jobsAt = args.indexOf('--jobs');
const jobs = jobsAt >= 0 ? Number(args.splice(jobsAt, 2)[1]) : 3;
const exe = args[0] && resolve(args[0]);
if (!exe || !existsSync(exe) || !(jobs >= 1)) {
  console.error('usage: node benchmarks/rust-core/run-slow-replays.mjs <path to mixdogd.exe> [--jobs N]');
  process.exit(2);
}

const renderer = join(DESKTOP, 'src', 'renderer');
const tests = readdirSync(renderer).filter((name) => /^remote-(protocol|shim)-.*\.slow\.test\.mjs$/.test(name)).sort();
const base = mkdtempSync(join(tmpdir(), 'slow-replays-'));

/** Processes whose command line names a path inside `dir`: what a test started there and left behind. */
const leftIn = (dir) => {
  // With the separator, so a test's folder never matches a sibling whose name starts with it (`files` and `files-downloads`).
  const inside = `${dir}\\`.replace(/'/g, "''");
  const listed = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -and $_.CommandLine.Contains('${inside}') } | ForEach-Object { "$($_.ProcessId) $($_.Name)|started $($_.CreationDate.ToString('HH:mm:ss.fff')), parent $($_.ParentProcessId): $($_.CommandLine)" }`],
    { encoding: 'utf8', windowsHide: true, timeout: 60_000 });
  return listed.stdout.split(/\r?\n/).filter(Boolean).map((line) => ({ short: line.split('|')[0], detail: line }));
};
const killTree = (pid) => spawnSync('taskkill', ['/T', '/F', '/PID', String(pid)], { stdio: 'ignore', windowsHide: true, timeout: 30_000 });

function run(name) {
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
  const started = Date.now();
  return new Promise((done) => {
    const child = spawn(process.execPath, ['--import', './scripts/test-env.mjs', '--import', './scripts/test-tsx.mjs', '--test', '--test-reporter=spec', `src/renderer/${name}`],
      { cwd: DESKTOP, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let out = '';
    child.stdout.on('data', (chunk) => (out += chunk));
    child.stderr.on('data', (chunk) => (out += chunk));
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
    }, DEADLINE_MS);
    child.once('exit', (code) => {
      clearTimeout(timer);
      const seconds = (Date.now() - started) / 1000;
      const left = leftIn(dir);
      for (const { short } of left) killTree(Number(short.split(' ')[0]));
      const count = (key) => Number(out.match(new RegExp(`^ℹ ${key} (\\d+)`, 'm'))?.[1] ?? NaN);
      const problems = [];
      if (timedOut) problems.push(`deadline of ${DEADLINE_MS / 1000} s`);
      else if (code !== 0) problems.push(`exit ${code}`);
      if (left.length) problems.push(`left running: ${left.map(({ short }) => short).join(', ')}`);
      if (seconds * 1000 > SLOW_MS) problems.push('over 5 minutes');
      writeFileSync(join(base, `${name}.log`), `${out}${left.length ? `\nleft running at ${new Date().toISOString()}:\n${left.map(({ detail }) => detail).join('\n')}\n` : ''}`);
      done({ name, tests: count('tests'), pass: count('pass'), fail: count('fail'), seconds, problems });
    });
  });
}

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
