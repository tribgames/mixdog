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

/** Processes whose command line names `dir`: what a test started there and left behind. */
const leftIn = (dir) => {
  const listed = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -and $_.CommandLine.Contains('${dir.replace(/'/g, "''")}') } | ForEach-Object { "$($_.ProcessId) $($_.Name)" }`],
    { encoding: 'utf8', windowsHide: true, timeout: 60_000 });
  return listed.stdout.split(/\r?\n/).filter(Boolean);
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
      for (const line of left) killTree(Number(line.split(' ')[0]));
      const count = (key) => Number(out.match(new RegExp(`^ℹ ${key} (\\d+)`, 'm'))?.[1] ?? NaN);
      const problems = [];
      if (timedOut) problems.push(`deadline of ${DEADLINE_MS / 1000} s`);
      else if (code !== 0) problems.push(`exit ${code}`);
      if (left.length) problems.push(`left running: ${left.join(', ')}`);
      if (seconds * 1000 > SLOW_MS) problems.push('over 5 minutes');
      writeFileSync(join(base, `${name}.log`), out);
      done({ name, tests: count('tests'), pass: count('pass'), fail: count('fail'), seconds, problems });
    });
  });
}

const started = Date.now();
const queue = [...tests];
const results = [];
await Promise.all(
  Array.from({ length: Math.min(jobs, queue.length) }, async () => {
    while (queue.length) {
      const result = await run(queue.shift());
      results.push(result);
      const status = result.problems.length ? 'FAIL' : 'ok  ';
      console.log(`${status} ${result.name}  ${result.pass}/${result.tests} pass  ${result.seconds.toFixed(1)} s${result.problems.length ? `  (${result.problems.join('; ')})` : ''}`);
    }
  })
);
const failed = results.filter((result) => result.problems.length);
console.log(`${results.length} slow replays, ${failed.length} failed, ${((Date.now() - started) / 1000).toFixed(1)} s; logs in ${base}`);
process.exit(failed.length ? 1 : 0);
