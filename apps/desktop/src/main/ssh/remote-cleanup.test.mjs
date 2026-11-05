import assert from 'node:assert/strict';
import { test } from 'node:test';

import { cleanupRemoteServer } from './remote-cleanup.ts';
import { errorReply, programArgs, reply, scriptedSsh, stagedPayloads } from './remote-fixture.mjs';

const { payloads } = await stagedPayloads('1.4.6');
const probe = (installed) => reply({ home: '/home/a', installed });
const cleanupResult = (cleanup) => reply({ home: '/home/a', cleanup });
const options = (ssh, extra = {}) => ({ removeUserData: false, spawnImpl: ssh.spawnImpl, payloads, ...extra });

test('cleanup stops the core, then removes everything but user-data', async () => {
  const ssh = scriptedSsh([
    probe(true),
    cleanupResult({ stopped: { pid: 4242, stopped: true }, removed: [], kept: [] }),
    cleanupResult({ stopped: null, removed: ['versions', 'deps', 'daemon.log', 'state.json'], kept: ['user-data'] }),
  ]);
  const events = [];
  await cleanupRemoteServer('devbox', options(ssh, { onProgress: (event) => events.push(event) }));
  assert.deepEqual(
    ssh.calls.map(programArgs).map(({ mode, phase, removeUserData, upload }) => ({ mode, phase, removeUserData, upload })),
    [
      { mode: 'probe', phase: undefined, removeUserData: undefined, upload: undefined },
      { mode: 'cleanup', phase: 'stop', removeUserData: false, upload: undefined },
      { mode: 'cleanup', phase: 'remove', removeUserData: false, upload: undefined },
    ]
  );
  assert.deepEqual(events.map((event) => event.phase), ['connect', 'stop', 'remove', 'done']);
  assert.equal(events[1].detail, 'stopped pid 4242');
  assert.match(events[2].detail, /kept user-data/);
});

test('a server without this build gets the runtime once, for the stop run; the remove run finds it', async () => {
  const ssh = scriptedSsh([
    probe(false),
    cleanupResult({ stopped: null, removed: [], kept: [] }),
    cleanupResult({ stopped: null, removed: ['versions'], kept: [] }),
  ]);
  await cleanupRemoteServer('devbox', options(ssh, { removeUserData: true }));
  assert.deepEqual(ssh.calls.map((call) => programArgs(call).upload), [undefined, true, undefined]);
  assert.ok(ssh.inputs[1].length > 0);
  assert.equal(ssh.inputs[2].length, 0);
});

test("the server's refusal (an unproven core or a process using the install) stops the cleanup", async () => {
  for (const phase of ['stop', 'remove']) {
    const refusal = errorReply('daemon-unproven', 'A process (pid 77) ... nothing was removed.');
    const ssh = scriptedSsh(
      phase === 'stop'
        ? [probe(true), refusal]
        : [probe(true), cleanupResult({ stopped: null, removed: [], kept: [] }), refusal]
    );
    const events = [];
    await assert.rejects(
      cleanupRemoteServer('devbox', options(ssh, { removeUserData: true, onProgress: (event) => events.push(event) })),
      (error) => error.code === 'daemon-unproven' && /pid 77/.test(error.message)
    );
    assert.equal(ssh.calls.length, phase === 'stop' ? 2 : 3);
    assert.equal(events.some((event) => event.phase === 'remove' || event.phase === 'done'), false);
  }
});
