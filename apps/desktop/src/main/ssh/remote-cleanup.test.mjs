import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';

import { cleanupRemoteServer } from './remote-cleanup.ts';

function scriptedSsh(replies) {
  const scripts = [];
  const spawnImpl = (_command, args) => {
    const reply = replies[Math.min(scripts.length, replies.length - 1)];
    const command = args[args.length - 1];
    scripts.push(Buffer.from(/printf %s ([A-Za-z0-9+/=]+) \|/.exec(command)[1], 'base64').toString('utf8'));
    const child = new EventEmitter();
    child.exitCode = null;
    child.signalCode = null;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.stdin.resume();
    child.kill = () => true;
    setImmediate(() => {
      child.stdout.end(reply.stdout ?? '');
      child.stderr.end('');
      setTimeout(() => {
        child.exitCode = reply.code ?? 0;
        child.emit('close', child.exitCode, null);
      }, 5);
    });
    return child;
  };
  return { scripts, spawnImpl };
}

const programArgs = (script) =>
  JSON.parse(Buffer.from(/'([A-Za-z0-9+/=]+)'\s*$/.exec(script.trim())[1], 'base64').toString('utf8'));
const cleanupResult = (cleanup) => ({
  stdout: `MIXDOG_PLATFORM Linux x86_64|glibc\nMIXDOG_RESULT ${JSON.stringify({ home: '/home/a', cleanup })}\n`,
});

test('cleanup stops the daemon, then removes everything but user-data', async () => {
  const ssh = scriptedSsh([
    cleanupResult({ stopped: { pid: 4242, stopped: true }, removed: [], kept: [] }),
    cleanupResult({ stopped: null, removed: ['versions', 'deps', 'daemon.log', 'state.json'], kept: ['user-data'] }),
  ]);
  const events = [];
  await cleanupRemoteServer('devbox', {
    removeUserData: false,
    onProgress: (event) => events.push(event),
    spawnImpl: ssh.spawnImpl,
  });
  assert.deepEqual(
    ssh.scripts.map(programArgs).map(({ mode, phase, removeUserData }) => ({ mode, phase, removeUserData })),
    [
      { mode: 'cleanup', phase: 'stop', removeUserData: false },
      { mode: 'cleanup', phase: 'remove', removeUserData: false },
    ]
  );
  assert.deepEqual(
    events.map((event) => event.phase),
    ['connect', 'stop', 'remove', 'done']
  );
  assert.equal(events[1].detail, 'stopped pid 4242');
  assert.match(events[2].detail, /kept user-data/);
});

test("the server's refusal (an unproven daemon or a process using the install) stops the cleanup", async () => {
  for (const phase of ['stop', 'remove']) {
    const refusal = { stdout: 'MIXDOG_ERROR daemon-unproven A process (pid 77) ... nothing was removed.\n', code: 3 };
    const ssh = scriptedSsh(
      phase === 'stop' ? [refusal] : [cleanupResult({ stopped: null, removed: [], kept: [] }), refusal]
    );
    const events = [];
    await assert.rejects(
      cleanupRemoteServer('devbox', {
        removeUserData: true,
        onProgress: (event) => events.push(event),
        spawnImpl: ssh.spawnImpl,
      }),
      (error) => error.code === 'daemon-unproven' && /pid 77/.test(error.message)
    );
    assert.equal(ssh.scripts.length, phase === 'stop' ? 1 : 2);
    assert.equal(
      events.some((event) => event.phase === 'remove' || event.phase === 'done'),
      false
    );
  }
});

test('a server without a usable node is never cleaned blind', async () => {
  for (const code of ['node-missing', 'node-too-old']) {
    const ssh = scriptedSsh([{ stdout: `MIXDOG_ERROR ${code} Node.js was not found on the server.\n`, code: 3 }]);
    await assert.rejects(
      cleanupRemoteServer('devbox', { removeUserData: true, spawnImpl: ssh.spawnImpl }),
      (error) =>
        error.code === 'node-missing' &&
        /nothing was removed/.test(error.message) &&
        /~\/\.mixdog-remote\/runtime\/daemon\.json/.test(error.message) &&
        /rm -rf ~\/\.mixdog-remote/.test(error.message)
    );
    // Only the program run: no shell-only removal follows.
    assert.equal(ssh.scripts.length, 1);
  }
});
