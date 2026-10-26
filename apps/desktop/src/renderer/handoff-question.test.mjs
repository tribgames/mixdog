// A session a bot chat handed work to asks the user a question: the same
// question card shows in that chat under the session's hand-off line, is
// answered through the chat (once), and leaves once the question does.
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
const { useConversationRowRenderer } = await import('./use-conversation-row-renderer.ts');
const { HandoffQuestionsContext } = await import('./agent-task-line.tsx');
const { QuestionCard } = await import('./QuestionCard.tsx');
const { approvalQuestions } = await import('./question-card-logic.ts');
const { publishSessionGlances } = await import('./session-glance-store.ts');
const { publishCatalogApprovalSessions } = await import('./session-catalog-approvals.ts');
const { roomSessionId } = await import('../../../../src/runtime/agent/orchestrator/session/agent-room.mjs');

const HOME = 'sess_home_data-analyst';
const LEAD = 'sess_daemon_rank';
const TASK = 'sess_daemon_markets';
const DAY = new Date(2026, 9, 26, 19, 0).getTime();

const call = (id, args, result) => ({
  kind: 'tool',
  id,
  name: 'session',
  args,
  result: JSON.stringify(result),
  status: 'done',
  startedAt: DAY,
});
const send = (id, sendId) =>
  call(
    id,
    { action: 'send', session_id: LEAD, prompt: `prompt ${id}` },
    { sessionId: LEAD, accepted: true, sendId, reportsBack: true }
  );
const create = (id) =>
  call(
    id,
    { action: 'create', title: 'Markets', brief: 'Add five markets' },
    { session_id: TASK, status: 'started', title: 'Markets', project: null }
  );
const user = { _tag: 'UserMessage', key: 'u1', turnKey: 'u1', item: { kind: 'user', id: 'u1', text: 'go', at: DAY } };
const round = (key, items) => ({ _tag: 'ToolActivity', key, turnKey: 't1', items });
const replied = {
  _tag: 'AssistantPart',
  key: 'a1',
  turnKey: 't1',
  item: { kind: 'assistant', id: 'a1', text: 'Handed it over', at: DAY },
};

const args = (question, labels) => ({ questions: [{ question, options: labels.map((label) => ({ label })) }] });
// As the runtime copies a handed-off session's ask_user into the chat's `handoffQuestions`.
const copy = (id, sessionId, questionArgs) => ({
  id,
  name: 'ask_user',
  kind: 'question',
  args: questionArgs,
  sessionId,
  surfaceSessionId: HOME,
  chain: [],
  handoff: { title: 'Rank' },
});
const RANK = args('Which markets?', ['All five', 'Only KR']);
const MARKETS = args('Which source?', ['API', 'Scrape']);

