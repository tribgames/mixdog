import assert from 'node:assert/strict';
import test from 'node:test';

import { EventEmitter } from 'node:events';

import { decideBrowserApproval, requestBrowserApproval, setBrowserApprovalHooks } from './approval-dialog.ts';
import { approvalSurfaceSessionId, createApprovalRequesterResolver } from './approval-requester.ts';
import { desktopSessionSummaries } from '../desktop-state.ts';

const agents = [{ id: 'agent-12c3dee5bf', custom: true, kind: 'bot', definition: { name: '마케터' } }];
const sessions = [
  { id: 'sess_home_agent-12c3dee5bf', agentHome: 'agent-12c3dee5bf', title: 'hello', preview: '' },
  { id: 'sess_home_agent-gone', agentHome: 'agent-gone', title: 'Old chat', preview: '' },
  { id: 'sess_code', title: '[Image]', preview: '' },
];
const resolve = createApprovalRequesterResolver({
  sessions: () => sessions,
  listAgents: async () => agents,
  titleLabels: () => ({ image: '이미지', video: '비디오', file: '파일' }),
});

test('a bot home chat resolves to the bot; every other session is named by its title and is no bot', async () => {
  assert.deepEqual(await resolve('sess_home_agent-12c3dee5bf'), { name: '마케터', agentId: 'agent-12c3dee5bf' });
  // A deleted or non-contact agent's home, a coding session and an unknown one belong to no bot.
  assert.deepEqual(await resolve('sess_home_agent-gone'), { name: 'Old chat', agentId: '' });
  assert.deepEqual(await resolve('sess_code'), { name: '이미지', agentId: '' });
  assert.deepEqual(await resolve('sess_unknown'), { name: '', agentId: '' });
});

test('Mixy home is her own bot (the id the Lead shares is never read from a coding session)', async () => {
  const mixy = createApprovalRequesterResolver({
    sessions: () => [{ id: 'sess_home_lead', agentHome: 'lead', title: 'Mixy chat', preview: '' }],
    listAgents: async () => [],
  });
  assert.deepEqual(await mixy('sess_home_lead'), { name: 'Mixy chat', agentId: 'lead' });
});

// A bot's home chat, a task session the bot created, a coding Lead; sub-agents
// are no catalog rows, only pool rows naming their owner and spawn parent.
const delegation = {
  sessions: () => [
    ...sessions,
    { id: 'sess_task', taskAgent: 'agent-12c3dee5bf', taskFrom: 'home', title: 'Report', preview: '' },
    { id: 'sess_rtask', taskAgent: 'agent-12c3dee5bf', taskFrom: 'room', title: 'Room job', preview: '' },
    { id: 'sess_otask', taskAgent: 'agent-12c3dee5bf', title: 'Older job', preview: '' },
    { id: 'sess_lead', title: 'Refactor', preview: '' },
  ],
  agentPool: () => [
    {
      sessionId: 'sess_w1',
      ownerSessionId: 'sess_home_agent-12c3dee5bf',
      parentSessionId: 'sess_home_agent-12c3dee5bf',
      agent: 'worker',
      cwd: '/w',
    },
    { sessionId: 'sess_t1', ownerSessionId: 'sess_task', parentSessionId: 'sess_task', agent: 'worker' },
    { sessionId: 'sess_t2', ownerSessionId: 'sess_task', parentSessionId: 'sess_t1', agent: 'reviewer' },
    { sessionId: 'sess_r1', ownerSessionId: 'sess_lead', parentSessionId: 'sess_lead', agent: 'reviewer' },
    { sessionId: 'sess_rw', ownerSessionId: 'sess_rtask', parentSessionId: 'sess_rtask', agent: 'worker' },
    { sessionId: 'sess_ow', ownerSessionId: 'sess_otask', parentSessionId: 'sess_otask', agent: 'worker' },
  ],
  listAgents: async () => [
    ...agents,
    { id: 'worker', definition: { name: 'Worker' } },
    { id: 'reviewer', definition: { name: 'Reviewer' } },
  ],
};

test("a bot's sub-agent (nested, or under its task session) asks as the bot; a coding Lead's as no bot", async () => {
  const resolveChain = createApprovalRequesterResolver(delegation);
  // Delegated work uses the bot's standing allows, but its card (not the bot's
  // own chat) never offers "always allow".
  assert.deepEqual(await resolveChain('sess_w1'), {
    name: '마케터 › Worker',
    agentId: 'agent-12c3dee5bf',
    rememberable: false,
    cwd: '/w',
  });
  assert.deepEqual(await resolveChain('sess_t2'), {
    name: '마케터 › Task session › Worker › Reviewer',
    agentId: 'agent-12c3dee5bf',
    rememberable: false,
  });
  assert.deepEqual(await resolveChain('sess_r1'), { name: 'Lead › Reviewer', agentId: '', rememberable: false });
  // The task session's own Lead asks as the bot that created it from its chat.
  assert.deepEqual(await resolveChain('sess_task'), {
    name: '마케터 › Task session',
    agentId: 'agent-12c3dee5bf',
    rememberable: false,
  });
  // Created in a room, or before the origin was recorded: no bot, so no standing allow and no "always".
  for (const sessionId of ['sess_rtask', 'sess_rw', 'sess_otask', 'sess_ow']) {
    assert.equal((await resolveChain(sessionId)).agentId, '', sessionId);
  }
  assert.equal((await resolveChain('sess_rw')).name, '마케터 › Task session › Worker');
  // A pool row whose owner is unknown stays unknown.
  const orphan = createApprovalRequesterResolver({ ...delegation, sessions: () => [] });
  assert.deepEqual(await orphan('sess_w1'), { name: '', agentId: '' });
});

