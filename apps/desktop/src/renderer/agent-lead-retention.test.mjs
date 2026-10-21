// Finished Leads on the Bots page: the "Keep finished agents" window (1 hour
// by default, 1 day, 7 days, forever) and pinned Leads that never expire. Both
// ride in the host-stored bot order (`retain:<choice>`, `pin:<sessionId>`).
// The pool stops publishing a finished Lead after an hour, so the longer
// windows and pins list the session itself, as finished.
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

const NOW = Date.now();
const MIN = 60_000;
const HOUR = 60 * MIN;
const coding = (id, agoMs, extra = {}) => ({
  id,
  title: `Code ${id}`,
  preview: '',
  updatedAt: NOW - agoMs,
  activityAt: NOW - agoMs,
  messageCount: 2,
  ...extra,
});

function mount(t, { sessions, pool = [], stored = [] }) {
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
  const host = { order: stored, calls: [] };
  window.mixdogDesktop = {
    listAgentPool: async () => pool,
    subscribeAgentPool: () => () => {},
    invokeCapability: async ({ capability, args }) => {
      if (capability === 'getLeadStatus') return { value: { created: true } };
      if (capability === 'getBotOrder') return { value: { order: host.order } };
      if (capability === 'setBotOrder') {
        host.calls.push(args[0]);
        host.order = args[0];
        return { value: { order: host.order } };
      }
      if (capability === 'listAgents') return { value: [] };
      return { value: null };
    },
    subscribeSettingsChanged: () => () => {},
  };
  const render = async () => {
    await act(async () =>
      root.render(React.createElement(AgentActivityPane, { active: true, sessions, onOpenSession: () => {} }))
    );
    await act(async () => {});
  };
  const leads = () => [...window.document.querySelectorAll('[data-agent-lead]')].map((el) => el.dataset.agentLead);
  return { window, document: window.document, host, render, leads };
}

const SESSIONS = [coding('two-hours', 2 * HOUR), coding('day-old', 25 * HOUR), coding('fresh', 10 * MIN)];

test('default 1 hour: a Lead finished 10 minutes ago stays, 2 and 25 hours ago do not', async (t) => {
  const m = mount(t, { sessions: [coding('fresh', 10 * MIN), ...SESSIONS.slice(0, 2)] });
  await m.render();
  assert.deepEqual(m.leads(), ['fresh'], '10 min stays, 2 h and 25 h are past the default hour');
});

test('1 day keeps a 2-hour-old finished Lead and drops a 25-hour-old one', async (t) => {
  const m = mount(t, { sessions: SESSIONS, stored: ['retain:1d'] });
  await m.render();
  assert.deepEqual(m.leads(), ['fresh', 'two-hours']);
  const row = m.document.querySelector('[data-agent-lead="two-hours"]');
  assert.equal(row.querySelector('.agent-chat-preview').textContent, 'Idle', 'shown as finished, not Working');
  assert.equal(row.querySelector('.agent-chat-status'), null);
});

test('7 days keeps the 25-hour-old one, and Forever keeps every finished Lead', async (t) => {
  const week = mount(t, { sessions: [...SESSIONS, coding('eight-days', 8 * 24 * HOUR)], stored: ['retain:7d'] });
  await week.render();
  assert.deepEqual(week.leads(), ['fresh', 'two-hours', 'day-old']);
  const forever = mount(t, {
    sessions: [...SESSIONS, coding('eight-days', 8 * 24 * HOUR)],
    stored: ['retain:forever'],
  });
  await forever.render();
  assert.deepEqual(forever.leads(), ['fresh', 'two-hours', 'day-old', 'eight-days']);
});

test('a pinned Lead survives past the window, comes first with a pin mark, and goes when archived', async (t) => {
  const m = mount(t, {
    sessions: [
      coding('fresh', 10 * MIN),
      coding('old', 40 * 24 * HOUR),
      coding('gone', 40 * 24 * HOUR, { archived: true }),
    ],
    stored: ['pin:old', 'pin:gone'],
  });
  await m.render();
  assert.deepEqual(m.leads(), ['old', 'fresh'], 'pinned first, archived pin not listed');
  assert.ok(m.document.querySelector('[data-agent-lead="old"] [data-lead-pin]'), 'the pin mark');
  assert.equal(m.document.querySelector('[data-agent-lead="fresh"] [data-lead-pin]'), null);
});

