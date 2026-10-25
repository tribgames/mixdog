import assert from 'node:assert/strict';
import test from 'node:test';

import { EventEmitter } from 'node:events';

import { waitUntil } from '../bounded-wait.mjs';
import { decideBrowserApproval, requestBrowserApproval, setBrowserApprovalHooks } from './approval-dialog.ts';
import { approvalSurfaceSessionId, createApprovalRequesterResolver, ownBotOfSession } from './approval-requester.ts';
import { desktopSessionSummaries } from '../desktop-state.ts';
import {
  roomMemberSessionId,
  roomSessionId,
} from '../../../../../src/runtime/agent/orchestrator/session/agent-room.mjs';

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

test('a bot home chat is named by the bot; any other session by its title; only a bot own session id is a bot', async () => {
  assert.deepEqual(await resolve('sess_home_agent-12c3dee5bf'), { name: '마케터' });
  // A deleted agent's home keeps its title but is still that agent's own session.
  assert.deepEqual(await resolve('sess_home_agent-gone'), { name: 'Old chat' });
  assert.deepEqual(await resolve('sess_code'), { name: '이미지' });
  assert.deepEqual(await resolve('sess_unknown'), { name: '' });
  // The bot is read from the id alone: home, room seat and Mixy; nothing else.
  const seat = roomMemberSessionId('abc123', 'agent-12c3dee5bf');
  assert.equal(ownBotOfSession('sess_home_agent-12c3dee5bf'), 'agent-12c3dee5bf');
  assert.equal(ownBotOfSession('sess_home_agent-gone'), 'agent-gone');
  assert.equal(ownBotOfSession('sess_home_lead'), 'lead');
  assert.equal(ownBotOfSession(seat), 'agent-12c3dee5bf');
  for (const id of ['sess_code', 'sess_unknown', 'sess_w1', 'sess_task', roomSessionId('abc123'), '', undefined]) {
    assert.equal(ownBotOfSession(id), '', String(id));
  }
});

