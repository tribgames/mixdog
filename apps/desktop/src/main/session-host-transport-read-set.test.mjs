// The desktop sends an action on `read` exactly when the daemon serves it on `session.read`: a read sent as a `configure`
// is refused (`getSessionWorktreeWork`, `agentDefinitionPresence` were), so the lane choice follows the daemon's own list.
import assert from 'node:assert/strict';
import test from 'node:test';
import { SESSION_CONFIGURE_ACTION_SET, SESSION_READ_ACTION_SET } from '../../../../src/standalone/session-protocol.mjs';
import { SessionHostTransport } from './session-host-transport.ts';

function transport() {
  const lanes = [];
  const answer = (lane) => async (params) => {
    lanes.push([lane, params.action]);
    return { sessionId: params.sessionId, revision: 1, full: {}, value: null };
  };
  const client = {
    list: async () => ({}),
    create: async () => ({ sessionId: 'control-1', revision: 1, full: {} }),
    read: answer('read'),
    subscribe: async () => ({}),
    unsubscribe: async () => ({}),
    submit: async () => ({}),
    abort: async () => ({}),
    approve: async () => ({}),
    configure: answer('configure'),
    close: async () => {},
  };
  const owner = {
    isDisposed: () => false,
    taskWorkspace: async () => process.cwd(),
    openHints: () => ({}),
    transcriptWindow: () => ({}),
    projection: () => undefined,
    applySessionResult: () => ({}),
    heldTranscript: () => null,
    applyTranscriptPage: () => null,
    deleteProjection: () => {},
  };
  return { lanes, transport: new SessionHostTransport(client, owner) };
}

test('every action the daemon serves on session.read is sent on read, and a configure action on configure', async () => {
  const { lanes, transport: t } = transport();
  const configure = [...SESSION_CONFIGURE_ACTION_SET][0];
  for (const action of SESSION_READ_ACTION_SET) await t.invokeSession('sess_a1', action, []);
  await t.invokeSession('sess_a1', configure, []);
  assert.deepEqual(
    lanes.filter(([lane]) => lane !== 'read'),
    [['configure', configure]]
  );
  for (const action of ['getSessionWorktreeWork', 'agentDefinitionPresence']) {
    assert.ok(lanes.some(([lane, name]) => lane === 'read' && name === action), `${action} is sent on read`);
  }
});
