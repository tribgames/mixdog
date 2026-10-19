// The messenger-style Agents list: one row per Lead session with a preview,
// a single prioritized status, a fold for its agents and an overflow menu that
// a right-click or a touch long-press opens.
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import React, { act } from 'react';
import { installTestDom } from './test-support/test-dom.mjs';

// react-dom's one-time event-support detection needs a DOM at import time.
const { restore: restoreBootstrapDom } = installTestDom(null);
after(restoreBootstrapDom);
const [
  { AgentActivityPane },
  { agentActivityGroups },
  { agentSessionChatSummary, agentChatTimeLabel, agentChatElapsed },
  { installTouchGestures },
  { resetDismissedShellJobsCache },
] = await Promise.all([
  import('./AgentActivityPane.tsx'),
  import('./agent-activity-model.ts'),
  import('./agent-chat-summary.ts'),
  import('./touch-gestures.ts'),
  import('./background-jobs-dismissed-store.ts'),
]);

const NOW = Date.now();
const lead = (overrides = {}) => ({
  tag: 'lead:lead-a',
  agent: 'lead',
  sessionId: 'lead-a',
  ownerSessionId: 'lead-a',
  status: 'idle',
  stage: 'idle',
  idleSince: new Date(NOW - 60_000).toISOString(),
  ...overrides,
});
const worker = (tag, overrides = {}) => ({
  tag,
  agent: 'worker',
  sessionId: `s-${tag}`,
  ownerSessionId: 'lead-a',
  parentSessionId: 'lead-a',
  status: 'idle',
  stage: 'idle',
  ...overrides,
});
const running = { status: 'running', stage: 'running', turnStartedAt: NOW - 5_000 };
const sessions = [{ id: 'lead-a', title: 'Fix the release', preview: '', updatedAt: 1, messageCount: 1 }];

function summary(pool, unread = []) {
  const [group] = agentActivityGroups(pool, (id) => id === 'lead-a');
  return agentSessionChatSummary('lead-a', group.nodes, new Set(unread));
}

test('the status slot shows exactly one indicator: approval > failure > running > unread, nothing when read', () => {
  const approval = worker('ask', { ...running, awaitingUser: 'approval' });
  const failed = worker('crash', { status: 'failed', stage: 'failed', failureReason: 'stalled' });
  const busy = worker('busy', running);
  assert.deepEqual(summary([lead(), approval, failed, busy], ['lead-a']).indicator, { kind: 'attention' });
  assert.deepEqual(summary([lead(), failed, busy], ['lead-a']).indicator, { kind: 'error' });
  assert.deepEqual(summary([lead(), busy], ['lead-a']).indicator, { kind: 'running' });
  // The Lead's own work runs the spinner too.
  assert.deepEqual(summary([lead(running)]).indicator, { kind: 'running' });
  // Unread counts every unseen session of the group, the Lead's included.
  assert.deepEqual(summary([lead(), worker('done')], ['lead-a', 's-done']).indicator, { kind: 'unread', count: 2 });
  assert.equal(summary([lead(), worker('done')]).indicator, null);
});

test('the preview line names what the session is doing now', () => {
  const busy = summary([lead(running), worker('a', running), worker('b', running), worker('c')]);
  assert.equal(busy.preview, 'Working · 3 agents');
  assert.equal(busy.memberCount, 3);
  assert.equal(summary([lead(), worker('a', running)]).preview, 'Waiting for tasks · 1 agent');
  assert.equal(summary([lead()]).preview, 'Idle');
  assert.equal(summary([lead()], ['lead-a']).preview, 'Completed');
  // A blocked or failed member speaks for the group, by name and reason.
  assert.equal(
    summary([lead(running), worker('ask', { ...running, awaitingUser: 'approval' })]).preview,
    'Worker · ask · Waiting for approval'
  );
  const crashed = summary([lead(), worker('crash', { status: 'failed', stage: 'failed', failureReason: 'stalled' })]);
  assert.equal(crashed.state, 'failed');
  assert.equal(crashed.preview, 'Worker · crash · Stopped: no progress');
  assert.equal(
    summary([lead({ status: 'failed', stage: 'failed', failureReason: 'process-restart' })]).preview,
    'Interrupted by app restart'
  );
  // No Lead row: the busiest member names the group.
  assert.equal(summary([worker('a', running), worker('b')]).preview, 'Working · 2 agents');
  assert.equal(summary([lead(), worker('done')]).preview, 'Idle · 1 agent');
});

