// Agent mode (에이전트 모드): which sessions take it, the bubble runs, the
// messenger composer, the phone's no-tab chat slot — and coding mode left as it was.
import { preloadSyncMarkdownParser } from './markdown-worker-client.ts';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { installTestDom } from './test-support/test-dom.mjs';

installTestDom(null, {
  html: '<!doctype html><html><body></body></html>',
  jsdom: { url: 'https://mixdog.test/', pretendToBeVisual: true },
  expose: ['navigator', 'Node', 'Element', 'HTMLElement', 'MutationObserver'],
  globals: {
    ResizeObserver: class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  },
});
window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
window.HTMLElement.prototype.scrollIntoView = () => {};

const { default: React, act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { renderToStaticMarkup } = await import('react-dom/server');
const { roomSessionId } = await import('../shared/core-src/runtime/agent/orchestrator/session/agent-room.mjs');
const { isAgentChatSession, isDeletedBotSession, publishAgentModeSessions } = await import('./agent-chat-mode.ts');
const { agentChatPlace, routineGroupOf } = await import('./agent-chat-place.ts');
const { AgentChatRow, AgentRoutineBody, AgentRoutineCard } = await import('./agent-chat-row.tsx');
const { routineLoginRequiredText } = await import(
  '../shared/core-src/runtime/agent/orchestrator/session/routine-result.mjs'
);
const { useConversationRowRenderer } = await import('./use-conversation-row-renderer.ts');
const { transcriptRowVariant } = await import('./transcript-list-estimates.ts');
const { transcriptRowNode } = await import('./conversation-support.tsx');
const { publishAgentRooms } = await import('./agent-room-store.ts');
const { publishSessionGlances } = await import('./session-glance-store.ts');
const { publishCatalogApprovalSessions } = await import('./session-catalog-approvals.ts');
const { Composer } = await import('./Composer.tsx');
const { MENTION_SEARCH_DEBOUNCE_MS } = await import('./use-composer-palettes.ts');
const { recognisedAgentRoomSlash } = await import('./slash-commands.ts');
const { usePaneWorkspace, agentChatSlotKey } = await import('./pane-workspace-state.ts');
const { navigationKey } = await import('./text-format.ts');

const ROOM = roomSessionId('release01');
const HOME = 'sess_home_github-watcher';

test('the mode helper: homes and rooms by id, other sessions by their persisted mode', () => {
  assert.equal(isAgentChatSession('sess_home_lead'), true);
  assert.equal(isAgentChatSession(HOME), true);
  assert.equal(isAgentChatSession(ROOM), true);
  assert.equal(isAgentChatSession('sess_task_1'), false);
  assert.equal(isAgentChatSession(''), false);
  publishAgentModeSessions([{ id: 'sess_run_1', sessionMode: 'agent' }, { id: 'sess_task_1' }]);
  assert.equal(isAgentChatSession('sess_run_1'), true);
  assert.equal(isAgentChatSession('sess_task_1'), false);
  publishAgentModeSessions([]);
  assert.equal(isAgentChatSession('sess_run_1'), false);
});

test("a deleted bot's chat is read-only from the host's mark, and only that chat", () => {
  publishAgentModeSessions([{ id: HOME, agentDeleted: true }, { id: 'sess_home_lead' }]);
  assert.equal(isDeletedBotSession(HOME), true);
  assert.equal(isDeletedBotSession('sess_home_lead'), false);
  assert.equal(isAgentChatSession(HOME), true, 'it still reads as a chat');
  publishAgentModeSessions([{ id: HOME }]);
  assert.equal(isDeletedBotSession(HOME), false, 'a bot made again under the id talks again');
});

const DAY1 = new Date(2026, 9, 19, 13, 36).getTime();
const DAY2 = new Date(2026, 9, 20, 9, 0).getTime();
const user = (id, at) => ({ _tag: 'UserMessage', key: id, turnKey: id, item: { kind: 'user', id, text: id, at } });
const reply = (id, at) => ({
  _tag: 'AssistantPart',
  key: id,
  turnKey: 't',
  item: { kind: 'assistant', id, text: id, at },
});
const speech = (id, speaker, at) => ({
  _tag: 'AssistantPart',
  key: id,
  turnKey: 't',
  item: { kind: 'notice', id, text: id, at, room: { kind: 'speech', speaker, name: speaker } },
});
const tools = { _tag: 'ToolActivity', key: 'tools', turnKey: 't', items: [] };
const compacted = {
  _tag: 'AssistantPart',
  key: 'compact',
  turnKey: 't',
  item: { kind: 'statusdone', status: 'compacted' },
};

test('a routine "nothing new" reply paints nothing and leaves the run before it closed', () => {
  const quiet = {
    ...reply('q', DAY1),
    turnKey: 'q',
    item: { kind: 'assistant', id: 'q', text: 'ROUTINE_QUIET', at: DAY1 },
  };
  const rows = [reply('a1', DAY1), quiet];
  assert.equal(agentChatPlace(rows, 1), null);
  assert.equal(agentChatPlace(rows, 0).last, true);
});

test('posted messages hours apart are separate runs; two within one minute still join', async () => {
  const { transcriptTurnKeys } = await import('./renderer-logic.mjs');
  const posted = (id, at) => ({ kind: 'assistant', id, text: id, at, messageId: id, posted: true });
  const items = [
    posted('routine_h1', DAY1),
    posted('routine_h2', DAY1 + 2 * 3_600_000),
    posted('routine_h3', DAY1 + 4 * 3_600_000),
    posted('routine_h4', DAY1 + 4 * 3_600_000 + 20_000),
  ];
  const keys = transcriptTurnKeys(items);
  const rows = items.map((item, index) => ({
    _tag: 'AssistantPart',
    key: item.id,
    turnKey: keys[index],
    item,
  }));
  assert.deepEqual(
    rows.map((_, index) => {
      const place = agentChatPlace(rows, index);
      return [place.first, place.last];
    }),
    [
      [true, true],
      [true, true],
      [true, false],
      [false, true],
    ]
  );
  // The turn keys give rows posted back to back one segment key; the posted
  // marker, not the key, keeps them apart.
  assert.equal(new Set(keys).size, 1);
  // The parts of one real turn stay together, however far apart they were sent.
  const turn = [
    { ...reply('t1', DAY1), turnKey: 'turn:u9' },
    { ...reply('t2', DAY1 + 10 * 60_000), turnKey: 'turn:u9' },
  ];
  assert.deepEqual(
    turn.map((_, index) => {
      const place = agentChatPlace(turn, index);
      return [place.first, place.last];
    }),
    [
      [true, false],
      [false, true],
    ]
  );
});

const runRows = [
  user('u1', DAY1),
  reply('a1', DAY1),
  tools,
  reply('a2', DAY1),
  compacted,
  reply('a3', DAY1),
  user('u2', DAY2),
];
const runPlace = (index) => agentChatPlace(runRows, index);

test('bubble runs: first, last and day divider per row', () => {
  assert.deepEqual(
    runRows.map((_, index) => {
      const at = runPlace(index);
      return at && [at.side, at.first, at.last, at.newDay];
    }),
    [
      ['user', true, true, true],
      ['agent', true, false, false],
      null,
      ['agent', false, false, false],
      ['hidden', true, true, false],
      ['agent', false, true, false],
      ['user', true, true, true],
    ]
  );
});

test('separate turns join only within one minute', () => {
  const proactive = (id, at) => ({ ...reply(id, at), turnKey: id });
  const later = [
    proactive('p1', DAY1),
    proactive('p2', DAY1 + 20_000),
    proactive('p3', DAY1 + 5 * 60_000),
    user('u3', DAY1 + 6 * 60_000),
    user('u4', DAY1 + 6 * 60_000 + 30_000),
  ];
  assert.deepEqual(
    later.map((_, index) => {
      const at = agentChatPlace(later, index);
      return [at.first, at.last];
    }),
    [
      [true, false],
      [false, true],
      [true, true],
      [true, false],
      [false, true],
    ]
  );
});

test('a room: each member has its own run', () => {
  const room = [speech('s1', 'rel', DAY1), speech('s2', 'rel', DAY1), speech('s3', 'bench', DAY1)];
  assert.deepEqual(
    room.map((_, index) => {
      const at = agentChatPlace(room, index);
      return [at.speaker, at.first, at.last];
    }),
    [
      ['rel', true, false],
      ['rel', false, true],
      ['bench', true, true],
    ]
  );
});

const routine = (id, status, name = 'morning-brief', summary = 'Done.') => ({
  _tag: 'AssistantPart',
  key: id,
  turnKey: id,
  item: { kind: 'notice', id, at: DAY1, text: 'x', routine: { name, status, summary } },
});
const old = {
  _tag: 'AssistantPart',
  key: 'o',
  turnKey: 'o',
  item: { kind: 'notice', at: DAY1, text: '⏱ Schedule · x' },
};
const routines = [
  reply('r0', DAY1),
  routine('r1', 'completed'),
  routine('r2', 'failed'),
  routine('r3', 'completed', 'shop-check'),
  old,
];
const member = { id: 'github-watcher', name: 'GitHub 감시', avatar: { kind: 'mascot' } };

test('routine results group per routine, success and failure alike; an old marker-less row stays a bubble', () => {
  assert.deepEqual(
    routines.map((_, index) => {
      const at = agentChatPlace(routines, index);
      return [at.side, at.source ?? '', at.first];
    }),
    [
      ['agent', '', true],
      ['agent', 'schedule:morning-brief', true],
      ['agent', 'schedule:morning-brief', false],
      ['agent', 'schedule:shop-check', true],
      ['agent', '', true],
    ]
  );
  assert.deepEqual(routineGroupOf(routines, 1), [1, 2]);
  assert.deepEqual(routineGroupOf(routines, 2), [1, 2]);
  assert.deepEqual(routineGroupOf(routines, 3), [3]);
  assert.equal(routineGroupOf(routines, 0), null);
});

test('chat row: face and name on the first bubble, the time on the last, a day pill per date', () => {
  const row = (index) =>
    renderToStaticMarkup(
      React.createElement(AgentChatRow, { place: runPlace(index), member }, React.createElement('p', null, 'body'))
    );
  assert.match(row(1), /mx-chat-face/);
  assert.match(row(1), /GitHub 감시/);
  assert.doesNotMatch(row(1), /mx-chat-time/);
  assert.doesNotMatch(row(5), /mx-chat-face|mx-chat-name/);
  assert.match(row(5), /<time class="mx-chat-time">/);
  // The time is a caption after the bubble's line, not inside it.
  assert.match(row(5), /<\/p><\/div><time class="mx-chat-time">/);
  assert.match(row(0), /mx-chat-day/);
  assert.equal(row(4), '');
});

test('routine card: head, folded older runs, latest summary, and the foot actions per status', () => {
  const card = renderToStaticMarkup(
    React.createElement(
      AgentChatRow,
      { place: agentChatPlace(routines, 2), member, card: true },
      React.createElement(AgentRoutineCard, { runs: [routines[1].item, routines[2].item], sessionId: HOME })
    )
  );
  assert.match(card, /class="question-card mx-routine-card"[^>]*data-status="failed"/);
  assert.match(card, /<strong>morning-brief<\/strong>/);
  assert.match(card, /class="mx-routine-chip" data-status="failed">Failed</);
  assert.match(card, /class="mx-routine-older"[\s\S]*data-status="ok">Succeeded</);
  assert.match(card, /Run again/);
  assert.match(card, /Run history/);
  assert.doesNotMatch(card, /mx-chat-time/);
  const ok = renderToStaticMarkup(React.createElement(AgentRoutineCard, { runs: [routines[3].item], sessionId: HOME }));
  assert.doesNotMatch(ok, /mx-routine-older|Run again/);
  assert.match(ok, /data-status="ok">Succeeded</);
  const login = renderToStaticMarkup(
    React.createElement(AgentRoutineCard, {
      runs: [routine('r4', 'failed', 'shop', routineLoginRequiredText('shop.example.com')).item],
      sessionId: HOME,
    })
  );
  assert.match(login, /data-status="login"/);
  assert.match(login, /Sign in again/);
  assert.doesNotMatch(login, /Run again/);
  // The runtime's live rows and an empty result.
  const live = (routineFields) =>
    renderToStaticMarkup(
      React.createElement(AgentRoutineCard, {
        runs: [{ kind: 'notice', at: DAY1, text: '⏱ x', routine: { name: 'brief', runId: 'r9', ...routineFields } }],
        sessionId: HOME,
      })
    );
  const running = live({ status: 'running' });
  assert.match(running, /data-status="running">Running</);
  assert.match(running, /Running…[\s\S]*mx-chat-dots/);
  assert.match(running, /class="question-foot mx-routine-foot" hidden=""/);
  const undelivered = live({ status: 'completed', delivery: 'failed', runSessionId: 'sess_run_9' });
  assert.match(undelivered, /data-status="delivery">Delivery failed</);
  assert.match(undelivered, /mx-routine-note">Delivery failed[\s\S]*>Retry</);
  const empty = live({ status: 'completed', summary: '' });
  assert.match(empty, /mx-routine-note">Nothing to report</);
  assert.doesNotMatch(empty, /⏱ x/, 'the plain-text line never shows in a card');
  const plain = renderToStaticMarkup(React.createElement(AgentRoutineBody, { item: old.item }));
  assert.match(plain, /message-body/);
});

test('routine card actions: retry delivery re-sends, run history opens the run session', async (t) => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const calls = [];
  const opened = [];
  const previous = window.mixdogDesktop;
  window.mixdogDesktop = { ...previous, invokeCapability: async (request) => calls.push(request) };
  // The card dispatches on the DOM's window: its own event class.
  const NodeCustomEvent = globalThis.CustomEvent;
  globalThis.CustomEvent = window.CustomEvent;
  t.after(() => {
    globalThis.CustomEvent = NodeCustomEvent;
  });
  const onOpen = (event) => opened.push(event.detail.sessionId);
  window.addEventListener('mixdog:open-task-session', onOpen);
  t.after(() => {
    act(() => root.unmount());
    host.remove();
    window.mixdogDesktop = previous;
    window.removeEventListener('mixdog:open-task-session', onOpen);
  });
  const item = {
    kind: 'notice',
    at: DAY1,
    text: 'x',
    routine: {
      kind: 'webhook',
      name: 'gh-pr',
      status: 'completed',
      runId: 'r1',
      runSessionId: 'sess_run_1',
      delivery: 'failed',
    },
  };
  await act(async () => root.render(React.createElement(AgentRoutineCard, { runs: [item], sessionId: HOME })));
  const button = (label) => [...host.querySelectorAll('button')].find((node) => node.textContent === label);
  await act(async () => button('Retry').click());
  assert.deepEqual(calls, [{ capability: 'retryRoutineDelivery', args: ['webhook', 'gh-pr'] }]);
  await act(async () => button('Run history').click());
  assert.deepEqual(opened, ['sess_run_1']);
});

function rowHarness(t) {
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  t.after(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
  return async (element) => {
    await act(async () => root.render(element));
    return host.innerHTML;
  };
}

const THINKING = { _tag: 'Thinking', key: 'think', turnKey: 't', active: true };

const DEV = 'sess_dev_1';
const TASK = 'sess_daemon_7_task';
const CLERK_HOME = 'sess_home_agent-a70d746b04';

const rowOptions = (sessionId, overrides = {}) => ({
  snapshot: { sessionId },
  disclosureScope: sessionId,
  readOnly: false,
  transitioning: false,
  renderAssistantRow: undefined,
  onOpenSettings() {},
  settledItems: [],
  settledTurnKeys: [],
  optimisticActivityStartedAt: 0,
  submit: async () => true,
  questionCard: null,
  agentMode: true,
  ...overrides,
});

const renderRows = (render, options, rows, { wrap = (children) => children, rowAttrs = () => ({}) } = {}) => {
  function Rows() {
    const { renderTranscriptRow } = useConversationRowRenderer(options);
    return wrap(
      rows.map((row, index) =>
        React.createElement('div', { key: row.key, ...rowAttrs(row) }, renderTranscriptRow(row, index, rows))
      )
    );
  }
  return render(React.createElement(Rows));
};

function captureOpenedSessions(t) {
  const opened = [];
  const onOpen = (event) => opened.push(event.detail.sessionId);
  const NodeCustomEvent = globalThis.CustomEvent;
  globalThis.CustomEvent = window.CustomEvent;
  window.addEventListener('mixdog:open-task-session', onOpen);
  t.after(() => {
    globalThis.CustomEvent = NodeCustomEvent;
    window.removeEventListener('mixdog:open-task-session', onOpen);
  });
  return opened;
}

const showRows = (render, sessionId, rows, agentMode = true, settledItems = []) =>
  renderRows(
    render,
    rowOptions(sessionId, {
      snapshot: { sessionId, busy: true },
      readOnly: true,
      settledItems,
      optimisticActivityStartedAt: DAY1,
      agentMode,
    }),
    rows
  );

const streamingTail = (text, streaming) => ({
  ...reply('a2', DAY1),
  live: true,
  item: { kind: 'assistant', id: 'a2', text, streaming, at: DAY1 },
});
const dots = (html) => html.match(/class="mx-chat-dots"/g)?.length ?? 0;
const agentBubbles = (html) => html.match(/class="mx-chat-row" data-side="agent"/g)?.length ?? 0;

test('a bot chat shows one typing bubble and none of the words while a reply streams', async (t) => {
  const render = rowHarness(t);
  for (const partial of ['Hel', 'Hello there, how are']) {
    const html = await showRows(render, HOME, [user('u1', DAY1), streamingTail(partial, true), THINKING]);
    assert.equal(dots(html), 1, 'the typing indicator');
    assert.equal(agentBubbles(html), 1, 'in the bot’s bubble position, one bubble');
    assert.doesNotMatch(html, new RegExp(partial));
    assert.match(html, /is typing…/);
  }
});

test('a bot chat shows a completed reply whole, without dots', async (t) => {
  // A settled reply is drawn parsed in the commit that mounts it once the page's parser is loaded, as the app loads
  // it at boot (lazy-widgets.ts). Unloaded, the reply stands pending for as long as the import takes.
  await preloadSyncMarkdownParser();
  const render = rowHarness(t);
  const whole = await showRows(render, HOME, [
    user('u1', DAY1),
    streamingTail('Hello there, how are you?', false),
    THINKING,
  ]);
  assert.match(whole, /Hello there, how are you\?/);
  assert.equal(dots(whole), 0);
  assert.equal(agentBubbles(whole), 1);
});

test("a turn's earlier message stays whole above the next one's typing bubble", async (t) => {
  // A settled reply is drawn parsed in the commit that mounts it once the page's parser is loaded, as the app loads
  // it at boot (lazy-widgets.ts). Unloaded, the reply stands pending for as long as the import takes.
  await preloadSyncMarkdownParser();
  const render = rowHarness(t);
  const first = { ...reply('a1', DAY1), item: { ...reply('a1', DAY1).item, text: 'Checking first', streaming: false } };
  const second = await showRows(render, HOME, [user('u1', DAY1), first, streamingTail('Then', true), THINKING]);
  assert.match(second, /Checking first/);
  assert.doesNotMatch(second, />Then</);
  assert.equal(dots(second), 1);
});

test("a room's chat holds back a streaming reply too", async (t) => {
  const render = rowHarness(t);
  const inRoom = await showRows(render, ROOM, [user('u1', DAY1), streamingTail('Partial words', true), THINKING]);
  assert.doesNotMatch(inRoom, /Partial words/);
});

test('coding mode keeps streaming into its own live bubble, no dots', async (t) => {
  const render = rowHarness(t);
  const coding = await showRows(
    render,
    'sess_task_1',
    [user('u1', DAY1), streamingTail('Hello there, how are', true), THINKING],
    false
  );
  assert.match(coding, /<article class="message assistant\s+streaming/);
  assert.doesNotMatch(coding, /mx-chat/);
});

test('a bot chat row that shows nothing renders no node, so the list gives it no room or step', async (t) => {
  const render = rowHarness(t);
  const whole = { ...reply('a1', DAY1), live: true };
  const streaming = { ...reply('a2', DAY1), live: true, item: { ...reply('a2', DAY1).item, streaming: true } };
  const options = rowOptions(HOME, {
    snapshot: { sessionId: HOME, busy: true },
    readOnly: true,
    optimisticActivityStartedAt: DAY1,
  });
  const nodes = (rows) => {
    const out = [];
    function Rows() {
      const { renderTranscriptRow } = useConversationRowRenderer(options);
      out.length = 0;
      for (const [index, row] of rows.entries()) out.push(renderTranscriptRow(row, index, rows) !== null);
      return null;
    }
    return render(React.createElement(Rows)).then(() => out);
  };
  assert.deepEqual(await nodes([user('u1', DAY1), streaming, shellToolRow, THINKING]), [true, false, false, true]);
  assert.deepEqual(await nodes([user('u1', DAY1), whole, THINKING]), [true, true, false]);
  assert.deepEqual(await nodes([user('u1', DAY1), reply('a1', DAY1), turnDoneRow]), [true, true, false]);
});

const taskSessionRow = (id, status, extra = {}) => ({
  _tag: 'AssistantPart',
  key: id,
  turnKey: id,
  item: {
    kind: 'notice',
    id,
    text: '🛠 Agent task',
    at: DAY1,
    routine: { kind: 'task', name: 'Fence fix', status, sessionId: 'sess_task_9', ...extra },
    attachments: [{ id: 'a1', attachmentRef: 'r1', kind: 'file', name: 'cdp.ts', mimeType: 'text/plain', size: 10 }],
  },
});
const taskSessionFiles = [
  { name: 'cdp.ts', path: 'src/cdp.ts', id: 'a1' },
  { name: 'big.mp4', path: 'out/big.mp4' },
];

function mountTaskSessionRows(t) {
  const render = rowHarness(t);
  const nodes = [];
  const show = (rows) => {
    function Rows() {
      const { renderTranscriptRow } = useConversationRowRenderer(rowOptions(HOME, { readOnly: true }));
      nodes.length = 0;
      return React.createElement(
        React.Fragment,
        null,
        rows.map((row, index) => {
          const node = renderTranscriptRow(row, index, rows);
          nodes.push(node !== null);
          return React.createElement('div', { key: row.key }, node);
        })
      );
    }
    return render(React.createElement(Rows));
  };
  return { show, nodes, host: () => document.querySelector('main') };
}

test('a task session that has only started renders no node, so the list gives it no room', async (t) => {
  const { show, nodes, host } = mountTaskSessionRows(t);
  await show([user('u1', DAY1), taskSessionRow('s', 'started')]);
  assert.deepEqual(nodes, [true, false]);
  assert.equal(host().querySelector('.mx-task-card, .mx-chat-routine-failed'), null);
});

test('an ended task session is one card with its status and changed-file count, no file cards or links', async (t) => {
  const { show, host } = mountTaskSessionRows(t);
  for (const [status, label] of [
    ['completed', 'Completed'],
    ['failed', 'Failed'],
    ['cancelled', 'Cancelled'],
  ]) {
    await show([user('u1', DAY1), taskSessionRow(status, status, { files: taskSessionFiles })]);
    const cards = host().querySelectorAll('.mx-task-card');
    assert.equal(cards.length, 1, status);
    assert.equal(cards[0].dataset.status, status);
    assert.equal(cards[0].querySelector('.turn-changes-title strong').textContent, 'Fence fix');
    assert.equal(cards[0].querySelector('.mx-task-card-meta').textContent, `Task session · ${label} · 2 files changed`);
    assert.equal(host().querySelector('.message-attachments, .message-body a'), null, `no files (${status})`);
  }
});

test('an ended task session with one changed file reads in the singular', async (t) => {
  const { show, host } = mountTaskSessionRows(t);
  await show([user('u1', DAY1), taskSessionRow('single', 'completed', { files: taskSessionFiles.slice(0, 1) })]);
  assert.equal(host().querySelector('.mx-task-card-meta').textContent, 'Task session · Completed · 1 file changed');
});

test('an ended task session with no changed files leaves the count out', async (t) => {
  const { show, host } = mountTaskSessionRows(t);
  await show([user('u1', DAY1), taskSessionRow('plain', 'completed')]);
  assert.equal(host().querySelector('.mx-task-card-meta').textContent, 'Task session · Completed');
});

test('a task session card’s "Open session" opens the task session', async (t) => {
  const { show, host } = mountTaskSessionRows(t);
  const opened = captureOpenedSessions(t);
  await show([user('u1', DAY1), taskSessionRow('plain', 'completed')]);
  await act(async () => host().querySelector('.mx-task-card .turn-changes-view').click());
  assert.deepEqual(opened, ['sess_task_9']);
});

test('coding mode renders its rows exactly as before; agent mode frames them', async (t) => {
  const render = rowHarness(t);
  const rows = [user('u1', DAY1), reply('a1', DAY1)];
  const options = {
    snapshot: { sessionId: 'sess_task_1' },
    disclosureScope: 'sess_task_1',
    readOnly: true,
    transitioning: false,
    renderAssistantRow: undefined,
    onOpenSettings() {},
    settledItems: rows.map((row) => row.item),
    settledTurnKeys: [],
    optimisticActivityStartedAt: 0,
    submit: async () => true,
    questionCard: null,
  };
  function Rows({ agentMode }) {
    const { renderTranscriptRow } = useConversationRowRenderer({ ...options, agentMode });
    return React.createElement(
      React.Fragment,
      null,
      rows.map((row, index) => React.createElement('div', { key: row.key }, renderTranscriptRow(row, index, rows)))
    );
  }
  function Before() {
    const shared = {
      ...options,
      retryDisabled: false,
      latestCompletion: undefined,
      onRetryTurn() {},
    };
    return React.createElement(
      React.Fragment,
      null,
      rows.map((row) => React.createElement('div', { key: row.key }, transcriptRowNode(row, shared)))
    );
  }
  const before = await render(React.createElement(Before));
  const coding = await render(React.createElement(Rows, { agentMode: false }));
  assert.equal(coding, before);
  assert.doesNotMatch(coding, /mx-chat/);
  const agent = await render(React.createElement(Rows, { agentMode: true }));
  assert.match(agent, /class="mx-chat-row" data-side="user"/);
  assert.match(agent, /class="mx-chat-row" data-side="agent"/);
});

const finishedReply = {
  ...reply('a1', DAY1),
  completion: { kind: 'turndone', id: 'd1', status: 'done', elapsedMs: 3000 },
};
const shellToolRow = {
  _tag: 'ToolActivity',
  key: 'tools',
  turnKey: 't',
  items: [{ kind: 'tool', id: 'tc1', name: 'shell', args: { command: 'ls' }, status: 'done', at: DAY1 }],
};
const turnDoneRow = {
  _tag: 'AssistantPart',
  key: 'td',
  turnKey: 't',
  item: { kind: 'turndone', id: 'd2', status: 'done', elapsedMs: 12000 },
};
const typingRowOf = (html) => {
  const host = document.createElement('div');
  host.innerHTML = html;
  return host.querySelector('.mx-chat-typing')?.closest('.mx-chat-row') ?? null;
};

test('agent mode shows no tool, turn or working-status rows while the agent works: only a typing bubble', async (t) => {
  const render = rowHarness(t);
  const working = await showRows(render, HOME, [user('u1', DAY1), finishedReply, shellToolRow, turnDoneRow, THINKING]);
  for (const status of ['tool-activity', 'turn-status', 'response-footer', 'live-activity', 'thinking-status']) {
    assert.doesNotMatch(working, new RegExp(status), status);
  }
  assert.match(working, /role="status" aria-label="github-watcher is typing…"/);
  assert.equal(typingRowOf(working).querySelector('.mx-chat-face'), null);
});

test("a typing bubble right after the user's message carries the agent's face and name", async (t) => {
  const render = rowHarness(t);
  const fresh = typingRowOf(await showRows(render, HOME, [user('u1', DAY1), THINKING]));
  assert.ok(fresh.querySelector('.mx-chat-face'));
  assert.equal(fresh.querySelector('.mx-chat-name')?.textContent, 'github-watcher');
  assert.equal(fresh.dataset.side, 'agent');
});

test('while text streams the typing bubble stands for the reply and its words stay out', async (t) => {
  const render = rowHarness(t);
  const streamingNow = await showRows(render, HOME, [user('u1', DAY1), streamingTail('a2', true), THINKING]);
  assert.ok(typingRowOf(streamingNow));
  assert.doesNotMatch(streamingNow, />a2</);
});

test('a reply part opened before its first text paints no empty bubble: the typing bubble keeps its face and name', async (t) => {
  const render = rowHarness(t);
  const beforeText = await showRows(render, HOME, [user('u1', DAY1), streamingTail('', true), THINKING]);
  assert.equal(beforeText.match(/class="message assistant/g)?.length, 1, 'only the typing bubble');
  assert.ok(typingRowOf(beforeText).querySelector('.mx-chat-face'));
  assert.equal(typingRowOf(beforeText).querySelector('.mx-chat-name')?.textContent, 'github-watcher');
});

test('a room band paints the member the trailing typing row names, and nothing when nobody types', async (t) => {
  const render = rowHarness(t);
  const memberTyping = {
    kind: 'notice',
    id: 'ty',
    text: '',
    room: { kind: 'typing', speaker: 'bench', name: 'Bench' },
  };
  const roomRows = [user('u1', DAY1), THINKING];
  const room = await showRows(render, ROOM, roomRows, true, [user('u1', DAY1).item, memberTyping]);
  assert.equal(room.match(/mx-chat-typing"/g)?.length, 1);
  assert.equal(typingRowOf(room).querySelector('.mx-chat-name')?.textContent, 'Bench');
  assert.ok(typingRowOf(room).querySelector('.mx-chat-face'));
  assert.doesNotMatch(room, /agent-room-typing|mx-chat-typing-idle/);
  const between = await showRows(render, ROOM, roomRows, true, [user('u1', DAY1).item]);
  assert.equal(typingRowOf(between), null);
  assert.doesNotMatch(between, /mx-chat-typing|role="status"/);
});

test('coding mode keeps its tool and turn-status rows', async (t) => {
  const render = rowHarness(t);
  const coding = await showRows(
    render,
    'sess_task_1',
    [user('u1', DAY1), finishedReply, shellToolRow, turnDoneRow],
    false
  );
  assert.match(coding, /tool-activity/);
  assert.match(coding, /turn-status/);
  assert.doesNotMatch(coding, /mx-chat/);
});

const roomTyping = (id, speaker) => ({
  kind: 'notice',
  id,
  text: '',
  room: { kind: 'typing', speaker, name: speaker },
});
const roomDeciding = {
  kind: 'notice',
  id: 'room-deciding',
  text: '',
  room: { kind: 'typing', speaker: '', name: '', deciding: true },
};
const roomPrompt = user('u1', DAY1);
const roomS1 = speech('s1', 'alpha', DAY1);
const roomS2 = speech('s2', 'beta', DAY1);
const roomPass = { kind: 'notice', id: 'p1', room: { kind: 'pass', speaker: 'gamma' } };

const roomBandOf = (render) => async (settled) => {
  const said = [roomS1, roomS2].filter((row) => settled.includes(row.item));
  const host = document.createElement('div');
  host.innerHTML = await showRows(render, ROOM, [roomPrompt, ...said, THINKING], true, settled);
  const bubble = host.querySelector('.mx-chat-typing');
  if (!bubble) return null;
  const row = bubble.closest('.mx-chat-row');
  return {
    name: row.querySelector('.mx-chat-name')?.textContent,
    status: bubble.getAttribute('aria-label'),
    footprint: [
      ...row.querySelectorAll(
        '.mx-chat-face,.mx-chat-column,.mx-chat-name,.mx-chat-line,.mx-chat-typing,.mx-chat-dots'
      ),
    ].map((element) => element.className.split(' ')[0]),
  };
};

test('a room draws the band the core supplies: a named speaker, the hand-off, or nothing', async (t) => {
  const bandOf = roomBandOf(rowHarness(t));
  const speaker = async (settled) => (await bandOf(settled))?.name ?? null;
  const [prompt, s1, s2] = [roomPrompt, roomS1, roomS2];
  assert.equal(await speaker([prompt.item, roomTyping('ty-a', 'alpha')]), 'alpha');
  assert.equal(await speaker([prompt.item]), null);
  assert.equal(await speaker([prompt.item, s1.item, roomDeciding]), '');
  assert.equal(await speaker([prompt.item, s1.item, roomTyping('ty-b', 'beta')]), 'beta');
  assert.equal(await speaker([prompt.item, s1.item, s2.item, roomDeciding]), '');
  assert.equal(await speaker([prompt.item, s1.item, s2.item]), null, 'the room finished');
  assert.equal(await speaker([prompt.item, s1.item, s2.item, roomTyping('ty-c', 'gamma')]), 'gamma');
  assert.equal(await speaker([prompt.item, s1.item, s2.item, roomPass]), null, 'a pass is no band');
});

test('the room band’s name is one truncated line', () => {
  const css = readFileSync(new URL('./agent-chat.css', import.meta.url), 'utf8');
  assert.match(
    css,
    /^\.mx-chat-name\[data-band\] \{[^}]*white-space: nowrap;[^}]*text-overflow: ellipsis;/m,
    'the band name is one truncated line'
  );
  assert.doesNotMatch(css, /mx-chat-name:empty/);
});

for (const phone of [false, true]) {
  test(`a room band keeps its rendered footprint named → deciding → named (${phone ? 'phone' : 'desktop'})`, async (t) => {
    const bandOf = roomBandOf(rowHarness(t));
    const [prompt, s1] = [roomPrompt, roomS1];
    if (phone) document.documentElement.setAttribute('data-mixdog-mobile-tabs', '');
    t.after(() => document.documentElement.removeAttribute('data-mixdog-mobile-tabs'));
    const named = await bandOf([prompt.item, roomTyping('ty-a', 'alpha')]);
    const handOff = await bandOf([prompt.item, s1.item, roomDeciding]);
    const next = await bandOf([prompt.item, s1.item, roomTyping('ty-b', 'beta')]);
    assert.deepEqual(
      handOff.footprint,
      named.footprint,
      phone ? 'phone: hand-off footprint' : 'desktop: hand-off footprint'
    );
    assert.deepEqual(next.footprint, named.footprint);
    assert.ok(handOff.footprint.includes('mx-chat-name'), 'the name line is there');
    // Its own status, not "<nobody> is typing".
    assert.equal(handOff.status, 'Choosing who speaks next…');
    assert.match(named.status, /alpha is typing…/);
  });
}

function composerProps(calls, overrides = {}) {
  return {
    turnBusy: false,
    commandBusy: false,
    transitioning: false,
    focusRequest: 0,
    historyScope: 'agent-test',
    identityScope: 'agent-test',
    recoveryScope: 'agent-test',
    projectScope: 'C:/project',
    sessionId: ROOM,
    hasConversation: true,
    provider: 'openai-oauth',
    model: 'test-model',
    effort: 'medium',
    fast: false,
    fastCapable: true,
    paneActive: true,
    submit: async (content) => {
      calls.push(content);
      return true;
    },
    abort: async () => {},
    invokeResult: (action) => action(),
    applySnapshot() {},
    onNewTask() {},
    onResumeSession() {},
    onOpenSessions() {},
    onOpenProjects() {},
    onOpenSettings() {},
    onOpenCommandSurface() {},
    dropTargetRef: { current: null },
    ...overrides,
  };
}

async function mountComposer(t) {
  window.mixdogDesktop = {
    invokeCapability: async (request) => {
      if (request.capability === 'getVoiceStatus') return { value: { installed: false } };
      if (request.capability === 'skillsStatus') return { value: { skills: [{ name: 'deploy', state: 'inUse' }] } };
      return { value: {} };
    },
    searchProjectFiles: async () => ['src/a.ts'],
  };
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  t.after(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
  const input = () => host.querySelector('textarea');
  const type = async (value) => {
    // The file-mention search waits MENTION_SEARCH_DEBOUNCE_MS on its own debounce timer
    // (use-composer-palettes.ts): that timer is held here and fired on demand, so the search's
    // answer is awaited through the mock rather than through elapsed time.
    const realSetTimeout = window.setTimeout;
    const realClearTimeout = window.clearTimeout;
    const held = new Map();
    let nextId = -1;
    window.setTimeout = (callback, delay, ...rest) => {
      if (delay !== MENTION_SEARCH_DEBOUNCE_MS) return realSetTimeout.call(window, callback, delay, ...rest);
      held.set(nextId, callback);
      return nextId--;
    };
    window.clearTimeout = (id) => {
      if (!held.delete(id)) realClearTimeout.call(window, id);
    };
    try {
      await act(async () => {
        const field = input();
        field.focus();
        Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set.call(field, value);
        field.setSelectionRange(value.length, value.length);
        field.dispatchEvent(new window.Event('input', { bubbles: true }));
      });
      for (const [id, callback] of [...held]) {
        held.delete(id);
        await act(async () => callback());
      }
    } finally {
      window.setTimeout = realSetTimeout;
      window.clearTimeout = realClearTimeout;
    }
  };
  const key = async (name) => {
    await act(async () => {
      input().dispatchEvent(new window.KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }));
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
  };
  const render = (props) => act(async () => root.render(React.createElement(Composer, props)));
  return { host, input, type, key, render };
}

const textOf = (content) =>
  typeof content === 'string' ? content : content.find((part) => part.type === 'text')?.text;

const publishReleaseRoom = (members = ['bench', 'release']) =>
  publishAgentRooms([
    {
      id: ROOM,
      agentRoom: {
        id: 'release01',
        name: '릴리스 점검',
        members,
        memberNames: { bench: 'Bench', release: '릴리스 관리' },
        maxRounds: 1,
        maxMessages: 6,
        shareTools: false,
      },
    },
  ]);

async function mountReleaseRoomComposer(t, overrides = {}) {
  publishReleaseRoom();
  t.after(() => publishAgentRooms([]));
  const calls = [];
  const mounted = await mountComposer(t);
  await mounted.render(composerProps(calls, { agentMode: true, ...overrides }));
  return { ...mounted, calls };
}

test('the agent-mode room composer: no picker or gauge inside the bar, the readout line under it', async (t) => {
  const { host } = await mountReleaseRoomComposer(t, {
    modelAside: React.createElement('i', { id: 'gauge' }),
    usageReadout: React.createElement('i', { id: 'readout' }),
  });
  const form = host.querySelector('form.composer');
  assert.equal(form.dataset.chatMode, 'agent');
  assert.equal(form.querySelector('.route-controls'), null, 'no model control inside the bar');
  // A room's members each use their own model: no picker and no context gauge.
  const line = form.nextElementSibling;
  assert.equal(line?.className, 'composer-model-line', 'the readout line sits under the bar');
  assert.ok(line.querySelector('#readout'), 'the readout stays');
  assert.equal(line.querySelector('.route-controls, .model-trigger, #gauge, .composer-model-aside'), null);
  assert.ok(form.querySelector('.composer-footer .composer-tool'), 'the room keeps its add menu');
  assert.ok(form.querySelector('.composer-footer .send-button'), 'the room keeps send');
});

test('the agent-mode composer: `/` and `$` are text', async (t) => {
  const { type, key, calls } = await mountReleaseRoomComposer(t);
  await type('/');
  assert.equal(document.getElementById('composer-slash-palette'), null);
  await type('$de');
  assert.equal(document.getElementById('composer-skill-mention-palette'), null);
  await type('/model');
  await key('Enter');
  assert.deepEqual(calls.map(textOf), ['/model'], 'a slash line goes out as typed');
});

test('the agent-mode room composer: `@` tags a member who then answers on the /ask path', async (t) => {
  const { host, type, key, calls } = await mountReleaseRoomComposer(t);
  await type('@be');
  const palette = document.getElementById('composer-room-ask-palette');
  assert.ok(palette, '@ opens the member picker');
  assert.deepEqual(
    [...palette.querySelectorAll('[role="option"]')].map((option) => option.textContent),
    ['Bench']
  );
  await act(async () => palette.querySelector('[role="option"]').click());
  assert.equal(host.querySelector('.mx-chat-tag')?.textContent, '@Bench');
  await type('서명 확인해 줘');
  await key('Enter');
  assert.equal(textOf(calls.at(-1)), '/ask bench 서명 확인해 줘', 'the tagged member answers on the /ask path');
  assert.equal(host.querySelector('.mx-chat-tag'), null);
});

test('the agent-mode room composer: ↑/↓ move the highlight through the candidates; Enter tags the highlighted one', async (t) => {
  const { host, type, key } = await mountReleaseRoomComposer(t);
  await type('@');
  const options = () => [...document.querySelectorAll('#composer-room-ask-palette [role="option"]')];
  assert.ok(options().length > 1, 'every member is a candidate');
  assert.equal(options()[0].getAttribute('aria-selected'), 'true');
  await key('ArrowDown');
  assert.equal(options()[1].getAttribute('aria-selected'), 'true');
  const second = options()[1].textContent;
  await key('ArrowUp');
  await key('ArrowUp');
  assert.equal(options().at(-1).getAttribute('aria-selected'), 'true', '↑ from the first wraps to the last');
  await key('ArrowDown');
  await key('ArrowDown');
  await key('Enter');
  assert.equal(host.querySelector('.mx-chat-tag')?.textContent, `@${second}`);
});

test("a bot's 1:1 agent-mode chat keeps its model control and context gauge, and its `@` opens nothing", async (t) => {
  const calls = [];
  const { host, type, render } = await mountComposer(t);
  await render(
    composerProps(calls, {
      agentMode: true,
      sessionId: HOME,
      identityScope: HOME,
      modelAside: React.createElement('i', { id: 'gauge' }),
    })
  );
  const botLine = host.querySelector('form.composer').nextElementSibling;
  assert.ok(botLine.querySelector('#gauge'), 'the bot chat shows the context gauge');
  // The chip edits the agent's route (agent-chat-route.ts), like the profile pane.
  assert.equal(botLine.querySelector('.model-trigger')?.disabled, false);
  await type('@b');
  assert.equal(document.getElementById('composer-room-ask-palette'), null);
  assert.equal(document.getElementById('composer-mention-palette'), null);
});

test('a room composer’s @ offers Everyone: it addresses each current member once, never a bot that left', async (t) => {
  const { host, type, key, calls } = await mountReleaseRoomComposer(t);
  // The room's composer keeps its tags between mounts: start from none.
  await act(async () => host.querySelector('.mx-chat-tag')?.click());
  const options = () => [...document.querySelectorAll('#composer-room-ask-palette [role="option"]')];
  const pick = (label) =>
    act(async () =>
      options()
        .find((option) => option.textContent === label)
        .click()
    );

  await type('@');
  assert.deepEqual(
    options().map((option) => option.textContent),
    ['Bench', '릴리스 관리', 'Everyone'],
    'Everyone is listed with the members'
  );
  await type('@ev');
  assert.deepEqual(
    options().map((option) => option.textContent),
    ['Everyone']
  );
  await pick('Everyone');
  assert.equal(host.querySelector('.mx-chat-tag')?.textContent, '@Everyone');
  await type('hi all');
  await key('Enter');
  assert.equal(textOf(calls.at(-1)), '/ask bench, release hi all', 'every member, once');

  // With individual mentions, nobody is called twice.
  await type('@be');
  await pick('Bench');
  await type('@all');
  await key('Enter');
  assert.deepEqual(
    [...host.querySelectorAll('.mx-chat-tag')].map((tag) => tag.textContent),
    ['@Bench', '@Everyone'],
    'the keyboard picks Everyone too'
  );
  await type('both');
  await key('Enter');
  assert.equal(textOf(calls.at(-1)), '/ask bench, release both');

  // Everyone means the room as it is when the message goes out.
  await type('@all');
  await key('Enter');
  publishReleaseRoom(['bench']);
  await type('@');
  assert.deepEqual(
    options().map((option) => option.textContent),
    ['Bench'],
    'the picker no longer lists the removed member'
  );
  await type('now');
  await key('Enter');
  assert.equal(textOf(calls.at(-1)), '/ask bench now', 'a member who left is not addressed');
});

test('a room composer’s @all inside a Markdown code fence is text: no picker opens and Enter tags nobody', async (t) => {
  const { host, type, key } = await mountReleaseRoomComposer(t);
  await act(async () => host.querySelector('.mx-chat-tag')?.click());
  const palette = () => document.getElementById('composer-room-ask-palette');

  await type('```\n@all');
  assert.equal(palette(), null, 'an @ on a line inside an open fence offers nothing');
  await key('Enter');
  assert.equal(host.querySelector('.mx-chat-tag'), null, 'Enter does not tag Everyone');

  await type('```js\nconst a = 1;\n```\n@all');
  assert.ok(palette(), 'once the fence is closed, @ is a tag again');
  assert.deepEqual(
    [...palette().querySelectorAll('[role="option"]')].map((option) => option.textContent),
    ['Everyone']
  );
});

test('the agent-mode composer runs /compact and /clear as commands, other `/` lines stay text', async (t) => {
  const calls = [];
  const capabilities = [];
  const clearedToNewTask = [];
  const { input, type, key, render } = await mountComposer(t);
  const base = window.mixdogDesktop.invokeCapability;
  window.mixdogDesktop.invokeCapability = async (request) => {
    if (request.capability === 'compact' || request.capability === 'clear') capabilities.push(request.capability);
    return base(request);
  };
  const props = (overrides = {}) =>
    composerProps(calls, {
      agentMode: true,
      sessionId: HOME,
      identityScope: HOME,
      onClearToNewTask: () => clearedToNewTask.push(HOME),
      ...overrides,
    });
  await render(props());

  await type('/compact');
  await key('Enter');
  await type('/clear');
  await key('Enter');
  assert.deepEqual(capabilities, ['compact', 'clear'], 'idle: both run as commands, in place');
  assert.deepEqual(calls, [], 'neither is sent as a message, so nothing is queued');
  assert.deepEqual(clearedToNewTask, [], '/clear keeps the persistent thread instead of opening a New Task');

  await type('/new');
  await key('Enter');
  await type('/compact now please');
  await key('Enter');
  assert.deepEqual(calls.map(textOf), ['/new'], 'other slash lines still go out as typed');
  assert.deepEqual(capabilities, ['compact', 'clear', 'compact']);

  // While a reply runs they act as in coding sessions: /compact runs, /clear waits for the turn.
  await render(props({ turnBusy: true }));
  await type('/compact');
  await key('Enter');
  await type('/clear');
  await key('Enter');
  assert.deepEqual(capabilities, ['compact', 'clear', 'compact', 'compact']);
  assert.deepEqual(calls.map(textOf), ['/new']);
  assert.equal(input().value, '/clear', 'the refused /clear stays in the editor');
});

test('recognisedAgentRoomSlash names only the room commands, by their literal name', () => {
  assert.equal(recognisedAgentRoomSlash('/compact'), true);
  assert.equal(recognisedAgentRoomSlash(' /CLEAR now'), true);
  assert.equal(recognisedAgentRoomSlash('/new'), false, 'an alias stays text');
  assert.equal(recognisedAgentRoomSlash('/model'), false);
  assert.equal(recognisedAgentRoomSlash('/nope'), false);
  assert.equal(recognisedAgentRoomSlash('say /compact'), false);
});

test('the coding composer: model controls on the line under the card, `/` commands and `@` files', async (t) => {
  const calls = [];
  const { host, type, render } = await mountComposer(t);
  await render(
    composerProps(calls, {
      sessionId: 'sess_task_1',
      identityScope: 'coding',
      modelAside: React.createElement('i', { id: 'gauge' }),
      usageReadout: React.createElement('i', { id: 'readout' }),
    })
  );
  const form = host.querySelector('form.composer');
  assert.equal(form.dataset.chatMode, undefined);
  // The card keeps the add menu and send; the picker and gauge left it.
  assert.ok(form.querySelector('.composer-footer .composer-tool'), 'the add menu stays in the card');
  assert.ok(form.querySelector('.composer-footer .send-button'), 'send stays in the card');
  assert.equal(form.querySelector('.route-controls, #gauge, #readout'), null);
  const line = form.nextElementSibling;
  assert.equal(line?.className, 'composer-model-line');
  // Readout at the left end; picker, then gauge, at the right end.
  assert.equal(line.firstElementChild.id, 'readout');
  const controls = line.querySelector('.composer-model-line-controls');
  assert.deepEqual(
    [...controls.children].map((node) => node.className),
    ['route-controls', 'composer-model-aside']
  );
  assert.ok(controls.querySelector('#gauge'));
  assert.equal(controls.querySelector('.model-trigger')?.disabled, false, 'the coding picker stays editable');
  await type('/');
  assert.ok(document.getElementById('composer-slash-palette'), '/ lists commands');
  await type('@sr');
  assert.ok(document.getElementById('composer-mention-palette'), '@ searches files');
  assert.equal(host.querySelector('.mx-chat-tag'), null);
});

test('desktop agent rows open as tabs like sessions; the phone slot helper keeps one chat a pane', async (t) => {
  let current;
  function Harness() {
    current = usePaneWorkspace(null);
    return null;
  }
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(React.createElement(Harness)));
  t.after(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
  const run = (command) => act(async () => command(current));
  const tabs = () => current.leaves.map((leaf) => [leaf.tabs.map((tab) => navigationKey(tab)), leaf.activeKey]);
  const session = (id) => ({ kind: 'session', id });

  await run((w) => w.openInFocused(session('sess_task_1')));
  await run((w) => w.openInFocused(session('sess_home_lead')));
  await run((w) => w.openInFocused(session('sess_task_1')));
  // Another agent, from a coding tab: its own tab, shown; no chat is replaced.
  await run((w) => w.openInFocused(session(HOME)));
  assert.deepEqual(tabs(), [[['session:sess_task_1', 'session:sess_home_lead', `session:${HOME}`], `session:${HOME}`]]);
  await run((w) => w.openInFocused(session(ROOM)));
  assert.deepEqual(tabs(), [
    [['session:sess_task_1', 'session:sess_home_lead', `session:${HOME}`, `session:${ROOM}`], `session:${ROOM}`],
  ]);
  await run((w) => w.openInFocused(session('sess_task_2')));
  assert.deepEqual(tabs()[0][0], [
    'session:sess_task_1',
    'session:sess_home_lead',
    `session:${HOME}`,
    `session:${ROOM}`,
    'session:sess_task_2',
  ]);

  // The phone's slot: a new agent chat takes the place of the one held.
  const leaf = current.leaves[0];
  assert.equal(agentChatSlotKey(leaf, session('sess_task_3')), '');
  assert.equal(agentChatSlotKey(leaf, session(ROOM)), '');
  assert.equal(agentChatSlotKey(leaf, session('sess_home_translator')), 'session:sess_home_lead');
});

async function mountVisualize(t, initialChangedPaths = ['src/b.ts']) {
  const { resyncVisualizeStates } = await import('./visualize-store.ts');
  const { TurnChangesContext } = await import('./TurnChangesCard.tsx');
  const { resetTurnChangesCache } = await import('./turn-changes-model.ts');
  const render = rowHarness(t);
  const SESSION = 'sess_home_lead';
  const commands = [];
  let changedPaths = initialChangedPaths;
  resetTurnChangesCache();
  const previous = window.mixdogDesktop;
  window.mixdogDesktop = {
    ...previous,
    visualizeCommand: async (command) => {
      commands.push(command);
      if (command.action !== 'thumbnail') return undefined;
      return command.version === 1 ? { thumbnail: 'data:image/png;base64,VjE=' } : {};
    },
    invokeCapability: async () => ({
      value: {
        status: 'ready',
        checkpointId: 'cp',
        revision: 1,
        root: 'C:/p',
        files: changedPaths.map((path) => ({
          path,
          status: 'M',
          additions: 1,
          deletions: 0,
          state: 'applied',
          revertable: true,
        })),
        canUndo: true,
        canReapply: false,
      },
    }),
  };
  t.after(() => {
    window.mixdogDesktop = previous;
    resyncVisualizeStates([]);
  });
  const open = (id, at) => ({
    _tag: 'ToolActivity',
    key: id,
    turnKey: id,
    items: [
      {
        id,
        kind: 'tool',
        name: 'visualize',
        args: { action: 'open', input: { targets: ['site/a.html'], label: '요금제 시안' } },
        result: 'Showing site/a.html (html) in the side panel as tab v1.',
        status: 'done',
        startedAt: at,
        completedAt: at + 1,
      },
    ],
  });
  const tabAt = (newest) => ({
    sessionId: SESSION,
    active: 'v1',
    tabs: [
      {
        id: 'v1',
        label: '요금제 시안',
        revision: newest,
        panes: [{ target: 'site/a.html' }],
        versions: Array.from({ length: newest }, (_, index) => ({ n: index + 1 })),
        ...(newest > 1 ? { thumbnail: 'data:image/png;base64,VjI=', thumbnailVersion: newest } : {}),
      },
    ],
  });
  const context = {
    sessionId: SESSION,
    busy: false,
    turnRunning: false,
    onOpenSessionDiff() {},
    onOpenFile() {},
  };
  const show = (rows, agentMode = true) =>
    renderRows(render, rowOptions(SESSION, { agentMode }), rows, {
      wrap: (children) => React.createElement(TurnChangesContext.Provider, { value: context }, children),
    });
  const host = () => document.querySelector('main');
  return {
    show,
    open,
    host,
    seedTab: (newest) => resyncVisualizeStates([tabAt(newest)]),
    setChangedPaths: (paths) => {
      changedPaths = paths;
      resetTurnChangesCache();
    },
    cards: () => [...host().querySelectorAll('.transcript-visualize-tile')],
    turnCards: () => [...host().querySelectorAll('.transcript-visualize-turn[data-artifact="visualize"]')],
    sentCommands: () => commands.filter((command) => command.action !== 'thumbnail'),
    clearCommands: () => {
      commands.length = 0;
    },
  };
}

const visualizeAnswer = {
  ...reply('a9', DAY1),
  turnKey: 'f',
  turnChanges: { checkpointId: 'cp', boundary: 'done-f', trailing: false },
};
const nodeFollows = (a, b) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

test('a visualize open leaves one compact card in the bubble column at turn end', async (t) => {
  const { show, open, host, cards, seedTab } = await mountVisualize(t);
  seedTab(1);
  await show([user('u1', DAY1), open('e', 100)]);
  assert.equal(cards().length, 1);
  const [first] = cards();
  assert.ok(first.closest('.mx-chat-row[data-side="aside"]'), 'in the bubble column');
  assert.ok(first.closest('.transcript-visualize-turn').classList.contains('is-compact'), 'at the bubble column width');
  assert.equal(first.querySelector('b').textContent, '요금제 시안');
  assert.match(first.querySelector('.transcript-visualize-badge.is-version').textContent, /^Version 1/);
  assert.equal(
    first.closest('.transcript-visualize-turn').querySelector('.transcript-visualize-title').textContent,
    'Previews 1'
  );
  assert.equal(
    first.closest('.transcript-visualize-turn').querySelector('.transcript-visualize-all').textContent,
    'Show all'
  );
  assert.doesNotMatch(host().innerHTML, /tool-activity/);
});

test('a later turn opening the tab again leaves one card per turn, the latter closing its turn under the reply, with no changed-files card in a bot chat', async (t) => {
  const { show, open, host, cards, turnCards, seedTab } = await mountVisualize(t);
  seedTab(2);
  await show([user('u1', DAY1), open('e', 100), user('u2', DAY1), open('f', 200), visualizeAnswer]);
  const rows = [...host().querySelectorAll('.mx-chat-row')];
  assert.equal(host().querySelector('.turn-changes-card'), null, 'no changed-files card in a bot chat');
  assert.ok(rows.at(-1).contains(cards()[1]), 'the visualize card closes the turn');
  assert.equal(turnCards().length, 2, 'one card per turn');
  assert.equal(rows.at(-2)?.dataset.side, 'agent', 'under the reply');
});

test('each visualize card shows its own version: the earlier one folded on v1, the newest open on v2', async (t) => {
  const { show, open, cards, seedTab } = await mountVisualize(t);
  seedTab(2);
  await show([user('u1', DAY1), open('e', 100), user('u2', DAY1), open('f', 200), visualizeAnswer]);
  assert.equal(cards()[0].querySelector('.transcript-visualize-badge.is-version').textContent, 'Version 1');
  assert.equal(cards()[0].querySelector('.transcript-visualize-status'), null, 'no status words, only the version');
  assert.equal(cards()[0].getAttribute('aria-label'), `${cards()[0].querySelector('b').textContent}, Version 1`);
  assert.deepEqual(
    cards().map((card) => card.querySelector('.transcript-visualize-thumb img')?.getAttribute('src')),
    ['data:image/png;base64,VjE=', 'data:image/png;base64,VjI=']
  );
  assert.deepEqual(
    cards().map((card) => [card.dataset.visualizeCard, card.dataset.version]),
    [
      ['folded', '1'],
      ['open', '2'],
    ]
  );
});

test('clicking an earlier visualize card activates its tab at its version; the newest card shows live', async (t) => {
  const { show, open, cards, seedTab, sentCommands, clearCommands } = await mountVisualize(t);
  seedTab(2);
  await show([user('u1', DAY1), open('e', 100), user('u2', DAY1), open('f', 200), visualizeAnswer]);
  clearCommands();
  await act(async () => cards()[0].click());
  assert.deepEqual(
    sentCommands().map((command) => [command.action, command.tabId, command.version]),
    [
      ['activate', 'v1', undefined],
      ['version', 'v1', 1],
    ]
  );
  clearCommands();
  await act(async () => cards()[1].click());
  assert.deepEqual(
    sentCommands().map((command) => command.action),
    ['activate'],
    'the newest card shows live'
  );
});

test('coding mode seats the same turn-end card, not compact, outside the tool group', async (t) => {
  const { show, open, host, seedTab } = await mountVisualize(t);
  seedTab(2);
  await show([user('u1', DAY1), open('g', 300)], false);
  assert.equal(host().querySelector('.is-compact'), null);
  assert.ok(host().querySelector('.transcript-visualize-turn'));
  assert.equal(host().querySelector('.tool-activity .transcript-visualize-tile'), null);
});

for (const agentMode of [true, false]) {
  test(`no visualize card while the turn runs, under its live band or a streaming reply (agentMode ${agentMode})`, async (t) => {
    const { show, open, cards, seedTab } = await mountVisualize(t);
    seedTab(2);
    const thinking = { _tag: 'Thinking', key: 'th', turnKey: 'f', active: true };
    const streaming = { ...reply('live', DAY1), turnKey: 'f', active: true, live: true };
    await show([user('u1', DAY1), open('f', 200), thinking], agentMode);
    assert.equal(cards().length, 0, 'no card while thinking');
    await show([user('u1', DAY1), open('f', 200), streaming], agentMode);
    assert.equal(cards().length, 0, 'no card while streaming');
  });
}

test('coding mode orders reply, visualize card, then changes card', async (t) => {
  const { show, open, host, cards, seedTab } = await mountVisualize(t);
  seedTab(2);
  await show([user('u1', DAY1), open('f', 200), visualizeAnswer], false);
  assert.equal(cards().length, 1);
  const replyText = [...host().querySelectorAll('*')].find(
    (node) => node.children.length === 0 && node.textContent === 'a9'
  );
  const codingChanges = host().querySelector('.turn-changes-card');
  assert.ok(replyText && codingChanges);
  assert.ok(nodeFollows(replyText, cards()[0]), 'the card follows the reply');
  assert.ok(nodeFollows(cards()[0], codingChanges), 'the changes card follows the card');
});

for (const agentMode of [true, false]) {
  test(`an error that ends the turn still leaves its visualize card, above the changed files in coding mode (agentMode ${agentMode})`, async (t) => {
    const { show, open, host, cards, seedTab } = await mountVisualize(t);
    seedTab(2);
    const failed = {
      _tag: 'Error',
      key: 'err',
      turnKey: 'f',
      item: { kind: 'error', id: 'err', text: 'boom', at: DAY1 },
      failures: [],
      turnChanges: { checkpointId: 'cp', boundary: 'done-f', trailing: false },
    };
    await show([user('u1', DAY1), open('f', 200), failed], agentMode);
    assert.equal(cards().length, 1, 'one card');
    const errorChanges = host().querySelector('.turn-changes-card');
    if (agentMode) {
      assert.equal(errorChanges, null, 'a bot chat shows no changes card');
      return;
    }
    assert.ok(errorChanges, 'coding mode keeps its changes card');
    assert.ok(nodeFollows(cards()[0], errorChanges), 'card above the changes');
  });
}

for (const agentMode of [true, false]) {
  test(`when the changed file is the visualized one its card stands in for the diff and carries Undo (agentMode ${agentMode})`, async (t) => {
    const { show, open, host, cards, turnCards, seedTab } = await mountVisualize(t, ['site/a.html']);
    seedTab(2);
    await show([user('u1', DAY1), open('f', 200), visualizeAnswer], agentMode);
    assert.equal(cards().length, 1, 'the visualize card stays');
    assert.equal(host().querySelector('.turn-changes-card'), null, 'no changes card');
    assert.equal(turnCards()[0].querySelector('.turn-changes-action')?.textContent, 'Undo', 'Undo on the card');
  });
}

test('when another file changed too the changes card lists only that one and Undo stays there', async (t) => {
  const { show, open, host, turnCards, seedTab } = await mountVisualize(t, ['site/a.html', 'src/b.ts']);
  seedTab(2);
  await show([user('u1', DAY1), open('f', 200), visualizeAnswer], false);
  assert.deepEqual(
    [...host().querySelectorAll('.turn-changes-base')].map((node) => node.textContent),
    ['b.ts']
  );
  assert.equal(turnCards()[0].querySelector('.turn-changes-action'), null);
  assert.ok(host().querySelector('.turn-changes-card .turn-changes-action'));
});

const followFlowTab = {
  sessionId: 'sess_home_lead',
  active: 'v1',
  tabs: [{ id: 'v1', label: 'Flow', revision: 1, panes: [{ target: 'a.html' }], versions: [{ n: 1 }] }],
};
const followFlowOpen = {
  _tag: 'ToolActivity',
  key: 'open',
  turnKey: 'f',
  items: [
    {
      id: 'open',
      kind: 'tool',
      name: 'visualize',
      args: { action: 'open', input: { targets: ['a.html'], label: 'Flow' } },
      result: 'Showing a.html (html) in the side panel as tab v1.',
      status: 'done',
      startedAt: 100,
      completedAt: 101,
    },
  ],
};
const followFlowBefore = { ...reply('before-text', DAY1), turnKey: 'f' };
const followFlowAfter = { ...reply('after-text', DAY1), turnKey: 'f' };

async function mountFollowFlow(t, agentMode) {
  const { resyncVisualizeStates } = await import('./visualize-store.ts');
  const render = rowHarness(t);
  const previous = window.mixdogDesktop;
  window.mixdogDesktop = { ...previous, visualizeCommand: async () => undefined };
  t.after(() => {
    window.mixdogDesktop = previous;
    resyncVisualizeStates([]);
  });
  resyncVisualizeStates([followFlowTab]);
  const show = (rows) =>
    renderRows(render, rowOptions('sess_home_lead', { agentMode }), rows, {
      wrap: (children) => React.createElement('div', null, children),
    });
  const textNode = (label) =>
    [...document.querySelectorAll('main *')].find((node) => node.children.length === 0 && node.textContent === label);
  return { show, textNode };
}

for (const agentMode of [false, true]) {
  test(`a visualize card follows the text before the call and the text after it (agentMode ${agentMode})`, async (t) => {
    const { show, textNode } = await mountFollowFlow(t, agentMode);
    await show([user('u1', DAY1), followFlowBefore, followFlowOpen, followFlowAfter]);
    const card = document.querySelector('main .transcript-visualize-turn');
    assert.ok(card, 'the card is drawn');
    assert.ok(nodeFollows(textNode('before-text'), card), 'the card follows the text before the call');
    assert.ok(nodeFollows(textNode('after-text'), card), 'the card follows the text after the call');
  });

  test(`a turn ending on the visualize call still draws the card under the earlier text (agentMode ${agentMode})`, async (t) => {
    const { show, textNode } = await mountFollowFlow(t, agentMode);
    await show([user('u1', DAY1), followFlowBefore, followFlowOpen]);
    const closing = document.querySelector('main .transcript-visualize-turn');
    assert.ok(closing, 'a turn ending on the call still draws it');
    assert.ok(nodeFollows(textNode('before-text'), closing), 'under the text before the call');
  });

  test(`no visualize card shows while the reply after the call streams (agentMode ${agentMode})`, async (t) => {
    const { show } = await mountFollowFlow(t, agentMode);
    await show([user('u1', DAY1), followFlowBefore, followFlowOpen, { ...followFlowAfter, active: true, live: true }]);
    assert.equal(document.querySelectorAll('main .transcript-visualize-turn').length, 0);
  });
}

async function mountTurnCard(t, agentMode) {
  const { resyncVisualizeStates, setVisualizePanelOnScreen } = await import('./visualize-store.ts');
  const render = rowHarness(t);
  const SESSION = 'sess_home_lead_turncard';
  setVisualizePanelOnScreen(SESSION, true);
  const commands = [];
  const previous = window.mixdogDesktop;
  window.mixdogDesktop = {
    ...previous,
    visualizeCommand: async (command) => {
      if (command.action !== 'thumbnail') commands.push(command);
      return undefined;
    },
  };
  t.after(() => {
    window.mixdogDesktop = previous;
    setVisualizePanelOnScreen(SESSION, false);
    resyncVisualizeStates([]);
  });
  const tab = (id, label, file, extra = {}) => ({
    id,
    label,
    revision: 2,
    panes: [{ target: file }],
    versions: [{ n: 1 }, { n: 2 }],
    ...extra,
  });
  resyncVisualizeStates([
    {
      sessionId: SESSION,
      active: 'v1',
      tabs: [tab('v1', 'Login', 'a.html', { problems: [{ message: 'x' }] }), tab('v2', 'Settings', 'b.html')],
    },
  ]);
  const call = (id, file, tabId, label, at) => ({
    id,
    kind: 'tool',
    name: 'visualize',
    args: { action: 'open', input: { targets: [file], label } },
    result: `Showing ${file} (html) in the side panel as tab ${tabId}.`,
    status: 'done',
    startedAt: at,
    completedAt: at + 1,
  });
  const rows = [
    user('u1', DAY1),
    {
      _tag: 'ToolActivity',
      key: 'g1',
      turnKey: 'f',
      items: [call('c1', 'a.html', 'v1', 'Login', 100), call('c2', 'b.html', 'v2', 'Settings', 110)],
    },
    {
      _tag: 'ToolActivity',
      key: 'g2',
      turnKey: 'f',
      items: [call('c3', 'a.html', 'v1', 'Login', 120), call('c4', 'c.html', 'v3', 'Closed one', 130)],
    },
    { ...reply('done', DAY1), turnKey: 'f' },
  ];
  await renderRows(render, rowOptions(SESSION, { agentMode }), rows, {
    wrap: (children) => React.createElement('div', null, children),
  });
  const cards = [...document.querySelectorAll('main .transcript-visualize-turn')];
  return { cards, tiles: [...(cards[0]?.querySelectorAll('.transcript-visualize-tile') ?? [])], commands };
}

for (const agentMode of [false, true]) {
  test(`a turn leaves ONE visualize card with a tile per distinct tab, the reopened one counted once (agentMode ${agentMode})`, async (t) => {
    const { cards, tiles } = await mountTurnCard(t, agentMode);
    assert.equal(cards.length, 1, 'one card for the turn');
    assert.equal(cards[0].classList.contains('is-compact'), agentMode);
    assert.equal(cards[0].querySelector('.transcript-visualize-title').textContent, 'Previews 3');
    assert.deepEqual(
      tiles.map((tile) => tile.dataset.visualizeTab),
      ['v2', 'v1', 'v3'],
      'a tile per tab; the reopened one counted once'
    );
  });

  test(`visualize tiles show the tab on its final version: shown, closed, current, problem badge, no status words (agentMode ${agentMode})`, async (t) => {
    const { tiles } = await mountTurnCard(t, agentMode);
    assert.deepEqual(
      tiles.map((tile) => [tile.classList.contains('is-shown'), tile.classList.contains('is-closed')]),
      [
        [false, false],
        [true, false],
        [false, true],
      ]
    );
    assert.equal(tiles[1].querySelector('.transcript-visualize-badge.is-version').textContent, 'Version 2');
    assert.deepEqual(
      tiles.map((tile) => tile.getAttribute('aria-current')),
      [null, 'true', null],
      'the tile of the tab the panel shows is announced as current'
    );
    assert.equal(tiles[2].querySelector('.transcript-visualize-badge.is-version'), null);
    assert.ok(
      tiles.every((tile) => !tile.querySelector('.transcript-visualize-status')),
      'no status words'
    );
    assert.ok(tiles[1].querySelector('.transcript-visualize-badge.is-problem'), 'page problems badge');
  });

  test(`a visualize tile reveals its own tab and a closed one opens again (agentMode ${agentMode})`, async (t) => {
    const { tiles, commands } = await mountTurnCard(t, agentMode);
    await act(async () => tiles[0].click());
    assert.deepEqual(
      commands.map((command) => [command.action, command.tabId]),
      [['activate', 'v2']]
    );
    commands.length = 0;
    await act(async () => tiles[2].click());
    assert.deepEqual(
      commands.map((command) => [command.action, command.tabId, command.targets]),
      [['reopen', 'v3', ['c.html']]]
    );
  });

  test(`Show all brings every tab up, the first tile's tab shown last (agentMode ${agentMode})`, async (t) => {
    const { cards, commands } = await mountTurnCard(t, agentMode);
    await act(async () => cards[0].querySelector('.transcript-visualize-all').click());
    assert.deepEqual(
      commands.map((command) => [command.action, command.tabId]),
      [
        ['reopen', 'v3'],
        ['activate', 'v1'],
        ['activate', 'v2'],
      ]
    );
  });
}

test('a connect card shows in a bot chat even when the round also holds an answered question', async (t) => {
  const render = rowHarness(t);
  const ask = {
    kind: 'tool',
    id: 'q1',
    name: 'ask_user',
    args: { questions: [{ question: 'Which account?', header: 'Mail', options: [{ label: 'Gmail' }] }] },
    result: 'User has answered your questions: "Which account?"="Gmail".',
    status: 'done',
    at: DAY1,
  };
  const connect = (id) => ({
    kind: 'tool',
    id,
    name: 'setup',
    args: { action: 'connect_connector', connector: 'gmail' },
    result: '{"connector":"gmail","connected":false}',
    status: 'done',
    at: DAY1,
  });
  const round = (items) => ({ _tag: 'ToolActivity', key: 'tools', turnKey: 'c', items });
  const show = (rows) => renderRows(render, rowOptions(HOME), rows);
  const cards = () => document.querySelectorAll('main [data-connector-card="gmail"]').length;
  await show([{ ...user('c', DAY1), turnKey: 'c' }, round([connect('s1')])]);
  assert.equal(cards(), 1, 'a connect-only round shows its card');
  await show([{ ...user('c', DAY1), turnKey: 'c' }, round([ask, connect('s1')])]);
  assert.equal(cards(), 1, 'the card is not dropped when an answered question shares the round');
});

test("a bot chat shows a terminal card for a completed run, which reveals that run's tab; a pending run shows none", async (t) => {
  const { onTerminalRevealRequested } = await import('./terminal-command-request.ts');
  const { activeSessionTerminalId, releaseSessionTerminalTabs } = await import('./session-terminal-tabs.ts');
  const render = rowHarness(t);
  const terminalId = `session-terminal:${HOME}:2`;
  const run = (id, result) => ({
    kind: 'tool',
    id,
    name: 'terminal',
    args: { action: 'run', command: 'npm test' },
    result,
    status: result ? 'done' : 'running',
    at: DAY1,
  });
  const reply = `Terminal run: ${terminalId} · 2 pwsh running C:\\work · cursor=42\nCommand sent to the side terminal.`;
  const round = (items) => ({ _tag: 'ToolActivity', key: 'tools', turnKey: 'c', items });
  const show = (rows) => renderRows(render, rowOptions(HOME), rows);
  const revealed = [];
  let stop = () => {};
  await act(async () => {
    stop = onTerminalRevealRequested((sessionId) => revealed.push(sessionId));
  });
  t.after(async () => {
    await act(async () => stop());
    releaseSessionTerminalTabs(HOME);
  });
  const cards = () => document.querySelectorAll('main .transcript-terminal-peek');
  await show([{ ...user('c', DAY1), turnKey: 'c' }, round([run('r1', '')])]);
  assert.equal(cards().length, 0, 'a run that has not started has no tab to reveal');
  await show([{ ...user('c', DAY1), turnKey: 'c' }, round([run('r1', reply)])]);
  assert.equal(cards().length, 1);
  assert.equal(cards()[0].textContent, 'Terminal·npm test·View');
  await act(async () => cards()[0].dispatchEvent(new window.MouseEvent('click', { bubbles: true })));
  assert.deepEqual(revealed, [HOME]);
  assert.equal(activeSessionTerminalId(HOME), terminalId);

  // A round that also connected an account keeps both cards.
  const connect = {
    kind: 'tool',
    id: 's1',
    name: 'setup',
    args: { action: 'connect_connector', connector: 'gmail' },
    result: '{"connector":"gmail","connected":false}',
    status: 'done',
    at: DAY1,
  };
  await show([{ ...user('c', DAY1), turnKey: 'c' }, round([connect, run('r1', reply)])]);
  assert.equal(document.querySelectorAll('main [data-connector-card="gmail"]').length, 1);
  assert.equal(cards().length, 1, 'the terminal card is not dropped by the connector card');
});

const MARKETER = 'agent-12c3dee5bf';
const botMessage = (id, extra = {}) => ({
  _tag: 'UserMessage',
  key: id,
  turnKey: id,
  item: {
    kind: 'user',
    id,
    text: 'Hello from the marketer',
    at: DAY1,
    sender: 'lead',
    fromAgent: MARKETER,
    ...extra,
  },
});
const botTaskReply = (id, routine) => ({
  _tag: 'AssistantPart',
  key: id,
  turnKey: id,
  item: {
    kind: 'notice',
    id,
    text: '🛠 Session completed',
    at: DAY1,
    routine: { kind: 'task', name: 'x', ...routine },
  },
});
const botTaskReplies = [
  botTaskReply('r1', {
    status: 'completed',
    summary: 'Got it',
    agentId: MARKETER,
    target: 'session',
    sessionId: CLERK_HOME,
  }),
  botTaskReply('r2', { status: 'started', summary: '', agentId: MARKETER, target: 'session' }),
  botTaskReply('r3', { status: 'completed', summary: 'Plain', target: 'session' }),
];
const botSend = (id, extra = {}) => ({
  kind: 'tool',
  id,
  name: 'session',
  args: { action: 'send', session_id: CLERK_HOME, prompt: 'Please watch the mailbox', ...extra },
  result: '{"sessionId":"x","accepted":true,"reportsBack":true}',
  status: 'done',
  startedAt: DAY1,
});
const botAsk = {
  kind: 'tool',
  id: 'q1',
  name: 'ask_user',
  args: { questions: [{ question: 'Which?', header: 'H', options: [{ label: 'A' }] }] },
  result: 'User has answered your questions: "Which?"="A".',
  status: 'done',
  at: DAY1,
};
const botRound = (items) => ({ _tag: 'ToolActivity', key: 'tools', turnKey: 's', items });

function mountBotChat(t) {
  const render = rowHarness(t);
  const show = (list, agentMode = true) => renderRows(render, rowOptions(HOME, { agentMode }), list);
  const opened = captureOpenedSessions(t);
  const main = () => document.querySelector('main');
  return { show, opened, main };
}

test('bot-to-bot: a bot message is that bot’s own run on the agent side; a lead brief and the user keep their sides', () => {
  const rows = [
    botMessage('b1'),
    user('u1', DAY1),
    { ...user('l1', DAY1), item: { kind: 'user', id: 'l1', text: 'brief', at: DAY1, sender: 'lead' } },
  ];
  const places = rows.map((_, index) => agentChatPlace(rows, index));
  assert.deepEqual(
    places.map((place) => [place.side, place.speaker, Boolean(place.bot)]),
    [
      ['agent', MARKETER, true],
      ['user', '', false],
      ['user', '', false],
    ]
  );
});

test('bot-to-bot: a completed reply of a bot’s home session is an aside card and a start paints nothing', () => {
  assert.deepEqual(
    botTaskReplies
      .map((_, index) => agentChatPlace(botTaskReplies, index))
      .map((place) => place && [place.side, place.speaker, Boolean(place.bot)]),
    [['aside', '', false], null, ['aside', '', false]]
  );
});

test('bot-to-bot: the receiver shows the sending bot with its tag, the words folded behind a disclosure', async (t) => {
  const { show, main } = mountBotChat(t);
  await show([botMessage('b1')]);
  assert.equal(
    main()
      .querySelector('.mx-chat-row[data-side="agent"]')
      ?.querySelector('.mx-chat-name')
      ?.textContent.includes(MARKETER),
    true
  );
  assert.ok(main().querySelector('.mx-chat-bot-tag'), 'the bot tag sits by the name');
  assert.equal(main().querySelector('.mx-chat-row[data-side="user"]'), null, 'not a user bubble');
  assert.doesNotMatch(main().textContent, /LEAD/);
  assert.match(main().textContent, /Hello from the marketer/);
  assert.equal(main().querySelector('.mx-bot-fold-body'), null, 'a bot message is folded by default');
  await act(async () => main().querySelector('.mx-bot-fold-pill .mx-routine-more').click());
  assert.match(main().querySelector('.mx-bot-fold-body').textContent, /Hello from the marketer/);
});

test('bot-to-bot: the bot’s answer is the session completion card under its face and name; its words open in place and Open opens its chat', async (t) => {
  const { show, main, opened } = mountBotChat(t);
  await show(botTaskReplies.slice(0, 1));
  const card = main().querySelector('.mx-task-card');
  assert.ok(card, 'the completion card');
  assert.equal(main().querySelector('.mx-bot-fold, .mx-chat-bot-tag'), null, 'no folded bot bubble');
  assert.ok(card.querySelector('.mx-task-card-face'), 'the bot’s face');
  assert.equal(card.querySelector('.turn-changes-title strong').textContent, MARKETER);
  assert.equal(card.querySelector('.mx-task-card-meta').textContent, 'Session · Completed');
  assert.equal(card.querySelector('.mx-task-card-answer'), null, 'the answer is folded by default');
  await act(async () => card.querySelector('.mx-routine-more').click());
  assert.match(card.querySelector('.mx-task-card-answer').textContent, /Got it/);
  await act(async () => card.querySelector('.turn-changes-view').click());
  assert.equal(opened.at(-1), botTaskReplies[0].item.routine.sessionId);
});

test('bot-to-bot: the send is one hand-off line naming the recipient bot with its face; Open opens that bot’s chat', async (t) => {
  const { show, main, opened } = mountBotChat(t);
  for (const items of [[botSend('s1')], [botAsk, botSend('s1')]]) {
    await show([botRound(items)]);
    const line = main().querySelector('.mx-handoff-line');
    assert.ok(line, 'the sent line is drawn');
    assert.ok(line.querySelector('.mx-bot-sent-face'), 'the bot’s face');
    assert.match(line.textContent, /Sent to agent-a70d746b04 · Working/);
    assert.equal(main().querySelector('.mx-handoff-line .mx-routine-more'), null, 'no message disclosure');
    await act(async () => line.querySelector('button').click());
    assert.equal(opened.at(-1), CLERK_HOME);
  }
});

test('bot-to-bot: the send sits under the sending bot’s reply bubble, in its group, never above the name', async (t) => {
  const { show, main } = mountBotChat(t);
  const replyRow = {
    _tag: 'AssistantPart',
    key: 'a1',
    turnKey: 's',
    item: { kind: 'assistant', id: 'a1', text: 'Handed it over', at: DAY1 },
  };
  await show([botRound([botSend('s1')]), replyRow]);
  const group = main().querySelector('.mx-chat-row[data-side="agent"]');
  assert.ok(group.querySelector('.mx-chat-column > .mx-handoff-block'), 'inside the reply column');
  const nodes = [...group.querySelectorAll('.mx-chat-name, .mx-chat-line, .mx-handoff-block')];
  const order = (selector) => nodes.findIndex((n) => n.matches(selector));
  assert.ok(order('.mx-chat-line') < order('.mx-handoff-block'), 'after the bubble');
  assert.equal(main().querySelectorAll('.mx-handoff-line').length, 1);
});

test('bot-to-bot: the reply’s time and the hand-off share one row, the time first, then the line', async (t) => {
  const { show, main } = mountBotChat(t);
  const replyRow = {
    _tag: 'AssistantPart',
    key: 'a1',
    turnKey: 's',
    item: { kind: 'assistant', id: 'a1', text: 'Handed it over', at: DAY1 },
  };
  await show([botRound([botSend('s1')]), replyRow]);
  const group = main().querySelector('.mx-chat-row[data-side="agent"]');
  const block = group.querySelector('.mx-handoff-block');
  const time = block.querySelector('time.mx-chat-time');
  assert.ok(time, 'the time sits in the hand-off block');
  assert.equal(group.querySelectorAll('.mx-chat-time').length, 1, 'one time');
  assert.equal(time.closest('.mx-handoff-block'), block);
  assert.equal(time.parentElement.parentElement, block, 'same row parent as the line');
  assert.equal(block.querySelector('.mx-handoff-line').parentElement, block);
  assert.ok(time.compareDocumentPosition(block.querySelector('.mx-handoff-line')) & 4, 'time before the line');
  assert.equal(block.querySelector('.mx-handoff-when > [aria-hidden]').textContent, '·', 'the separator');
  assert.ok(block.querySelector('.mx-handoff-line .mx-handoff-name'), 'the name ellipsizes on its own span');
  assert.ok(block.querySelector('.mx-handoff-line > button'), 'Open stays a sibling after the name');
  assert.equal(time.tabIndex, -1, 'the time is not focusable');
});

test('bot-to-bot: a session call that is not a send draws no line', async (t) => {
  const { show, main } = mountBotChat(t);
  await show([botRound([botSend('s3', { action: 'read' })])]);
  assert.equal(main().querySelector('.mx-handoff-line'), null);
});

test('a hand-off line stays until that send’s own report, per send', async (t) => {
  const render = rowHarness(t);
  const DEV = 'sess_dev_2';
  const send = (id, sessionId, sendId) => ({
    kind: 'tool',
    id,
    name: 'session',
    args: { action: 'send', session_id: sessionId, prompt: `prompt ${id}` },
    result: JSON.stringify({ sessionId, accepted: true, reportsBack: true, ...(sendId ? { sendId } : {}) }),
    status: 'done',
    startedAt: DAY1,
  });
  const round = (key, items) => ({ _tag: 'ToolActivity', key, turnKey: key, items });
  const answer = (key, sessionId, sendId, status = 'completed', sendIds) => ({
    _tag: 'AssistantPart',
    key,
    turnKey: key,
    item: {
      kind: 'notice',
      id: key,
      text: '🛠 x',
      at: DAY1,
      routine: {
        kind: 'task',
        name: 'x',
        status,
        summary: 'ok',
        sessionId,
        target: 'session',
        ...(sendId ? { sendId } : {}),
        ...(sendIds ? { sendIds } : {}),
      },
    },
  });
  const show = (rows) => renderRows(render, rowOptions(HOME), rows);
  // Which sends still show their line, in order.
  const open = () => [...document.querySelectorAll('main .mx-handoff-line')].map((line) => line.textContent);

  // Two sends to one session in a round paint one line with their count.
  await show([round('r1', [send('a', DEV, 'atask_1'), send('b', DEV, 'atask_2')])]);
  assert.equal(open().length, 1);
  assert.match(open()[0], /×2/);
  // Across rounds: send A, send B, then A's answer: only B still owes one.
  const rounds = [round('r1', [send('a', DEV, 'atask_1')]), round('r2', [send('b', DEV, 'atask_2')])];
  await show(rounds);
  assert.equal(open().length, 2);
  await show([...rounds, answer('ans-a', DEV, 'atask_1')]);
  assert.equal(open().length, 1, "A's answer ends A's line only");
  await show([...rounds, answer('ans-a', DEV, 'atask_1'), answer('ans-b', DEV, 'atask_2')]);
  assert.equal(open().length, 0, "B's own answer ends it");
  // A report without a correlation (an older one) ends by session, as before.
  await show([...rounds, answer('old', DEV, '')]);
  assert.equal(open().length, 0);
  // A failed end ends the send too; a start does not.
  await show([...rounds, answer('f', DEV, 'atask_2', 'failed')]);
  assert.equal(open().length, 1);
  await show([...rounds, answer('s', DEV, 'atask_2', 'started')]);
  assert.equal(open().length, 2);
  // Sends folded into one running turn get one report that lists them all: it
  // ends each of them, never a send it does not list.
  await show([...rounds, answer('one', DEV, 'atask_1', 'completed', ['atask_1', 'atask_2'])]);
  assert.equal(open().length, 0, 'the one report ends both sends');
  await show([...rounds, answer('one', DEV, 'atask_1', 'completed', ['atask_1', 'atask_3'])]);
  assert.equal(open().length, 1, "a report that does not list B leaves B's line");
  // A report naming the send ends it wherever it is stored, even before the call.
  await show([answer('early', DEV, 'atask_2'), ...rounds]);
  assert.equal(open().length, 1, 'B ended by its own earlier-stored report; A still owes one');
  await show([answer('early', DEV, '', 'completed', ['atask_1', 'atask_2']), ...rounds]);
  assert.equal(open().length, 0);
  // An older report naming no send never closes a later resend to that session.
  await show([answer('old', DEV, ''), ...rounds]);
  assert.equal(open().length, 2);
  await show([answer('old', DEV, ''), round('r9', [send('c', DEV, '')])]);
  assert.equal(open().length, 1, 'nor a later send without an id');
});

test('a hand-off line keeps Working and shows the latest progress update only on hover, never a card per update', async (t) => {
  const render = rowHarness(t);
  const DEV = 'sess_dev_progress';
  const sent = {
    _tag: 'ToolActivity',
    key: 'r1',
    turnKey: 'r1',
    items: [
      {
        kind: 'tool',
        id: 's1',
        name: 'session',
        args: { action: 'send', session_id: DEV, prompt: 'refactor it' },
        result: JSON.stringify({ sessionId: DEV, accepted: true, reportsBack: true, sendId: 'atask_1' }),
        status: 'done',
        startedAt: DAY1,
      },
    ],
  };
  const report = (key, routine) => ({
    _tag: 'AssistantPart',
    key,
    turnKey: key,
    item: {
      kind: 'notice',
      id: key,
      text: '🛠 x',
      at: DAY1,
      posted: true,
      routine: { kind: 'task', name: 'Dev', sessionId: DEV, target: 'session', ...routine },
    },
  });
  const update = (key, line) => report(key, { status: 'working', summary: `${line} more detail`, line });
  const show = (rows) => renderRows(render, rowOptions(HOME), rows);
  const lines = () => [...document.querySelectorAll('main .mx-handoff-line')];
  const hover = () => lines()[0].querySelector('.mx-handoff-state[data-tooltip]')?.getAttribute('data-tooltip') ?? null;
  const visibleText = () => {
    const line = lines()[0].cloneNode(true);
    for (const hidden of line.querySelectorAll('.sr-only')) hidden.remove();
    return line.textContent;
  };
  const cards = () => document.querySelectorAll('main .mx-task-card').length;

  await show([sent]);
  assert.match(lines()[0].textContent, / · Working/, 'no update yet: Working');
  assert.equal(hover(), null);
  // An update rides Working's hover; the line itself stays short. No card, no row of its own.
  const first = [sent, update('p1', 'Worker is on the parser.')];
  await show(first);
  assert.equal(lines().length, 1);
  assert.match(lines()[0].textContent, / · Working/);
  assert.equal(visibleText().includes('Worker is on the parser'), false, 'off the visible line');
  assert.equal(hover(), 'Worker is on the parser.', 'its first line only, on hover');
  assert.equal(lines()[0].querySelector('.mx-handoff-state[data-tooltip]').tabIndex, 0, 'focusable for the keyboard');
  const open = lines()[0].querySelector('button');
  assert.equal(
    document.getElementById(open.getAttribute('aria-describedby'))?.textContent,
    'Worker is on the parser.',
    'Open is described by the progress for screen readers'
  );
  assert.equal(open.hasAttribute('data-tooltip'), false, 'no second bubble on Open');
  assert.equal(cards(), 0, 'no card per update');
  assert.equal(document.querySelector('main [data-status="working"]'), null, 'the update row paints nothing');
  // A later update replaces it.
  await show([...first, update('p2', 'Reviewer asked for a fix.')]);
  assert.equal(lines().length, 1);
  assert.equal(hover(), 'Reviewer asked for a fix.');
  assert.equal(cards(), 0);
  // The final report ends the line (and the update with it); its card shows once.
  await show([
    ...first,
    update('p2', 'Reviewer asked for a fix.'),
    report('end', { status: 'completed', summary: 'Done.', sendId: 'atask_1' }),
  ]);
  assert.equal(lines().length, 0, 'cleared when the final report lands');
  assert.equal(cards(), 1);
  // An update stored before this send belongs to an earlier one: never shown.
  await show([update('p0', 'Old news.'), sent]);
  assert.match(lines()[0].textContent, / · Working/);
  assert.equal(hover(), null, 'the stale update is not shown');
  assert.equal(lines()[0].querySelector('button').hasAttribute('aria-describedby'), false);
});

test('only an accepted send draws a hand-off line; a bot’s reports are cards, never its bubble', async (t) => {
  const render = rowHarness(t);
  const CLERK_HOME = 'sess_home_agent-a70d746b04';
  const send = (id, extra) => ({
    kind: 'tool',
    id,
    name: 'session',
    args: { action: 'send', session_id: CLERK_HOME, prompt: 'hi' },
    status: 'done',
    startedAt: DAY1,
    ...extra,
  });
  const round = (items) => ({ _tag: 'ToolActivity', key: 'tools', turnKey: 's', items });
  const sentLines = async (item) => {
    await renderRows(render, rowOptions(HOME), [round([item])]);
    return document.querySelectorAll('main .mx-handoff-line').length;
  };
  assert.equal(await sentLines(send('ok', { result: '{"sessionId":"x","accepted":true,"reportsBack":true}' })), 1);
  assert.equal(await sentLines(send('run', { status: 'running' })), 0, 'a running call was not sent yet');
  assert.equal(await sentLines(send('err', { result: 'session: boom', isError: true })), 0);
  assert.equal(await sentLines(send('no', { result: '{"sessionId":"x","accepted":false}' })), 0);
  const reply = (status) => [
    {
      _tag: 'AssistantPart',
      key: status,
      turnKey: status,
      item: {
        kind: 'notice',
        id: status,
        text: '🛠 x',
        at: DAY1,
        routine: { kind: 'task', name: 'x', status, summary: 'because', agentId: 'agent-1', target: 'session' },
      },
    },
  ];
  assert.equal(agentChatPlace(reply('completed'), 0).bot, undefined);
  assert.equal(agentChatPlace(reply('completed'), 0).side, 'aside');
  assert.equal(agentChatPlace(reply('failed'), 0).bot, undefined);
  assert.equal(agentChatPlace(reply('cancelled'), 0).bot, undefined);
});

const SENT_LINE = 'Sent to Dev session · Working·Open';

const handedCall = (id, args, result) => ({
  kind: 'tool',
  id,
  name: 'session',
  args,
  result: JSON.stringify(result),
  status: 'done',
  startedAt: DAY1,
});
const handedSend = (id, sendId, result = {}, sessionId = DEV) =>
  handedCall(
    id,
    { action: 'send', session_id: sessionId, prompt: `prompt ${id}` },
    { sessionId, accepted: true, sendId, reportsBack: true, hop: 1, ...result }
  );
const handedCreate = (id, args = {}) =>
  handedCall(
    id,
    { action: 'create', title: 'Fence fix', brief: 'Fix the fence', ...args },
    { session_id: TASK, status: 'started', title: 'Fence fix', project: null }
  );
const handedRound = (key, items) => ({ _tag: 'ToolActivity', key, turnKey: 't1', items });
const handedReport = (key, routine) => ({
  _tag: 'AssistantPart',
  key,
  turnKey: key,
  item: { kind: 'notice', id: key, text: '🛠 x', at: DAY1, routine: { kind: 'task', summary: 'done', ...routine } },
});
const handedEnded = (key, status, sendId) =>
  handedReport(key, { name: 'Dev session', status, sessionId: DEV, target: 'session', hop: 1, sendId });
const handedTaskEnded = (key, status) =>
  handedReport(key, { name: 'Fence fix', status, sessionId: TASK, sendId: 'atask_9' });
const handedTaskWait = (key) =>
  handedReport(key, { name: 'Fence fix', status: 'blocked', summary: '', sessionId: TASK });
const handedStarted = handedReport('started', { name: 'Fence fix', status: 'started', summary: '', sessionId: TASK });
const HANDED_THINKING = { _tag: 'Thinking', key: 'think', turnKey: 't1', active: true };
const handedStreaming = {
  _tag: 'AssistantPart',
  key: 'a1',
  turnKey: 't1',
  live: true,
  active: true,
  item: { kind: 'assistant', id: 'a1', text: 'Sent i', streaming: true, at: DAY1 },
};
const handedLanded = {
  ...handedStreaming,
  item: { ...handedStreaming.item, text: 'Handed it over', streaming: false },
};
const handedReplied = {
  _tag: 'AssistantPart',
  key: 'a1',
  turnKey: 't1',
  item: { kind: 'assistant', id: 'a1', text: 'Handed it over', at: DAY1 },
};
const handedSent = handedRound('r1', [handedSend('s1', 'atask_1')]);
const handedRows = () => [user('u1', DAY1), handedSent, handedReplied];

async function mountHandoff(t) {
  const render = rowHarness(t);
  const options = rowOptions(HOME, { snapshot: { sessionId: HOME, busy: true } });
  const show = (rows, agentMode = true) => renderRows(render, { ...options, agentMode }, rows);
  const main = () => document.querySelector('main');
  const lines = () => [...main().querySelectorAll('.mx-handoff-line')].map((line) => line.textContent);
  const nodeOf = async (rows, index) => {
    let node;
    function Probe() {
      const { renderTranscriptRow } = useConversationRowRenderer(options);
      node = renderTranscriptRow(rows[index], index, rows);
      return null;
    }
    await render(React.createElement(Probe));
    return node;
  };
  const linesRow = () => [...main().children].findIndex((node) => node.querySelector('.mx-handoff-line'));
  const waiting = (ids) =>
    act(async () => publishCatalogApprovalSessions(ids.map((id) => ({ id, awaitingApproval: true }))));
  const opened = captureOpenedSessions(t);
  t.after(() => {
    publishSessionGlances([]);
    publishCatalogApprovalSessions([]);
  });
  await act(async () => publishSessionGlances([{ id: DEV, title: 'Dev session', preview: '', working: true }]));
  return { show, main, lines, nodeOf, linesRow, waiting, opened };
}

test('work handed to a session: while the turn runs the block stands under the typing bubble, not at the round', async (t) => {
  const { show, main, lines, linesRow } = await mountHandoff(t);
  for (const rest of [[HANDED_THINKING], [handedStreaming, HANDED_THINKING]]) {
    await show([user('u1', DAY1), handedSent, ...rest]);
    assert.deepEqual(lines(), [SENT_LINE], `${rest.map((row) => row.key)}`);
    const run = main().querySelector('.mx-chat-row[data-side="agent"]');
    assert.ok(run.querySelector('.mx-chat-typing'), 'the typing bubble');
    const column = [...run.querySelector('.mx-chat-column').children];
    const at = (selector) => column.findIndex((node) => node.matches(selector));
    assert.ok(at('.mx-chat-line') < at('.mx-handoff-block'), 'below the typing bubble');
    assert.equal(linesRow(), 2, 'at the live band or the streaming part, not the round');
    assert.equal(main().querySelectorAll('.mx-chat-typing').length, 1, 'one typing bubble');
    assert.equal(main().querySelector('.mx-handoff-line').getAttribute('role'), 'status');
    assert.ok(main().querySelector('.mx-handoff-line .mx-bot-sent-dot'), 'the dot');
  }
});

test('work handed to a session: once the reply lands the block sits under the reply bubble and its time, and Open opens the session', async (t) => {
  const { show, main, lines, linesRow, opened } = await mountHandoff(t);
  await show(handedRows());
  assert.deepEqual(lines(), [SENT_LINE]);
  assert.equal(linesRow(), 2, 'at the reply');
  const run = main().querySelector('.mx-chat-row[data-side="agent"]');
  const column = [...run.querySelector('.mx-chat-column').children];
  const at = (selector) => column.findIndex((node) => node.matches(selector));
  assert.match(run.querySelector('.mx-chat-line').textContent, /Handed it over/);
  assert.ok(at('.mx-chat-line') < at('.mx-handoff-block'), 'below the bubble');
  assert.equal(at('.mx-chat-time'), -1, 'the time is not its own block: it leads the hand-off line');
  const timed = run.querySelector('.mx-handoff-block');
  assert.ok(timed.querySelector(':scope > .mx-handoff-when > time.mx-chat-time'), 'time in the hand-off row');
  assert.equal(timed.dataset.timed, 'true');
  assert.equal(main().querySelector('.mx-bot-sent, .mx-routine-more'), null, 'no pill, no message disclosure');
  await act(async () => main().querySelector('.mx-handoff-line button').click());
  assert.equal(opened.at(-1), DEV);
});

test('work handed to a session: one carrier row holds the block from streaming through the turn’s end', async (t) => {
  const { show, lines, linesRow } = await mountHandoff(t);
  const carriers = [];
  for (const rest of [[handedStreaming, HANDED_THINKING], [handedLanded, HANDED_THINKING], [handedReplied]]) {
    const rows = [user('u1', DAY1), handedSent, ...rest];
    await show(rows);
    const at = linesRow();
    carriers.push([rows[at].key, transcriptRowVariant(rows, at, new Set())]);
    assert.equal(
      rows.filter((_, index) => transcriptRowVariant(rows, index, new Set()).startsWith('lines')).length,
      1,
      'one carrier'
    );
    assert.deepEqual(lines(), [SENT_LINE]);
  }
  assert.deepEqual(carriers, [
    ['a1', 'lines:1'],
    ['a1', 'lines:1'],
    ['a1', 'lines:1'],
  ]);
});

test('work handed to a session: a turn with no reply keeps the line at its own round', async (t) => {
  const { show, lines, linesRow } = await mountHandoff(t);
  await show([user('u1', DAY1), handedSent]);
  assert.deepEqual(lines(), [SENT_LINE]);
  assert.equal(linesRow(), 1);
});

test('work handed to a session: one block per turn, a line per piece of work in call order', async (t) => {
  const { show, main, lines } = await mountHandoff(t);
  await show([user('u1', DAY1), handedSent, handedRound('r3', [handedCreate('c1')]), handedReplied]);
  assert.deepEqual(lines(), [SENT_LINE, 'Fence fix · Working·Open']);
  assert.equal(main().querySelectorAll('.mx-handoff-block').length, 1);
  const multi = main().querySelector('.mx-handoff-block');
  const children = [...multi.children];
  assert.ok(children[0].matches('.mx-handoff-when') && children[0].querySelector('time.mx-chat-time'));
  assert.ok(children[1].matches('.mx-handoff-line') && children[2].matches('.mx-handoff-line'));
  assert.equal(multi.querySelectorAll('time').length, 1, 'one time for the block');
  assert.match(children[1].textContent, /Sent to Dev session/);
  assert.match(children[2].textContent, /Fence fix/);
});

test('work handed to a session: under the typing bubble the line stands alone, with no time or separator', async (t) => {
  const { show, main } = await mountHandoff(t);
  await show([user('u1', DAY1), handedSent, HANDED_THINKING]);
  assert.equal(main().querySelector('.mx-handoff-block').dataset.timed, undefined);
  assert.equal(main().querySelector('.mx-handoff-block time'), null);
  assert.equal(main().querySelector('.mx-handoff-when'), null);
});

test('work handed to a session: the line names the session’s current title', async (t) => {
  const { show, lines } = await mountHandoff(t);
  await act(async () => publishSessionGlances([{ id: DEV, title: 'Renamed', preview: '', working: true }]));
  await show(handedRows());
  assert.deepEqual(lines(), ['Sent to Renamed · Working·Open']);
});

test('work handed to a session: a session waiting for approval reads so, and back once approved, with no row of its own', async (t) => {
  const { show, main, lines, waiting } = await mountHandoff(t);
  await show(handedRows());
  const nodes = main().querySelectorAll('.mx-chat-row').length;
  await waiting([DEV]);
  assert.deepEqual(lines(), ['Sent to Dev session · Approval needed·Open']);
  assert.equal(main().querySelector('.mx-handoff-line').dataset.state, 'approval');
  assert.equal(main().querySelectorAll('.mx-chat-row').length, nodes, 'no new row');
  await waiting([]);
  assert.deepEqual(lines(), [SENT_LINE]);
  assert.equal(main().querySelector('.mx-handoff-line').dataset.state, 'working');
});

test('work handed to a session: a question in its open lane reads as an answer wait', async (t) => {
  const { show, main, lines } = await mountHandoff(t);
  await show(handedRows());
  const { defaultSessionLaneStore } = await import('./session-lane-store.ts');
  const laneAsk = (toolApproval) =>
    act(async () => {
      defaultSessionLaneStore.setShownSessionIds([DEV]);
      defaultSessionLaneStore.apply({
        sessionId: DEV,
        frameSource: 'live',
        snapshot: { sessionId: DEV, busy: true, toolApproval },
      });
    });
  try {
    await laneAsk({ id: 'q1', kind: 'question', args: { questions: [] } });
    assert.deepEqual(lines(), ['Sent to Dev session · Answer needed·Open']);
    assert.equal(main().querySelector('.mx-handoff-line').dataset.state, 'question');
    await laneAsk(null);
    assert.deepEqual(lines(), [SENT_LINE]);
  } finally {
    await act(async () => defaultSessionLaneStore.clear());
  }
});

test('work handed to a session: its wait reports draw nothing while the line carries the state', async (t) => {
  const { show, main, waiting } = await mountHandoff(t);
  await waiting([DEV]);
  await show([...handedRows(), handedEnded('b1', 'blocked', 'atask_1'), handedEnded('b2', 'blocked', 'atask_1')]);
  assert.equal(main().querySelectorAll('.mx-chat-routine-failed').length, 1, 'one line for the session');
  assert.equal(main().children[3].childElementCount + main().children[4].childElementCount, 0);
});

test('work handed to a session: a wait with no hand-off line shows one named line on its latest report, only while the session waits', async (t) => {
  const { show, lines, linesRow, nodeOf, waiting } = await mountHandoff(t);
  const older = [user('u1', DAY1), handedReplied, handedTaskWait('w1'), handedTaskWait('w2')];
  await waiting([TASK]);
  await show(older);
  assert.deepEqual(lines(), ['Fence fix · Approval needed·Open']);
  assert.equal(linesRow(), 3, 'on the latest wait');
  await waiting([]);
  assert.deepEqual(lines(), [], 'gone once the session no longer waits');
  assert.equal(await nodeOf(older, 3), null);
  assert.equal(transcriptRowVariant(older, 3, new Set()), 'hidden');
  await waiting([TASK]);
  assert.notEqual(await nodeOf(older, 3), null);
  assert.equal(transcriptRowVariant(older, 3, new Set([TASK])), '');
});

test('work handed to a session: a wait the session’s later end closed paints nothing at all', async (t) => {
  const { show, main, lines, waiting } = await mountHandoff(t);
  const older = [user('u1', DAY1), handedReplied, handedTaskWait('w1'), handedTaskWait('w2')];
  await waiting([TASK]);
  await show([...older, handedTaskEnded('done', 'completed')]);
  assert.deepEqual(lines(), []);
  assert.equal(main().children[2].childElementCount + main().children[3].childElementCount, 0);
});

test('work handed to a session: its terminal report removes the line and shows the session card, no folded answer', async (t) => {
  const { show, main, lines } = await mountHandoff(t);
  for (const [status, label] of [
    ['completed', 'Completed'],
    ['failed', 'Failed'],
    ['cancelled', 'Cancelled'],
  ]) {
    await show([...handedRows(), handedEnded('e', status, 'atask_1')]);
    assert.deepEqual(lines(), [], status);
    const cards = main().querySelectorAll('.mx-task-card');
    assert.equal(cards.length, 1, status);
    assert.equal(cards[0].dataset.status, status);
    assert.equal(cards[0].querySelector('.turn-changes-title strong').textContent, 'Dev session');
    assert.equal(cards[0].querySelector('.mx-task-card-meta').textContent, `Session · ${label}`);
    assert.equal(main().querySelector('.mx-bot-fold'), null, status);
  }
});

test('work handed to a session: another send’s end leaves the line, and a send reporting nothing back draws none', async (t) => {
  const { show, lines } = await mountHandoff(t);
  await show([...handedRows(), handedEnded('o', 'completed', 'atask_other')]);
  assert.equal(lines().length, 1);
  await show([user('u1', DAY1), handedRound('r2', [handedSend('s2', '', { reportsBack: false })]), handedReplied]);
  assert.deepEqual(lines(), []);
});

test('work handed to a session: a created task session shows its name alone, the stored start paints nothing, and Open opens it', async (t) => {
  const { show, main, lines, opened } = await mountHandoff(t);
  const made = handedRound('r3', [handedCreate('c1')]);
  for (const rest of [[HANDED_THINKING], [handedReplied], [handedReplied, handedStarted]]) {
    await show([user('u1', DAY1), made, ...rest]);
    assert.deepEqual(lines(), ['Fence fix · Working·Open'], `${rest.map((row) => row.key)}`);
    assert.equal(main().querySelector('.mx-task-card'), null);
  }
  await act(async () => main().querySelector('.mx-handoff-line button').click());
  assert.equal(opened.at(-1), TASK);
});

test('work handed to a session: a created session’s end is the task card, and notify:false draws no line', async (t) => {
  const { show, main, lines } = await mountHandoff(t);
  const made = handedRound('r3', [handedCreate('c1')]);
  await show([user('u1', DAY1), made, handedReplied, handedStarted, handedTaskEnded('done', 'completed')]);
  assert.deepEqual(lines(), []);
  assert.equal(main().querySelector('.mx-task-card-meta').textContent, 'Task session · Completed');
  await show([user('u1', DAY1), handedRound('r4', [handedCreate('c2', { notify: false })]), handedReplied]);
  assert.deepEqual(lines(), []);
});

test('work handed to another bot’s chat: its face and name, then its answer as a completion card under the bot', async (t) => {
  const { show, main, lines } = await mountHandoff(t);
  const toBot = handedRound('r5', [handedSend('s5', 'atask_5', {}, CLERK_HOME)]);
  await show([user('u1', DAY1), toBot, handedReplied]);
  assert.deepEqual(lines(), ['Sent to agent-a70d746b04 · Working·Open']);
  assert.ok(main().querySelector('.mx-handoff-line .mx-bot-sent-face'));
  const botAnswer = handedReport('ba', {
    name: 'Clerk',
    status: 'completed',
    summary: 'Mailbox watched',
    sessionId: CLERK_HOME,
    agentId: 'agent-a70d746b04',
    target: 'session',
    sendId: 'atask_5',
  });
  await show([user('u1', DAY1), toBot, handedReplied, botAnswer]);
  assert.deepEqual(lines(), []);
  assert.equal(main().querySelector('.mx-bot-fold'), null, 'no folded bot bubble');
  const botCard = main().querySelector('.mx-task-card');
  assert.equal(botCard.querySelector('.turn-changes-title strong').textContent, 'agent-a70d746b04');
  assert.ok(botCard.querySelector('.mx-task-card-face'));
  assert.equal(botCard.querySelector('.mx-task-card-meta').textContent, 'Session · Completed');
  await act(async () => botCard.querySelector('.mx-routine-more').click());
  assert.match(botCard.querySelector('.mx-task-card-answer').textContent, /Mailbox watched/);
});

test('work handed to another bot’s chat: its wait with no line here names the bot with its face', async (t) => {
  const { show, main, lines, waiting } = await mountHandoff(t);
  await waiting([CLERK_HOME]);
  await show([
    user('u1', DAY1),
    handedReport('bw', {
      name: 'x',
      status: 'blocked',
      sessionId: CLERK_HOME,
      agentId: 'agent-a70d746b04',
      target: 'session',
    }),
  ]);
  assert.deepEqual(lines(), ['agent-a70d746b04 · Approval needed·Open']);
  assert.ok(main().querySelector('.mx-handoff-line .mx-bot-sent-face'));
});

test('work handed to a session: a coding transcript shows the block under the turn’s reply', async (t) => {
  const { show, main, lines, linesRow } = await mountHandoff(t);
  await show(handedRows(), false);
  assert.deepEqual(lines(), [SENT_LINE]);
  assert.equal(linesRow(), 2, 'under the reply, not at the round');
  const reply = main().children[2];
  assert.ok(
    reply.querySelector('article.message.assistant').compareDocumentPosition(reply.querySelector('.mx-handoff-block')) &
      window.Node.DOCUMENT_POSITION_FOLLOWING
  );
  await show([user('u1', DAY1), handedSent, HANDED_THINKING], false);
  assert.equal(linesRow(), 2, 'under the working row while it runs');
  assert.deepEqual(lines(), [SENT_LINE]);
});

test('work handed to a session: a coding transcript shows the wait on the line and the end as the same card', async (t) => {
  const { show, main, lines, waiting } = await mountHandoff(t);
  await waiting([DEV]);
  await show([user('u1', DAY1), handedSent, handedReplied, handedEnded('b1', 'blocked', 'atask_1')], false);
  assert.deepEqual(lines(), ['Sent to Dev session · Approval needed·Open']);
  assert.equal(main().children[3].childElementCount, 0, 'its wait report draws nothing');
  await waiting([]);
  await show([user('u1', DAY1), handedSent, handedReplied, handedEnded('e', 'completed', 'atask_1')], false);
  assert.deepEqual(lines(), []);
  assert.equal(main().querySelector('.mx-task-card-meta').textContent, 'Session · Completed');
});

test('a bot message shows its name and its words, never the envelope or LEAD, in a coding transcript and in a bot chat', async (t) => {
  const render = rowHarness(t);
  const { wrapAgentMessage } = await import('../shared/core-src/runtime/shared/agent-message-envelope.mjs');
  const text = wrapAgentMessage('Please check the build', { name: 'Marketer', agentId: 'agent-m1' });
  const row = {
    _tag: 'UserMessage',
    key: 'b',
    turnKey: 'b',
    item: { kind: 'user', id: 'b', text, at: DAY1, sender: 'lead', fromAgent: 'agent-m1' },
  };
  const lead = { ...row, key: 'l', item: { ...row.item, id: 'l', fromAgent: undefined, text: 'plain brief' } };
  for (const agentMode of [false, true]) {
    const options = rowOptions(agentMode ? HOME : 'sess_task_1', { agentMode });
    const show = async (rows) => {
      await renderRows(render, options, rows);
      return document.querySelector('main').textContent;
    };
    const shown = await show([row]);
    assert.match(shown, /Please check the build/);
    assert.match(shown, /agent-m1/, `the bot's name labels it (agentMode ${agentMode})`);
    assert.doesNotMatch(shown, /LEAD|agent-message|From another bot/);
    if (!agentMode) assert.match(await show([lead]), /LEAD/, 'a lead brief keeps its label');
  }
});

test("agent chat: an older ask_user left waiting keeps its round content; only the approval's call holds the card", async (t) => {
  const render = rowHarness(t);
  const signIn = {
    kind: 'tool',
    id: 'browser-1',
    name: 'browser',
    args: { action: 'open', url: 'https://example.com' },
    result: 'Saved sign-in: signed in to example.com with its saved login',
    status: 'done',
    at: DAY1,
  };
  const questions = [{ question: 'Which?', header: 'W', options: [{ label: 'A', description: '' }] }];
  const ask = (callId) => ({
    kind: 'tool',
    id: `item-${callId}`,
    callId,
    name: 'ask_user',
    args: { questions },
    result: null,
  });
  const rows = [
    { _tag: 'ToolActivity', key: 'tools-old', turnKey: 's', items: [signIn, ask('call-old')] },
    { _tag: 'ToolActivity', key: 'tools-new', turnKey: 's', items: [ask('call-new')] },
  ];
  const items = rows.flatMap((row) => row.items);
  const options = rowOptions(HOME, {
    snapshot: { sessionId: HOME, toolApproval: { id: 'ap-1', kind: 'question', toolCallId: 'call-new' } },
    settledItems: items,
    questionCard: React.createElement('div', { className: 'stub-question-card' }),
  });
  await renderRows(render, options, rows, { rowAttrs: (row) => ({ 'data-row': row.key }) });
  const row = (key) => document.querySelector(`main [data-row="${key}"]`);
  assert.equal(document.querySelectorAll('main .stub-question-card').length, 1);
  assert.equal(
    row('tools-new').querySelectorAll('.stub-question-card').length,
    1,
    "the card sits at the approval's call"
  );
  assert.equal(
    row('tools-old').querySelectorAll('.transcript-saved-sign-in').length,
    1,
    'the older waiting round keeps its sign-in line'
  );
});
