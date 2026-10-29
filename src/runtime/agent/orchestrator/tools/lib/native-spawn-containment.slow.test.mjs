// Windows containment through the real native spawn server: a command spawned
// into a job object it cannot break away from is killed whole the moment it is
// cancelled or times out, and its workspace is released once the server has
// verified that job empty — never on a process-table read. Every table read is
// made slow here, so a kill or a release that still waits on one shows up as a
// delay. Paths without containment keep the conservative pre-kill capture.
// Import before runtime modules: several paths are captured at module load.
import { fixtureRoot } from './isolated-test-env.mjs';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test, { after, mock } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

const realTree = await import('../../mcp/child-tree.mjs');
const reads = { count: 0, delayMs: 0 };
mock.module('../../mcp/child-tree.mjs', {
  namedExports: {
    ...realTree,
    readProcessTable: async () => {
      reads.count += 1;
      if (reads.delayMs > 0) await delay(reads.delayMs);
      return realTree.readProcessTable();
    },
  },
});
const { execShellCommand } = await import('../shell-command.mjs');
const { shutdownShellJobs } = await import('../builtin/shell-jobs.mjs');
const { holdWorkspaceActivity } = await import('../../../../shared/worktrees/activity-gate.mjs');
const { cleanupTempDirs, makeRepo } = await import('../../../../shared/worktrees/test-support.mjs');
const { cancelOwnedShellTrees } = await import('./owned-shell-trees.mjs');
const client = await import('./native-spawn-client.mjs');

const isWin = process.platform === 'win32';
const binary = resolve('native/mixdog-spawn/target/debug', 'mixdog-spawn.exe');
const skip = !isWin ? 'Windows job containment only' : existsSync(binary) ? false : `missing ${binary}`;
if (!skip) client._setNativeSpawnBinaryForTest(binary);
const opts = { skip, timeout: 120_000 };

// Slower than any wait below: a kill or a release gated on a read cannot pass.
const SLOW_READ_MS = 30_000;
// "At once": the kill and the release follow within this, with no read.
const AT_ONCE_MS = 5_000;

const keepAlive = setInterval(() => {}, 1_000);
const started = new Set();
// Cleanup never signals a pid (a pid may have been reused by then): every
// fixture process exits by itself once its stop file exists.
after(async () => {
  clearInterval(keepAlive);
  reads.delayMs = 0;
  writeFileSync(STOP_ALL, '');
  await within(10_000, () => [...started].every((pid) => !alive(pid)));
  if (!skip) {
    await shutdownShellJobs('test-cleanup');
    await client.shutdownNativeSpawnServer('test-finish').catch(() => {});
    client._resetNativeSpawnClientForTest();
  }
  cleanupTempDirs();
});

// Every process appends `<role> <pid>`. root → mid → leaf (detached), all
// long-lived; `finisher` exits at once and leaves a detached `survivor`.
// A long-lived one exits once `<pidFile>.stop` or the directory's `stop` exists.
const FIXTURE = `
const { spawn } = require('node:child_process');
const { appendFileSync, existsSync } = require('node:fs');
const { dirname, join } = require('node:path');
const [role, pidFile] = process.argv.slice(2);
appendFileSync(pidFile, role + ' ' + process.pid + '\\n');
const start = (next, detached) =>
  spawn(process.execPath, [__filename, next, pidFile], { stdio: 'ignore', detached }).unref();
if (role === 'root') start('mid', false);
if (role === 'mid') start('leaf', true);
if (role === 'finisher') start('survivor', true);
else {
  const stops = [pidFile + '.stop', join(dirname(pidFile), 'stop')];
  setInterval(() => stops.some((stop) => existsSync(stop)) && process.exit(0), 100);
}
`;
const workDir = join(fixtureRoot, 'containment');
mkdirSync(workDir, { recursive: true });
const STOP_ALL = join(workDir, 'stop');
const fixture = join(workDir, 'tree.cjs');
writeFileSync(fixture, FIXTURE);
let sequence = 0;
const pidFileFor = (name) => join(workDir, `${name}-${(sequence += 1)}.pids`);

const admission = {
  async acquire() {
    return { signal: null, async detachDependency() {}, async release() {} };
  },
};
const command = (argv, extra = {}) =>
  execShellCommand({
    shell: process.execPath,
    shellArg: '',
    command: `tree ${argv.join(' ')}`,
    directArgv: argv,
    env: process.env,
    cwd: workDir,
    timeoutMs: 120_000,
    backgroundOnTimeout: false,
    ownerSessionId: 'sess_containment',
    clientHostPid: process.pid,
    admission,
    ...extra,
  });

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}
const workspaceFree = (repo) => {
  try {
    holdWorkspaceActivity([repo])();
    return true;
  } catch {
    return false;
  }
};
async function within(ms, predicate) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await delay(25);
  }
  return Boolean(await predicate());
}
function recorded(pidFile) {
  if (!existsSync(pidFile)) return {};
  const roles = {};
  for (const line of readFileSync(pidFile, 'utf8').split(/\r?\n/).filter(Boolean)) {
    const [role, pid] = line.split(' ');
    roles[role] = Number(pid);
    started.add(Number(pid));
  }
  return roles;
}
async function running(pidFile, roles) {
  assert.ok(
    await within(30_000, () => roles.every((role) => recorded(pidFile)[role])),
    `${roles.join(', ')} started`
  );
  return roles.map((role) => recorded(pidFile)[role]);
}
const treeGoneAtOnce = (pids) => within(AT_ONCE_MS, () => pids.every((pid) => !alive(pid)));

