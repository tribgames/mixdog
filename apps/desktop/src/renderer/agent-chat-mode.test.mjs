// Agent mode (에이전트 모드): which sessions take it, the bubble runs, the
// messenger composer, the phone's no-tab chat slot — and coding mode left as it was.
import assert from 'node:assert/strict';
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
const { roomSessionId } = await import('../../../../src/runtime/agent/orchestrator/session/agent-room.mjs');
const { isAgentChatSession, isDeletedBotSession, publishAgentModeSessions } = await import('./agent-chat-mode.ts');
const { agentChatPlace, routineGroupOf } = await import('./agent-chat-place.ts');
const { AgentChatRow, AgentRoutineBody, AgentRoutineCard } = await import('./agent-chat-row.tsx');
const { routineLoginRequiredText } = await import(
  '../../../../src/runtime/agent/orchestrator/session/routine-result.mjs'
);
const { useConversationRowRenderer } = await import('./use-conversation-row-renderer.ts');
const { transcriptRowVariant } = await import('./transcript-list-estimates.ts');
const { transcriptRowNode } = await import('./conversation-support.tsx');
const { publishAgentRooms } = await import('./agent-room-store.ts');
const { publishSessionGlances } = await import('./session-glance-store.ts');
const { publishCatalogApprovalSessions } = await import('./session-catalog-approvals.ts');
const { Composer } = await import('./Composer.tsx');
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

