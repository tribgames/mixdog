import assert from 'node:assert/strict';
import test from 'node:test';
import { installTestDom } from './test-support/test-dom.mjs';

installTestDom(null, { expose: ['navigator', 'Node', 'Element', 'HTMLElement'] });

const { agentOfChatSession, persistAgentChatRoute, subscribeAgentRouteChange } = await import('./agent-chat-route.ts');

const selection = { provider: 'anthropic-oauth', model: 'claude-haiku-5-5', effort: 'high', contextPercent: 50 };

function fakeApi(definition = {}) {
  const calls = [];
  return {
    calls,
    async setModelRoute(...args) {
      calls.push(['setModelRoute', ...args]);
      return null;
    },
    async invokeCapability(request) {
      calls.push([request.capability, ...request.args]);
      return { value: request.capability === 'getAgentDefinition' ? definition : null };
    },
  };
}

test('the chat names the agent it acts as', () => {
  assert.equal(agentOfChatSession('sess_home_lead'), 'lead');
  assert.equal(agentOfChatSession('sess_home_writer'), 'writer');
  assert.equal(agentOfChatSession('sess_task_1'), '');
});

test("Mixy's chip writes Mixy's own route, never the Lead's Main route, as its profile pane does", async () => {
  const api = fakeApi();
  const seen = [];
  const stop = subscribeAgentRouteChange((agentId) => seen.push(agentId));
  assert.equal(await persistAgentChatRoute('sess_home_lead', selection, api), true);
  stop();
  assert.deepEqual(api.calls, [['setAgentRoute', 'lead', selection]]);
  assert.deepEqual(seen, ['lead'], 'an open profile pane re-reads');
});

test("another agent's chip writes its stored route, every field, and keeps an off agent off", async () => {
  const on = fakeApi({ disabled: false });
  await persistAgentChatRoute('sess_home_writer', selection, on);
  assert.deepEqual(on.calls.at(-1), ['setAgentRoute', 'writer', selection]);
  const off = fakeApi({ disabled: true });
  await persistAgentChatRoute('sess_home_writer', selection, off);
  assert.deepEqual(off.calls.at(-1), ['setAgentRoute', 'writer', { ...selection, disabled: true }]);
});

test('a session that acts as no single agent keeps the write on the session alone', async () => {
  const api = fakeApi();
  assert.equal(await persistAgentChatRoute('sess_task_1', selection, api), false);
  assert.deepEqual(api.calls, []);
});