test('a cancel kills the whole tree at once and releases the workspace without a process-table read', opts, async () => {
  const repo = makeRepo();
  const pidFile = pidFileFor('cancel');
  const abort = new AbortController();
  const result = command([fixture, 'root', pidFile], { cwd: repo, abortSignal: abort.signal });
  const pids = await running(pidFile, ['root', 'mid', 'leaf']);
  reads.count = 0;
  reads.delayMs = SLOW_READ_MS;
  abort.abort();
  assert.ok(await treeGoneAtOnce(pids), 'root, mid and the detached leaf died at once');
  assert.equal((await result).killed, true);
  assert.ok(await within(AT_ONCE_MS, () => workspaceFree(repo)), 'the workspace is released on the verified-empty job');
  assert.equal(reads.count, 0, 'no process-table read gated the kill or the release');
});

test('a timeout kills the whole tree at once and releases the workspace without a process-table read', opts, async () => {
  const repo = makeRepo();
  const pidFile = pidFileFor('timeout');
  reads.count = 0;
  reads.delayMs = SLOW_READ_MS;
  const result = command([fixture, 'root', pidFile], { cwd: repo, timeoutMs: 6_000 });
  const pids = await running(pidFile, ['root', 'mid', 'leaf']);
  const settled = await result;
  assert.equal(settled.timedOut, true);
  assert.ok(await treeGoneAtOnce(pids), 'the timed-out tree died at once');
  assert.ok(await within(AT_ONCE_MS, () => workspaceFree(repo)), 'the workspace is released');
  assert.equal(reads.count, 0);
});

test('closing the owning session kills a running foreground tree at once', opts, async () => {
  const repo = makeRepo();
  const pidFile = pidFileFor('session');
  const result = command([fixture, 'root', pidFile], { cwd: repo, ownerSessionId: 'sess_containment_close' });
  const pids = await running(pidFile, ['root', 'mid', 'leaf']);
  reads.count = 0;
  reads.delayMs = SLOW_READ_MS;
  const cancelled = cancelOwnedShellTrees('sess_containment_close');
  assert.equal(typeof cancelled?.then, 'undefined', 'the cancel is sent at once, not after a snapshot');
  assert.ok(await treeGoneAtOnce(pids));
  assert.equal((await result).killed, true);
  assert.ok(await within(AT_ONCE_MS, () => workspaceFree(repo)));
  assert.equal(reads.count, 0);
});

test('runtime shutdown kills a promoted background tree at once and confirms it gone', opts, async () => {
  const repo = makeRepo();
  const pidFile = pidFileFor('background');
  const result = await command([fixture, 'root', pidFile], {
    cwd: repo,
    autoBackgroundMs: 200,
    backgroundOnTimeout: true,
  });
  assert.equal(result.backgrounded, true, result.stderr);
  const pids = await running(pidFile, ['root', 'mid', 'leaf']);
  reads.delayMs = SLOW_READ_MS;
  const shutdown = await shutdownShellJobs('test');
  assert.deepEqual(shutdown.treeUnconfirmedJobs, [], 'every tree was confirmed gone within the shutdown bound');
  assert.ok(await treeGoneAtOnce(pids));
  assert.ok(await within(AT_ONCE_MS, () => workspaceFree(repo)));
});

test('a command that finishes on its own reports a clean exit from the empty job, without a table read', opts, async () => {
  const repo = makeRepo();
  reads.count = 0;
  reads.delayMs = SLOW_READ_MS;
  const result = await command(['-e', 'console.log("contained-ok")'], { cwd: repo });
  assert.equal(result.exitCode, 0, result.stderr);
  assert.match(result.stdout, /contained-ok/);
  assert.equal(result.descendants ?? null, null);
  assert.equal(workspaceFree(repo), true);
  assert.equal(reads.count, 0, 'the verified-empty job replaces the survivor probe');
});

test('a process a finished command started on purpose keeps running and holds the workspace', opts, async () => {
  const repo = makeRepo();
  const pidFile = pidFileFor('survivor');
  reads.delayMs = 0;
  const result = await command([fixture, 'finisher', pidFile], { cwd: repo });
  assert.equal(result.exitCode, 0, result.stderr);
  const [survivor] = await running(pidFile, ['survivor']);
  assert.ok(result.descendants, 'the survivor is reported, not killed');
  await delay(1_500);
  assert.ok(alive(survivor), 'a normal completion never kills what the command left running');
  assert.equal(workspaceFree(repo), false, 'the survivor holds the workspace');
  writeFileSync(`${pidFile}.stop`, '');
  assert.ok(await within(10_000, () => !alive(survivor)), 'the survivor stopped itself');
});

test('a command opted out in its own environment keeps the conservative capture; the next one is contained', opts, async () => {
  const repo = makeRepo();
  const pidFile = pidFileFor('opt-out');
  reads.delayMs = 0;
  const abort = new AbortController();
  const result = command([fixture, 'root', pidFile], {
    cwd: repo,
    abortSignal: abort.signal,
    env: { ...process.env, [client.ALLOW_BREAKAWAY_ENV]: '1' },
  });
  const pids = await running(pidFile, ['root', 'mid', 'leaf']);
  reads.count = 0;
  abort.abort();
  assert.equal((await result).killed, true);
  assert.ok(reads.count >= 1, 'the identities were read before the kill');
  assert.ok(await within(60_000, () => pids.every((pid) => !alive(pid))), 'the tree is still killed');
  assert.ok(await within(60_000, () => workspaceFree(repo)), 'and released once confirmed gone');
  // The opt-out was that command's alone.
  reads.count = 0;
  reads.delayMs = SLOW_READ_MS;
  const next = await command(['-e', 'console.log("contained-again")'], { cwd: repo });
  assert.equal(next.exitCode, 0, next.stderr);
  assert.equal(reads.count, 0, 'an unrelated command stays contained');
});
