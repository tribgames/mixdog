// An MCP action the desktop issues for a session's view names that session (`threadId`, protocol.md
// §12.4), on the session path and the control path alike, so the core reads and changes the servers of
// the scope that session holds. Other actions carry no `threadId`. (The lane that turns the call into an
// `mcp/<action>` request is WP-DESKTOP-CORE's; this pins the carrier it needs.)
import assert from 'node:assert/strict';
import test from 'node:test';
import { MCP_ACTIONS, SessionHostTransport } from './session-host-transport.ts';

function transport() {
  const calls = [];
  const answer = (lane) => async (params) => {
    calls.push({ lane, params });
    return { sessionId: params.sessionId, revision: 1, full: {}, value: 'ok' };
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
  return { calls, transport: new SessionHostTransport(client, owner) };
}

test('an MCP action for a session names that session, on the read and the configure lane', async () => {
  const { calls, transport: t } = transport();
  await t.invokeSession('sess_a1', 'mcpStatus', []);
  await t.invokeSession('sess_a1', 'setMcpServerEnabled', ['linear', false]);
  assert.deepEqual(
    calls.map(({ lane, params }) => [lane, params.action, params.sessionId, params.threadId]),
    [
      ['read', 'mcpStatus', 'sess_a1', 'sess_a1'],
      ['configure', 'setMcpServerEnabled', 'sess_a1', 'sess_a1'],
    ]
  );
});

test('an MCP action on the control path names the control session', async () => {
  const { calls, transport: t } = transport();
  await t.invokeControlResult('beginMcpOAuthLogin', ['linear']);
  await t.invokeControlResult('reconnectMcp', []);
  assert.deepEqual(
    calls.map(({ params }) => [params.action, params.sessionId, params.threadId]),
    [
      ['beginMcpOAuthLogin', 'control-1', 'control-1'],
      ['reconnectMcp', 'control-1', 'control-1'],
    ]
  );
});

test('an action that is not an MCP action carries no threadId, and every MCP action is listed', async () => {
  const { calls, transport: t } = transport();
  await t.invokeSession('sess_a1', 'skillsStatus', []);
  assert.equal('threadId' in calls[0].params, false);
  for (const action of ['mcpStatus', 'reconnectMcp', 'beginMcpOAuthLogin', 'signOutMcpServer', 'listConnectorTools']) {
    assert.ok(MCP_ACTIONS.has(action), action);
  }
});