test('Mixy home is her own bot (the id the Lead shares is never read from a coding session)', async () => {
  const mixy = createApprovalRequesterResolver({
    sessions: () => [{ id: 'sess_home_lead', agentHome: 'lead', title: 'Mixy chat', preview: '' }],
    listAgents: async () => [],
  });
  assert.deepEqual(await mixy('sess_home_lead'), { name: 'Mixy chat' });
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

test("a bot's sub-agent is no bot; a task session and its sub-agents are ordinary coding sessions", async () => {
  const resolveChain = createApprovalRequesterResolver(delegation);
  // Only a bot's OWN session is the bot: a sub-agent of its home chat is named
  // by its chain but has no agent id, so no standing allow applies to it.
  assert.deepEqual(await resolveChain('sess_w1'), { name: '마케터 › Worker', cwd: '/w' });
  assert.deepEqual(await resolveChain('sess_r1'), { name: 'Lead › Reviewer' });
  // A task session a bot created is named by its title like any coding session
  // and never asks as the bot, whatever its origin; its sub-agents are
  // "Lead › Worker…", no bot.
  assert.deepEqual(await resolveChain('sess_task'), { name: 'Report' });
  assert.deepEqual(await resolveChain('sess_t2'), { name: 'Lead › Worker › Reviewer' });
  for (const sessionId of ['sess_rtask', 'sess_otask']) {
    assert.equal(ownBotOfSession(sessionId), '', sessionId);
  }
  assert.equal((await resolveChain('sess_rw')).name, 'Lead › Worker');
  assert.deepEqual(await resolveChain('sess_ow'), { name: 'Lead › Worker' });
  // A pool row whose owner is unknown stays unknown.
  const orphan = createApprovalRequesterResolver({ ...delegation, sessions: () => [] });
  assert.deepEqual(await orphan('sess_w1'), { name: '' });
});

test('the approval notification opens the top-level chat: the owner session, a task session itself', () => {
  assert.equal(approvalSurfaceSessionId('sess_w1', delegation), 'sess_home_agent-12c3dee5bf');
  assert.equal(approvalSurfaceSessionId('sess_t2', delegation), 'sess_task', "a task's sub-agent opens the task");
  assert.equal(approvalSurfaceSessionId('sess_r1', delegation), 'sess_lead');
  assert.equal(approvalSurfaceSessionId('sess_task', delegation), 'sess_task', "a bot's task opens itself");
  assert.equal(approvalSurfaceSessionId('sess_rtask', delegation), 'sess_rtask', 'a room task opens itself');
  assert.equal(approvalSurfaceSessionId('sess_lead', delegation), 'sess_lead', 'a top-level session opens itself');
  assert.equal(approvalSurfaceSessionId('sess_unknown', delegation), 'sess_unknown');
});

test("a group-room member is its bot like the home chat; its sub-agents are no bot; cards dock in the room log", async () => {
  const roomId = 'abc123';
  const member = roomMemberSessionId(roomId, 'agent-12c3dee5bf');
  const gone = roomMemberSessionId(roomId, 'agent-gone');
  // Member sessions are no catalog rows; only the agent pool names their sub-agents.
  const room = {
    sessions: () => [...sessions, { id: roomSessionId(roomId), title: 'Standup', preview: '' }],
    agentPool: () => [
      { sessionId: 'sess_m1', ownerSessionId: member, parentSessionId: member, agent: 'worker', cwd: '/m' },
      { sessionId: 'sess_m2', ownerSessionId: member, parentSessionId: 'sess_m1', agent: 'reviewer' },
      { sessionId: 'sess_g1', ownerSessionId: gone, parentSessionId: gone, agent: 'worker' },
    ],
    listAgents: delegation.listAgents,
  };
  const resolveRoom = createApprovalRequesterResolver(room);
  assert.deepEqual(await resolveRoom(member), { name: '마케터' });
  assert.deepEqual(await resolveRoom('sess_m1'), { name: '마케터 › Worker', cwd: '/m' });
  assert.deepEqual(await resolveRoom('sess_m2'), { name: '마케터 › Worker › Reviewer' });
  // A seat whose bot left the catalog is still that bot's seat, named by its id.
  assert.deepEqual(await resolveRoom(gone), { name: 'agent-gone' });
  // The room shows its members' approvals in its log.
  const logId = roomSessionId(roomId);
  assert.equal(approvalSurfaceSessionId(member, room), logId);
  assert.equal(approvalSurfaceSessionId('sess_m2', room), logId);
  assert.equal(approvalSurfaceSessionId(logId, room), logId);
  // A browser ask from a member offers "always allow" like the home chat, and
  // the grant is the bot's: the same one the home chat reads.
  const sent = [];
  const stored = [];
  const contents = Object.assign(new EventEmitter(), { isDestroyed: () => false, send: (_c, p) => sent.push(p) });
  const window = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    isFocused: () => true,
    webContents: contents,
  });
  const ask = (sessionId) => ({
    action: 'click',
    url: 'https://example.test/form',
    sessionId,
    target: 'Send',
    paths: [],
    kinds: ['submit'],
  });
  try {
    setBrowserApprovalHooks({
      resolveRequester: resolveRoom,
      isAllowed: async (agentId) => stored.some(([id]) => id === agentId),
      remember: async (agentId, actions) => stored.push([agentId, actions]),
      surfaceSessionId: (sessionId) => approvalSurfaceSessionId(sessionId, room),
    });
    const own = requestBrowserApproval(window, ask(member));
    await waitUntil(() => sent.length > 0, 'the approval card to be sent');
    assert.deepEqual(sent[0].remember, { kinds: ['submit'] }, 'the seat offers "always allow"');
    assert.equal(sent[0].agentId, 'agent-12c3dee5bf');
    assert.equal(sent[0].surfaceSessionId, logId);
    decideBrowserApproval(contents, sent[0].id, 'always');
    assert.equal(await own, true);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(stored, [['agent-12c3dee5bf', ['browser_submit']]]);
    // The bot's home chat then runs unasked on the grant the seat stored.
    sent.length = 0;
    assert.equal(await requestBrowserApproval(window, ask('sess_home_agent-12c3dee5bf')), true);
    assert.deepEqual(sent, [], "no card: the grant is the bot's, shared between home and room");
    // A sub-agent of the seat is no bot: it runs without a card and stores nothing.
    assert.equal(await requestBrowserApproval(window, ask('sess_m1')), true);
    assert.deepEqual(sent, []);
    assert.equal(stored.length, 1, 'nothing more was stored');
  } finally {
    setBrowserApprovalHooks({});
  }
});

