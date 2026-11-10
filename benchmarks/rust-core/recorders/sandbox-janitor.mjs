#!/usr/bin/env node
// Ends what a recording of the Node product leaves in its sandbox profile, by ownership and never by a pid found in a listing
// (a listed process can exit and its pid be reused before a kill; ending a parent first invalidates the entries after it):
//   1. the PostgreSQL cluster the profile's data directory holds is stopped with the runtime's own `pg_ctl stop -m fast -D <pgdata>`
//      (the data directory is the cluster's identity; `pg_ctl status` before and after, every exit status checked);
//   2. a process whose command line still names the profile is NOT ended: the failure names it;
//   3. the profile folder is removed once, whatever failed before, and a failure names the path (a folder a process still holds stays
//      where its owner put it: the recorders keep their sandboxes under one folder that their next run empties first).
// The recorder runs this itself at the end of a recording (`endSandbox`), and starts this file as a detached process holding a pipe to
// it: the pipe reaches end-of-file when the recorder dies by any means, which is the cue to run the same steps for a recorder that could
// run nothing (it was killed).
// The profile folder is passed in the environment (REC_SANDBOX), not on the command line, so that no process names the profile because of this one.
// Usage: REC_SANDBOX=<profile folder> node sandbox-janitor.mjs   (the pipe is its standard input)
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const PG_STEP_MS = 40_000;

/** The folder of the PostgreSQL runtime the sandbox's data directory downloaded (`ensureRuntime`: `<data>/runtime/runtime-pg...`). */
function runtimeDirOf(dataDir) {
  const base = join(dataDir, 'runtime');
  const found = existsSync(base) ? readdirSync(base).filter((name) => name.startsWith('runtime-pg') && existsSync(join(base, name, 'bin', 'pg_ctl.exe'))) : [];
  if (found.length !== 1) throw new Error(`${base} holds ${found.length} PostgreSQL runtimes (expected 1) but ${join(dataDir, 'pgdata')} holds a cluster`);
  return join(base, found[0]);
}

function pgCtl(runtimeDir, args) {
  const run = spawnSync(join(runtimeDir, 'bin', 'pg_ctl.exe'), args, {
    env: { ...process.env, PATH: `${join(runtimeDir, 'bin')};${process.env.PATH}` },
    encoding: 'utf8',
    timeout: PG_STEP_MS,
    windowsHide: true,
  });
  if (run.error) throw new Error(`pg_ctl ${args[0]} did not finish: ${run.error.message}`);
  return run;
}

/** Stops the cluster of the profile, if one is running. `pg_ctl status` answers 0 for a running server and 3 for none. */
export function stopCluster(dataDir) {
  const pgdata = join(dataDir, 'pgdata');
  if (!existsSync(join(pgdata, 'postmaster.pid'))) return;
  const runtimeDir = runtimeDirOf(dataDir);
  const running = () => {
    const status = pgCtl(runtimeDir, ['status', '-D', pgdata]).status;
    if (status !== 0 && status !== 3) throw new Error(`pg_ctl status -D ${pgdata} answered ${status}`);
    return status === 0;
  };
  if (!running()) return;
  const stopped = pgCtl(runtimeDir, ['stop', '-m', 'fast', '-w', '-t', '30', '-D', pgdata]);
  if (stopped.status !== 0) throw new Error(`pg_ctl stop -m fast -D ${pgdata} answered ${stopped.status}: ${stopped.stderr}`);
  if (running()) throw new Error(`the cluster ${pgdata} still runs after pg_ctl stop`);
}

/** Names the processes whose command line holds the profile (a read-only lookup: nothing is ended through it). */
function namingProfile(sandbox) {
  const list = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-Command', "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($env:REC_SANDBOX) } | ForEach-Object { \"$($_.ProcessId) $($_.Name)\" }"],
    { env: { ...process.env, REC_SANDBOX: sandbox }, encoding: 'utf8', timeout: 30_000, windowsHide: true }
  );
  if (list.error || list.status !== 0) throw new Error(`cannot look up the processes naming ${sandbox}: ${list.error?.message ?? list.status}`);
  return list.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

/** Waits, at most `ms`, for the processes `entries` (`"<pid> <name>"`) to exit: `Wait-Process` waits on each process's own exit
 *  (its handle), never by listing again. Nothing is ended; a pid that has already exited is no wait. */
function awaitExit(entries, ms) {
  const ids = entries.map((entry) => entry.split(' ')[0]).join(',');
  const waited = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-Command', `Wait-Process -Id ${ids} -Timeout ${Math.ceil(ms / 1000)} -ErrorAction SilentlyContinue`],
    { encoding: 'utf8', timeout: ms + 30_000, windowsHide: true }
  );
  if (waited.error) throw new Error(`cannot wait for ${entries.join(', ')} to exit: ${waited.error.message}`);
}

/** The whole end of a profile. Returns the failures (an empty list: the profile is gone); throws nothing. */
export function endSandbox(sandbox, settleMs = 0, dataDir = join(sandbox, 'mixdog_data_dir')) {
  if (!existsSync(sandbox)) return [];
  const failures = [];
  try {
    stopCluster(dataDir);
  } catch (error) {
    failures.push(error.message);
  }
  try {
    // A short-lived child of a killed recorder (an `initdb` writing the cluster) ends by itself: its exit is awaited for at most
    // `settleMs`, once, and it is never killed. The profile is then looked up once more: a pid reused meanwhile names it no longer.
    let left = namingProfile(sandbox);
    if (left.length && settleMs > 0) {
      awaitExit(left, settleMs);
      left = namingProfile(sandbox);
    }
    if (left.length) failures.push(`still running and naming ${sandbox} after ${settleMs} ms: ${left.join(', ')}`);
  } catch (error) {
    failures.push(error.message);
  }
  try {
    rmSync(sandbox, { recursive: true, force: true });
  } catch (error) {
    failures.push(`cannot remove ${sandbox} (it stays until its recorder's next run empties the folder above it): ${error.message}`);
  }
  return failures;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const sandbox = process.env.REC_SANDBOX;
  process.stdin.resume();
  // End-of-file: the recorder is gone.
  process.stdin.on('end', () => {
    const failures = endSandbox(sandbox, 60_000);
    // Nobody reads this process's output (its recorder is gone): a failure is written next to the profile it kept.
    for (const failure of failures) appendFileSync(`${sandbox}.janitor.log`, `${failure}\n`);
    process.exit(failures.length ? 1 : 0);
  });
}