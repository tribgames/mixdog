// Agents as contacts: Mixy pinned first, then each user-facing agent over its
// one home thread, then the work sessions; each contact row's preview, time
// and single status.
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import React, { act } from 'react';
import { installTestDom } from './test-support/test-dom.mjs';

const { restore: restoreBootstrapDom } = installTestDom(null);
after(restoreBootstrapDom);
const [{ AgentActivityPane, splitAgentHomeGroups }, { agentContacts, agentHomeTitle }, { agentActivityGroups }] =
  await Promise.all([
    import('./AgentActivityPane.tsx'),
    import('./agent-contacts-model.ts'),
    import('./agent-activity-model.ts'),
  ]);

const { defaultAgentAvatar } = await import('../../../../src/runtime/shared/agent-avatar.mjs');
const { contactAgentRows } = await import('../shared/agent-contacts.ts');
const NOW = Date.now();
const AGENTS = [
  { id: 'maintainer', label: 'Maintainer', locked: true, route: { provider: 'openai', model: 'gpt-5' } },
  {
    id: 'github-watcher',
    custom: true,
    kind: 'bot',
    description: 'Watches the repository',
    definition: { name: 'GitHub Watcher' },
    route: { provider: 'anthropic', model: 'claude-x' },
    avatar: { kind: 'mascot', variant: 'perky-calm-collar', color: '#5b9bff' },
  },
  { id: 'translator', custom: true, kind: 'bot', label: 'Translator', route: { provider: 'openai', model: 'gpt-5' } },
  { id: 'off', custom: true, kind: 'bot', disabled: true, label: 'Off' },
  // Shipped starter roles are sub-agents, never contacts, even when on.
  { id: 'worker', custom: true, label: 'Worker', route: { provider: 'openai', model: 'gpt-5' } },
  { id: 'reviewer', custom: true, label: 'Reviewer', route: { provider: 'openai', model: 'gpt-5' } },
];
const home = (agentHome, overrides = {}) => ({
  id: `sess_home_${agentHome}`,
  agentHome,
  title: 'x',
  preview: '',
  updatedAt: NOW - 60_000,
  activityAt: NOW - 30_000,
  messageCount: 4,
  readMessageCount: 4,
  cwd: '/tasks',
  classification: 'task',
  projectPath: null,
  ...overrides,
});
const work = { id: 'lead-a', title: 'Fix the release', preview: '', updatedAt: 1, messageCount: 1 };

test('contacts are only the agents the user made: no shipped starter or Maintainer', () => {
  assert.deepEqual(
    contactAgentRows(AGENTS).map((row) => row.id),
    ['github-watcher', 'translator']
  );
});

test('only a kind: bot agent is a contact; a Workflows-page agent or an unmarked custom agent never is', () => {
  const rows = [
    ...AGENTS,
    { id: 'triage', custom: true, kind: 'agent', label: 'Triage', route: { provider: 'openai', model: 'gpt-5' } },
    { id: 'legacy', custom: true, kind: null, label: 'Legacy' },
  ];
  assert.deepEqual(
    contactAgentRows(rows).map((row) => row.id),
    ['github-watcher', 'translator']
  );
  const contacts = agentContacts(rows, [], new Map()).map((contact) => contact.agentId);
  assert.ok(!contacts.includes('triage') && !contacts.includes('legacy'));
});

test('a live home thread of an agent that is no contact (a former 1.3.0 bot, a switched-off bot) lists in Sessions', async () => {
  const { contactHomeAgentIds, listsAsSession } = await import('./session-sidebar-agents.ts');
  const rows = [...AGENTS, { id: 'legacy', custom: true, kind: null, label: 'Legacy' }];
  assert.equal(contactHomeAgentIds(undefined), null, 'unknown until the catalog loads');
  const ids = contactHomeAgentIds(rows);
  assert.deepEqual([...ids].sort(), ['github-watcher', 'lead', 'translator']);
  // Before the catalog loads every live home stays hidden, as before.
  assert.equal(listsAsSession(home('legacy'), null), false);
  assert.equal(listsAsSession(home('legacy'), ids), true, 'the chat with a former bot stays reachable');
  assert.equal(listsAsSession(home('off'), ids), true, 'a switched-off bot keeps its chat reachable');
  assert.equal(listsAsSession(home('github-watcher'), ids), false, 'a bot chat is its contact row');
  assert.equal(listsAsSession(home('lead'), ids), false, "Mixy's chat is its contact row");
  assert.equal(listsAsSession(home('github-watcher', { archived: true }), ids), true);
  assert.equal(listsAsSession(work, ids), true);
});