test('row times are compact: clock today, Yesterday, month/day, and elapsed in one unit', () => {
  const now = new Date(2026, 9, 19, 15, 0).getTime();
  assert.equal(agentChatTimeLabel(new Date(2026, 9, 19, 11, 4).getTime(), now), '11:04');
  assert.equal(agentChatTimeLabel(new Date(2026, 9, 18, 23, 59).getTime(), now), 'Yesterday');
  assert.equal(agentChatTimeLabel(new Date(2026, 9, 17, 9, 0).getTime(), now), '10/17');
  assert.equal(agentChatTimeLabel(0, now), '');
  assert.equal(agentChatElapsed(5_000), '5s');
  assert.equal(agentChatElapsed(134_000), '2m');
  assert.equal(agentChatElapsed(3_700_000), '1h');
});

function mount(t, pool, props = {}) {
  const { dom, root } = installTestDom(t, {
    jsdom: { url: 'http://localhost/' },
    expose: ['HTMLElement', 'Element', 'Node', 'KeyboardEvent', 'MouseEvent', 'navigator'],
    rootId: 'root',
  });
  dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  resetDismissedShellJobsCache();
  dom.window.mixdogDesktop = {
    listAgentPool: async () => pool,
    subscribeAgentPool: () => () => {},
  };
  const opened = [];
  const render = (extra = {}) =>
    act(async () =>
      root.render(
        React.createElement(AgentActivityPane, {
          active: false,
          sessions,
          onOpenLeadSession: (id) => opened.push(['lead', id]),
          onOpenSession: (id) => opened.push(['agent', id]),
          ...props,
          ...extra,
        })
      )
    );
  return { document: dom.window.document, window: dom.window, opened, render };
}

test('a session row shows the unread count badge and nothing else in its slot', async (t) => {
  const { document, render } = mount(t, [lead(), worker('done')]);
  await render({ unreadSessionIds: new Set(['lead-a', 's-done']) });
  const row = document.querySelector('[data-agent-session-id="lead-a"]');
  const slots = [...row.querySelectorAll('.agent-chat-status')];
  assert.deepEqual(
    slots.map((slot) => [slot.dataset.kind, slot.textContent]),
    [['unread', 'Unread 2']]
  );
  // Once read, a finished session shows no status at all.
  await render({ unreadSessionIds: new Set() });
  assert.equal(row.querySelectorAll('.agent-chat-status').length, 0);
});

test('a waiting-for-approval session shows the attention pill without a spinner', async (t) => {
  const { document, render } = mount(t, [lead(running), worker('ask', { ...running, awaitingUser: 'approval' })]);
  await render();
  const slots = [...document.querySelectorAll('[data-agent-session-id="lead-a"] .agent-chat-status')];
  assert.deepEqual(
    slots.map((slot) => slot.dataset.kind),
    ['attention']
  );
  assert.equal(slots[0].textContent, 'Needs attention');
  assert.equal(document.querySelector('[data-agent-session-id="lead-a"] .progress-spinner'), null);
});

