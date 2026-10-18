// Issue #115: a cancelled, timed-out or abandoned shell command must leave no
// process behind. Every scenario starts real processes through the shell tool
// (the native spawn runner), records each pid the command started and the
// port its server answers on, ends the command the way the user would, and
// then requires every pid gone and the port closed.
// Import before runtime modules: several paths are captured at module load.
import { fixtureRoot } from './lib/isolated-test-env.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { connect, createServer } from 'node:net';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { executeBashTool } from './builtin/bash-tool.mjs';
import { executeTaskTool } from './builtin/task-tool.mjs';
import { shutdownShellJobs } from './builtin/shell-jobs.mjs';
import { cancelOwnedShellTrees } from './lib/owned-shell-trees.mjs';
import {
  _resetNativeSpawnClientForTest,
  _setNativeSpawnBinaryForTest,
  shutdownNativeSpawnServer,
} from './lib/native-spawn-client.mjs';

const isWin = process.platform === 'win32';
const binary = resolve('native/mixdog-spawn/target/debug', isWin ? 'mixdog-spawn.exe' : 'mixdog-spawn');
const skip = existsSync(binary) ? false : `native spawn test binary not found: ${binary}`;
if (!skip) _setNativeSpawnBinaryForTest(binary);

// Without an owner the runtime never exits on its own between steps.
const keepAlive = setInterval(() => {}, 1_000);
const started = new Set();
test.after(async () => {
  clearInterval(keepAlive);
  // Whatever a failed assertion left behind is still removed here.
  for (const pid of started) hardKill(pid);
  if (skip) return;
  await shutdownShellJobs('test-cleanup');
  await shutdownNativeSpawnServer('test-finish').catch(() => {});
  _resetNativeSpawnClientForTest();
});

// Every process the fixture starts appends `<role> <pid>` to the pid file.
const FIXTURE = `
const { spawn } = require('node:child_process');
const { appendFileSync } = require('node:fs');
const { createServer } = require('node:http');
const [mode, port, pidFile] = process.argv.slice(2);
appendFileSync(pidFile, mode + ' ' + process.pid + '\\n');
const again = (next) =>
  spawn(process.execPath, [__filename, next, port, pidFile], { detached: true, stdio: 'ignore' }).unref();
if (mode === 'server') createServer((_, res) => res.end('ok')).listen(Number(port), '127.0.0.1');
else if (mode === 'detached-parent') { again('server'); setInterval(() => {}, 1000); }
else if (mode === 'double-fork') { again('intermediate'); setInterval(() => {}, 1000); }
else if (mode === 'intermediate') { again('server'); setTimeout(() => process.exit(0), 300); }
`;

const workDir = join(fixtureRoot, 'tree-kill');
mkdirSync(workDir, { recursive: true });
const fixture = join(workDir, 'tree-fixture.cjs');
writeFileSync(fixture, FIXTURE);
const q = (path) => `"${path}"`;

let sequence = 0;
async function freePort() {
  const server = createServer();
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address();
  await new Promise((done) => server.close(done));
  return port;
}

async function scenario(name) {
  sequence += 1;
  const port = await freePort();
  const pidFile = join(workDir, `${name}-${sequence}.pids`);
  return {
    name,
    port,
    pidFile,
    // Appears in the argv of the processes a POSIX scenario names by command line.
    token: `mdtok${sequence}x${port}`,
    run: (mode) => `node ${q(fixture)} ${mode} ${port} ${q(pidFile)}`,
  };
}

// POSIX: processes whose command line carries the scenario's token. The role
// is the program they were started as.
function namedByToken(s) {
  const ps = spawnSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8' });
  const rows = [];
  for (const line of String(ps.stdout || '').split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\S+)(.*)$/);
    if (!m || m[1] === String(ps.pid) || !(m[2] + m[3]).includes(s.token)) continue;
    rows.push({ role: m[2].split('/').pop(), pid: Number(m[1]) });
  }
  return rows;
}

function recorded(s) {
  const rows = existsSync(s.pidFile)
    ? readFileSync(s.pidFile, 'utf8')
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => {
          const [role, pid] = line.split(' ');
          return { role, pid: Number(pid) };
        })
    : [];
  if (!isWin) rows.push(...namedByToken(s));
  for (const row of rows) started.add(row.pid);
  return rows;
}

