// Rename in the bot, room and Lead-agent row menus: the item is offered on
// every surface, a commit calls the right backend with the trimmed name, and
// Esc / empty / unchanged names do nothing.
import assert from 'node:assert/strict';
import test from 'node:test';
import { installTestDom } from './test-support/test-dom.mjs';

const wait = () => new Promise((resolve) => setTimeout(resolve, 10));

async function setup(t, answer) {
  const { window } = installTestDom(t, { expose: ['CustomEvent'] });
  const { overridePromptAction } = await import('./app-confirm.tsx');
  const asked = [];
  overridePromptAction((title, options) => {
    asked.push({ title, ...options });
    return answer.value;
  });
  t.after(() => overridePromptAction(null));
  const calls = [];
  const definition = { name: 'Watcher', description: 'Watches', body: 'Body', revision: 'rev1' };
  window.mixdogDesktop = {
    invokeCapability: async ({ capability, args }) => {
      calls.push([capability, ...args]);
      if (capability === 'getAgentDefinition') return { value: definition };
      if (capability === 'saveLeadIdentity') return { value: { created: true, name: args[0].name } };
      return { value: {} };
    },
    agentRoomAction: async (action, args) => {
      calls.push(['room', action, ...args]);
    },
  };
  return { calls, asked };
}

const handlers = { onOpen() {}, onProfile() {} };

test('Rename is in every bot menu on both surfaces, and in the room menu', async () => {
  const { agentContactMenuItems, agentRoomMenuItems } = await import('./agent-profile-actions.ts');
  for (const surface of ['page', 'sidebar']) {
    for (const contact of [
      { agentId: 'watcher', name: 'Watcher', mixy: false },
      { agentId: 'lead', name: 'Mixy', mixy: true },
    ]) {
      const ids = agentContactMenuItems(contact, handlers, {}, surface).map((item) => item.id);
      assert.ok(ids.includes('agent-rename'), `${surface} ${contact.agentId}`);
    }
  }
  assert.ok(agentRoomMenuItems({ id: 'r1', name: 'Room' }).some((item) => item.id === 'room-rename'));
});

test('a bot rename saves only the trimmed name over the stored definition', async (t) => {
  const answer = { value: '  Sentinel  ' };
  const { calls, asked } = await setup(t, answer);
  const { agentContactMenuItems } = await import('./agent-profile-actions.ts');
  const item = (name = 'Watcher') =>
    agentContactMenuItems({ agentId: 'watcher', name, mixy: false }, handlers, {}, 'sidebar').find(
      (entry) => entry.id === 'agent-rename'
    );
  item().onSelect();
  await wait();
  assert.equal(asked[0].value, 'Watcher');
  assert.equal(asked[0].maxLength, 64);
  assert.deepEqual(calls, [
    ['getAgentDefinition', 'watcher'],
    [
      'saveAgentDefinition',
      { id: 'watcher', expectedRevision: 'rev1', name: 'Sentinel', description: 'Watches', body: 'Body' },
    ],
  ]);
  for (const cancelled of [null, '', '   ', ' Watcher ']) {
    calls.length = 0;
    answer.value = cancelled;
    item().onSelect();
    await wait();
    assert.deepEqual(calls, [], `no call for ${JSON.stringify(cancelled)}`);
  }
});

test('Mixy is renamed through its identity', async (t) => {
  const { calls } = await setup(t, { value: ' Navi ' });
  const { agentContactMenuItems } = await import('./agent-profile-actions.ts');
  agentContactMenuItems({ agentId: 'lead', name: 'Mixy', mixy: true }, handlers, {}, 'page')
    .find((entry) => entry.id === 'agent-rename')
    .onSelect();
  await wait();
  assert.deepEqual(calls, [['saveLeadIdentity', { name: 'Navi' }]]);
});

test('a room rename updates the room config with the trimmed name; cancel, empty and unchanged do nothing', async (t) => {
  const answer = { value: ' Release crew ' };
  const { calls, asked } = await setup(t, answer);
  const { agentRoomMenuItems } = await import('./agent-profile-actions.ts');
  const run = async () => {
    agentRoomMenuItems({ id: 'r1', name: 'Release' })
      .find((entry) => entry.id === 'room-rename')
      .onSelect();
    await wait();
  };
  await run();
  assert.equal(asked[0].maxLength, 80);
  assert.deepEqual(calls, [['room', 'update', 'r1', { name: 'Release crew' }]]);
  for (const ignored of [null, '', '  ', 'Release']) {
    calls.length = 0;
    answer.value = ignored;
    await run();
    assert.deepEqual(calls, []);
  }
});

test('a Lead session rename uses the session rename with the trimmed title', async (t) => {
  const answer = { value: ' New title ' };
  await setup(t, answer);
  const { renameLeadSession } = await import('./agent-profile-actions.ts');
  const renamed = [];
  const rename = async (id, title) => renamed.push([id, title]);
  assert.equal(await renameLeadSession(rename, 'sess_1', 'Old'), true);
  assert.deepEqual(renamed, [['sess_1', 'New title']]);
  for (const ignored of [null, '', 'Old']) {
    answer.value = ignored;
    assert.equal(await renameLeadSession(rename, 'sess_1', 'Old'), false);
  }
  assert.equal(renamed.length, 1);
});

test('session rows: Rename for ordinary sessions, none for a bot home chat or a room log', async () => {
  const { sessionMenuItems } = await import('./session-sidebar-menus.tsx');
  const { agentHomeSessionId } = await import('../../../../src/runtime/agent/orchestrator/session/agent-home.mjs');
  const { roomSessionId } = await import('../../../../src/runtime/agent/orchestrator/session/agent-room.mjs');
  const actions = { projectGroups: [], sessionGroupKeys: new Map(), onResumeSession() {} };
  const ids = (id) => sessionMenuItems({ id, title: 'x', archived: true }, id, actions).map((item) => item.id);
  assert.ok(ids('sess_plain').includes('rename'));
  assert.ok(!ids(agentHomeSessionId('watcher')).includes('rename'));
  assert.ok(!ids(roomSessionId('abc123')).includes('rename'));
});