test('the chevron folds and unfolds the agents beneath a session row', async (t) => {
  const { document, render, opened } = mount(t, [lead(running), worker('a', running), worker('b')]);
  await render();
  const toggle = document.querySelector('.agent-chat-toggle[data-lead-session-id="lead-a"]');
  const row = document.querySelector('[data-agent-session-id="lead-a"]');
  assert.equal(document.querySelector('[data-agent-session-id="s-a"]'), null);
  assert.equal(row.getAttribute('aria-expanded'), 'false');
  // The twisty sits before the title, only on rows with agents beneath them.
  assert.equal(row.querySelector('.agent-chat-twisty').nextElementSibling.className, 'agent-chat-title');
  await act(async () => toggle.click());
  assert.equal(row.querySelector('.agent-chat-twisty').dataset.expanded, 'true');
  assert.equal(document.querySelector('[data-agent-session-id="s-a"] .agent-chat-twisty'), null);
  assert.equal(row.getAttribute('aria-expanded'), 'true');
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  const members = [...document.querySelectorAll('[data-kind="agent"] [role="treeitem"]')];
  assert.deepEqual(
    members.map((member) => [member.dataset.agentSessionId, member.getAttribute('aria-level')]),
    [
      ['s-a', '2'],
      ['s-b', '2'],
    ]
  );
  // Each member keeps its mark, name, route line, state and drag source.
  assert.ok(members[0].querySelector('.sidebar-resource-icon'));
  assert.equal(members[0].getAttribute('aria-label'), 'Worker · a');
  assert.ok(members[0].querySelector('.agent-route-summary'));
  assert.equal(members[1].querySelector('.agent-activity-elapsed').dataset.state, 'idle');
  assert.equal(members[0].getAttribute('draggable'), 'true');
  await act(async () => members[0].click());
  assert.deepEqual(opened, [['agent', 's-a']]);
  await act(async () => toggle.click());
  assert.equal(document.querySelector('[data-agent-session-id="s-a"]'), null);
  assert.equal(row.getAttribute('aria-expanded'), 'false');
});

test('the row overflow menu opens in a tab, hides the group and clears finished agents', async (t) => {
  const { document, render, opened } = mount(t, [lead(), worker('done'), worker('busy', running)]);
  await render();
  const openMenu = () =>
    act(async () => document.querySelector('[data-agent-owner-session-id="lead-a"] .row-overflow-trigger').click());
  const select = (id) => act(async () => document.querySelector(`[data-action-id="${id}"]`).click());
  await openMenu();
  assert.deepEqual(
    [...document.querySelectorAll('.row-overflow-menu [data-action-id]')].map((item) => item.dataset.actionId),
    ['open-agent-session', 'hide-agent-group', 'clear-finished-agents']
  );
  await select('open-agent-session');
  assert.deepEqual(opened, [['lead', 'lead-a']]);
  await openMenu();
  await select('clear-finished-agents');
  assert.equal(
    document.querySelector('[data-agent-session-id="lead-a"] .agent-chat-preview').textContent,
    'Waiting for tasks · 1 agent'
  );
  await openMenu();
  await select('hide-agent-group');
  assert.equal(document.querySelector('[data-agent-owner-session-id="lead-a"]'), null);
  assert.match(document.body.textContent, /All agent groups are hidden/);
});

test('the empty list says no agents are running', async (t) => {
  const { document, render } = mount(t, []);
  await render();
  assert.match(document.querySelector('.agent-activity-empty').textContent, /No agents are running\./);
});

function touch(window, type, target, { x = 10, y = 10 } = {}) {
  const event = new window.Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    pointerType: { value: 'touch' },
    pointerId: { value: 7 },
    isPrimary: { value: true },
    clientX: { value: x },
    clientY: { value: y },
  });
  target.dispatchEvent(event);
}

test('a touch long-press on a row opens its overflow menu without opening the session; a tap opens it', async (t) => {
  const { document, window, render, opened } = mount(t, [lead(), worker('done')]);
  t.after(installTouchGestures(window, 20));
  await render();
  const row = document.querySelector('[data-agent-session-id="lead-a"]');
  touch(window, 'pointerdown', row);
  await act(async () => new Promise((resolve) => setTimeout(resolve, 60)));
  assert.ok(document.querySelector('.row-overflow-menu'), 'the long-press opened the row menu');
  touch(window, 'pointerup', row);
  await act(async () => row.click());
  assert.deepEqual(opened, [], 'the release after a long-press opens nothing');
  await act(async () => document.querySelector('[data-action-id="open-agent-session"]').click());
  assert.deepEqual(opened, [['lead', 'lead-a']]);

  // A quick tap still opens the session.
  touch(window, 'pointerdown', row);
  touch(window, 'pointerup', row);
  await act(async () => row.click());
  assert.deepEqual(opened, [
    ['lead', 'lead-a'],
    ['lead', 'lead-a'],
  ]);
});