test('only a bot own session asks; a coding Lead, any sub-agent and a task session run every kind with no card', async () => {
  const allowed = new Set(['agent-12c3dee5bf\nbrowser_upload']);
  const audits = [];
  const remembered = [];
  setBrowserApprovalHooks({
    resolveRequester: createApprovalRequesterResolver(delegation),
    isAllowed: async (agentId, actions) => actions.every((action) => allowed.has(`${agentId}\n${action}`)),
    audit: async (agentId, actions, decision) => audits.push([agentId, actions, decision]),
    remember: async (agentId, actions) => remembered.push([agentId, actions]),
  });
  const sent = [];
  const contents = Object.assign(new EventEmitter(), { isDestroyed: () => false, send: (_c, p) => sent.push(p) });
  const window = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    isFocused: () => true,
    webContents: contents,
  });
  const ask = (sessionId, kinds) => ({
    action: 'click',
    url: 'https://example.test/form',
    sessionId,
    target: 'Go',
    paths: [],
    kinds,
  });
  try {
    for (const kinds of [['submit'], ['post'], ['upload'], ['confirm'], ['submit', 'confirm']]) {
      for (const sessionId of ['sess_lead', 'sess_r1', 'sess_w1', 'sess_t2', 'sess_task', 'sess_unknown']) {
        assert.equal(await requestBrowserApproval(window, ask(sessionId, kinds)), true, `${sessionId} ${kinds}`);
      }
    }
    assert.deepEqual(sent, [], 'no card for any session that is not a bot own');
    assert.deepEqual(remembered, []);
    assert.deepEqual(audits, []);
    // The bot's own chat still runs on its allow, audited, and asks for the rest.
    assert.equal(await requestBrowserApproval(window, ask('sess_home_agent-12c3dee5bf', ['upload'])), true);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(audits, [['agent-12c3dee5bf', ['browser_upload'], 'remembered']]);
    const own = requestBrowserApproval(window, ask('sess_home_agent-12c3dee5bf', ['submit']));
    await waitUntil(() => sent.length > 0, 'the approval card to be sent');
    assert.deepEqual(sent[0].remember, { kinds: ['submit'] });
    decideBrowserApproval(contents, sent[0].id, 'always');
    assert.equal(await own, true);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(remembered, [['agent-12c3dee5bf', ['browser_submit']]]);
  } finally {
    setBrowserApprovalHooks({});
  }
});

test('a sub-agent session the roster lists surfaces in its owner, not itself (live roster shape)', async () => {
  const lead = 'sess_desktop_f44a';
  const worker = 'sess_daemon_1792946754220_0d74';
  // The roster as the desktop builds it: the agent tool's worker is a listed row flagged agentSession.
  const roster = desktopSessionSummaries([
    { id: lead, owner: 'cli', agent: 'lead', title: 'Visual check', preview: 'Spawn a worker', cwd: 'C:\\work' },
    {
      id: worker,
      owner: 'agent',
      agent: 'worker',
      visibility: 'agent-only',
      parentSessionId: lead,
      ownerSessionId: lead,
      preview: 'Run the diagnostic',
    },
  ]);
  assert.equal(roster.find((row) => row.id === worker)?.agentSession, true);
  const live = {
    sessions: () => roster,
    agentPool: () => [{ sessionId: worker, ownerSessionId: lead, parentSessionId: lead, agent: 'worker', cwd: 'C:\\work' }],
    listAgents: delegation.listAgents,
  };
  assert.equal(approvalSurfaceSessionId(worker, live), lead);
  assert.equal(approvalSurfaceSessionId(lead, live), lead);
  assert.deepEqual(await createApprovalRequesterResolver(live)(worker), { name: 'Lead › Worker', cwd: 'C:\\work' });
  // Its pool row gone, nothing names an owner: the session stays its own
  // surface and keeps its own name.
  const orphaned = { ...live, agentPool: () => [] };
  assert.equal(approvalSurfaceSessionId(worker, orphaned), worker);
  const orphanName = (await createApprovalRequesterResolver(orphaned)(worker)).name;
  assert.ok(orphanName, 'a listed sub-agent without a pool row keeps a requester name');
  assert.equal(orphanName, roster.find((row) => row.id === worker)?.title);
  // A room member's listed sub-agent still lands in the room log.
  const roomId = 'abc123';
  const member = roomMemberSessionId(roomId, 'agent-12c3dee5bf');
  const inRoom = {
    sessions: () => [
      ...roster,
      { id: roomSessionId(roomId), title: 'Standup', preview: '' },
      { id: 'sess_rm', agentSession: true, title: 'sub', preview: '' },
    ],
    agentPool: () => [{ sessionId: 'sess_rm', ownerSessionId: member, parentSessionId: member, agent: 'worker' }],
    listAgents: delegation.listAgents,
  };
  assert.equal(approvalSurfaceSessionId('sess_rm', inRoom), roomSessionId(roomId));
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
  assert.deepEqual(await fallback('sess_home_agent-12c3dee5bf'), { name: 'hello' });
});