// A POSIX zombie (killed, never reaped: an init that does not reap, as in a
// container without one) runs nothing; it is not a leak.
function zombie(pid) {
  if (isWin) return false;
  const ps = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' });
  return String(ps.stdout || '')
    .trim()
    .startsWith('Z');
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return !zombie(pid);
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function hardKill(pid) {
  if (!alive(pid)) return;
  if (isWin) spawnSync('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore', windowsHide: true });
  else {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {}
  }
}

function portOpen(port) {
  return new Promise((done) => {
    const socket = connect({ port, host: '127.0.0.1' });
    socket.setTimeout(1_000);
    socket.once('connect', () => {
      socket.destroy();
      done(true);
    });
    socket.once('timeout', () => {
      socket.destroy();
      done(true);
    });
    socket.once('error', () => done(false));
  });
}

async function until(read, ms, what) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await delay(200);
  }
}

// The server answers and every role the scenario starts has recorded its pid.
async function serving(s, roles) {
  await until(
    async () => roles.every((role) => recorded(s).some((row) => row.role === role)) && (await portOpen(s.port)),
    30_000,
    `${s.name}: ${roles.join(', ')} serving on ${s.port}`
  );
  return recorded(s);
}

async function leftovers(s) {
  const pids = recorded(s)
    .filter((row) => alive(row.pid))
    .map((row) => `${row.role}:${row.pid}`);
  if (await portOpen(s.port)) pids.push(`port:${s.port}`);
  return pids;
}

async function assertGoneNow(s, when) {
  assert.deepEqual(await leftovers(s), [], `${s.name}: still running ${when}`);
}

// A kill is asynchronous end to end (the command's result is reported before
// the last survivor dies), so a bounded wait precedes the hard assertion.
async function assertGoneSoon(s, when, ms = 20_000) {
  const deadline = Date.now() + ms;
  let left = await leftovers(s);
  while (left.length > 0 && Date.now() < deadline) {
    await delay(250);
    left = await leftovers(s);
  }
  assert.deepEqual(left, [], `${s.name}: still running ${when}`);
}

const ctx = (sessionId) => ({ sessionId, callerSessionId: sessionId, clientHostPid: process.pid });

async function shell(args, sessionId = 'sess_tree_kill') {
  const out = await executeBashTool(args, workDir, ctx(sessionId));
  return String(out?.result ?? out);
}

const taskIdOf = (text) => text.match(/task_id: (\S+)/)?.[1] || assert.fail(`no task_id in:\n${text}`);

// `task cancel` may answer `cancelled` only once nothing is left running; an
// honest pending answer must still end with everything gone.
async function cancelAndCheck(s, taskId, sessionId = 'sess_tree_kill') {
  const answer = await executeTaskTool({ action: 'cancel', task_id: taskId }, ctx(sessionId));
  if (/^cancelled: /m.test(answer)) await assertGoneNow(s, `after task cancel reported:\n${answer}`);
  else assert.match(answer, /cancel-(unconfirmed|pending)/, answer);
  await assertGoneSoon(s, 'after task cancel');
  return answer;
}

const launcherCommand = (s) =>
  isWin
    ? `Start-Process -FilePath node -ArgumentList '${q(fixture)}','server','${s.port}','${q(s.pidFile)}' -WindowStyle Hidden`
    : `nohup ${s.run('server')} >/dev/null 2>&1 & disown`;

const opts = { skip, timeout: 120_000 };

test('task cancel kills a background http server', opts, async () => {
  const s = await scenario('server');
  const out = await shell({ command: s.run('server'), background: true });
  await serving(s, ['server']);
  await cancelAndCheck(s, taskIdOf(out));
});

test('task cancel kills a detached (setsid on POSIX) grandchild server', opts, async () => {
  const s = await scenario('detached');
  const out = await shell({ command: s.run('detached-parent'), background: true });
  await serving(s, ['detached-parent', 'server']);
  await cancelAndCheck(s, taskIdOf(out));
});

test('task cancel kills a double-forked server whose intermediate already exited', opts, async () => {
  const s = await scenario('double-fork');
  const out = await shell({ command: s.run('double-fork'), background: true });
  await serving(s, ['double-fork', 'intermediate', 'server']);
  await cancelAndCheck(s, taskIdOf(out));
});

