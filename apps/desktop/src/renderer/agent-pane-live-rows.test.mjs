// The Bots page's agents section stays live: a Lead that starts appears, and
// one that is removed or ages out of the "Keep finished agents" window leaves,
// with no manual refresh.
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import React, { act } from 'react';
import { installTestDom } from './test-support/test-dom.mjs';

const { restore: restoreBootstrapDom } = installTestDom(null);
after(restoreBootstrapDom);
const [{ AgentActivityPane }, orderStore, { resetMixyStatus }, { publishAgentModeSessions }] = await Promise.all([
  import('./AgentActivityPane.tsx'),
  import('./bot-order-store.ts'),
  import('./mixy-identity.ts'),
  import('./agent-chat-mode.ts'),
]);

const MIN = 60_000;
const coding = (id, at, extra = {}) => ({
  id,
  title: `Code ${id}`,
  preview: '',
  updatedAt: at,
  activityAt: at,
  messageCount: 2,
  ...extra,
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

function mount(t, { pool = [] } = {}) {
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
  const host = { pool, push: () => {} };
  window.mixdogDesktop = {
    listAgentPool: async () => host.pool,
    subscribeAgentPool(listener) {
      host.push = (rows) => {
        host.pool = rows;
        listener(rows);
      };
      return () => {};
    },
    invokeCapability: async ({ capability }) => {
      if (capability === 'getLeadStatus') return { value: { created: true } };
      if (capability === 'getBotOrder') return { value: { order: [] } };
      if (capability === 'listAgents') return { value: [] };
      return { value: null };
    },
    subscribeSettingsChanged: () => () => {},
  };
  const render = (sessions) =>
    act(async () => {
      root.render(React.createElement(AgentActivityPane, { active: false, sessions, onOpenSession: () => {} }));
    });
  const leads = () => [...window.document.querySelectorAll('[data-agent-lead]')].map((el) => el.dataset.agentLead);
  return { host, render, leads };
}

test('a Lead that starts appears, and one whose session is removed disappears, with no refresh', async (t) => {
  const now = Date.now();
  const m = mount(t, { pool: [lead('a')] });
  const a = coding('a', now - MIN);
  await m.render([a]);
  assert.deepEqual(m.leads(), ['a']);

  // A new Lead: its session reaches the catalog, then its pool row is pushed.
  const b = coding('b', now, { working: true });
  await m.render([b, a]);
  await act(async () => m.host.push([lead('a'), lead('b')]));
  assert.deepEqual(m.leads().sort(), ['a', 'b'], 'the new Lead shows at once');

  // The Lead is deleted: its pool row and its session leave.
  await act(async () => m.host.push([lead('b')]));
  await m.render([b]);
  assert.deepEqual(m.leads(), ['b'], 'the removed Lead is gone at once');
});

test('a finished Lead leaves when its retention window ends, though nothing else changes', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: Date.now() });
  const now = Date.now();
  // Settled 59 minutes ago: one minute left in the default 1-hour window.
  const settled = lead('done', { status: 'idle', stage: 'idle', turnStartedAt: null, idleSince: now - 59 * MIN });
  const m = mount(t, { pool: [settled] });
  await m.render([coding('done', now - 59 * MIN)]);
  await act(async () => {});
  assert.deepEqual(m.leads(), ['done']);
  await act(async () => {
    t.mock.timers.tick(2 * MIN);
  });
  assert.deepEqual(m.leads(), [], 'the expired Lead left without a refresh');
});

test('a future-dated finish stamp never arms a timer past the setTimeout limit', async (t) => {
  const delays = [];
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn, ms, ...args) => {
    delays.push(ms);
    return realSetTimeout(fn, ms, ...args);
  };
  t.after(() => {
    globalThis.setTimeout = realSetTimeout;
  });
  const now = Date.now();
  // A clock that ran ahead stamped the finish 30 days out: expiry lies past 2^31-1 ms.
  const future = now + 30 * 24 * 60 * MIN;
  const settled = lead('ahead', { status: 'idle', stage: 'idle', turnStartedAt: null, idleSince: future });
  const m = mount(t, { pool: [settled] });
  await m.render([coding('ahead', future)]);
  await act(async () => {});
  assert.deepEqual(m.leads(), ['ahead']);
  const expiryDelays = delays.filter((ms) => ms > 24 * 60 * MIN);
  assert.ok(expiryDelays.length > 0, 'the expiry timer was armed');
  assert.ok(Math.max(...expiryDelays) <= 2 ** 31 - 1, `delay within the limit: ${Math.max(...expiryDelays)}`);
});
