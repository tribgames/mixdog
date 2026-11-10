// lib/core-stop.mjs ends only what the core's job holds, within one deadline, the stop request included.
//   node --test benchmarks/rust-core/recorders/lib/core-stop.test.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { endCore, spawnCore } from './core-stop.mjs';

/** `promise`, or a failure naming `what` after `ms`. */
function within(ms, promise, what) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => (timer = setTimeout(() => reject(new Error(`${what}: not within ${ms} ms`)), ms)))]).finally(() => clearTimeout(timer));
}

// Each stand-in tells the test who it is over a connection of its own and stays while that connection is open (`process.argv` past the
// script is what it was started with, never read).
const TELLS = (port, role) => `const s = require('net').connect(${port}, '127.0.0.1', () => s.write('${role} ' + process.pid)); s.on('close', () => process.exit(0)); s.on('error', () => process.exit(0));`;
// The stand-in core: with `kid`, it first starts a process of its own that stays after it exits (detached: outside the job Node keeps for
// its own children, which would end it with the stand-in, as the database a real core leaves is).
const CORE = (port, kid) =>
  `${kid ? `require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(TELLS(port, 'kid'))}], { stdio: 'ignore', detached: true, windowsHide: true });` : ''}${TELLS(port, 'core')}`;
// The stand-in stop request: asks the test to close the core's connection, which ends the core.
const STOP = (port) => `const s = require('net').connect(${port}, '127.0.0.1', () => s.end('stop'));`;

/** A loopback server the stand-ins report to: `arrived(role)` resolves with `{ socket, pid }` once that role has connected. */
async function world() {
  const seen = new Map();
  const waits = new Map();
  const server = net.createServer((socket) => {
    socket.on('error', () => {});
    socket.once('data', (chunk) => {
      const [role, pid] = String(chunk).split(' ');
      if (role === 'stop') return seen.get('core')?.socket.destroy();
      seen.set(role, { socket, pid: Number(pid) });
      waits.get(role)?.();
    });
  });
  await within(30_000, new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)), 'the test listening on loopback');
  const arrived = (role) => within(60_000, new Promise((resolve) => (seen.has(role) ? resolve() : waits.set(role, resolve))).then(() => seen.get(role)), `the stand-in ${role} to report`);
  const closed = (role) => {
    const { socket } = seen.get(role);
    return within(30_000, new Promise((resolve) => (socket.destroyed ? resolve() : socket.once('close', resolve))), `the stand-in ${role} to end`);
  };
  return { port: server.address().port, arrived, closed, close: () => server.close() };
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test('only what the core started is ended: a process naming its folders and the pid of a stale postmaster.pid stay', { timeout: 120_000 }, async () => {
  const w = await world();
  const root = mkdtempSync(join(tmpdir(), 'core-stop-'));
  const data = join(root, 'data');
  mkdirSync(join(data, 'pgdata'), { recursive: true });
  // Not started by the core: its command line names a sibling folder and the core's own data folder.
  const decoy = spawn(process.execPath, ['-e', TELLS(w.port, 'decoy'), `${root}-other\\x`, `${data}\\pgdata`], { stdio: 'ignore', windowsHide: true });
  try {
    const { pid } = await w.arrived('decoy');
    // A postmaster.pid left by an earlier run whose pid Windows has since given to the decoy.
    writeFileSync(join(data, 'pgdata', 'postmaster.pid'), `${pid}\n${join(data, 'pgdata')}\n${Math.floor(Date.now() / 1000)}\n5432\n`);
    const { child, job } = await spawnCore(process.execPath, ['-e', CORE(w.port, true)], { env: process.env });
    await w.arrived('core');
    const kid = await w.arrived('kid');
    await assert.rejects(
      endCore({ child, job, env: process.env, dataDir: data, ms: 30_000, stop: [process.execPath, ['-e', STOP(w.port)]] }),
      /the core's stop needed force: 1 process\(es\) of its job ended with the job/
    );
    await w.closed('kid');
    assert.ok(!alive(kid.pid), `the process the core left (pid ${kid.pid}) still runs`);
    assert.ok(alive(pid), `the decoy (pid ${pid}) was ended`);
  } finally {
    decoy.kill();
    w.close();
  }
});

test('a stop request that hangs ends with the core, within the teardown\'s one deadline', { timeout: 120_000 }, async () => {
  const w = await world();
  try {
    const { child, job } = await spawnCore(process.execPath, ['-e', CORE(w.port, false)], { env: process.env });
    await w.arrived('core');
    const started = Date.now();
    await assert.rejects(
      endCore({ child, job, env: process.env, ms: 25_000, stop: [process.execPath, ['-e', TELLS(w.port, 'request')]] }),
      /the core \(pid \d+\) to stop when asked: not by the teardown's deadline/
    );
    const took = Date.now() - started;
    assert.ok(took <= 25_000, `the teardown took ${took} ms of its 25000`);
    const request = await w.arrived('request');
    await w.closed('request');
    await w.closed('core');
    assert.ok(!alive(request.pid), `the stop request (pid ${request.pid}) still runs`);
  } finally {
    w.close();
  }
});