test("the approval notification opens the top-level chat: the bot's home, else the owner session", () => {
  assert.equal(approvalSurfaceSessionId('sess_w1', delegation), 'sess_home_agent-12c3dee5bf');
  assert.equal(approvalSurfaceSessionId('sess_t2', delegation), 'sess_home_agent-12c3dee5bf');
  assert.equal(approvalSurfaceSessionId('sess_r1', delegation), 'sess_lead');
  assert.equal(
    approvalSurfaceSessionId('sess_task', delegation),
    'sess_home_agent-12c3dee5bf',
    "the bot's task opens its chat"
  );
  assert.equal(approvalSurfaceSessionId('sess_rtask', delegation), 'sess_rtask', 'a room task opens itself');
  assert.equal(approvalSurfaceSessionId('sess_lead', delegation), 'sess_lead', 'a top-level session opens itself');
  assert.equal(approvalSurfaceSessionId('sess_unknown', delegation), 'sess_unknown');
});

test("a bot's sub-agent upload runs on the bot's browser_upload allow, unasked; a coding sub-agent asks once", async () => {
  const allowed = new Set(['agent-12c3dee5bf\nbrowser_upload']);
  const audits = [];
  setBrowserApprovalHooks({
    resolveRequester: createApprovalRequesterResolver(delegation),
    isAllowed: async (agentId, actions) => actions.every((action) => allowed.has(`${agentId}\n${action}`)),
    audit: async (agentId, actions, decision) => audits.push([agentId, actions, decision]),
  });
  const sent = [];
  const contents = Object.assign(new EventEmitter(), { isDestroyed: () => false, send: (_c, p) => sent.push(p) });
  const window = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    isFocused: () => true,
    webContents: contents,
  });
  const upload = (sessionId) => ({
    action: 'upload',
    url: 'https://example.test/form',
    sessionId,
    target: 'Attach',
    paths: [],
    kinds: ['upload'],
  });
  try {
    assert.equal(await requestBrowserApproval(window, upload('sess_w1')), true);
    assert.deepEqual(sent, [], 'no card: the bot already allows uploads');
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(audits, [['agent-12c3dee5bf', ['browser_upload'], 'remembered']]);
    const pending = requestBrowserApproval(window, upload('sess_r1'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(sent[0].requester, 'Lead › Reviewer');
    assert.equal(sent[0].remember, null, 'no bot: once only');
    decideBrowserApproval(contents, sent[0].id, 'deny');
    assert.equal(await pending, false);
    // The bot's sub-agent on a step it has no allow for: asked, once only —
    // a forged "always" stores nothing.
    const remembered = [];
    setBrowserApprovalHooks({
      resolveRequester: createApprovalRequesterResolver(delegation),
      isAllowed: async () => false,
      remember: async (agentId, actions) => remembered.push([agentId, actions]),
    });
    sent.length = 0;
    const submit = requestBrowserApproval(window, { ...upload('sess_w1'), action: 'click', kinds: ['submit'] });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(sent[0].remember, null);
    decideBrowserApproval(contents, sent[0].id, 'always');
    assert.equal(await submit, true);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(remembered, []);
  } finally {
    setBrowserApprovalHooks({});
  }
});

test('a task origin is read only from a host-made task session row, never an agent session', () => {
  const rows = desktopSessionSummaries([
    {
      id: 'sess_forged',
      owner: 'agent',
      agent: 'worker',
      visibility: 'agent-only',
      sourceType: 'lead',
      sourceName: 'agent:agent-12c3dee5bf@home',
      cwd: 'C:\\work',
      title: 'Forged',
      desktopSession: { classification: 'task', projectPath: null },
    },
  ]);
  assert.deepEqual(
    rows.map((row) => [row.taskAgent, row.taskFrom]),
    [[undefined, undefined]]
  );
});

test('the catalog row carries where a bot created its task session; older rows carry none', () => {
  const rows = desktopSessionSummaries(
    [
      ['sess_a', 'agent:agent-12c3dee5bf@home'],
      ['sess_b', 'agent:agent-12c3dee5bf@room'],
      ['sess_c', 'agent:agent-12c3dee5bf'],
    ].map(([id, sourceName]) => ({
      id,
      sourceType: 'lead',
      sourceName,
      cwd: 'C:\\work',
      title: 'Job',
      desktopSession: { classification: 'task', projectPath: null },
    }))
  );
  assert.deepEqual(
    rows.map((row) => [row.taskAgent, row.taskFrom]),
    [
      ['agent-12c3dee5bf', 'home'],
      ['agent-12c3dee5bf', 'room'],
      ['agent-12c3dee5bf', undefined],
    ]
  );
});

test('an unavailable agent catalog falls back to the session title', async () => {
  const fallback = createApprovalRequesterResolver({
    sessions: () => sessions,
    listAgents: () => Promise.reject(new Error('down')),
  });
  assert.deepEqual(await fallback('sess_home_agent-12c3dee5bf'), { name: 'hello', agentId: '' });
});