test('the bot page lists a switched-off bot too, marked disabled; every other consumer keeps leaving it out', () => {
  const all = agentContacts(AGENTS, [], new Map(), undefined, { includeDisabled: true });
  assert.deepEqual(
    all.map(({ agentId, disabled }) => [agentId, disabled]),
    [
      ['lead', false],
      ['github-watcher', false],
      ['translator', false],
      ['off', true],
    ]
  );
  assert.equal(all[3].preview, 'Off');
  // The sidebar, room pickers and labels read the default: no switched-off bot.
  assert.ok(!agentContacts(AGENTS, [], new Map()).some((contact) => contact.agentId === 'off'));
  assert.deepEqual(
    contactAgentRows(AGENTS, { includeDisabled: true }).map((row) => row.id),
    ['github-watcher', 'translator', 'off']
  );
});

test('a switched-off bot stays on the bot page while hidden from the sidebar, dimmed, with 켜기 in its menu', async (t) => {
  const { setBotHiddenInSidebar, resetSidebarHiddenBotsCache } = await import('./sidebar-hidden-bots-store.ts');
  const { document, render } = mount(t);
  resetSidebarHiddenBotsCache();
  setBotHiddenInSidebar('off', true);
  t.after(() => {
    setBotHiddenInSidebar('off', false);
    resetSidebarHiddenBotsCache();
  });
  const { sidebarHiddenBots } = await import('./sidebar-hidden-bots-store.ts');
  assert.ok(sidebarHiddenBots().has('off'), 'hidden from the sidebar');
  await render();
  await render();
  const row = document.querySelector('[data-agent-contact="off"]');
  assert.ok(row, 'listed although off and hidden');
  assert.equal(row.dataset.agentDisabled, 'true');
  assert.equal(document.querySelector('[data-agent-contact="translator"]').dataset.agentDisabled, undefined);
  const { agentContactMenuItems } = await import('./agent-profile-actions.ts');
  const handlers = { onOpen() {}, onProfile() {} };
  assert.deepEqual(
    agentContactMenuItems({ agentId: 'off', name: 'Off', mixy: false, disabled: true }, handlers).map(
      (item) => item.id
    ),
    ['agent-profile', 'agent-rename', 'agent-show-in-sidebar', 'agent-turn-on', 'agent-delete']
  );
});

test('contacts list Mixy first, then the user-facing agents in catalog order', () => {
  const contacts = agentContacts(AGENTS, [], new Map());
  assert.deepEqual(
    contacts.map(({ agentId, name, mixy }) => [agentId, name, mixy]),
    [
      ['lead', 'Mixy', true],
      ['github-watcher', 'GitHub Watcher', false],
      ['translator', 'Translator', false],
    ]
  );
  // Each contact shows its mascot: Mixy's own look, a pick (an old `variant`
  // as its mapped look), else an id default.
  assert.deepEqual(contacts[0].avatar, {
    kind: 'mascot',
    species: 'mixy',
    accessory: 'none',
    expression: 'calm',
    color: '#e6e6e6',
  });
  assert.deepEqual(contacts[1].avatar, {
    kind: 'mascot',
    species: 'shepherd',
    accessory: 'collar',
    expression: 'calm',
    color: '#5b9bff',
  });
  assert.deepEqual(contacts[2].avatar, defaultAgentAvatar('translator'));
  // No thread yet: the description stands in, with no time and no status.
  assert.equal(contacts[1].preview, 'Watches the repository');
  assert.equal(contacts[1].at, 0);
  assert.equal(contacts[1].indicator, null);
  assert.equal(contacts[2].preview, 'No messages yet');
  // Mixy's empty default thread shows no placeholder in its row.
  assert.equal(contacts[0].preview, '');
});

