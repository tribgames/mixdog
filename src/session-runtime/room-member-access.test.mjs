import assert from 'node:assert/strict';
import test from 'node:test';

import { roomMemberSessionId } from '../runtime/agent/orchestrator/session/agent-room.mjs';
import { assertAutomationAccess, assertInteractiveCaller, scheduleCallerScope } from './services/schedule-access.mjs';
import { attachSessionHooks } from './session-hooks.mjs';

const member = roomMemberSessionId('abc123', 'gh');

function hooked(id, decision = null) {
  return attachSessionHooks(
    { id },
    {
      hooks: { beforeTool: async () => decision, dispatch: async () => {} },
      hookCommonPayload: (p) => p,
      getCwd: () => '.',
    }
  );
}

test('a room member follows the same approval rules as its home thread: no room-only ask', async () => {
  const allow = { action: 'allow' };
  const deny = { action: 'deny', reason: 'no' };
  const send = { name: 'session', args: { action: 'send', session_id: 'sess_home_lead', prompt: 'p' } };
  for (const call of [{ name: 'edit', args: { path: 'a' } }, { name: 'shell', args: { command: 'rm -rf x' } }, send]) {
    assert.deepEqual(await hooked(member, allow).beforeToolHook(call), allow, `${call.name}: as the hooks decide`);
    assert.deepEqual(
      await hooked(member).beforeToolHook(call),
      await hooked('sess_home_gh').beforeToolHook(call),
      `${call.name}: the same as the home thread`
    );
  }
  assert.deepEqual(await hooked(member, deny).beforeToolHook({ name: 'edit', args: {} }), deny, 'a deny still wins');
});

test('member sessions cannot create agents, automations or change settings', () => {
  const scope = scheduleCallerScope({ id: member, sourceType: 'lead' });
  assert.deepEqual(scope, { kind: 'room-member', agentId: 'gh' });
  assert.throws(() => assertInteractiveCaller(scope, 'saveAgentDefinition'), /group-room member/);
  assert.throws(() => assertAutomationAccess(scope, { action: 'create' }), /group-room member/);
  assert.doesNotThrow(() => assertInteractiveCaller(scheduleCallerScope({ id: 'sess_home_gh' }), 'save'));
});
