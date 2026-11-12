// Replay of native/core/fixtures/session-host-transport-read-set-cases (record-session-host-transport-read-set-cases.mjs, recorded from
// b6f10295a with node-fix-session-host-read-set.patch): the K1 desktop's SessionHostTransport sends each recorded action, and the
// recorded action sets and the lane of every action are compared whole, in recorded order.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { SESSION_CONFIGURE_ACTION_SET, SESSION_READ_ACTION_SET } from '../../../../packages/protocol-client/src/actions/session-protocol.mjs';
import { SessionHostTransport } from './session-host-transport.ts';

const NAME = 'every action the daemon serves on session.read is sent on read, and a configure action on configure';
const golden = JSON.parse(readFileSync(new URL('../../../../native/core/fixtures/session-host-transport-read-set-cases/golden.json', import.meta.url), 'utf8'));
const recorded = golden.cases.find((entry) => entry.case === NAME).observed;

test(NAME, async () => {
  const lanes = [];
  const answer = (lane) => async (params) => {
    lanes.push([lane, params.action]);
    return { sessionId: params.sessionId, revision: 1, full: {}, value: null };
  };
  const client = {
    list: async () => ({}), create: async () => ({ sessionId: 'control-1', revision: 1, full: {} }), read: answer('read'),
    subscribe: async () => ({}), unsubscribe: async () => ({}), submit: async () => ({}), abort: async () => ({}), approve: async () => ({}),
    configure: answer('configure'), close: async () => {},
  };
  const owner = {
    isDisposed: () => false, taskWorkspace: async () => process.cwd(), openHints: () => ({}), transcriptWindow: () => ({}), projection: () => undefined,
    applySessionResult: () => ({}), heldTranscript: () => null, applyTranscriptPage: () => null, deleteProjection: () => {},
  };
  const t = new SessionHostTransport(client, owner);
  assert.deepStrictEqual([...SESSION_READ_ACTION_SET], recorded.readActions, 'the read set');
  assert.deepStrictEqual([...SESSION_CONFIGURE_ACTION_SET], recorded.configureActions, 'the configure set');
  for (const action of recorded.readActions) await t.invokeSession('sess_a1', action, []);
  await t.invokeSession('sess_a1', recorded.configureActionSent, []);
  assert.deepStrictEqual(lanes, recorded.lanes, 'every recorded action, in order, on the recorded lane');
});