test("a contact shows its thread's preview, activity time and unread count", () => {
  const sessions = [
    home('github-watcher', {
      preview: 'Any new issues?',
      messageCount: 6,
      readMessageCount: 2,
      incomingTail: [2, 4, 6],
    }),
    home('translator', { preview: 'Review PR 12', working: true }),
    home('lead', { preview: 'Hello', archived: true }),
  ];
  const contacts = agentContacts(AGENTS, sessions, new Map(), new Set(['sess_home_github-watcher']));
  const [mixy, watcher, translator] = contacts;
  assert.equal(watcher.preview, 'Any new issues?');
  assert.equal(watcher.at, NOW - 30_000);
  assert.deepEqual(watcher.indicator, { kind: 'unread', count: 2 });
  // Running outranks unread, and the preview names it.
  assert.deepEqual(translator.indicator, { kind: 'running' });
  assert.equal(translator.preview, 'Working');
  // An archived thread is not a live contact thread.
  assert.equal(mixy.session, null);
});

test("a contact row shows the thread's latest message over its first prompt", () => {
  const sessions = [
    home('github-watcher', { preview: 'Any new issues?', lastMessagePreview: 'Two new issues were opened today.' }),
    home('translator', { preview: 'Review PR 12', lastMessagePreview: 'Reviewing now', working: true }),
  ];
  const [, watcher, translator] = agentContacts(AGENTS, sessions, new Map());
  assert.equal(watcher.preview, 'Two new issues were opened today.');
  // A stored preview from before the host stripped markdown (Mixy's too)
  // still reads as plain text.
  const [mixy] = agentContacts(
    AGENTS,
    [home('lead', { lastMessagePreview: '**v1.0 릴리스 노트** — 새 시작' })],
    new Map()
  );
  assert.equal(mixy.preview, 'v1.0 릴리스 노트 — 새 시작');
  // A live status still outranks the message line.
  assert.equal(translator.preview, 'Working');
});

test('the unread count is the chat messages that arrived past the read cursor, at least 1', () => {
  const unread = (overrides) =>
    agentContacts(AGENTS, [home('github-watcher', overrides)], new Map(), new Set(['sess_home_github-watcher']))[1]
      .indicator;
  // One reply that used three tools: 8 counted messages, one incoming message.
  assert.deepEqual(unread({ messageCount: 8, readMessageCount: 2, incomingTail: [2, 8] }), {
    kind: 'unread',
    count: 1,
  });
  assert.deepEqual(unread({ messageCount: 20, readMessageCount: 1, incomingTail: [2, 8, 15, 20] }), {
    kind: 'unread',
    count: 4,
  });
  // The user's own messages are not in the tail, so they never add to it.
  assert.deepEqual(unread({ messageCount: 10, readMessageCount: 8, incomingTail: [2, 8] }), {
    kind: 'unread',
    count: 1,
  });
  assert.deepEqual(unread({ messageCount: 3, readMessageCount: 3, incomingTail: [2] }), { kind: 'unread', count: 1 });
  // A row without a tail (an older catalog, or read off a session file) shows one.
  assert.deepEqual(unread({ messageCount: 250, readMessageCount: 0 }), { kind: 'unread', count: 1 });
  assert.deepEqual(unread({ messageCount: undefined, readMessageCount: undefined }), { kind: 'unread', count: 1 });
  // An old cursor that never moved counts every incoming message in the tail.
  assert.deepEqual(unread({ messageCount: 8, readMessageCount: undefined, incomingTail: [2, 8] }), {
    kind: 'unread',
    count: 2,
  });
});

test('a group room row counts the same way', async () => {
  const { agentRoomRows } = await import('./agent-rooms-model.ts');
  const room = {
    id: 'abc123',
    name: 'Standup',
    members: ['a', 'b'],
    maxRounds: 3,
    maxMessages: 8,
    shareTools: false,
  };
  const row = {
    id: 'sess_room_abc123',
    title: 'Standup',
    preview: '',
    updatedAt: 1,
    messageCount: 12,
    agentRoom: room,
  };
  const rows = agentRoomRows(
    [{ ...row, readMessageCount: 4, incomingTail: [3, 9, 12] }],
    (id) => ({ id, name: id }),
    new Set(['sess_room_abc123'])
  );
  assert.deepEqual(rows[0].indicator, { kind: 'unread', count: 2 });
});