test('bubble runs: face and name on the first bubble, the time on the last, a day pill per date', () => {
  const rows = [
    user('u1', DAY1),
    reply('a1', DAY1),
    tools,
    reply('a2', DAY1),
    compacted,
    reply('a3', DAY1),
    user('u2', DAY2),
  ];
  const place = (index) => agentChatPlace(rows, index);
  assert.deepEqual(
    rows.map((_, index) => {
      const at = place(index);
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
  // Separate turns join only within one minute: a later message opens its own
  // run (face, name) and the earlier one keeps its own time.
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
  // A room: each member's own run; a pass is a compact row that ends a run.
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

  // Routine results group per routine into one card (success and failure
  // alike); an old result row without the marker stays a bubble.
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

  const member = { id: 'github-watcher', name: 'GitHub 감시', avatar: { kind: 'mascot' } };
  const row = (index) =>
    renderToStaticMarkup(
      React.createElement(AgentChatRow, { place: place(index), member }, React.createElement('p', null, 'body'))
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

  // The card: head (name, status chip, time), older runs folded to a line,
  // the latest's summary, and the foot's actions for its status.
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

test('a bot chat shows a reply whole when complete (dots while it streams); a coding chat still streams', async (t) => {
  const render = rowHarness(t);
  const thinking = { _tag: 'Thinking', key: 'think', turnKey: 't', active: true };
  const tail = (text, streaming) => ({
    ...reply('a2', DAY1),
    live: true,
    item: { kind: 'assistant', id: 'a2', text, streaming, at: DAY1 },
  });
  const show = (sessionId, rows, agentMode) => {
    const options = {
      snapshot: { sessionId, busy: true },
      disclosureScope: sessionId,
      readOnly: true,
      transitioning: false,
      renderAssistantRow: undefined,
      onOpenSettings() {},
      settledItems: [],
      settledTurnKeys: [],
      optimisticActivityStartedAt: DAY1,
      submit: async () => true,
      questionCard: null,
    };
    function Rows() {
      const { renderTranscriptRow } = useConversationRowRenderer({ ...options, agentMode });
      return React.createElement(
        React.Fragment,
        null,
        rows.map((row, index) => React.createElement('div', { key: row.key }, renderTranscriptRow(row, index, rows)))
      );
    }
    return render(React.createElement(Rows));
  };
  const dots = (html) => html.match(/class="mx-chat-dots"/g)?.length ?? 0;
  const bubbles = (html) => html.match(/class="mx-chat-row" data-side="agent"/g)?.length ?? 0;

  // Streaming: one typing bubble in the bot's place, none of the words.
  for (const partial of ['Hel', 'Hello there, how are']) {
    const html = await show(HOME, [user('u1', DAY1), tail(partial, true), thinking], true);
    assert.equal(dots(html), 1, 'the typing indicator');
    assert.equal(bubbles(html), 1, 'in the bot’s bubble position, one bubble');
    assert.doesNotMatch(html, new RegExp(partial));
    assert.match(html, /is typing…/);
  }
  // Complete (the same row, no longer streaming): the whole message, no dots.
  const whole = await show(HOME, [user('u1', DAY1), tail('Hello there, how are you?', false), thinking], true);
  assert.match(whole, /Hello there, how are you\?/);
  assert.equal(dots(whole), 0);
  assert.equal(bubbles(whole), 1);
  // A turn's earlier message stays whole above the next one's typing bubble.
  const first = { ...reply('a1', DAY1), item: { ...reply('a1', DAY1).item, text: 'Checking first', streaming: false } };
  const second = await show(HOME, [user('u1', DAY1), first, tail('Then', true), thinking], true);
  assert.match(second, /Checking first/);
  assert.doesNotMatch(second, />Then</);
  assert.equal(dots(second), 1);
  // A room's chat takes it too.
  const inRoom = await show(ROOM, [user('u1', DAY1), tail('Partial words', true), thinking], true);
  assert.doesNotMatch(inRoom, /Partial words/);
  // Coding mode keeps streaming into its own live bubble, no dots.
  const coding = await show('sess_task_1', [user('u1', DAY1), tail('Hello there, how are', true), thinking], false);
  assert.match(coding, /<article class="message assistant\s+streaming/);
  assert.doesNotMatch(coding, /mx-chat/);
});

test('a bot chat row that shows nothing renders no node, so the list gives it no room or step', async (t) => {
  const render = rowHarness(t);
  const thinking = { _tag: 'Thinking', key: 'think', turnKey: 't', active: true };
  const whole = { ...reply('a1', DAY1), live: true };
  const streaming = { ...reply('a2', DAY1), live: true, item: { ...reply('a2', DAY1).item, streaming: true } };
  const toolRound = {
    _tag: 'ToolActivity',
    key: 'tools',
    turnKey: 't',
    items: [{ kind: 'tool', id: 'tc1', name: 'shell', args: { command: 'ls' }, status: 'done', at: DAY1 }],
  };
  const turnDone = {
    _tag: 'AssistantPart',
    key: 'td',
    turnKey: 't',
    item: { kind: 'turndone', id: 'd2', status: 'done', elapsedMs: 12000 },
  };
  const nodes = (rows) => {
    const out = [];
    function Rows() {
      const { renderTranscriptRow } = useConversationRowRenderer({
        snapshot: { sessionId: HOME, busy: true },
        disclosureScope: HOME,
        readOnly: true,
        transitioning: false,
        renderAssistantRow: undefined,
        onOpenSettings() {},
        settledItems: [],
        settledTurnKeys: [],
        optimisticActivityStartedAt: DAY1,
        submit: async () => true,
        questionCard: null,
        agentMode: true,
      });
      out.length = 0;
      for (const [index, row] of rows.entries()) out.push(renderTranscriptRow(row, index, rows) !== null);
      return null;
    }
    return render(React.createElement(Rows)).then(() => out);
  };
  // The unfinished part and the tool round paint nothing; the band paints the typing bubble.
  assert.deepEqual(await nodes([user('u1', DAY1), streaming, toolRound, thinking]), [true, false, false, true]);
  // Under a whole reply the band shows nothing; a turn status row never shows.
  assert.deepEqual(await nodes([user('u1', DAY1), whole, thinking]), [true, true, false]);
  assert.deepEqual(await nodes([user('u1', DAY1), reply('a1', DAY1), turnDone]), [true, true, false]);
});

test('a task session shows nothing while it starts and one card without file cards once it ends', async (t) => {
  const render = rowHarness(t);
  const task = (id, status, extra = {}) => ({
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
  const files = [
    { name: 'cdp.ts', path: 'src/cdp.ts', id: 'a1' },
    { name: 'big.mp4', path: 'out/big.mp4' },
  ];
  const nodes = [];
  const show = (rows) => {
    function Rows() {
      const { renderTranscriptRow } = useConversationRowRenderer({
        snapshot: { sessionId: HOME },
        disclosureScope: HOME,
        readOnly: true,
        transitioning: false,
        renderAssistantRow: undefined,
        onOpenSettings() {},
        settledItems: [],
        settledTurnKeys: [],
        optimisticActivityStartedAt: 0,
        submit: async () => true,
        questionCard: null,
        agentMode: true,
      });
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
  const host = () => document.querySelector('main');

  // Started: no node at all, so the list gives it no room.
  await show([user('u1', DAY1), task('s', 'started')]);
  assert.deepEqual(nodes, [true, false]);
  assert.equal(host().querySelector('.mx-task-card, .mx-chat-routine-failed'), null);

  // Ended: one card, its status, the changed-file count, no file cards or links.
  for (const [status, label] of [
    ['completed', 'Completed'],
    ['failed', 'Failed'],
    ['cancelled', 'Cancelled'],
  ]) {
    await show([user('u1', DAY1), task(status, status, { files })]);
    const cards = host().querySelectorAll('.mx-task-card');
    assert.equal(cards.length, 1, status);
    assert.equal(cards[0].dataset.status, status);
    assert.equal(cards[0].querySelector('.turn-changes-title strong').textContent, 'Fence fix');
    assert.equal(cards[0].querySelector('.mx-task-card-meta').textContent, `Task session · ${label} · 2 files changed`);
    assert.equal(host().querySelector('.message-attachments, .message-body a'), null, `no files (${status})`);
  }
  // One file reads in the singular.
  await show([user('u1', DAY1), task('single', 'completed', { files: files.slice(0, 1) })]);
  assert.equal(host().querySelector('.mx-task-card-meta').textContent, 'Task session · Completed · 1 file changed');
  // No files: the count is left out.
  await show([user('u1', DAY1), task('plain', 'completed')]);
  assert.equal(host().querySelector('.mx-task-card-meta').textContent, 'Task session · Completed');

  // "Open session" opens the task session.
  const opened = [];
  const listener = (event) => opened.push(event.detail.sessionId);
  const { OPEN_TASK_SESSION_EVENT } = await import('./agent-task-events.ts');
  // The component builds its event with the global CustomEvent: jsdom's here.
  const nodeCustomEvent = globalThis.CustomEvent;
  globalThis.CustomEvent = window.CustomEvent;
  t.after(() => {
    globalThis.CustomEvent = nodeCustomEvent;
  });
  window.addEventListener(OPEN_TASK_SESSION_EVENT, listener);
  t.after(() => window.removeEventListener(OPEN_TASK_SESSION_EVENT, listener));
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

test('agent mode shows no working status: a typing bubble while the agent works, no tool or turn rows', async (t) => {
  const render = rowHarness(t);
  const done = { kind: 'turndone', id: 'd1', status: 'done', elapsedMs: 3000 };
  const finished = { ...reply('a1', DAY1), completion: done };
  const toolRow = {
    _tag: 'ToolActivity',
    key: 'tools',
    turnKey: 't',
    items: [{ kind: 'tool', id: 'tc1', name: 'shell', args: { command: 'ls' }, status: 'done', at: DAY1 }],
  };
  const turnDone = {
    _tag: 'AssistantPart',
    key: 'td',
    turnKey: 't',
    item: { kind: 'turndone', id: 'd2', status: 'done', elapsedMs: 12000 },
  };
  const thinking = { _tag: 'Thinking', key: 'think', turnKey: 't', active: true };
  const live = { ...reply('a2', DAY1), live: true, item: { ...reply('a2', DAY1).item, streaming: true } };
  const show = (sessionId, rows, agentMode = true, settledItems = []) => {
    const options = {
      snapshot: { sessionId, busy: true },
      disclosureScope: sessionId,
      readOnly: true,
      transitioning: false,
      renderAssistantRow: undefined,
      onOpenSettings() {},
      settledItems,
      settledTurnKeys: [],
      optimisticActivityStartedAt: DAY1,
      submit: async () => true,
      questionCard: null,
    };
    function Rows() {
      const { renderTranscriptRow } = useConversationRowRenderer({ ...options, agentMode });
      return React.createElement(
        React.Fragment,
        null,
        rows.map((row, index) => React.createElement('div', { key: row.key }, renderTranscriptRow(row, index, rows)))
      );
    }
    return render(React.createElement(Rows));
  };
  const typingRow = (html) => {
    const host = document.createElement('div');
    host.innerHTML = html;
    return host.querySelector('.mx-chat-typing')?.closest('.mx-chat-row') ?? null;
  };

  // Working after its words: the bubble joins the agent's run.
  const working = await show(HOME, [user('u1', DAY1), finished, toolRow, turnDone, thinking]);
  for (const status of ['tool-activity', 'turn-status', 'response-footer', 'live-activity', 'thinking-status']) {
    assert.doesNotMatch(working, new RegExp(status), status);
  }
  assert.match(working, /role="status" aria-label="github-watcher is typing…"/);
  assert.equal(typingRow(working).querySelector('.mx-chat-face'), null);
  // Right after the user's message: under the agent's face and name.
  const fresh = typingRow(await show(HOME, [user('u1', DAY1), thinking]));
  assert.ok(fresh.querySelector('.mx-chat-face'));
  assert.equal(fresh.querySelector('.mx-chat-name')?.textContent, 'github-watcher');
  assert.equal(fresh.dataset.side, 'agent');
  // While text streams the typing bubble stands for the reply (see the
  // whole-bubble test below); its words stay out.
  const streamingNow = await show(HOME, [user('u1', DAY1), live, thinking]);
  assert.ok(typingRow(streamingNow));
  assert.doesNotMatch(streamingNow, />a2</);
  // A reply part that opened before its first text paints no empty bubble:
  // the typing bubble keeps its place, with the face and name it had.
  const opened = { ...live, item: { ...live.item, text: '' } };
  const beforeText = await show(HOME, [user('u1', DAY1), opened, thinking]);
  assert.equal(beforeText.match(/class="message assistant/g)?.length, 1, 'only the typing bubble');
  assert.ok(typingRow(beforeText).querySelector('.mx-chat-face'));
  assert.equal(typingRow(beforeText).querySelector('.mx-chat-name')?.textContent, 'github-watcher');
  // A room: the band is the typing slot. It paints the member the trailing
  // typing row names (that row opens no row of its own), with face and name.
  const memberTyping = {
    kind: 'notice',
    id: 'ty',
    text: '',
    room: { kind: 'typing', speaker: 'bench', name: 'Bench' },
  };
  const roomRows = [user('u1', DAY1), thinking];
  const room = await show(ROOM, roomRows, true, [user('u1', DAY1).item, memberTyping]);
  assert.equal(room.match(/mx-chat-typing"/g)?.length, 1);
  assert.equal(typingRow(room).querySelector('.mx-chat-name')?.textContent, 'Bench');
  assert.ok(typingRow(room).querySelector('.mx-chat-face'));
  assert.doesNotMatch(room, /agent-room-typing|mx-chat-typing-idle/);
  // Nobody typing: no bubble and no reserved slot.
  const between = await show(ROOM, roomRows, true, [user('u1', DAY1).item]);
  assert.equal(typingRow(between), null);
  assert.doesNotMatch(between, /mx-chat-typing|role="status"/);

  // Coding mode keeps every one of them.
  const coding = await show('sess_task_1', [user('u1', DAY1), finished, toolRow, turnDone], false);
  assert.match(coding, /tool-activity/);
  assert.match(coding, /turn-status/);
  assert.doesNotMatch(coding, /mx-chat/);
});

test('a room shows a typing bubble only while a member types, held until that member’s words land', async (t) => {
  const render = rowHarness(t);
  const thinking = { _tag: 'Thinking', key: 'think', turnKey: 't', active: true };
  const typing = (id, speaker) => ({ kind: 'notice', id, text: '', room: { kind: 'typing', speaker, name: speaker } });
  const prompt = user('u1', DAY1);
  const s1 = speech('s1', 'alpha', DAY1);
  const s2 = speech('s2', 'beta', DAY1);
  const pass = { kind: 'notice', id: 'p1', room: { kind: 'pass', speaker: 'gamma' } };
  function Rows({ settled }) {
    const { renderTranscriptRow } = useConversationRowRenderer({
      snapshot: { sessionId: ROOM, busy: true },
      disclosureScope: ROOM,
      readOnly: true,
      transitioning: false,
      renderAssistantRow: undefined,
      onOpenSettings() {},
      settledItems: settled,
      settledTurnKeys: [],
      optimisticActivityStartedAt: DAY1,
      submit: async () => true,
      questionCard: null,
      agentMode: true,
    });
    const said = [s1, s2].filter((row) => settled.includes(row.item));
    const rows = [prompt, ...said, thinking];
    return React.createElement(
      React.Fragment,
      null,
      rows.map((row, index) => React.createElement('div', { key: row.key }, renderTranscriptRow(row, index, rows)))
    );
  }
  const typer = async (settled) => {
    const host = document.createElement('div');
    host.innerHTML = await render(React.createElement(Rows, { settled }));
    const bubble = host.querySelector('.mx-chat-typing');
    return bubble ? bubble.closest('.mx-chat-row').querySelector('.mx-chat-name')?.textContent : null;
  };
  assert.equal(await typer([prompt.item, typing('ty-a', 'alpha')]), 'alpha');
  // The host drops the typing row while the supervisor decides, before the
  // member's words reach the view: the bubble stays until they land, so the
  // thread does not drop by a bubble and rise again 70ms later.
  assert.equal(await typer([prompt.item]), 'alpha');
  assert.equal(await typer([prompt.item, s1.item]), null, 'the words replace the bubble');
  assert.equal(await typer([prompt.item, s1.item, typing('ty-b', 'beta')]), 'beta');
  // The words land while the typing row is still there: no bubble under them.
  assert.equal(await typer([prompt.item, s1.item, s2.item, typing('ty-b', 'beta')]), null);
  assert.equal(await typer([prompt.item, s1.item, s2.item]), null);
  assert.equal(await typer([prompt.item, s1.item, s2.item, typing('ty-c', 'gamma')]), 'gamma');
  assert.equal(await typer([prompt.item, s1.item, s2.item, pass]), null, 'a pass ends the bubble');
});

test('the typing dots hold still under reduced motion', async () => {
  const { readFile } = await import('node:fs/promises');
  const css = await readFile(new URL('./agent-chat.css', import.meta.url), 'utf8');
  const animated = css.indexOf('animation: mx-chat-typing');
  assert.ok(animated > 0);
  const query = css.lastIndexOf('@media (prefers-reduced-motion: no-preference)', animated);
  assert.ok(
    query > 0 && !css.slice(query, animated).includes('\n}\n'),
    'the dots animate only inside the motion query'
  );
});

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
      if (request.capability === 'skillsStatus') return { value: { skills: [{ name: 'deploy', enabled: true }] } };
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
    await act(async () => {
      const field = input();
      field.focus();
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set.call(field, value);
      field.setSelectionRange(value.length, value.length);
      field.dispatchEvent(new window.Event('input', { bubbles: true }));
      await new Promise((resolve) => window.setTimeout(resolve, 200));
    });
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

test('the agent-mode composer: an editable route under it, `/` and `$` are text, `@` tags a room member', async (t) => {
  publishAgentRooms([
    {
      id: ROOM,
      agentRoom: {
        id: 'release01',
        name: '릴리스 점검',
        members: ['bench', 'release'],
        memberNames: { bench: 'Bench', release: '릴리스 관리' },
        maxRounds: 1,
        maxMessages: 6,
        shareTools: false,
      },
    },
  ]);
  t.after(() => publishAgentRooms([]));
  const calls = [];
  const { host, type, key, render } = await mountComposer(t);
  await render(
    composerProps(calls, {
      agentMode: true,
      modelAside: React.createElement('i', { id: 'gauge' }),
      usageReadout: React.createElement('i', { id: 'readout' }),
    })
  );
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

  await type('/');
  assert.equal(document.getElementById('composer-slash-palette'), null);
  await type('$de');
  assert.equal(document.getElementById('composer-skill-mention-palette'), null);
  await type('/model');
  await key('Enter');
  assert.deepEqual(calls.map(textOf), ['/model'], 'a slash line goes out as typed');

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

  // ↑/↓ move the highlight through the candidates; Enter tags the highlighted one.
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

  // A bot's 1:1 chat keeps its model control and context gauge, and its `@` opens nothing (yet).
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
  const publish = (members) =>
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
  publish(['bench', 'release']);
  t.after(() => publishAgentRooms([]));
  const calls = [];
  const { host, type, key, render } = await mountComposer(t);
  await render(composerProps(calls, { agentMode: true }));
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
  publish(['bench']);
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
  publishAgentRooms([
    {
      id: ROOM,
      agentRoom: {
        id: 'release01',
        name: '릴리스 점검',
        members: ['bench', 'release'],
        memberNames: { bench: 'Bench', release: '릴리스 관리' },
        maxRounds: 1,
        maxMessages: 6,
        shareTools: false,
      },
    },
  ]);
  t.after(() => publishAgentRooms([]));
  const calls = [];
  const { host, type, key, render } = await mountComposer(t);
  await render(composerProps(calls, { agentMode: true }));
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

test('a visualize open leaves one card at turn end, above the changed-files line; an earlier card opens its own version', async (t) => {
  const { resyncVisualizeStates } = await import('./visualize-store.ts');
  const { TurnChangesContext } = await import('./TurnChangesCard.tsx');
  const { resetTurnChangesCache } = await import('./turn-changes-model.ts');
  const render = rowHarness(t);
  const SESSION = 'sess_home_lead';
  const commands = [];
  // The turn's changed files (the visualized `site/a.html` is not one of them
  // until the last check: a visualized file shows as its card, not a diff).
  let changedPaths = ['src/b.ts'];
  // The card's own picture reads (`thumbnail`) are not what is checked here.
  const sent = {
    get length() {
      return commands.length;
    },
    set length(value) {
      commands.length = value;
    },
    map: (fn) => commands.filter((command) => command.action !== 'thumbnail').map(fn),
  };
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
        // The picture its last turn's end took, of its newest version.
        ...(newest > 1 ? { thumbnail: 'data:image/png;base64,VjI=', thumbnailVersion: newest } : {}),
      },
    ],
  });
  const show = (rows, agentMode = true) => {
    const options = {
      snapshot: { sessionId: SESSION },
      disclosureScope: SESSION,
      readOnly: false,
      transitioning: false,
      renderAssistantRow: undefined,
      onOpenSettings() {},
      settledItems: [],
      settledTurnKeys: [],
      optimisticActivityStartedAt: 0,
      submit: async () => true,
      questionCard: null,
    };
    function Rows() {
      const { renderTranscriptRow } = useConversationRowRenderer({ ...options, agentMode });
      return React.createElement(
        TurnChangesContext.Provider,
        {
          value: {
            sessionId: SESSION,
            busy: false,
            turnRunning: false,
            onOpenSessionDiff() {},
            onOpenFile() {},
          },
        },
        rows.map((row, index) => React.createElement('div', { key: row.key }, renderTranscriptRow(row, index, rows)))
      );
    }
    return render(React.createElement(Rows));
  };
  const host = () => document.querySelector('main');
  const cards = () => [...host().querySelectorAll('.transcript-visualize-tile')];
  const turnCards = () => [...host().querySelectorAll('.transcript-visualize-turn[data-artifact="visualize"]')];

  resyncVisualizeStates([tabAt(1)]);
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

  // A later turn opens the tab again (v2): two cards, the earlier on v1;
  // a turn's cards close it, under its reply and above its changed files.
  resyncVisualizeStates([tabAt(2)]);
  const answer = {
    ...reply('a9', DAY1),
    turnKey: 'f',
    turnChanges: { checkpointId: 'cp', boundary: 'done-f', trailing: false },
  };
  await show([user('u1', DAY1), open('e', 100), user('u2', DAY1), open('f', 200), answer]);
  await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
  const rows = [...host().querySelectorAll('.mx-chat-row')];
  const changes = host().querySelector('.turn-changes-card');
  assert.ok(changes, 'coding mode’s changed-files card');
  assert.ok(changes.closest('.mx-chat-row[data-side="aside"]'), 'in the bubble column, out of the bubble');
  assert.ok(changes.querySelector('.turn-changes-view'), 'with its own actions');
  assert.ok(rows.at(-1).contains(changes), 'the changed-files card closes the turn');
  assert.ok(rows.at(-2).contains(cards()[1]), 'the visualize card sits right above it');
  assert.equal(turnCards().length, 2, 'one card per turn');
  assert.equal(rows.at(-3)?.dataset.side, 'agent', 'both under the reply');
  assert.equal(cards()[0].querySelector('.transcript-visualize-badge.is-version').textContent, 'Version 1');
  assert.equal(cards()[0].querySelector('.transcript-visualize-status'), null, 'no status words, only the version');
  assert.equal(cards()[0].getAttribute('aria-label'), `${cards()[0].querySelector('b').textContent}, Version 1`);
  // Each card on its own version's picture: the newest from the tab, the
  // earlier one kept by the host for version 1 (never the tab's v2 picture).
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
  sent.length = 0;
  await act(async () => cards()[0].click());
  assert.deepEqual(
    sent.map((command) => [command.action, command.tabId, command.version]),
    [
      ['activate', 'v1', undefined],
      ['version', 'v1', 1],
    ]
  );
  sent.length = 0;
  await act(async () => cards()[1].click());
  assert.deepEqual(
    sent.map((command) => command.action),
    ['activate'],
    'the newest card shows live'
  );

  // Coding mode seats the same turn-end card (not compact), outside the tool group.
  await show([user('u1', DAY1), open('g', 300)], false);
  assert.equal(host().querySelector('.is-compact'), null);
  assert.ok(host().querySelector('.transcript-visualize-turn'));
  assert.equal(host().querySelector('.tool-activity .transcript-visualize-tile'), null);

  // No card while the turn runs, in either mode: not under its live band
  // (thinking), not under a streaming reply.
  const thinking = { _tag: 'Thinking', key: 'th', turnKey: 'f', active: true };
  const streaming = { ...reply('live', DAY1), turnKey: 'f', active: true, live: true };
  for (const agentMode of [true, false]) {
    await show([user('u1', DAY1), open('f', 200), thinking], agentMode);
    assert.equal(cards().length, 0, `no card while thinking (agentMode ${agentMode})`);
    await show([user('u1', DAY1), open('f', 200), streaming], agentMode);
    assert.equal(cards().length, 0, `no card while streaming (agentMode ${agentMode})`);
  }

  // Coding mode: reply → visualize card → changes card, by document order.
  const follows = (a, b) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
  await show([user('u1', DAY1), open('f', 200), answer], false);
  assert.equal(cards().length, 1);
  const replyText = [...host().querySelectorAll('*')].find(
    (node) => node.children.length === 0 && node.textContent === 'a9'
  );
  const codingChanges = host().querySelector('.turn-changes-card');
  assert.ok(replyText && codingChanges);
  assert.ok(follows(replyText, cards()[0]), 'the card follows the reply');
  assert.ok(follows(cards()[0], codingChanges), 'the changes card follows the card');

  // An error that ends the turn: its card also sits above the changed files.
  const failed = {
    _tag: 'Error',
    key: 'err',
    turnKey: 'f',
    item: { kind: 'error', id: 'err', text: 'boom', at: DAY1 },
    failures: [],
    turnChanges: { checkpointId: 'cp', boundary: 'done-f', trailing: false },
  };
  for (const agentMode of [true, false]) {
    await show([user('u1', DAY1), open('f', 200), failed], agentMode);
    assert.equal(cards().length, 1, `one card (agentMode ${agentMode})`);
    const errorChanges = host().querySelector('.turn-changes-card');
    assert.ok(errorChanges, `changes card (agentMode ${agentMode})`);
    assert.ok(follows(cards()[0], errorChanges), `card above the changes (agentMode ${agentMode})`);
  }

  // The changed file is the one the turn visualized: its card stands in for
  // the diff, so no changes card (either mode), and the card carries the Undo.
  changedPaths = ['site/a.html'];
  resetTurnChangesCache();
  for (const agentMode of [true, false]) {
    await show([user('u1', DAY1), open('f', 200), answer], agentMode);
    await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
    assert.equal(cards().length, 1, `the visualize card stays (agentMode ${agentMode})`);
    assert.equal(host().querySelector('.turn-changes-card'), null, `no changes card (agentMode ${agentMode})`);
    assert.equal(
      turnCards()[0].querySelector('.turn-changes-action')?.textContent,
      'Undo',
      `Undo on the card (agentMode ${agentMode})`
    );
  }
  // Another file changed too: the changes card lists only that one, and Undo stays there.
  changedPaths = ['site/a.html', 'src/b.ts'];
  resetTurnChangesCache();
  await show([user('u1', DAY1), open('f', 200), answer], false);
  await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
  assert.deepEqual(
    [...host().querySelectorAll('.turn-changes-base')].map((node) => node.textContent),
    ['b.ts']
  );
  assert.equal(turnCards()[0].querySelector('.turn-changes-action'), null);
  assert.ok(host().querySelector('.turn-changes-card .turn-changes-action'));
});

test('a visualize card follows the whole reply: text before the call, the call, text after it (coding and agent mode)', async (t) => {
  const { resyncVisualizeStates } = await import('./visualize-store.ts');
  const render = rowHarness(t);
  const SESSION = 'sess_home_lead';
  const previous = window.mixdogDesktop;
  window.mixdogDesktop = { ...previous, visualizeCommand: async () => undefined };
  t.after(() => {
    window.mixdogDesktop = previous;
    resyncVisualizeStates([]);
  });
  resyncVisualizeStates([
    {
      sessionId: SESSION,
      active: 'v1',
      tabs: [{ id: 'v1', label: 'Flow', revision: 1, panes: [{ target: 'a.html' }], versions: [{ n: 1 }] }],
    },
  ]);
  const turn = (item) => ({ ...item, turnKey: 'f' });
  const open = {
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
  const before = turn(reply('before-text', DAY1));
  const after = turn(reply('after-text', DAY1));
  const follows = (a, b) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
  const show = async (rows, agentMode) => {
    const options = {
      snapshot: { sessionId: SESSION },
      disclosureScope: SESSION,
      readOnly: false,
      transitioning: false,
      renderAssistantRow: undefined,
      onOpenSettings() {},
      settledItems: [],
      settledTurnKeys: [],
      optimisticActivityStartedAt: 0,
      submit: async () => true,
      questionCard: null,
    };
    function Rows() {
      const { renderTranscriptRow } = useConversationRowRenderer({ ...options, agentMode });
      return React.createElement(
        'div',
        null,
        rows.map((row, index) => React.createElement('div', { key: row.key }, renderTranscriptRow(row, index, rows)))
      );
    }
    await render(React.createElement(Rows));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
  };
  const textNode = (label) =>
    [...document.querySelectorAll('main *')].find((node) => node.children.length === 0 && node.textContent === label);
  for (const agentMode of [false, true]) {
    await show([user('u1', DAY1), before, open, after], agentMode);
    const card = document.querySelector('main .transcript-visualize-turn');
    assert.ok(card, `the card is drawn (agentMode ${agentMode})`);
    assert.ok(
      follows(textNode('before-text'), card),
      `the card follows the text before the call (agentMode ${agentMode})`
    );
    assert.ok(
      follows(textNode('after-text'), card),
      `the card follows the text after the call (agentMode ${agentMode})`
    );
    // The call is the last row of the turn: the card closes it, under the earlier text.
    await show([user('u1', DAY1), before, open], agentMode);
    const closing = document.querySelector('main .transcript-visualize-turn');
    assert.ok(closing, `a turn ending on the call still draws it (agentMode ${agentMode})`);
    assert.ok(follows(textNode('before-text'), closing), `under the text before the call (agentMode ${agentMode})`);
    // While the reply after the call streams, no card shows above or beside it.
    await show([user('u1', DAY1), before, open, { ...after, active: true, live: true }], agentMode);
    assert.equal(
      document.querySelectorAll('main .transcript-visualize-turn').length,
      0,
      `none while streaming (agentMode ${agentMode})`
    );
  }
});

test('a turn leaves ONE visualize card: a tile per distinct tab on its final version, Show all brings them all up, the first last', async (t) => {
  const { resyncVisualizeStates, setVisualizePanelOnScreen } = await import('./visualize-store.ts');
  const render = rowHarness(t);
  const SESSION = 'sess_home_lead_turncard';
  // The panel is open on screen: its active tab's tile is outlined.
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
  // v1 is shown in the panel (and has a page problem); v2 is open behind it; v3 was closed.
  const seed = () =>
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
      // The same tab opened again later in the turn: still one tile.
      items: [call('c3', 'a.html', 'v1', 'Login', 120), call('c4', 'c.html', 'v3', 'Closed one', 130)],
    },
    { ...reply('done', DAY1), turnKey: 'f' },
  ];
  for (const agentMode of [false, true]) {
    seed();
    commands.length = 0;
    const options = {
      snapshot: { sessionId: SESSION },
      disclosureScope: SESSION,
      readOnly: false,
      transitioning: false,
      renderAssistantRow: undefined,
      onOpenSettings() {},
      settledItems: [],
      settledTurnKeys: [],
      optimisticActivityStartedAt: 0,
      submit: async () => true,
      questionCard: null,
    };
    function Rows() {
      const { renderTranscriptRow } = useConversationRowRenderer({ ...options, agentMode });
      return React.createElement(
        'div',
        null,
        rows.map((row, index) => React.createElement('div', { key: row.key }, renderTranscriptRow(row, index, rows)))
      );
    }
    await render(React.createElement(Rows));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
    const cards = [...document.querySelectorAll('main .transcript-visualize-turn')];
    assert.equal(cards.length, 1, `one card for the turn (agentMode ${agentMode})`);
    assert.equal(cards[0].classList.contains('is-compact'), agentMode);
    assert.equal(cards[0].querySelector('.transcript-visualize-title').textContent, 'Previews 3');
    const tiles = [...cards[0].querySelectorAll('.transcript-visualize-tile')];
    assert.deepEqual(
      tiles.map((tile) => tile.dataset.visualizeTab),
      ['v2', 'v1', 'v3'],
      'a tile per tab; the reopened one counted once'
    );
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
    // A tile reveals its own tab; a closed one opens again.
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
    // Show all: every tab comes up, the first tile's tab shown last.
    commands.length = 0;
    await act(async () => cards[0].querySelector('.transcript-visualize-all').click());
    assert.deepEqual(
      commands.map((command) => [command.action, command.tabId]),
      [
        ['reopen', 'v3'],
        ['activate', 'v1'],
        ['activate', 'v2'],
      ]
    );
  }
});

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
  const options = {
    snapshot: { sessionId: HOME },
    disclosureScope: HOME,
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
  };
  const show = async (rows) => {
    function Rows() {
      const { renderTranscriptRow } = useConversationRowRenderer(options);
      return React.createElement(
        React.Fragment,
        null,
        rows.map((row, index) => React.createElement('div', { key: row.key }, renderTranscriptRow(row, index, rows)))
      );
    }
    return render(React.createElement(Rows));
  };
  const cards = () => document.querySelectorAll('main [data-connector-card="gmail"]').length;
  await show([{ ...user('c', DAY1), turnKey: 'c' }, round([connect('s1')])]);
  assert.equal(cards(), 1, 'a connect-only round shows its card');
  await show([{ ...user('c', DAY1), turnKey: 'c' }, round([ask, connect('s1')])]);
  assert.equal(cards(), 1, 'the card is not dropped when an answered question shares the round');
});

test('bot-to-bot messages: the receiver shows the sending bot, the sender a "sent to" line, the reply the answering bot', async (t) => {
  const render = rowHarness(t);
  const MARKETER = 'agent-12c3dee5bf';
  const CLERK_HOME = 'sess_home_agent-a70d746b04';
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
  // B: placement. A bot message is the bot's own run on the agent side; a lead
  // brief without fromAgent and the user's message keep their sides.
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
  // D: a completed reply of a bot's home session is its card like any
  // session's (an aside row), and a start paints nothing (no place at all).
  const taskReply = (id, routine) => ({
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
  const replies = [
    taskReply('r1', {
      status: 'completed',
      summary: 'Got it',
      agentId: MARKETER,
      target: 'session',
      sessionId: CLERK_HOME,
    }),
    taskReply('r2', { status: 'started', summary: '', agentId: MARKETER, target: 'session' }),
    taskReply('r3', { status: 'completed', summary: 'Plain', target: 'session' }),
  ];
  assert.deepEqual(
    replies
      .map((_, index) => agentChatPlace(replies, index))
      .map((place) => place && [place.side, place.speaker, Boolean(place.bot)]),
    [['aside', '', false], null, ['aside', '', false]]
  );
  const send = (id, extra = {}) => ({
    kind: 'tool',
    id,
    name: 'session',
    args: { action: 'send', session_id: CLERK_HOME, prompt: 'Please watch the mailbox', ...extra },
    result: '{"sessionId":"x","accepted":true,"reportsBack":true}',
    status: 'done',
    startedAt: DAY1,
  });
  const ask = {
    kind: 'tool',
    id: 'q1',
    name: 'ask_user',
    args: { questions: [{ question: 'Which?', header: 'H', options: [{ label: 'A' }] }] },
    result: 'User has answered your questions: "Which?"="A".',
    status: 'done',
    at: DAY1,
  };
  const round = (items) => ({ _tag: 'ToolActivity', key: 'tools', turnKey: 's', items });
  const options = {
    snapshot: { sessionId: HOME },
    disclosureScope: HOME,
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
  };
  const show = async (list, agentMode = true) => {
    function Rows() {
      const { renderTranscriptRow } = useConversationRowRenderer({ ...options, agentMode });
      return React.createElement(
        React.Fragment,
        null,
        list.map((row, index) => React.createElement('div', { key: row.key }, renderTranscriptRow(row, index, list)))
      );
    }
    await render(React.createElement(Rows));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
  };
  const opened = [];
  const onOpen = (event) => opened.push(event.detail.sessionId);
  const NodeCustomEvent = globalThis.CustomEvent;
  globalThis.CustomEvent = window.CustomEvent;
  window.addEventListener('mixdog:open-task-session', onOpen);
  t.after(() => {
    globalThis.CustomEvent = NodeCustomEvent;
    window.removeEventListener('mixdog:open-task-session', onOpen);
  });

  await show(rows.slice(0, 1));
  const main = () => document.querySelector('main');
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

  // Another bot's words are one folded line: the start of the text, the words behind the disclosure.
  assert.equal(main().querySelector('.mx-bot-fold-body'), null, 'a bot message is folded by default');
  await act(async () => main().querySelector('.mx-bot-fold-pill .mx-routine-more').click());
  assert.match(main().querySelector('.mx-bot-fold-body').textContent, /Hello from the marketer/);

  // The bot's answer is the session completion card under that bot's face
  // and name; its words open in place, "Open session" opens its chat.
  await show(replies.slice(0, 1));
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
  assert.equal(opened.at(-1), replies[0].item.routine.sessionId);

  // C: the send is one hand-off line naming the recipient bot with its face;
  // no disclosure of the message, Open opens that bot's chat.
  for (const items of [[send('s1')], [ask, send('s1')]]) {
    await show([round(items)]);
    const line = main().querySelector('.mx-handoff-line');
    assert.ok(line, 'the sent line is drawn');
    assert.ok(line.querySelector('.mx-bot-sent-face'), 'the bot’s face');
    assert.match(line.textContent, /Sent to agent-a70d746b04 · Working/);
    assert.equal(main().querySelector('.mx-handoff-line .mx-routine-more'), null, 'no message disclosure');
    await act(async () => line.querySelector('button').click());
    assert.equal(opened.at(-1), CLERK_HOME);
  }
  // The send sits under the sending bot's reply bubble, in its group, never above the name.
  const replyRow = {
    _tag: 'AssistantPart',
    key: 'a1',
    turnKey: 's',
    item: { kind: 'assistant', id: 'a1', text: 'Handed it over', at: DAY1 },
  };
  await show([round([send('s1')]), replyRow]);
  const group = main().querySelector('.mx-chat-row[data-side="agent"]');
  assert.ok(group.querySelector('.mx-chat-column > .mx-handoff-block'), 'inside the reply column');
  const nodes = [...group.querySelectorAll('.mx-chat-name, .mx-chat-line, .mx-handoff-block')];
  const order = (selector) => nodes.findIndex((n) => n.matches(selector));
  assert.ok(order('.mx-chat-line') < order('.mx-handoff-block'), 'after the bubble');
  assert.equal(main().querySelectorAll('.mx-handoff-line').length, 1);

  // Not a send: no line.
  await show([round([send('s3', { action: 'read' })])]);
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
  const options = {
    snapshot: { sessionId: HOME },
    disclosureScope: HOME,
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
  };
  const show = async (rows) => {
    function Rows() {
      const { renderTranscriptRow } = useConversationRowRenderer(options);
      return React.createElement(
        React.Fragment,
        null,
        rows.map((row, index) => React.createElement('div', { key: row.key }, renderTranscriptRow(row, index, rows)))
      );
    }
    await render(React.createElement(Rows));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
  };
  // Which sends still show their line, in order.
  const open = () => [...document.querySelectorAll('main .mx-handoff-line')].map((line) => line.textContent);

  // Two sends to one session in a round: each its own line.
  await show([round('r1', [send('a', DEV, 'atask_1'), send('b', DEV, 'atask_2')])]);
  assert.equal(open().length, 2);
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
  const options = {
    snapshot: { sessionId: HOME },
    disclosureScope: HOME,
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
  };
  const sentLines = async (item) => {
    const rows = [round([item])];
    function Rows() {
      const { renderTranscriptRow } = useConversationRowRenderer(options);
      return React.createElement(
        React.Fragment,
        null,
        rows.map((row, index) => React.createElement('div', { key: row.key }, renderTranscriptRow(row, index, rows)))
      );
    }
    await render(React.createElement(Rows));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
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

test('work handed to a session: one block of lines under the turn’s reply, its live state, then the report card', async (t) => {
  const render = rowHarness(t);
  const DEV = 'sess_dev_1';
  const TASK = 'sess_daemon_7_task';
  const CLERK_HOME = 'sess_home_agent-a70d746b04';
  const call = (id, args, result) => ({
    kind: 'tool',
    id,
    name: 'session',
    args,
    result: JSON.stringify(result),
    status: 'done',
    startedAt: DAY1,
  });
  const send = (id, sendId, result = {}, sessionId = DEV) =>
    call(
      id,
      { action: 'send', session_id: sessionId, prompt: `prompt ${id}` },
      { sessionId, accepted: true, sendId, reportsBack: true, hop: 1, ...result }
    );
  const create = (id, args = {}) =>
    call(
      id,
      { action: 'create', title: 'Fence fix', brief: 'Fix the fence', ...args },
      { session_id: TASK, status: 'started', title: 'Fence fix', project: null }
    );
  const round = (key, items) => ({ _tag: 'ToolActivity', key, turnKey: 't1', items });
  const report = (key, routine) => ({
    _tag: 'AssistantPart',
    key,
    turnKey: key,
    item: { kind: 'notice', id: key, text: '🛠 x', at: DAY1, routine: { kind: 'task', summary: 'done', ...routine } },
  });
  const ended = (key, status, sendId) =>
    report(key, { name: 'Dev session', status, sessionId: DEV, target: 'session', hop: 1, sendId });
  const taskEnded = (key, status) => report(key, { name: 'Fence fix', status, sessionId: TASK, sendId: 'atask_9' });
  const taskWait = (key) => report(key, { name: 'Fence fix', status: 'blocked', summary: '', sessionId: TASK });
  const started = report('started', { name: 'Fence fix', status: 'started', summary: '', sessionId: TASK });
  const thinking = { _tag: 'Thinking', key: 'think', turnKey: 't1', active: true };
  // The reply part while it streams: the same item id, so the same row key,
  // as the settled reply below (transcript-rows.ts transcriptRowKey).
  const streaming = {
    _tag: 'AssistantPart',
    key: 'a1',
    turnKey: 't1',
    live: true,
    active: true,
    item: { kind: 'assistant', id: 'a1', text: 'Sent i', streaming: true, at: DAY1 },
  };
  const landed = { ...streaming, item: { ...streaming.item, text: 'Handed it over', streaming: false } };
  const replied = {
    _tag: 'AssistantPart',
    key: 'a1',
    turnKey: 't1',
    item: { kind: 'assistant', id: 'a1', text: 'Handed it over', at: DAY1 },
  };
  const options = {
    snapshot: { sessionId: HOME, busy: true },
    disclosureScope: HOME,
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
  };
  const show = async (rows, agentMode = true) => {
    function Rows() {
      const { renderTranscriptRow } = useConversationRowRenderer({ ...options, agentMode });
      return React.createElement(
        React.Fragment,
        null,
        rows.map((row, index) => React.createElement('div', { key: row.key }, renderTranscriptRow(row, index, rows)))
      );
    }
    await render(React.createElement(Rows));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
  };
  const main = () => document.querySelector('main');
  const lines = () => [...main().querySelectorAll('.mx-handoff-line')].map((line) => line.textContent);
  // What the renderer returns for `rows[index]` (null: no node, no room).
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
  // The row (by its position in `rows`) whose node holds the lines.
  const linesRow = () => [...main().children].findIndex((node) => node.querySelector('.mx-handoff-line'));
  const waiting = (ids) =>
    act(async () => publishCatalogApprovalSessions(ids.map((id) => ({ id, awaitingApproval: true }))));
  const opened = [];
  const onOpen = (event) => opened.push(event.detail.sessionId);
  const NodeCustomEvent = globalThis.CustomEvent;
  globalThis.CustomEvent = window.CustomEvent;
  window.addEventListener('mixdog:open-task-session', onOpen);
  t.after(() => {
    globalThis.CustomEvent = NodeCustomEvent;
    window.removeEventListener('mixdog:open-task-session', onOpen);
    publishSessionGlances([]);
    publishCatalogApprovalSessions([]);
  });
  await act(async () => publishSessionGlances([{ id: DEV, title: 'Dev session', preview: '', working: true }]));
  const SENT = 'Sent to Dev session · Working·Open';

  // (1) While the turn runs the block stands under the typing bubble, in the
  // bot's run; once the reply lands, under the reply bubble and its time.
  // The round itself draws nothing.
  const sent = round('r1', [send('s1', 'atask_1')]);
  for (const rest of [[thinking], [streaming, thinking]]) {
    await show([user('u1', DAY1), sent, ...rest]);
    assert.deepEqual(lines(), [SENT], `${rest.map((row) => row.key)}`);
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
  await show([user('u1', DAY1), sent, replied]);
  assert.deepEqual(lines(), [SENT]);
  assert.equal(linesRow(), 2, 'at the reply');
  const run = main().querySelector('.mx-chat-row[data-side="agent"]');
  const column = [...run.querySelector('.mx-chat-column').children];
  const at = (selector) => column.findIndex((node) => node.matches(selector));
  assert.match(run.querySelector('.mx-chat-line').textContent, /Handed it over/);
  assert.ok(at('.mx-chat-time') < at('.mx-handoff-block'), 'below the bubble and its time');
  assert.equal(main().querySelector('.mx-bot-sent, .mx-routine-more'), null, 'no pill, no message disclosure');
  await act(async () => main().querySelector('.mx-handoff-line button').click());
  assert.equal(opened.at(-1), DEV);
  // One carrier row from streaming through the turn's end: the reply part's
  // row (one key, one variant) carries the block while it streams, once it
  // is whole and after it settles; the band carries nothing then.
  const carriers = [];
  for (const rest of [[streaming, thinking], [landed, thinking], [replied]]) {
    const rows = [user('u1', DAY1), sent, ...rest];
    await show(rows);
    const at = linesRow();
    carriers.push([rows[at].key, transcriptRowVariant(rows, at, new Set())]);
    assert.equal(
      rows.filter((_, index) => transcriptRowVariant(rows, index, new Set()).startsWith('lines')).length,
      1,
      'one carrier'
    );
    assert.deepEqual(lines(), [SENT]);
  }
  assert.deepEqual(carriers, [
    ['a1', 'lines:1'],
    ['a1', 'lines:1'],
    ['a1', 'lines:1'],
  ]);
  // A turn with no reply keeps the line at its own round.
  await show([user('u1', DAY1), sent]);
  assert.deepEqual(lines(), [SENT]);
  assert.equal(linesRow(), 1);
  // One block per turn, a line per piece of work in call order.
  await show([user('u1', DAY1), sent, round('r3', [create('c1')]), replied]);
  assert.deepEqual(lines(), [SENT, 'Fence fix · Working·Open']);
  assert.equal(main().querySelectorAll('.mx-handoff-block').length, 1);
  // The title is the session's current one.
  await act(async () => publishSessionGlances([{ id: DEV, title: 'Renamed', preview: '', working: true }]));
  await show([user('u1', DAY1), sent, replied]);
  assert.deepEqual(lines(), ['Sent to Renamed · Working·Open']);
  await act(async () => publishSessionGlances([{ id: DEV, title: 'Dev session', preview: '', working: true }]));

  // (2) The session waits for the user's approval: the same line reads so
  // (amber), and back once approved, with no row of its own.
  const rows = [user('u1', DAY1), sent, replied];
  await show(rows);
  const nodes = main().querySelectorAll('.mx-chat-row').length;
  await waiting([DEV]);
  assert.deepEqual(lines(), ['Sent to Dev session · Approval needed·Open']);
  assert.equal(main().querySelector('.mx-handoff-line').dataset.state, 'approval');
  assert.equal(main().querySelectorAll('.mx-chat-row').length, nodes, 'no new row');
  await waiting([]);
  assert.deepEqual(lines(), [SENT]);
  assert.equal(main().querySelector('.mx-handoff-line').dataset.state, 'working');
  // A question for the user (its open lane asks) reads as an answer wait, as the list says.
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
    assert.deepEqual(lines(), [SENT]);
  } finally {
    await act(async () => defaultSessionLaneStore.clear());
  }

  // (3) Its wait reports draw nothing while the line carries the state: two
  // of them still leave one line, and no other.
  await waiting([DEV]);
  await show([...rows, ended('b1', 'blocked', 'atask_1'), ended('b2', 'blocked', 'atask_1')]);
  assert.equal(main().querySelectorAll('.mx-chat-routine-failed').length, 1, 'one line for the session');
  assert.equal(main().children[3].childElementCount + main().children[4].childElementCount, 0);
  await waiting([]);

  // (4) A wait with no hand-off line here (older history): one named line on
  // its latest report, only while the session still waits.
  const older = [user('u1', DAY1), replied, taskWait('w1'), taskWait('w2')];
  await waiting([TASK]);
  await show(older);
  assert.deepEqual(lines(), ['Fence fix · Approval needed·Open']);
  assert.equal(linesRow(), 3, 'on the latest wait');
  await waiting([]);
  assert.deepEqual(lines(), [], 'gone once the session no longer waits');
  // The row then renders no node at all, and its height variant says so:
  // the variant changes exactly when the line comes or goes.
  assert.equal(await nodeOf(older, 3), null);
  assert.equal(transcriptRowVariant(older, 3, new Set()), 'hidden');
  await waiting([TASK]);
  assert.notEqual(await nodeOf(older, 3), null);
  assert.equal(transcriptRowVariant(older, 3, new Set([TASK])), '');
  await waiting([]);
  // A wait the session's later end closed paints nothing at all (no node).
  await waiting([TASK]);
  await show([...older, taskEnded('done', 'completed')]);
  assert.deepEqual(lines(), []);
  assert.equal(main().children[2].childElementCount + main().children[3].childElementCount, 0);
  await waiting([]);

  // (5) Its terminal report: the line gone, the session card, no folded answer.
  for (const [status, label] of [
    ['completed', 'Completed'],
    ['failed', 'Failed'],
    ['cancelled', 'Cancelled'],
  ]) {
    await show([...rows, ended('e', status, 'atask_1')]);
    assert.deepEqual(lines(), [], status);
    const cards = main().querySelectorAll('.mx-task-card');
    assert.equal(cards.length, 1, status);
    assert.equal(cards[0].dataset.status, status);
    assert.equal(cards[0].querySelector('.turn-changes-title strong').textContent, 'Dev session');
    assert.equal(cards[0].querySelector('.mx-task-card-meta').textContent, `Session · ${label}`);
    assert.equal(main().querySelector('.mx-bot-fold'), null, status);
  }
  // A start, a wait and another send's end leave it; a send reporting nothing back draws none.
  await show([...rows, ended('o', 'completed', 'atask_other')]);
  assert.equal(lines().length, 1);
  await show([user('u1', DAY1), round('r2', [send('s2', '', { reportsBack: false })]), replied]);
  assert.deepEqual(lines(), []);

  // (6) A created task session: its name alone, the stored start paints
  // nothing; its end is the task card.
  const made = round('r3', [create('c1')]);
  for (const rest of [[thinking], [replied], [replied, started]]) {
    await show([user('u1', DAY1), made, ...rest]);
    assert.deepEqual(lines(), ['Fence fix · Working·Open'], `${rest.map((row) => row.key)}`);
    assert.equal(main().querySelector('.mx-task-card'), null);
  }
  await act(async () => main().querySelector('.mx-handoff-line button').click());
  assert.equal(opened.at(-1), TASK);
  await show([user('u1', DAY1), made, replied, started, taskEnded('done', 'completed')]);
  assert.deepEqual(lines(), []);
  assert.equal(main().querySelector('.mx-task-card-meta').textContent, 'Task session · Completed');
  await show([user('u1', DAY1), round('r4', [create('c2', { notify: false })]), replied]);
  assert.deepEqual(lines(), []);

  // (7) Another bot's chat: its face and name; its answer is the same
  // completion card under that bot's face and name, the line gone.
  const toBot = round('r5', [send('s5', 'atask_5', {}, CLERK_HOME)]);
  await show([user('u1', DAY1), toBot, replied]);
  assert.deepEqual(lines(), ['Sent to agent-a70d746b04 · Working·Open']);
  assert.ok(main().querySelector('.mx-handoff-line .mx-bot-sent-face'));
  const botAnswer = report('ba', {
    name: 'Clerk',
    status: 'completed',
    summary: 'Mailbox watched',
    sessionId: CLERK_HOME,
    agentId: 'agent-a70d746b04',
    target: 'session',
    sendId: 'atask_5',
  });
  await show([user('u1', DAY1), toBot, replied, botAnswer]);
  assert.deepEqual(lines(), []);
  assert.equal(main().querySelector('.mx-bot-fold'), null, 'no folded bot bubble');
  const botCard = main().querySelector('.mx-task-card');
  assert.equal(botCard.querySelector('.turn-changes-title strong').textContent, 'agent-a70d746b04');
  assert.ok(botCard.querySelector('.mx-task-card-face'));
  assert.equal(botCard.querySelector('.mx-task-card-meta').textContent, 'Session · Completed');
  await act(async () => botCard.querySelector('.mx-routine-more').click());
  assert.match(botCard.querySelector('.mx-task-card-answer').textContent, /Mailbox watched/);
  // Its wait with no line here names the bot with its face, not "Session · …".
  await waiting([CLERK_HOME]);
  await show([
    user('u1', DAY1),
    report('bw', {
      name: 'x',
      status: 'blocked',
      sessionId: CLERK_HOME,
      agentId: 'agent-a70d746b04',
      target: 'session',
    }),
  ]);
  assert.deepEqual(lines(), ['agent-a70d746b04 · Approval needed·Open']);
  assert.ok(main().querySelector('.mx-handoff-line .mx-bot-sent-face'));
  await waiting([]);

  // (8) A coding transcript: the same block under the turn's reply, the same card.
  await show([user('u1', DAY1), sent, replied], false);
  assert.deepEqual(lines(), [SENT]);
  assert.equal(linesRow(), 2, 'under the reply, not at the round');
  const reply = main().children[2];
  assert.ok(
    reply.querySelector('article.message.assistant').compareDocumentPosition(reply.querySelector('.mx-handoff-block')) &
      window.Node.DOCUMENT_POSITION_FOLLOWING
  );
  await show([user('u1', DAY1), sent, thinking], false);
  assert.equal(linesRow(), 2, 'under the working row while it runs');
  await waiting([DEV]);
  await show([user('u1', DAY1), sent, replied, ended('b1', 'blocked', 'atask_1')], false);
  assert.deepEqual(lines(), ['Sent to Dev session · Approval needed·Open']);
  assert.equal(main().children[3].childElementCount, 0, 'its wait report draws nothing');
  await waiting([]);
  await show([user('u1', DAY1), sent, replied, ended('e', 'completed', 'atask_1')], false);
  assert.deepEqual(lines(), []);
  assert.equal(main().querySelector('.mx-task-card-meta').textContent, 'Session · Completed');
});

test('a bot message shows its name and its words, never the envelope or LEAD, in a coding transcript and in a bot chat', async (t) => {
  const render = rowHarness(t);
  const { wrapAgentMessage } = await import('../../../../src/runtime/shared/agent-message-envelope.mjs');
  const text = wrapAgentMessage('Please check the build', { name: 'Marketer', agentId: 'agent-m1' });
  const row = {
    _tag: 'UserMessage',
    key: 'b',
    turnKey: 'b',
    item: { kind: 'user', id: 'b', text, at: DAY1, sender: 'lead', fromAgent: 'agent-m1' },
  };
  const lead = { ...row, key: 'l', item: { ...row.item, id: 'l', fromAgent: undefined, text: 'plain brief' } };
  for (const agentMode of [false, true]) {
    const options = {
      snapshot: { sessionId: agentMode ? HOME : 'sess_task_1' },
      disclosureScope: agentMode ? HOME : 'sess_task_1',
      readOnly: false,
      transitioning: false,
      renderAssistantRow: undefined,
      onOpenSettings() {},
      settledItems: [],
      settledTurnKeys: [],
      optimisticActivityStartedAt: 0,
      submit: async () => true,
      questionCard: null,
      agentMode,
    };
    const show = async (rows) => {
      function Rows() {
        const { renderTranscriptRow } = useConversationRowRenderer(options);
        return React.createElement(
          React.Fragment,
          null,
          rows.map((r, index) => React.createElement('div', { key: r.key }, renderTranscriptRow(r, index, rows)))
        );
      }
      await render(React.createElement(Rows));
      await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
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
  const options = {
    snapshot: { sessionId: HOME, toolApproval: { id: 'ap-1', kind: 'question', toolCallId: 'call-new' } },
    disclosureScope: HOME,
    readOnly: false,
    transitioning: false,
    renderAssistantRow: undefined,
    onOpenSettings() {},
    settledItems: items,
    settledTurnKeys: [],
    optimisticActivityStartedAt: 0,
    submit: async () => true,
    questionCard: React.createElement('div', { className: 'stub-question-card' }),
    agentMode: true,
  };
  function Rows() {
    const { renderTranscriptRow } = useConversationRowRenderer(options);
    return React.createElement(
      React.Fragment,
      null,
      rows.map((row, index) =>
        React.createElement('div', { key: row.key, 'data-row': row.key }, renderTranscriptRow(row, index, rows))
      )
    );
  }
  await render(React.createElement(Rows));
  await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
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