function harness(t, chat = HOME) {
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  const calls = [];
  let answer = true;
  window.mixdogDesktop = {
    resolveToolApprovalForSession: async (...callArgs) => {
      calls.push(callArgs);
      return answer;
    },
  };
  const opened = [];
  const onOpen = (event) => opened.push(event.detail.sessionId);
  const NodeCustomEvent = globalThis.CustomEvent;
  globalThis.CustomEvent = window.CustomEvent;
  window.addEventListener('mixdog:open-task-session', onOpen);
  t.after(async () => {
    await act(async () => root.unmount());
    host.remove();
    globalThis.CustomEvent = NodeCustomEvent;
    window.removeEventListener('mixdog:open-task-session', onOpen);
    publishSessionGlances([]);
    publishCatalogApprovalSessions([]);
    delete window.mixdogDesktop;
  });
  const options = {
    snapshot: { sessionId: chat },
    disclosureScope: chat,
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
  const show = async (rows, questions) => {
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
    const value = questions ? { chatSessionId: chat, questions, agentMode: true } : null;
    await act(async () =>
      root.render(React.createElement(HandoffQuestionsContext.Provider, { value }, React.createElement(Rows)))
    );
  };
  return {
    host,
    calls,
    opened,
    show,
    refuse: () => {
      answer = false;
    },
  };
}

const cards = (host) => [...host.querySelectorAll('.question-card')];
const optionLabels = (card) =>
  [...card.querySelectorAll('.question-option-label')].map((label) => label.textContent);
/** Each card with the hand-off line right before it (the session it belongs to). */
const seats = (host) =>
  cards(host).map((card) => card.previousElementSibling?.querySelector('.mx-handoff-name')?.textContent ?? '');
const click = (node) => act(async () => node.click());

test("a handed-off session's question shows under its line with the same options and is answered once through the chat", async (t) => {
  const { host, calls, opened, show } = harness(t);
  await act(async () =>
    publishSessionGlances([
      { id: LEAD, title: 'Rank model', preview: '', working: true },
      { id: TASK, title: 'Markets', preview: '', working: true },
    ])
  );
  await act(async () =>
    publishCatalogApprovalSessions([
      { id: LEAD, awaitingApproval: true, awaitingQuestion: true },
      { id: TASK, awaitingApproval: true, awaitingQuestion: true },
    ])
  );
  const rows = [user, round('r1', [send('s1', 'atask_1'), create('c1')]), replied];

  // No question: the lines alone.
  await show(rows, null);
  const rowCount = host.querySelectorAll('.mx-chat-row').length;
  assert.deepEqual(cards(host), []);

  // The same card the session shows, with the same options, under its own line.
  await show(rows, [copy('q1', LEAD, RANK)]);
  assert.equal(cards(host).length, 1);
  assert.deepEqual(seats(host), ['Sent to Rank model']);
  assert.ok(cards(host)[0].closest('.mx-handoff-block'), 'in the hand-off block');
  assert.deepEqual(optionLabels(cards(host)[0]), ['All five', 'Only KR']);
  {
    // The child pane's card for the same request renders the same options.
    const own = document.createElement('div');
    const ownRoot = createRoot(own);
    await act(async () =>
      ownRoot.render(
        React.createElement(QuestionCard, { questions: approvalQuestions(RANK), resolve: async () => true })
      )
    );
    assert.deepEqual(optionLabels(own.querySelector('.question-card')), optionLabels(cards(host)[0]));
    await act(async () => ownRoot.unmount());
  }
  assert.equal(host.querySelectorAll('.mx-chat-row').length, rowCount, 'no row of its own');

  // Each delegated session shows its own card, at its own line.
  await show(rows, [copy('q1', LEAD, RANK), copy('q2', TASK, MARKETS)]);
  assert.deepEqual(seats(host), ['Sent to Rank model', 'Markets']);
  assert.deepEqual(optionLabels(cards(host)[1]), ['API', 'Scrape']);

  // Answered here: through this chat's copy, once; the card leaves at once.
  const [rank] = cards(host);
  await click(rank.querySelector('.question-option'));
  assert.equal(calls.length, 1);
  const [chat, id, decision] = calls[0];
  assert.deepEqual([chat, id, decision.approved], [HOME, 'q1', true]);
  assert.equal(decision.answers.length, 1);
  assert.match(JSON.stringify(decision.answers), /All five/);
  assert.deepEqual(seats(host), ['Markets'], 'gone while the copy still lingers; the other one stays');

  // The copy leaves (answered anywhere, or the session aborted): its card goes, never back.
  await show(rows, [copy('q2', TASK, MARKETS)]);
  assert.deepEqual(seats(host), ['Markets']);
  await show(rows, []);
  assert.deepEqual(cards(host), []);
  assert.equal(calls.length, 1, 'nothing else was answered');

  // Open still opens the session.
  await click(host.querySelector('.mx-handoff-line button'));
  assert.equal(opened.at(-1), LEAD);
});

test('two open sends to one session carry its card once, at the newest line; an answer from elsewhere first keeps it disabled', async (t) => {
  const { host, calls, show, refuse } = harness(t);
  await act(async () => publishSessionGlances([{ id: LEAD, title: 'Rank model', preview: '', working: true }]));
  await act(async () => publishCatalogApprovalSessions([{ id: LEAD, awaitingApproval: true, awaitingQuestion: true }]));
  const rows = [user, round('r1', [send('s1', 'atask_1')]), round('r2', [send('s2', 'atask_2')])];
  await show(rows, [copy('q1', LEAD, RANK)]);
  assert.equal(host.querySelectorAll('.mx-handoff-line').length, 2);
  assert.equal(cards(host).length, 1, 'one card for the one request');
  const lastLine = [...host.querySelectorAll('.mx-handoff-line')].at(-1);
  assert.equal(lastLine.nextElementSibling, cards(host)[0], 'under the newest line');

  // Another device answered first: the chat's answer is refused, the card stays disabled.
  refuse();
  await click(cards(host)[0].querySelector('.question-option'));
  assert.equal(calls.length, 1);
  assert.ok(cards(host)[0].querySelector('.question-option').disabled, 'no second answer');
  await show(rows, []);
  assert.deepEqual(cards(host), []);
});

test("a room shows each member's handed-off question under its newest words, answered through the room once", async (t) => {
  const ROOM = roomSessionId('room123abc');
  const { host, calls, opened, show } = harness(t, ROOM);
  await act(async () =>
    publishSessionGlances([
      { id: LEAD, title: 'Rank model', preview: '', working: true },
      { id: TASK, title: 'Markets', preview: '', working: true },
    ])
  );
  const speech = (key, speaker) => ({
    _tag: 'AssistantPart',
    key,
    turnKey: key,
    item: { kind: 'notice', id: key, text: `${speaker} ${key}`, at: DAY, room: { kind: 'speech', speaker, name: speaker } },
  });
  const rows = [user, speech('s1', 'gh'), speech('s2', 'rel'), speech('s3', 'gh'), speech('s4', 'rel')];
  // As the host projects a member's copy into its room (agent-room-views.ts).
  const inRoom = (id, sessionId, member, questionArgs) => ({
    ...copy(id, sessionId, questionArgs),
    surfaceSessionId: `sess_room_member_${member}`,
    roomMember: member,
    memberSessionId: `sess_room_member_${member}`,
  });
  const rowOf = (card) => card.closest('[data-row]')?.dataset.row;

  await show(rows, null);
  const rowCount = host.querySelectorAll('.mx-chat-row').length;
  await show(rows, [inRoom('q1', LEAD, 'gh', RANK), inRoom('q2', TASK, 'bench', MARKETS)]);
  assert.deepEqual(cards(host).map(rowOf), ['s3', 's4'], "under gh's newest words; bench, silent in view, under the last row");
  assert.deepEqual(seats(host), ['Rank model', 'Markets'], "each under its asking session's line");
  assert.deepEqual(optionLabels(cards(host)[0]), ['All five', 'Only KR']);
  assert.equal(
    host.querySelectorAll('.mx-chat-row').length,
    rowCount + 2,
    'one line beside the rows per seat, no transcript row'
  );

  // Answered in the room: through the room, under the member's copy id, once.
  await click(cards(host)[0].querySelector('.question-option'));
  assert.equal(calls.length, 1);
  assert.deepEqual([calls[0][0], calls[0][1], calls[0][2].approved], [ROOM, 'q1', true]);
  assert.deepEqual(seats(host), ['Markets']);
  // Answered in the asking session: the host drops the copy, the card goes.
  await show(rows, [inRoom('q2', TASK, 'bench', MARKETS)]);
  await click(host.querySelector('.mx-handoff-line button'));
  assert.equal(opened.at(-1), TASK, 'Open opens the asking session');
  await show(rows, []);
  assert.deepEqual(cards(host), []);
  assert.equal(calls.length, 1);
});