test('a group room row label joins only the parts that exist', async () => {
  const { roomRowLabel } = await import('./agent-rooms-model.ts');
  assert.equal(roomRowLabel('Standup', 2), 'Standup, 2 members');
  assert.equal(roomRowLabel('', 2), '2 members');
  assert.equal(roomRowLabel('  ', 2), '2 members');
  assert.equal(roomRowLabel('Standup', 0), 'Standup');
});

test('the catalog cache and the session summary keep the incoming tail', async () => {
  const { desktopSessionSummaries } = await import('../main/desktop-state.ts');
  const [summary] = desktopSessionSummaries([
    { id: 'sess_home_lead', preview: 'Hi', messageCount: 8, incomingTail: [2, 8, 'x', -1, 1.5] },
  ]);
  assert.deepEqual(summary.incomingTail, [2, 8]);
  const [plain] = desktopSessionSummaries([{ id: 'sess_home_lead', preview: 'Hi', messageCount: 8 }]);
  assert.equal(Object.hasOwn(plain, 'incomingTail'), false);
});

test('a routine result preview reads in the user language, like its transcript notice', async (t) => {
  const { default: i18n } = await import('./i18n.ts');
  const { readFileSync } = await import('node:fs');
  const { routineNoticeText } = await import('./transcript-row.tsx');
  const previous = i18n.language;
  t.after(() => i18n.changeLanguage(previous));
  i18n.addResourceBundle(
    'ko',
    'translation',
    JSON.parse(readFileSync(new URL('./locales/ko.json', import.meta.url), 'utf8'))
  );
  await i18n.changeLanguage('ko');
  const preview = (lastMessagePreview, lastMessageRoutine) =>
    agentContacts(
      AGENTS,
      [home('github-watcher', { preview: 'first', lastMessagePreview, lastMessageRoutine })],
      new Map()
    )[1].preview;
  // The catalog marker decides; the row shows the notice row's words.
  const hook = { kind: 'webhook', name: 'deploy-hook', status: 'ok', summary: 'Deployed v2' };
  assert.equal(
    preview('🔗 Webhook · deploy-hook — Deployed v2', hook),
    routineNoticeText({ kind: 'webhook', name: 'deploy-hook', status: 'completed', summary: 'Deployed v2' })
  );
  assert.equal(preview('🔗 Webhook · deploy-hook — Deployed v2', hook), '🔗 웹훅 · deploy-hook — Deployed v2');
  assert.equal(
    preview('🔗 Webhook · deploy-hook — Failed: 502', { ...hook, status: 'failed', summary: undefined, error: '502' }),
    '🔗 웹훅 · deploy-hook — 실행 중 문제가 생겼습니다.'
  );
  const daily = { kind: 'schedule', name: 'daily', status: 'ok', summary: 'All green.' };
  assert.equal(preview('⏱ Schedule · daily — All green.', daily), '⏱ 스케줄 · daily — All green.');
  assert.equal(
    preview('x', { kind: 'schedule', name: 'daily', status: 'failed', error: 'Provider down' }),
    '⏱ 스케줄 · daily — 실행 중 문제가 생겼습니다.'
  );
  assert.equal(
    preview('x', { kind: 'schedule', name: 'daily', status: 'failed' }),
    '⏱ 스케줄 · daily — 실행 중 문제가 생겼습니다.'
  );
  // Each failure class reads as its short localized reason, never the raw text.
  const failure = (reason, paused) =>
    routineNoticeText({ kind: 'schedule', name: 'daily', status: 'failed', summary: 'raw English', reason, paused });
  assert.equal(
    failure('provider_unavailable'),
    '⏱ 스케줄 · daily — 모델 또는 제공자를 사용할 수 없습니다. 모델 설정에서 다시 고르세요.'
  );
  assert.match(failure('auth_expired'), /로그인이 만료되었습니다/);
  assert.match(failure('rate_limited'), /사용 한도에 도달했습니다/);
  assert.match(failure('network'), /네트워크 연결이 끊겼거나/);
  assert.match(failure('permission_denied'), /권한이 거부되었습니다/);
  assert.match(failure('cancelled'), /실행이 취소되었습니다\./);
  assert.match(failure('unheard-of'), /실행 중 문제가 생겼습니다\./);
  assert.match(failure('network', true), /연속 실패로 이 루틴이 꺼졌습니다/);
  assert.doesNotMatch(failure('network'), /raw English/);
  // An expired sign-in reads as the localized sign-in line, never the raw summary.
  assert.equal(
    preview('x', { kind: 'schedule', name: 'shop', status: 'failed', error: 'Sign-in required: shop.example.com' }),
    '⏱ 스케줄 · shop — shop.example.com 로그인이 필요합니다'
  );
  // Without a marker the line is verbatim, even one shaped like a routine result:
  // a user's own message, or a row stored before the marker existed.
  assert.equal(preview('⏱ Schedule · daily — Failed: lol'), '⏱ Schedule · daily — Failed: lol');
  assert.equal(preview('🔗 Webhook · deploy-hook — Deployed v2'), '🔗 Webhook · deploy-hook — Deployed v2');
  assert.equal(preview('Schedule · daily is next'), 'Schedule · daily is next');
});

