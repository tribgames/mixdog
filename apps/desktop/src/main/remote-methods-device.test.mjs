// Device attribution on remote calls: the name comes from the authenticated
// connection, never from a field the client sent.
import assert from 'node:assert/strict';
import test from 'node:test';

import { createRemoteMethods, STALE_SESSION_VIEW_MESSAGE } from './remote-methods.ts';
import { requiredAbortOptions, requiredSubmitOptions, requiredToolApprovalDecision } from './ipc-validation.ts';

const SESSION = `sess_desktop_${'a'.repeat(64)}`;

function recordingHost() {
  const calls = [];
  return {
    calls,
    host: {
      submitToSession: async (...args) => (calls.push(['submit', ...args]), true),
      submitNewTask: async (...args) => (calls.push(['newTask', ...args]), { accepted: true }),
      abortSession: async (...args) => (calls.push(['abort', ...args]), { aborted: true }),
      resolveToolApprovalForSession: async (...args) => (calls.push(['approve', ...args]), true),
    },
  };
}

const client = (overrides = {}) => ({ deviceName: async () => 'Pixel 9', ...overrides });

test('submit, abort and approval carry the connection\'s device name', async () => {
  const { host, calls } = recordingHost();
  const methods = createRemoteMethods({ host }, client());
  await methods.submitToSession([SESSION, 'hello', { id: 'x1' }]);
  await methods.abortSession([SESSION, { restorePrompt: true }]);
  await methods.resolveToolApprovalForSession([SESSION, 'a1', { approved: true }]);
  assert.equal(calls[0][3].device, 'Pixel 9');
  assert.equal(calls[1][2].device, 'Pixel 9');
  assert.equal(calls[2][3].device, 'Pixel 9');
});

test('a client cannot name its own device', () => {
  assert.throws(() => requiredSubmitOptions({ device: 'Main PC' }), /unsupported field/);
  assert.throws(() => requiredAbortOptions({ device: 'Main PC' }), /unsupported field/);
  assert.throws(() => requiredToolApprovalDecision({ approved: true, device: 'Main PC' }), /unsupported field/);
});

test('a connection the relay does not name is a web app', async () => {
  const { host, calls } = recordingHost();
  const methods = createRemoteMethods({ host }, {});
  await methods.submitToSession([SESSION, 'hello', {}]);
  assert.equal(calls[0][3].device, 'Web app');
});

test('a submit from a view that lacks another device\'s prompt is refused with a clear message', async () => {
  const { host, calls } = recordingHost();
  const asked = [];
  const methods = createRemoteMethods(
    { host },
    client({
      staleView: (sessionId, device) => {
        asked.push([sessionId, device]);
        return true;
      },
    })
  );
  await assert.rejects(methods.submitToSession([SESSION, 'hello', {}]), (error) => {
    assert.equal(error.message, STALE_SESSION_VIEW_MESSAGE);
    return true;
  });
  assert.deepEqual(asked, [[SESSION, 'Pixel 9']]);
  assert.equal(calls.length, 0, 'nothing reached the session');
});
