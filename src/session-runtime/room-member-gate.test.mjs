import assert from 'node:assert/strict';
import test from 'node:test';

import { roomMemberSessionId } from '../runtime/agent/orchestrator/session/agent-room.mjs';
import { assertAutomationAccess, assertInteractiveCaller, scheduleCallerScope } from './services/schedule-access.mjs';
import { ROOM_APPROVAL_REASON, roomMemberToolDecision } from './room-member-gate.mjs';
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

test('room members need approval for writes even when hooks allow them; reads are free', async () => {
  const session = hooked(member, { action: 'allow' });
  assert.deepEqual(await session.beforeToolHook({ name: 'edit', args: { path: 'a' } }), {
    action: 'ask',
    reason: ROOM_APPROVAL_REASON,
  });
  assert.equal((await session.beforeToolHook({ name: 'shell', args: { command: 'rm -rf x' } })).action, 'ask');
  assert.deepEqual(await session.beforeToolHook({ name: 'read', args: { path: 'a' } }), { action: 'allow' });
  assert.equal((await session.beforeToolHook({ name: 'shell', args: { command: 'git status' } }))?.action, 'allow');
});

test('a hook deny still wins, and other sessions are untouched', async () => {
  const deny = { action: 'deny', reason: 'no' };
  assert.equal(await roomMemberToolDecision({ name: 'edit' }, deny), deny);
  assert.equal(await hooked('sess_home_gh').beforeToolHook({ name: 'edit', args: {} }), null);
});

test('member sessions cannot create agents, automations or change settings', () => {
  const scope = scheduleCallerScope({ id: member, sourceType: 'lead' });
  assert.deepEqual(scope, { kind: 'room-member', agentId: 'gh' });
  assert.throws(() => assertInteractiveCaller(scope, 'saveAgentDefinition'), /group-room member/);
  assert.throws(() => assertAutomationAccess(scope, { action: 'create' }), /group-room member/);
  assert.doesNotThrow(() => assertInteractiveCaller(scheduleCallerScope({ id: 'sess_home_gh' }), 'save'));
});
