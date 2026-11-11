// Replay of native/core/fixtures/session-host-transport-read-set-cases (record-session-host-transport-read-set-cases.mjs): the K1
// desktop's SessionHostTransport sends each recorded action, and the lane it chose is compared. The action lists are compared whole;
// the lanes against the case's own rule over the recorded read set, because the recording's `lanes` hold the old transport's choice
// (a desktop copy of the read list that sent 12 of the daemon's read actions as a refused `configure`), which K1 fixed
// (session-host-transport.ts READ_CAPABILITIES = SESSION_READ_ACTION_SET). The manifest declares it.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { SESSION_CONFIGURE_ACTION_SET, SESSION_READ_ACTION_SET } from '../../../../src/standalone/session-protocol.mjs';
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
  const configure = [...SESSION_CONFIGURE_ACTION_SET][0];
  assert.equal(configure, recorded.configureActionSent);
  for (const action of recorded.readActions) await t.invokeSession('sess_a1', action, []);
  await t.invokeSession('sess_a1', recorded.configureActionSent, []);
  const expected = [...recorded.readActions.map((action) => ['read', action]), ['configure', recorded.configureActionSent]];
  assert.deepStrictEqual(lanes, expected, 'every recorded action, in order, on the lane the daemon serves it');
});