test('a pooled finished Lead past the window is kept when pinned, with its pool state', async (t) => {
  const pool = [
    {
      tag: 'lead:old',
      agent: 'lead',
      sessionId: 'old',
      ownerSessionId: 'old',
      status: 'idle',
      stage: 'idle',
      idleSince: NOW - 3 * HOUR,
    },
  ];
  const sessions = [coding('old', 3 * HOUR)];
  const plain = mount(t, { sessions, pool });
  await plain.render();
  assert.deepEqual(plain.leads(), [], 'default hour drops it');
  const pinned = mount(t, { sessions, pool, stored: ['pin:old'] });
  await pinned.render();
  assert.deepEqual(pinned.leads(), ['old']);
});

test('the Lead menu pins and unpins, stored as pin:<sessionId> in the bot order', async (t) => {
  const m = mount(t, { sessions: [coding('fresh', 10 * MIN)] });
  await m.render();
  const menu = async () => {
    await act(async () =>
      m.document
        .querySelector('[data-agent-lead="fresh"]')
        .dispatchEvent(
          new m.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 9, clientY: 9 })
        )
    );
    return [...m.document.querySelectorAll('[role="menuitem"]')];
  };
  let items = await menu();
  assert.ok(items.some((el) => el.textContent.trim() === 'Hide this group'));
  await act(async () => items.find((el) => el.textContent.trim() === 'Pin').click());
  assert.deepEqual(m.host.calls.at(-1), ['pin:fresh']);
  assert.ok(m.document.querySelector('[data-agent-lead="fresh"] [data-lead-pin]'), 'marked at once');
  items = await menu();
  await act(async () => items.find((el) => el.textContent.trim() === 'Unpin').click());
  assert.deepEqual(m.host.calls.at(-1), []);
  assert.equal(m.document.querySelector('[data-lead-pin]'), null);
});

test('the ⋯ menu offers Keep finished agents as radios (1 hour default) and stores the choice', async (t) => {
  const m = mount(t, { sessions: SESSIONS });
  await m.render();
  assert.deepEqual(m.leads(), ['fresh']);
  await act(async () => m.document.querySelector('.agent-activity-page .row-overflow-trigger').click());
  const radios = () => [...m.document.querySelectorAll('[role="menuitemradio"]')];
  assert.deepEqual(
    radios().map((el) => [el.textContent.trim(), el.getAttribute('aria-checked')]),
    [
      ['1 hour', 'true'],
      ['1 day', 'false'],
      ['7 days', 'false'],
      ['Forever', 'false'],
    ]
  );
  assert.equal(
    m.document.querySelector('[data-action-id="keep-finished-agents"]').textContent.trim(),
    'Keep finished agents'
  );
  await act(async () => m.document.querySelector('[data-action-id="retain-1d"]').click());
  assert.deepEqual(m.host.calls.at(-1), ['retain:1d']);
  assert.deepEqual(m.leads(), ['fresh', 'two-hours'], 'the list follows at once');
  assert.equal(m.document.querySelector('[data-action-id="retain-1d"]').getAttribute('aria-checked'), 'true');
  await act(async () => m.document.querySelector('[data-action-id="retain-1h"]').click());
  assert.deepEqual(m.host.calls.at(-1), [], 'the default is stored as no entry');
});

test('pins and the retention choice are read from the host list and survive other entries', () => {
  const order = ['b1', 'section:agents', 'hidden:rooms', 'pin:s1', 'retain:7d', 'pin:s2'];
  assert.deepEqual([...orderStore.pinnedLeadIds(order)], ['s1', 's2']);
  assert.equal(orderStore.retainChoice(order), '7d');
  assert.equal(orderStore.retainChoice(['retain:bogus']), '1h');
  assert.equal(orderStore.retainChoice([]), '1h');
  assert.deepEqual(orderStore.toggledPinOrder(order, 's1', false), [
    'b1',
    'section:agents',
    'hidden:rooms',
    'retain:7d',
    'pin:s2',
  ]);
  assert.equal(orderStore.toggledPinOrder(order, 's1', true), null);
  assert.deepEqual(
    orderStore.retainedChoiceOrder(order, 'forever')?.filter((id) => id.startsWith('retain:')),
    ['retain:forever']
  );
  assert.equal(orderStore.retainedChoiceOrder(order, '7d'), null);
});