test("a home thread's tab is its agent's name, never a title from its first prompt", () => {
  assert.equal(agentHomeTitle('sess_home_lead', []), 'Mixy');
  assert.equal(agentHomeTitle('sess_home_github-watcher', AGENTS), 'GitHub Watcher');
  assert.equal(agentHomeTitle('sess_home_translator', AGENTS), 'Translator');
  // A switched-off agent keeps its name; an agent the catalog has not loaded yet shows its id.
  assert.equal(agentHomeTitle('sess_home_off', AGENTS), 'Off');
  assert.equal(agentHomeTitle('sess_home_github-watcher', []), 'github-watcher');
  assert.equal(agentHomeTitle('lead-a', AGENTS), null);
});

test('the tab strip titles a home tab by its agent even when the tab kept a prompt title (reload)', async (t) => {
  const { dom, root } = installTestDom(t, { jsdom: { url: 'http://localhost/' }, rootId: 'root' });
  dom.window.mixdogDesktop = { invokeCapability: async () => ({ value: AGENTS }) };
  const { useAppPaneChrome } = await import('./use-app-pane-chrome.tsx');
  const { resetSidebarReferenceCache } = await import('./sidebar-reference-cache.ts');
  resetSidebarReferenceCache();
  const homeTab = {
    key: 'session:sess_home_github-watcher',
    title: 'setup 도구로 에이전트를 만들어…',
    selection: { kind: 'session', id: 'sess_home_github-watcher' },
  };
  const workTab = { key: 'session:lead-a', title: 'Fix the release', selection: { kind: 'session', id: 'lead-a' } };
  let titleFor = null;
  function Probe() {
    titleFor = useAppPaneChrome({ tabs: [homeTab, workTab], sessions: [] }).stripTitleFor;
    return null;
  }
  await act(async () => root.render(React.createElement(Probe)));
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  assert.equal(titleFor(homeTab.key, homeTab.selection), 'GitHub Watcher');
  assert.equal(titleFor('session:sess_home_lead', { kind: 'session', id: 'sess_home_lead' }), 'Mixy');
  assert.equal(titleFor(workTab.key, workTab.selection), 'Fix the release');
});

test('a contact surfaces approval and failure from its thread first', () => {
  const sessionId = 'sess_home_github-watcher';
  const pool = [
    { tag: 'lead:x', agent: 'lead', sessionId, ownerSessionId: sessionId, status: 'running', stage: 'running' },
    {
      tag: 'ask',
      agent: 'worker',
      sessionId: 's-ask',
      ownerSessionId: sessionId,
      parentSessionId: sessionId,
      status: 'running',
      stage: 'running',
      awaitingUser: 'approval',
    },
  ];
  const [group] = agentActivityGroups(pool, (id) => id === sessionId);
  const contacts = agentContacts(AGENTS, [home('github-watcher')], new Map([[sessionId, group.nodes]]));
  assert.deepEqual(contacts[1].indicator, { kind: 'attention' });
  assert.equal(contacts[1].preview, 'Waiting for approval');
});

test('home threads leave the work sessions; every other group stays', () => {
  const groups = [
    { ownerId: 'lead-a', session: work, nodes: ['a'] },
    { ownerId: 'sess_home_lead', session: home('lead'), nodes: ['m'] },
  ];
  const split = splitAgentHomeGroups(groups);
  assert.deepEqual(
    split.groups.map((group) => group.ownerId),
    ['lead-a']
  );
  assert.deepEqual([...split.homeNodes], [['sess_home_lead', ['m']]]);
});

