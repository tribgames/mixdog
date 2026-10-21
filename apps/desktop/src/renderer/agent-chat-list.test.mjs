// The Agents pane's work section: a collapsible group per Lead session (its
// own menu by `…`, right-click or touch long-press), the Lead row and one row
// per child agent; plus the status and time helpers the contact rows use.
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
  { agentGroupIndicator, agentChatTimeLabel, agentChatTimeColumnLabels },
  { installTouchGestures },
  { resetDismissedShellJobsCache },
  { publishAgentModeSessions },
] = await Promise.all([
  import('./AgentActivityPane.tsx'),
  import('./agent-activity-model.ts'),
  import('./agent-chat-summary.ts'),
  import('./touch-gestures.ts'),
  import('./background-jobs-dismissed-store.ts'),
  import('./agent-chat-mode.ts'),
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

function indicator(pool, unread = []) {
  const [group] = agentActivityGroups(pool, (id) => id === 'lead-a');
  return agentGroupIndicator('lead-a', group.nodes, new Set(unread));
}

test("a home thread's work gives its contact exactly one status: approval > failure > running > unread, nothing when read", () => {
  const approval = worker('ask', { ...running, awaitingUser: 'approval' });
  const failed = worker('crash', { status: 'failed', stage: 'failed', failureReason: 'stalled' });
  const busy = worker('busy', running);
  assert.deepEqual(indicator([lead(), approval, failed, busy], ['lead-a']), { kind: 'attention' });
  assert.deepEqual(indicator([lead(), failed, busy], ['lead-a']), { kind: 'error' });
  assert.deepEqual(indicator([lead(), busy], ['lead-a']), { kind: 'running' });
  // The Lead's own work runs the spinner too.
  assert.deepEqual(indicator([lead(running)]), { kind: 'running' });
  // Unread counts every unseen session of the group, the Lead's included.
  assert.deepEqual(indicator([lead(), worker('done')], ['lead-a', 's-done']), { kind: 'unread', count: 2 });
  assert.equal(indicator([lead(), worker('done')]), null);
});

const at = (...parts) => new Date(...parts).getTime();
// Every branch, in English and Korean: today's clock, Yesterday, this year's
// month and day, an earlier year's full date; New Year's Day still calls the
// day before "Yesterday", and two days back crosses into the previous year.
const TIME_LABELS = {
  en: {
    today: /^2:08\sPM$/u,
    yesterday: 'Yesterday',
    thisYear: 'Oct 17',
    pastYear: '10/17/2025',
    newYearsEve: 'Yesterday',
    lastYear: '12/30/2025',
  },
  ko: {
    today: /^오후 2:08$/u,
    yesterday: '어제',
    thisYear: '10월 17일',
    pastYear: '2025. 10. 17.',
    newYearsEve: '어제',
    lastYear: '2025. 12. 30.',
  },
};

for (const [language, expected] of Object.entries(TIME_LABELS)) {
  test(`contact row times follow the messenger rules in ${language}`, async (t) => {
    const { default: i18n } = await import('./i18n.ts');
    const previous = i18n.language;
    t.after(() => i18n.changeLanguage(previous));
    if (language !== 'en') {
      const { readFileSync } = await import('node:fs');
      const catalog = JSON.parse(readFileSync(new URL(`./locales/${language}.json`, import.meta.url), 'utf8'));
      i18n.addResourceBundle(language, 'translation', catalog);
    }
    await i18n.changeLanguage(language);
    const now = at(2026, 9, 19, 15, 0);
    assert.match(agentChatTimeLabel(at(2026, 9, 19, 14, 8), now), expected.today);
    assert.equal(agentChatTimeLabel(at(2026, 9, 18, 23, 59), now), expected.yesterday);
    assert.equal(agentChatTimeLabel(at(2026, 9, 17, 9, 0), now), expected.thisYear);
    assert.equal(agentChatTimeLabel(at(2025, 9, 17, 9, 0), now), expected.pastYear);
    const newYear = at(2026, 0, 1, 9, 0);
    assert.equal(agentChatTimeLabel(at(2025, 11, 31, 23, 0), newYear), expected.newYearsEve);
    assert.equal(agentChatTimeLabel(at(2025, 11, 30, 23, 0), newYear), expected.lastYear);
    assert.equal(agentChatTimeLabel(0, now), '');
    // The time column is sized to these: a clock, "Yesterday", a month-day.
    const labels = agentChatTimeColumnLabels();
    assert.ok(labels.some((label) => /12:59/.test(label)));
    assert.ok(labels.includes(expected.yesterday));
    if (language === 'ko') assert.ok(labels.includes('12월 28일'));
  });
}

// The work groups: an agent-mode session's work lists on the page; an
// ordinary coding session's (`ordinary`) stays with that session.
function mount(t, pool, props = {}, { ordinary = false } = {}) {
  publishAgentModeSessions(ordinary ? [] : [{ id: 'lead-a', sessionMode: 'agent' }]);
  t.after(() => publishAgentModeSessions([]));
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

test('a group starts collapsed: header and Lead row (with its member badge) show, children are hidden', async (t) => {
  const { document, render, opened } = mount(t, [lead(running), worker('a', running), worker('b')]);
  await render();
  const heading = document.querySelector('.agent-session-heading[data-lead-session-id="lead-a"]');
  assert.equal(heading.getAttribute('aria-expanded'), 'false');
  assert.equal(heading.textContent, 'Fix the release');
  const leadRow = document.querySelector('[data-agent-session-id="lead-a"]');
  assert.ok(leadRow, 'the Lead row stays visible while collapsed');
  assert.equal(leadRow.querySelector('.agent-pool-name').textContent, 'Lead');
  assert.equal(leadRow.querySelector('.dock-review-count').textContent, '2');
  assert.equal(document.querySelector('[data-agent-session-id="s-a"]'), null);
  // Expanding reveals every child row: mark, role · tag, route and right-aligned state.
  await act(async () => heading.click());
  assert.equal(heading.getAttribute('aria-expanded'), 'true');
  const child = document.querySelector('[data-agent-session-id="s-a"]');
  assert.ok(child.querySelector('.sidebar-resource-icon'));
  assert.equal(child.getAttribute('aria-label'), 'Worker · a');
  assert.ok(child.querySelector('.agent-route-summary'));
  assert.equal(child.lastElementChild.className, 'agent-activity-status');
  assert.equal(document.querySelector('[data-agent-session-id="s-b"] .agent-activity-elapsed').dataset.state, 'idle');
  await act(async () => child.click());
  assert.deepEqual(opened, [['agent', 's-a']]);
  await act(async () => heading.click());
  assert.equal(document.querySelector('[data-agent-session-id="s-a"]'), null);
  assert.ok(document.querySelector('[data-agent-session-id="lead-a"]'));
});

test('an agent waiting for approval shows its state text, never a pill', async (t) => {
  const { document, render } = mount(t, [lead(running), worker('ask', { ...running, awaitingUser: 'approval' })]);
  await render();
  await act(async () => document.querySelector('.agent-activity-group .agent-session-heading').click());
  const state = document.querySelector('[data-agent-session-id="s-ask"] .agent-activity-elapsed');
  assert.ok(state.textContent.trim());
  assert.equal(document.querySelector('.agent-chat-status'), null);
});

test("the group's own menu hides the group and clears finished agents", async (t) => {
  const { document, render } = mount(t, [lead(), worker('done'), worker('busy', running)]);
  await render();
  const openMenu = () =>
    act(async () => document.querySelector('[data-agent-owner-session-id="lead-a"] .row-overflow-trigger').click());
  const select = (id) => act(async () => document.querySelector(`[data-action-id="${id}"]`).click());
  await openMenu();
  assert.ok(document.querySelector('[data-action-id="hide-agent-group"]'));
  assert.ok(document.querySelector('[data-action-id="clear-finished-agents"]'));
  await select('clear-finished-agents');
  await act(async () => document.querySelector('.agent-activity-group .agent-session-heading').click());
  assert.equal(document.querySelector('[data-agent-session-id="s-done"]'), null);
  assert.ok(document.querySelector('[data-agent-session-id="s-busy"]'));
  await openMenu();
  await select('hide-agent-group');
  assert.equal(document.querySelector('[data-agent-owner-session-id="lead-a"]'), null);
  // Under the contacts, hidden work shows nothing: no line, no divider.
  assert.doesNotMatch(document.body.textContent, /All agent groups are hidden/);
  assert.equal(document.querySelector('.agent-chat-divider'), null);
});

test('the pane lists agents, then group rooms, without ordinary session work', async (t) => {
  const room = {
    id: 'sess_room_abc123',
    title: 'Release check',
    preview: '',
    updatedAt: 2,
    messageCount: 3,
    lastMessagePreview: 'Looks good',
    agentRoom: {
      id: 'abc123',
      name: 'Release check',
      members: ['lead', 'gh'],
      maxRounds: 3,
      maxMessages: 8,
      shareTools: false,
      lastSpeaker: 'user',
    },
  };
  const { document, render, opened } = mount(t, [lead()], { sessions: [...sessions, room] }, { ordinary: true });
  await render();
  const order = [
    ...document.querySelectorAll('[data-agent-contact], [data-agent-room], [data-agent-owner-session-id]'),
  ].map((node) => (node.dataset.agentContact ? 'agent' : node.dataset.agentRoom ? 'room' : 'work'));
  assert.deepEqual([...new Set(order)], ['agent', 'room']);
  // Its finished Lead rests as one Lead row (inside the pane window), never as a work group.
  assert.deepEqual(
    [...document.querySelectorAll('.agent-chat-divider:not(.agent-room-section-divider)')].map((hr) =>
      hr.getAttribute('aria-label')
    ),
    ['Leads']
  );
  assert.ok(document.querySelector('[data-agent-lead="lead-a"]'));
  const row = document.querySelector('[data-agent-room="abc123"]');
  assert.match(row.textContent, /Release check/);
  assert.match(row.textContent, /Looks good/);
  await act(async () => row.querySelector('button').click());
  assert.deepEqual(opened.at(-1), ['agent', 'sess_room_abc123']);
});

test('under the contacts, an empty work list shows nothing', async (t) => {
  const { document, render } = mount(t, []);
  await render();
  assert.ok(document.querySelector('[data-agent-contact="lead"]'), 'Mixy is listed');
  assert.equal(document.querySelector('.agent-activity-empty'), null, 'no centred empty state under contacts');
  assert.equal(document.querySelector('.agent-chat-divider'), null, 'no divider without work');
  assert.doesNotMatch(document.body.textContent, /No agents are running/);
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

test('a touch long-press on a group header opens the group menu without folding it', async (t) => {
  const { document, window, render } = mount(t, [lead(), worker('done')]);
  t.after(installTouchGestures(window, 20));
  await render();
  const heading = document.querySelector('.agent-activity-group .agent-session-heading');
  touch(window, 'pointerdown', heading);
  await act(async () => new Promise((resolve) => setTimeout(resolve, 60)));
  assert.ok(document.querySelector('.dock-scm-context-menu'), 'the long-press opened the group menu');
  assert.ok(document.querySelector('.dock-scm-context-menu [data-action-id="hide-agent-group"]'));
  touch(window, 'pointerup', heading);
  await act(async () => heading.click());
  assert.equal(heading.getAttribute('aria-expanded'), 'false', 'the release after a long-press folds nothing');
});