test('task cancel kills a server the shell launched itself (Start-Process / nohup & disown)', opts, async () => {
  const s = await scenario('launcher');
  const out = await shell({
    command: `${launcherCommand(s)}${isWin ? '; Start-Sleep -Seconds 600' : '; sleep 600'}`,
    background: true,
  });
  await serving(s, ['server']);
  await cancelAndCheck(s, taskIdOf(out));
});

test('POSIX: task cancel kills a job-control (set -m) background server', {
  ...opts,
  skip: skip || (isWin && 'POSIX job control only'),
}, async () => {
  const s = await scenario('monitor');
  const out = await shell({ command: `set -m; ${s.run('server')} & sleep 600`, background: true });
  await serving(s, ['server']);
  await cancelAndCheck(s, taskIdOf(out));
});

test('task cancel kills a long npm script and its server', opts, async () => {
  const s = await scenario('npm');
  const project = join(workDir, `npm-${sequence}`);
  mkdirSync(project, { recursive: true });
  writeFileSync(
    join(project, 'package.json'),
    JSON.stringify({ name: 'tree-kill-npm', private: true, scripts: { serve: s.run('server') } })
  );
  const out = String(
    await executeBashTool({ command: 'npm run serve', background: true }, project, ctx('sess_tree_kill'))
  );
  await serving(s, ['server']);
  await cancelAndCheck(s, taskIdOf(out));
});

test('task cancel kills what a finished command left running', opts, async () => {
  const s = await scenario('left-running');
  const out = await shell({ command: launcherCommand(s), wait_ms: 30_000 });
  await serving(s, ['server']);
  await cancelAndCheck(s, taskIdOf(out));
});

test('a foreground timeout kills the whole tree', opts, async () => {
  const s = await scenario('timeout');
  const out = await shell({ command: s.run('detached-parent'), timeout_ms: 4_000, wait_ms: 30_000 });
  assert.match(out, /timed out|timeout/i, out);
  await assertGoneSoon(s, 'after the foreground timeout');
});

test('a background deadline (timeout_ms) kills the whole tree', opts, async () => {
  const s = await scenario('bg-timeout');
  const out = await shell({ command: s.run('detached-parent'), background: true, timeout_ms: 4_000 });
  taskIdOf(out);
  await serving(s, ['detached-parent', 'server']);
  await delay(4_000);
  await assertGoneSoon(s, 'after the background deadline');
});

test('closing the owning session (or agent) kills its jobs', opts, async () => {
  const owner = 'sess_tree_kill_close';
  const s = await scenario('session-close');
  const out = await shell({ command: s.run('detached-parent'), background: true }, owner);
  taskIdOf(out);
  await serving(s, ['detached-parent', 'server']);
  // What closeSession and the scoped runtime teardown run for that owner.
  await cancelOwnedShellTrees(owner);
  await shutdownShellJobs('session-close', { scope: { ownerSessionId: owner } });
  await assertGoneSoon(s, 'after the session closed');
});

test('daemon shutdown kills every tracked job tree', opts, async () => {
  const a = await scenario('shutdown-detached');
  const b = await scenario('shutdown-npm');
  await shell({ command: a.run('detached-parent'), background: true });
  await shell({
    command: `${launcherCommand(b)}${isWin ? '; Start-Sleep -Seconds 600' : '; sleep 600'}`,
    background: true,
  });
  await serving(a, ['detached-parent', 'server']);
  await serving(b, ['server']);
  await shutdownShellJobs('runtime-close');
  await shutdownNativeSpawnServer('runtime-close');
  await assertGoneSoon(a, 'after daemon shutdown');
  await assertGoneSoon(b, 'after daemon shutdown');
  // Later files in the same process get a fresh runner.
  _resetNativeSpawnClientForTest();
  _setNativeSpawnBinaryForTest(binary);
});

// Issue #115 on macOS/POSIX: a virtualenv-activated Python (`source … && python …`)
// that is its own process group (os.setsid / setpgid) is not in the group the
// runner kills, and is reparented to PID 1 once its wrapper shell dies.
const python = isWin ? false : spawnSync('python3', ['--version']).status === 0;
const posixOpts = { ...opts, skip: skip || (isWin && 'POSIX only') || (!python && 'python3 not found') };

