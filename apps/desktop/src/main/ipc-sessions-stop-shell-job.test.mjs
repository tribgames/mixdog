import assert from 'node:assert/strict';
import test from 'node:test';
import { DESKTOP_IPC } from '../shared/contract.ts';
import { registerSessionIpc } from './ipc-sessions.ts';
import { createRemoteMethods } from './remote-methods.ts';
import { SessionHostLifecycle } from './session-host-lifecycle.ts';

const SESSION = `sess_desktop_${'a'.repeat(64)}`;

function ipc() {
  const handlers = new Map();
  const calls = [];
  registerSessionIpc({
    handle: (channel, fn) => handlers.set(channel, fn),
    host: {
      stopShellJob: async (...args) => {
        calls.push(args);
        return { stopped: true };
      },
    },
    invokeDesktopOperation: async () => undefined,
  });
  return { call: (...args) => handlers.get(DESKTOP_IPC.stopShellJob)({}, ...args), calls };
}

test('the stopShellJob IPC handler validates both ids and forwards to the host', async () => {
  const { call, calls } = ipc();
  assert.deepEqual(await call(` ${SESSION} `, ' job_1 '), { stopped: true });
  assert.deepEqual(calls, [[SESSION, 'job_1']]);
  await assert.rejects(async () => call('../bad id', 'job_1'), /session id is invalid/);
  await assert.rejects(async () => call(undefined, 'job_1'), /session id must be a string/);
  await assert.rejects(async () => call(SESSION, undefined), /taskId must be a string/);
  await assert.rejects(async () => call(SESSION, '   '), /taskId is invalid/);
  await assert.rejects(async () => call(SESSION, 'x'.repeat(257)), /taskId is invalid/);
  assert.equal(calls.length, 1);
});

test('the remote stopShellJob method applies the same validation', async () => {
  const calls = [];
  const methods = createRemoteMethods({
    host: {
      stopShellJob: async (...args) => {
        calls.push(args);
        return { stopped: false, error: 'nope' };
      },
    },
  });
  assert.deepEqual(await methods.stopShellJob([SESSION, 'job_1']), { stopped: false, error: 'nope' });
  assert.deepEqual(calls, [[SESSION, 'job_1']]);
  assert.throws(() => methods.stopShellJob(['bad id', 'job_1']), /session id is invalid/);
  assert.throws(() => methods.stopShellJob([SESSION, 5]), /taskId must be a string/);
  assert.equal(calls.length, 1);
});

test('the host routes the stop to the session runtime and reports only a real stop', async () => {
  const sent = [];
  let answer = { stopped: true };
  const lifecycle = new SessionHostLifecycle({
    invokeSession: async (...args) => {
      sent.push(args);
      if (answer instanceof Error) throw answer;
      return { value: answer };
    },
  });
  assert.deepEqual(await lifecycle.stopShellJob(SESSION, 'job_1'), { stopped: true });
  assert.deepEqual(sent, [[SESSION, 'stopShellJob', ['job_1']]]);

  answer = { stopped: false, error: 'task already completed: job_1' };
  assert.deepEqual(await lifecycle.stopShellJob(SESSION, 'job_1'), {
    stopped: false,
    error: 'task already completed: job_1',
  });
  answer = { stopped: 'yes' };
  assert.equal((await lifecycle.stopShellJob(SESSION, 'job_1')).stopped, false);
  answer = null;
  assert.equal((await lifecycle.stopShellJob(SESSION, 'job_1')).stopped, false);
  answer = new Error('Session is not available.');
  assert.deepEqual(await lifecycle.stopShellJob(SESSION, 'job_1'), {
    stopped: false,
    error: 'Session is not available.',
  });
});

test('releaseShellJob is validated on IPC and remote, and routed to the session runtime', async () => {
  const handlers = new Map();
  const calls = [];
  const host = {
    releaseShellJob: async (...args) => {
      calls.push(args);
      return { released: true };
    },
  };
  registerSessionIpc({
    handle: (channel, fn) => handlers.set(channel, fn),
    host,
    invokeDesktopOperation: async () => {},
  });
  const call = (...args) => handlers.get(DESKTOP_IPC.releaseShellJob)({}, ...args);
  assert.deepEqual(await call(` ${SESSION} `, ' job_1 '), { released: true });
  await assert.rejects(async () => call('../bad id', 'job_1'), /session id is invalid/);
  await assert.rejects(async () => call(SESSION, undefined), /taskId must be a string/);
  const methods = createRemoteMethods({ host });
  assert.deepEqual(await methods.releaseShellJob([SESSION, 'job_2']), { released: true });
  assert.throws(() => methods.releaseShellJob([SESSION, 5]), /taskId must be a string/);
  assert.deepEqual(calls, [
    [SESSION, 'job_1'],
    [SESSION, 'job_2'],
  ]);

  const sent = [];
  let answer = { released: true };
  const lifecycle = new SessionHostLifecycle({
    invokeSession: async (...args) => {
      sent.push(args);
      if (answer instanceof Error) throw answer;
      return { value: answer };
    },
  });
  assert.deepEqual(await lifecycle.releaseShellJob(SESSION, 'job_1'), { released: true });
  assert.deepEqual(sent, [[SESSION, 'releaseShellJob', ['job_1']]]);
  answer = { released: false, error: 'no unconfirmed termination hold: job_1' };
  assert.deepEqual(await lifecycle.releaseShellJob(SESSION, 'job_1'), {
    released: false,
    error: 'no unconfirmed termination hold: job_1',
  });
  answer = new Error('Session is not available.');
  assert.equal((await lifecycle.releaseShellJob(SESSION, 'job_1')).released, false);
});