function mount(t, { agents = AGENTS, pool = [], sessions = [work], unreadSessionIds } = {}) {
  const { dom, root } = installTestDom(t, {
    jsdom: { url: 'http://localhost/' },
    expose: ['HTMLElement', 'Element', 'Node', 'KeyboardEvent', 'MouseEvent', 'navigator'],
    rootId: 'root',
  });
  dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  const homeOpens = [];
  dom.window.mixdogDesktop = {
    listAgentPool: async () => pool,
    subscribeAgentPool: () => () => {},
    invokeCapability: async ({ capability }) => ({ value: capability === 'listAgents' ? agents : null }),
    openAgentHome: async (agentId) => {
      homeOpens.push(agentId);
      return { sessionId: `sess_home_${agentId}` };
    },
  };
  const opened = [];
  const render = () =>
    act(async () =>
      root.render(
        React.createElement(AgentActivityPane, {
          active: true,
          sessions,
          unreadSessionIds,
          onOpenLeadSession: (id) => opened.push(['lead', id]),
          onOpenSession: (id, title) => opened.push(['thread', id, title]),
        })
      )
    );
  return { document: dom.window.document, opened, homeOpens, render };
}

test('the pane paints the contacts, no ordinary session work, and a contact opens its home thread', async (t) => {
  const pool = [{ tag: 'lead:lead-a', agent: 'lead', sessionId: 'lead-a', ownerSessionId: 'lead-a', status: 'idle' }];
  const { document, opened, homeOpens, render } = mount(t, { pool });
  await render();
  await render();
  const order = [...document.querySelectorAll('[data-agent-contact], .agent-chat-divider, .agent-activity-group')].map(
    (node) => node.dataset.agentContact || node.dataset.agentOwnerSessionId || node.getAttribute('aria-label')
  );
  // An ordinary coding session's work stays with that session: no work group, only its
  // finished Lead resting in the Leads block (inside the pane window).
  assert.deepEqual(order, ['lead', 'github-watcher', 'translator', 'off', 'Leads']);
  const mixy = document.querySelector('[data-agent-contact="lead"]');
  assert.equal(mixy.querySelector('.agent-chat-title').textContent, 'Mixy');
  assert.doesNotMatch(mixy.textContent, /@/, 'no handle is shown');
  assert.ok(mixy.querySelector('.agent-contact-badge'), 'Mixy carries the star badge');
  // The mascot replaces the provider mark, on its full grid (whole pixels a cell).
  const face = mixy.querySelector('svg.agent-contact-mascot');
  assert.equal(face.getAttribute('viewBox'), '0 0 16 12');
  assert.equal(face.dataset.look, 'mixy-none-calm');
  assert.equal(face.getAttribute('shape-rendering'), 'crispEdges');
  // A name-only row (fresh Mixy) has no empty second line: the name centres.
  assert.deepEqual(
    [...mixy.querySelector('.agent-contact-body').children].map((node) => node.className),
    ['agent-chat-title'],
    'a name-only row holds just the name'
  );
  assert.equal(mixy.dataset.nameOnly, 'true');
  assert.equal(mixy.querySelector('.agent-chat-time'), null, 'no messages, no time');
  const watcher = document.querySelector('[data-agent-contact="github-watcher"]');
  assert.deepEqual(
    [...watcher.querySelector('.agent-contact-body').children].map((node) => node.className),
    ['agent-chat-title', 'agent-chat-preview']
  );
  assert.equal(watcher.dataset.nameOnly, undefined);
  assert.equal(watcher.querySelector('svg.agent-contact-mascot').dataset.look, 'shepherd-collar-calm');
  await act(async () => mixy.querySelector('.agent-chat-row-main').click());
  assert.deepEqual(homeOpens, ['lead']);
  assert.deepEqual(opened, [['thread', 'sess_home_lead', 'Mixy']]);
});