const PY_FIXTURE = `
import os, sys, time
mode, port, pid_file = sys.argv[1:4]
def record(role):
    with open(pid_file, 'a') as f:
        f.write(role + ' ' + str(os.getpid()) + '\\n')
record(mode)
if mode == 'setsid':
    os.setsid()
    time.sleep(600)
elif mode == 'setpgid-child':
    if os.fork() == 0:
        os.setpgid(0, 0)
        record('child')
        time.sleep(600)
        os._exit(0)
    time.sleep(600)
elif mode == 'setsid-server':
    os.setsid()
    from http.server import HTTPServer, SimpleHTTPRequestHandler
    HTTPServer(('127.0.0.1', int(port)), SimpleHTTPRequestHandler).serve_forever()
`;

function activation() {
  const bin = join(workDir, '.venv', 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(workDir, '.venv', 'bin', 'activate'), `export PATH="${bin}:$PATH"\n`);
  const link = join(bin, 'python');
  if (!existsSync(link)) symlinkSync(spawnSync('which', ['python3'], { encoding: 'utf8' }).stdout.trim(), link);
  const file = join(workDir, 'py-fixture.py');
  writeFileSync(file, PY_FIXTURE);
  return { source: `source ${q(join(bin, 'activate'))}`, file };
}

const pgidOf = (pid) => Number(spawnSync('ps', ['-o', 'pgid=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim());

async function running(s, roles, ms = 30_000) {
  await until(() => roles.every((role) => recorded(s).some((row) => row.role === role)), ms, `${s.name}: ${roles}`);
  return recorded(s);
}

test('POSIX: task cancel kills a plain sleep', posixOpts, async () => {
  const s = await scenario('posix-sleep');
  const out = await shell({ command: `sleep 600 & echo "sleep $!" >> ${q(s.pidFile)}; wait`, background: true });
  await running(s, ['sleep']);
  await cancelAndCheck(s, taskIdOf(out));
});

test('POSIX: task cancel kills the issue #115 venv python command', posixOpts, async () => {
  const s = await scenario('posix-issue');
  const { source } = activation();
  const code =
    "import json,os,time; print(json.dumps({'pid':os.getpid(),'ppid':os.getppid(),'pgid':os.getpgrp()}),flush=True); time.sleep(90)";
  const out = await shell({ command: `${source} && python -u -c '${code}' ${s.token}`, background: true });
  await running(s, ['python']);
  await cancelAndCheck(s, taskIdOf(out));
});

test(
  'POSIX: task cancel kills a python that called os.setsid (own pgid, not the runner group)',
  posixOpts,
  async () => {
    const s = await scenario('posix-setsid');
    const { source, file } = activation();
    const out = await shell({
      command: `${source} && python ${q(file)} setsid ${s.port} ${q(s.pidFile)}`,
      background: true,
    });
    const [{ pid }] = await running(s, ['setsid']);
    assert.equal(pgidOf(pid), pid, 'fixture must leave the command group');
    await cancelAndCheck(s, taskIdOf(out));
  }
);

test('POSIX: task cancel kills a setpgid child of a python job', posixOpts, async () => {
  const s = await scenario('posix-setpgid');
  const { source, file } = activation();
  const out = await shell({
    command: `${source} && python ${q(file)} setpgid-child ${s.port} ${q(s.pidFile)}`,
    background: true,
  });
  const [{ pid }] = (await running(s, ['setpgid-child', 'child'])).filter((row) => row.role === 'child');
  assert.equal(pgidOf(pid), pid, 'child must leave the command group');
  await cancelAndCheck(s, taskIdOf(out));
});

test('POSIX: task cancel kills `python -m http.server`', posixOpts, async () => {
  const s = await scenario('posix-http-server');
  const { source } = activation();
  s.token = `http.server ${s.port}`;
  const out = await shell({
    command: `${source} && python -m http.server ${s.port} --bind 127.0.0.1`,
    background: true,
  });
  await until(() => portOpen(s.port), 30_000, 'http.server answering');
  await cancelAndCheck(s, taskIdOf(out));
});

test('POSIX: task cancel kills a setsid python http server', posixOpts, async () => {
  const s = await scenario('posix-setsid-server');
  const { source, file } = activation();
  const out = await shell({
    command: `${source} && python ${q(file)} setsid-server ${s.port} ${q(s.pidFile)}`,
    background: true,
  });
  await serving(s, ['setsid-server']);
  await cancelAndCheck(s, taskIdOf(out));
});
