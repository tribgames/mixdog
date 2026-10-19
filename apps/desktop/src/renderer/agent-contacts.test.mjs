// Agents as contacts: Mixy pinned first, then each user-facing agent over its
// one home thread, then the work sessions; each contact row's preview, time
// and single status.
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import React, { act } from 'react';
import { installTestDom } from './test-support/test-dom.mjs';

const { restore: restoreBootstrapDom } = installTestDom(null);
after(restoreBootstrapDom);
const [{ AgentActivityPane, splitAgentHomeGroups }, { agentContacts }, { agentActivityGroups }] = await Promise.all([
  import('./AgentActivityPane.tsx'),
  import('./agent-contacts-model.ts'),
  import('./agent-activity-model.ts'),
]);

const NOW = Date.now();
const AGENTS = [
  { id: 'maintainer', label: 'Maintainer', locked: true, route: { provider: 'openai', model: 'gpt-5' } },
  {
    id: 'github-watcher',
    custom: true,
    description: 'Watches the repository',
    definition: { name: 'GitHub Watcher' },
    route: { provider: 'anthropic', model: 'claude-x' },
  },
  { id: 'reviewer', custom: true, label: 'Reviewer', route: { provider: 'openai', model: 'gpt-5' } },
  { id: 'off', custom: true, disabled: true, label: 'Off' },
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

test('contacts list Mixy first, then the user-facing agents in catalog order', () => {
  const contacts = agentContacts(AGENTS, [], new Map());
  assert.deepEqual(
    contacts.map(({ agentId, name, mixy }) => [agentId, name, mixy]),
    [
      ['lead', 'Mixy', true],
      ['github-watcher', 'GitHub Watcher', false],
      ['reviewer', 'Reviewer', false],
    ]
  );
  assert.equal(contacts[1].provider, 'anthropic');
  // No thread yet: the description stands in, with no time and no status.
  assert.equal(contacts[1].preview, 'Watches the repository');
  assert.equal(contacts[1].at, 0);
  assert.equal(contacts[1].indicator, null);
  assert.equal(contacts[2].preview, 'No messages yet');
});

test("a contact shows its thread's preview, activity time and unread count", () => {
  const sessions = [
    home('github-watcher', { preview: 'Any new issues?', messageCount: 6, readMessageCount: 2 }),
    home('reviewer', { preview: 'Review PR 12', working: true }),
    home('lead', { preview: 'Hello', archived: true }),
  ];
  const contacts = agentContacts(AGENTS, sessions, new Map(), new Set(['sess_home_github-watcher']));
  const [mixy, watcher, reviewer] = contacts;
  assert.equal(watcher.preview, 'Any new issues?');
  assert.equal(watcher.at, NOW - 30_000);
  assert.deepEqual(watcher.indicator, { kind: 'unread', count: 4 });
  // Running outranks unread, and the preview names it.
  assert.deepEqual(reviewer.indicator, { kind: 'running' });
  assert.equal(reviewer.preview, 'Working');
  // An archived thread is not a live contact thread.
  assert.equal(mixy.session, null);
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

function mount(t, { agents = AGENTS, pool = [], sessions = [work] } = {}) {
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
          onOpenLeadSession: (id) => opened.push(['lead', id]),
          onOpenSession: (id, title) => opened.push(['thread', id, title]),
        })
      )
    );
  return { document: dom.window.document, opened, homeOpens, render };
}

test('the pane paints contacts above the work sessions, and a contact opens its home thread', async (t) => {
  const pool = [{ tag: 'lead:lead-a', agent: 'lead', sessionId: 'lead-a', ownerSessionId: 'lead-a', status: 'idle' }];
  const { document, opened, homeOpens, render } = mount(t, { pool });
  await render();
  await render();
  const order = [
    ...document.querySelectorAll('[data-agent-contact], .agent-chat-section-label, .agent-chat-group'),
  ].map((node) => node.dataset.agentContact || node.dataset.agentOwnerSessionId || node.textContent);
  assert.deepEqual(order, ['lead', 'github-watcher', 'reviewer', 'Work sessions', 'lead-a']);
  const mixy = document.querySelector('[data-agent-contact="lead"]');
  assert.equal(mixy.querySelector('.agent-chat-title').textContent, 'Mixy');
  assert.doesNotMatch(mixy.textContent, /@/, 'no handle is shown');
  assert.ok(mixy.querySelector('.agent-contact-badge'), 'Mixy carries the star badge');
  await act(async () => mixy.querySelector('.agent-chat-row-main').click());
  assert.deepEqual(homeOpens, ['lead']);
  assert.deepEqual(opened, [['thread', 'sess_home_lead', 'Mixy']]);
});