test('a contact with a thread always shows its last-message time; the preview may wrap', async (t) => {
  const sessions = [work, home('github-watcher', { lastMessagePreview: 'A long reply '.repeat(20) })];
  const { document, render } = mount(t, { sessions });
  await render();
  await render();
  const watcher = document.querySelector('[data-agent-contact="github-watcher"]');
  // A quiet thread (no unread, no status) still shows when it last spoke.
  // The text grid: name, preview, then the right column (time over status).
  assert.deepEqual(
    [...watcher.querySelector('.agent-contact-body').children].map((node) => node.className),
    ['agent-chat-title', 'agent-chat-preview', 'agent-contact-aside']
  );
  // No status: the column hugs the top (time on the name line).
  assert.equal(watcher.querySelector('.agent-contact-aside').dataset.hasStatus, undefined);
  assert.ok(watcher.querySelector('.agent-chat-time').textContent.trim());
  assert.equal(watcher.querySelector('.agent-chat-status'), null);
});

test('the unread pill caps at "99+"', async () => {
  const { unreadBadgeLabel } = await import('./AgentActivityPane.tsx');
  assert.equal(unreadBadgeLabel(1), '1');
  assert.equal(unreadBadgeLabel(42), '42');
  assert.equal(unreadBadgeLabel(99), '99');
  assert.equal(unreadBadgeLabel(100), '99+');
  assert.equal(unreadBadgeLabel(5000), '99+');
});

test('an unread contact or room keeps its unread flag while a running badge takes the status slot', async () => {
  const unreadIds = new Set(['sess_home_translator', 'sess_home_github-watcher']);
  const sessions = [
    home('translator', { working: true }),
    home('github-watcher', { messageCount: 4, readMessageCount: 1, incomingTail: [3] }),
  ];
  const [mixy, watcher, translator] = agentContacts(AGENTS, sessions, new Map(), unreadIds);
  assert.deepEqual(translator.indicator, { kind: 'running' });
  assert.equal(translator.unread, true, 'running badge, still unread');
  assert.equal(watcher.unread, true);
  assert.equal(mixy.unread, false, 'no thread, nothing unread');
  const { agentRoomRows } = await import('./agent-rooms-model.ts');
  const room = { id: 'abc', name: 'Standup', members: ['a', 'b'], maxRounds: 3, maxMessages: 8, shareTools: false };
  const rows = agentRoomRows(
    [{ id: 'sess_room_abc', title: 'Standup', preview: '', updatedAt: 1, agentRoom: { ...room, running: true } }],
    (id) => ({ id, name: id }),
    new Set(['sess_room_abc'])
  );
  assert.deepEqual(rows[0].indicator, { kind: 'running' });
  assert.equal(rows[0].unread, true);
});

test('the row exposes data-unread on its time column whatever status badge shows', async (t) => {
  const sessions = [
    work,
    home('translator', { lastMessagePreview: 'Reviewing', working: true }),
    home('github-watcher', { lastMessagePreview: 'Hi', messageCount: 4, readMessageCount: 1, incomingTail: [3] }),
  ];
  const { document, render } = mount(t, {
    sessions,
    unreadSessionIds: new Set(['sess_home_translator', 'sess_home_github-watcher']),
  });
  await render();
  await render();
  const aside = (id) => document.querySelector(`[data-agent-contact="${id}"] .agent-contact-aside`);
  assert.equal(aside('translator').querySelector('.agent-chat-status').dataset.kind, 'running');
  assert.equal(aside('translator').dataset.unread, 'true', 'running badge, unread time');
  assert.equal(aside('github-watcher').querySelector('.agent-chat-status').dataset.kind, 'unread');
  assert.equal(aside('github-watcher').dataset.unread, 'true');
  assert.equal(aside('lead')?.dataset.unread, undefined, 'a read row carries no flag');
});

test('a running contact keeps its time and shows exactly one status: the spinner', async (t) => {
  const sessions = [
    work,
    home('github-watcher', { lastMessagePreview: 'Reviewing', working: true, messageCount: 9, readMessageCount: 2 }),
  ];
  const { document, render } = mount(t, { sessions });
  await render();
  await render();
  const watcher = document.querySelector('[data-agent-contact="github-watcher"]');
  assert.ok(watcher.querySelector('.agent-chat-time').textContent.trim(), 'time stays while running');
  const statuses = watcher.querySelectorAll('.agent-chat-status');
  assert.equal(statuses.length, 1);
  assert.equal(statuses[0].dataset.kind, 'running', 'running outranks unread');
});
