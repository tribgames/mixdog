import assert from 'node:assert/strict';
import test from 'node:test';

import { MIXY_AGENT_ID, agentHomeSessionId, agentIdOfHomeSession, isAgentHomeSessionId } from './agent-home.mjs';
import { SESSION_ID_PATTERN } from '../runtime-core/session-id.mjs';
import { isScratchSession } from '../../../../session-runtime/lifecycle/shared.mjs';
import { sessionRolePromptFields } from './manager/session-prompt-composition.mjs';

test('the home key is a fixed, reversible session id per agent', () => {
  for (const agentId of ['github-watcher', 'a.b', 'reviewer2', MIXY_AGENT_ID]) {
    const sessionId = agentHomeSessionId(agentId);
    assert.equal(sessionId, agentHomeSessionId(agentId), 'the same agent always names the same session');
    assert.match(sessionId, SESSION_ID_PATTERN);
    assert.equal(agentIdOfHomeSession(sessionId), agentId);
    assert.equal(isAgentHomeSessionId(sessionId), true);
  }
  // Distinct agents never share a thread.
  assert.notEqual(agentHomeSessionId('a.b'), agentHomeSessionId('a-b'));
  assert.equal(agentHomeSessionId('lead'), 'sess_home_lead');
});

test('non-agent ids and ordinary sessions are not home threads', () => {
  for (const agentId of ['', 'Upper', '-lead', 'has space', 'a_b', null]) {
    assert.equal(agentHomeSessionId(agentId), '');
  }
  for (const sessionId of ['sess_desktop_x', 'sess_home_', 'sess_home_Up', 'sess_home__x', 'sess_daemon_1']) {
    assert.equal(isAgentHomeSessionId(sessionId), false, sessionId);
  }
});

test("a home thread's prompt carries its agent's role; a Lead's does not", () => {
  const fields = (agent) =>
    sessionRolePromptFields(
      { agent, skipAgentRules: true },
      { ownerIsAgent: false, toolFreeRole: false, delegationFree: false }
    );
  assert.equal(fields('github-watcher').skipRoleCatalog, false);
  assert.equal(fields('lead').skipRoleCatalog, true);
  assert.equal(fields(null).skipRoleCatalog, true);
});

test('a blank home thread is never scratch, so no close tombstones its fixed id', () => {
  assert.equal(isScratchSession({ id: 'sess_desktop_blank', messages: [] }), true);
  assert.equal(isScratchSession({ id: agentHomeSessionId('github-watcher'), messages: [] }), false);
});
