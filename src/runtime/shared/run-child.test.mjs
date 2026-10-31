import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { runChild } from './run-child.mjs';

/** A child that keeps writing (and fails once) after its kill, and exits only when told. */
function stubbornChild() {
  const child = new EventEmitter();
  Object.assign(child, {
    pid: undefined, // no taskkill: the kill is child.kill()
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
