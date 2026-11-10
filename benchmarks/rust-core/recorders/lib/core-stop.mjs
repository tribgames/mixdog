// Ends a mixdogd a replay started, with everything it started. The core is asked to stop as the app's own quit does (`ctl stop --when-idle`):
// its stop sequence stops the PostgreSQL it started (the memory stop step, as Node's shutdown does, daemon.mjs:375-386). A core that does not
// exit within the deadline is ended with its process tree. `pg_ctl start` leaves the postmaster outside the core's tree (in Node as here,
// process.mjs:378-385), so a postmaster still running after the core is gone is ended by the pid it recorded in `<data>/pgdata/postmaster.pid`.
// The core's other children (an `initdb` it cancelled, a terminal's shell) run in the job its process helper holds, which the OS ends once
// that helper has seen the core go: they are waited for, with one deadline. Resolves once every one of them has exited; a stop that needed
// force rejects, naming what was forced.
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;

const within = (promise, what, ms) => {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = realSetTimeout(() => reject(new Error(`${what} (not within ${ms} ms)`)), ms);
  });
  return Promise.race([promise, deadline]).finally(() => realClearTimeout(timer));
};

const powershell = (command, ms) =>
  spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8', windowsHide: true, timeout: ms + 30_000 });

const killTree = (pid) => {
  const ended = spawnSync('taskkill', ['/T', '/F', '/PID', String(pid)], { stdio: 'ignore', windowsHide: true, timeout: 30_000 });
  // 128: the pid no longer exists.
  if (ended.error || (ended.status !== 0 && ended.status !== 128)) throw new Error(`taskkill could not end pid ${pid}: ${ended.error?.message ?? `status ${ended.status}`}`);
};

/** The processes whose command line names `root` (the core's own folders): what the core started there. */
const childrenIn = (root) => {
  const listed = powershell(
    `Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -and $_.CommandLine.Contains('${root.replace(/'/g, "''")}') } | ForEach-Object { "$($_.ProcessId) $($_.Name)" }`,
    30_000
  );
  if (listed.error || listed.status !== 0) throw new Error(`could not list the processes in ${root}: ${listed.error?.message ?? listed.stderr}`);
  return listed.stdout.split(/\r?\n/).filter(Boolean).map((line) => ({ pid: Number(line.split(' ')[0]), name: line.split(' ').slice(1).join(' ') }));
};

/** Waits until each of `pids` has exited, at most `ms`; returns whether they all did. */
const exitedWithin = (pids, ms) => {
  if (!pids.length) return true;
  const waited = powershell(`Wait-Process -Id ${pids.join(',')} -Timeout ${Math.ceil(ms / 1000)} -ErrorAction SilentlyContinue; if (Get-Process -Id ${pids.join(',')} -ErrorAction SilentlyContinue) { exit 1 }`, ms);
  return !waited.error && waited.status === 0;
};

/** `child` is the spawned `mixdogd serve`; `env` the environment it was started with (the stop request finds it through it); `dataDir` its MIXDOG_DATA_DIR. */
export async function endCore({ exe, child, env, dataDir, ms = 60_000 }) {
  const forced = [];
  if (child.exitCode === null && child.signalCode === null) {
    const exited = new Promise((resolve) => child.once('exit', resolve));
    const stopped = new Promise((resolve, reject) => {
      const stop = spawn(exe, ['ctl', 'stop', '--when-idle', '--reason', 'userStop'], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      let said = '';
      stop.stdout.on('data', (chunk) => (said += chunk));
      stop.stderr.on('data', (chunk) => (said += chunk));
      stop.once('error', reject);
      stop.once('close', (status) => (status === 0 ? resolve() : reject(new Error(`ctl stop exited ${status}: ${said.trim()}`))));
    }).then(() => exited);
    try {
      await within(stopped, `the core (pid ${child.pid}) to stop when asked`, ms);
    } catch (error) {
      forced.push(`the core: ${error.message}`);
      killTree(child.pid);
      await within(exited, `the core (pid ${child.pid}) to exit after taskkill`, 30_000);
    }
  }
  let postmaster = null;
  try {
    postmaster = Number(readFileSync(join(dataDir, 'pgdata', 'postmaster.pid'), 'utf8').split(/\r?\n/)[0]);
  } catch {}
  if (postmaster && !exitedWithin([postmaster], 0)) {
    forced.push(`its PostgreSQL (pid ${postmaster}) outlived it`);
    killTree(postmaster);
    if (!exitedWithin([postmaster], 30_000)) throw new Error(`the postmaster (pid ${postmaster}) still runs 30 s after taskkill`);
  }
  const root = dirname(dataDir);
  const children = childrenIn(root);
  if (!exitedWithin(children.map(({ pid }) => pid), 30_000)) {
    const left = childrenIn(root);
    forced.push(`still running 30 s after it exited: ${left.map(({ pid, name }) => `${name} (pid ${pid})`).join(', ')}`);
    for (const { pid } of left) killTree(pid);
  }
  if (forced.length) throw new Error(`the core's stop needed force: ${forced.join('; ')}`);
}
