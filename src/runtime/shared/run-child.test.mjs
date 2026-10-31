import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import test from 'node:test';
import { TREE_KILL_DEADLINE_MS } from '../agent/orchestrator/mcp/child-tree.mjs';
import { runChild } from './run-child.mjs';

/** A child that keeps writing (and fails once) after its kill, and exits only when told. */
function stubbornChild() {
  const child = new EventEmitter();
  Object.assign(child, {
    pid: undefined, // no tree kill: the kill is child.kill()
    exitCode: null,
    signalCode: null,
    stdin: null,
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    killed: 0,
    kill() {
      child.killed += 1;
    },
    exit() {
      child.signalCode = 'SIGTERM';
      child.emit('exit', null, 'SIGTERM');
      child.emit('close', null, 'SIGTERM');
    },
  });
  return child;
}

test('once a timeout terminates the child it owns completion: later output or errors do not settle early', async () => {
  const child = stubbornChild();
  let settledAt = null;
  const run = runChild({
    command: 'git',
    args: ['status'],
    timeoutMs: 20,
    maxBytes: 10,
    waitForExitMs: 5_000,
    spawnChild: () => child,
  }).then(
    () => assert.fail('a timeout never resolves'),
    (error) => {
      settledAt = Date.now();
      return error;
    }
  );
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(child.killed, 1, 'the timeout sent the kill');
  // During termination: an output overflow and an error.
  child.stdout.emit('data', Buffer.alloc(100, 120));
  child.emit('error', new Error('kill failed'));
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(settledAt, null, 'still waiting for the exit');
  const exitedAt = Date.now();
  child.exit();
  const error = await run;
  assert.equal(error.code, 'ETIMEDOUT');
  assert.equal(error.childExited, true);
  assert.ok(settledAt >= exitedAt, 'settled only after the exit');
});

test('killTree false: a hung tree-kill helper is killed directly at its own deadline, with no second pass', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  // Any tree kill of the helper would be a pass that hangs like the helper did.
  const passes = t.mock.method(childProcess, 'spawn', () =>
    Object.assign(new EventEmitter(), { kill() {}, unref() {} })
  );
  syncBuiltinESMExports();
  t.after(() => {
    passes.mock.restore();
    syncBuiltinESMExports();
  });
  const helper = Object.assign(stubbornChild(), { pid: 4242 });
  const run = runChild({
    command: 'powershell.exe',
    args: [],
    timeoutMs: TREE_KILL_DEADLINE_MS,
    maxBytes: 10,
    killTree: false,
    spawnChild: () => helper,
  }).then(
    () => assert.fail('a timeout never resolves'),
    (error) => error
  );
  t.mock.timers.tick(TREE_KILL_DEADLINE_MS - 1);
  assert.equal(helper.killed, 0);
  t.mock.timers.tick(1);
  assert.equal(helper.killed, 1, 'killed at the first deadline, not after another pass');
  assert.equal(passes.mock.callCount(), 0);
  assert.equal((await run).code, 'ETIMEDOUT');
});

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
};

test('waitForExitMs: a timed-out child is killed and has exited before the timeout rejects', async () => {
  const error = await runChild({
    command: process.execPath,
    args: ['-e', 'setTimeout(() => {}, 60_000)'],
    timeoutMs: 200,
    maxBytes: 1024,
    waitForExitMs: 5_000,
  }).then(
    () => null,
    (failure) => failure
  );
  assert.equal(error?.code, 'ETIMEDOUT');
  assert.equal(error.childExited, true);
  assert.ok(error.pid > 0);
  assert.equal(alive(error.pid), false, 'no child left running');
});
