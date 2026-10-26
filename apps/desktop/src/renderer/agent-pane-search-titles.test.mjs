// The Bots page titles a session for its search only while there is something
// to search for: an empty search renders the same rows without building any
// title. `sessionTitleNormalizationStats.cleaned` counts the title builder's
// uncached runs (the memo is keyed by the exact title text, so each title here
// is unique to its test).
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import React, { act } from 'react';
import { installTestDom } from './test-support/test-dom.mjs';

const { restore: restoreBootstrapDom } = installTestDom(null);
after(restoreBootstrapDom);
const [{ AgentActivityPane }, orderStore, { resetMixyStatus }, { publishAgentModeSessions }, titles] =
  await Promise.all([
    import('./AgentActivityPane.tsx'),
    import('./bot-order-store.ts'),
    import('./mixy-identity.ts'),
    import('./agent-chat-mode.ts'),
    import('../shared/session-title.mjs'),
  ]);

const HOUR = 60 * 60_000;
const coding = (id, title, at) => ({
  id,
  title,
  preview: '',
  updatedAt: at,
  activityAt: at,
  messageCount: 2,
});
const lead = (id, extra = {}) => ({
  tag: `lead:${id}`,
  agent: 'lead',
  sessionId: id,
  ownerSessionId: id,
  status: 'running',
  stage: 'running',
  turnStartedAt: Date.now() - 5_000,
  ...extra,
});

async function mount(t, sessions, pool) {
  orderStore.resetBotOrder();
  resetMixyStatus();
  publishAgentModeSessions([]);
  t.after(() => {
    orderStore.resetBotOrder();
    resetMixyStatus();
  });
  const { dom, root } = installTestDom(t, {
    jsdom: { url: 'http://localhost/' },
    expose: ['HTMLElement', 'Element', 'Node', 'KeyboardEvent', 'MouseEvent', 'navigator'],
    rootId: 'root',
  });
  const { window } = dom;
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  window.mixdogDesktop = {
    listAgentPool: async () => pool,
    subscribeAgentPool: () => () => {},
    invokeCapability: async ({ capability }) => {
      if (capability === 'getLeadStatus') return { value: { created: true } };
      if (capability === 'getBotOrder') return { value: { order: [] } };
      if (capability === 'listAgents') return { value: [] };
      return { value: null };
    },
    subscribeSettingsChanged: () => () => {},
  };
  await act(async () => {
    root.render(React.createElement(AgentActivityPane, { active: false, sessions, onOpenSession: () => {} }));
  });
  await act(async () => {});
  const leads = () => [...window.document.querySelectorAll('[data-agent-lead]')].map((el) => el.dataset.agentLead);
  const search = async (text) => {
    const button = window.document.querySelector('button.session-panel-action[aria-label="Search"]');
    if (!window.document.querySelector('input.agent-pane-search'))
      await act(async () => button.dispatchEvent(new window.MouseEvent('click', { bubbles: true })));
    const input = window.document.querySelector('input.agent-pane-search');
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, text);
      input.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
  };
  return { leads, search };
}

test('an empty search builds no title for a session that is not shown; a search does', async (t) => {
  const now = Date.now();
  // A Lead settled two hours ago is past the 1-hour retention window: never a row.
  const expired = lead('old', { status: 'idle', stage: 'idle', turnStartedAt: null, idleSince: now - 2 * HOUR });
  const m = await mount(t, [coding('old', 'Cleaned-once expired title', now - 2 * HOUR)], [expired]);
  assert.deepEqual(m.leads(), []);
  assert.equal(titles.sessionTitleNormalizationStats.cleaned, 0, 'no title was built with nothing to search for');
  await m.search('no such session');
  assert.deepEqual(m.leads(), []);
  assert.ok(titles.sessionTitleNormalizationStats.cleaned > 0, 'a search titles the sessions it looks through');
});

test('an empty search shows every row; a search filters by title as before', async (t) => {
  const now = Date.now();
  const m = await mount(
    t,
    [coding('one', 'Quokka planning title', now), coding('two', 'Zebra review title', now)],
    [lead('one'), lead('two')]
  );
  assert.deepEqual(m.leads().sort(), ['one', 'two']);
  await m.search('zebra');
  assert.deepEqual(m.leads(), ['two']);
  await m.search('QUOKKA');
  assert.deepEqual(m.leads(), ['one']);
  await m.search('');
  assert.deepEqual(m.leads().sort(), ['one', 'two']);
});
