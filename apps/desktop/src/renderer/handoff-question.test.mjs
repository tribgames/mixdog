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
const { useConversationApprovals } = await import('./use-conversation-approvals.tsx');
const { AskUserRecord } = await import('./ask-user-record.tsx');

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
  // The chat pane's approvals (its composer's question binding), as Conversation.tsx wires them.
  const pane = { approvals: null };
  const route = { current: chat };
  // One component for every render, so the pane's state lives on as in the app.
  function Pane({ rows, questions, own }) {
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
    const snapshot = { sessionId: chat, items: [], toolApproval: own, handoffQuestions: questions ?? undefined };
    pane.approvals = useConversationApprovals(snapshot, route);
    const value = questions ? { chatSessionId: chat, questions, agentMode: true, relay: pane.approvals.relay } : null;
    return React.createElement(HandoffQuestionsContext.Provider, { value }, React.createElement(Rows));
  }
  const show = (rows, questions, { own = null } = {}) =>
    act(async () => root.render(React.createElement(Pane, { rows, questions, own })));
  /** A message sent from the chat's composer, as its dock wraps the submit;
   *  `sent` collects what would go to the chat's agent. A refusal (thrown:
   *  the composer keeps the draft and shows its message) comes back as `error`. */
  const sent = [];
  const compose = async (content, composeOptions) => {
    const submit = async (...args) => (sent.push(args), true);
    let outcome;
    await act(async () => {
      try {
        outcome = { result: await pane.approvals.wrapSubmit(submit)(content, composeOptions) };
      } catch (error) {
        outcome = { error: error.message };
      }
    });
    return outcome;
  };
  return {
    host,
    calls,
    opened,
    show,
    pane,
    sent,
    compose,
    refuse: () => {
      answer = false;
    },
  };
}

const cards = (host) => [...host.querySelectorAll('.question-card')];
const optionLabels = (card) => [...card.querySelectorAll('.question-option-label')].map((label) => label.textContent);
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
    item: {
      kind: 'notice',
      id: key,
      text: `${speaker} ${key}`,
      at: DAY,
      room: { kind: 'speech', speaker, name: speaker },
    },
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
  assert.deepEqual(
    cards(host).map(rowOf),
    ['s3', 's4'],
    "under gh's newest words; bench, silent in view, under the last row"
  );
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

// What the asking session's ask_user call returns (ask-user-tool.mjs), carried by a settled copy.
const CLOSE = 'You can now continue with these answers in mind.';
const ALL_FIVE = `User has answered your questions: "Which markets?"="All five". ${CLOSE}`;
const DISMISSED =
  'User closed the questions without answering. Proceed with your best judgment; ask again only if something new depends on it.';
const settled = (id, sessionId, questionArgs, record) => ({ ...copy(id, sessionId, questionArgs), record });
const records = (host) => [...host.querySelectorAll('.ask-user-record')];
/** The record the asking session's transcript keeps for the same call. */
async function sessionRecord(questionArgs, result) {
  const own = document.createElement('div');
  const ownRoot = createRoot(own);
  const item = { kind: 'tool', id: 'q1', name: 'ask_user', args: questionArgs, result, status: 'done' };
  await act(async () => ownRoot.render(React.createElement(AskUserRecord, { item })));
  const html = own.querySelector('.ask-user-record').outerHTML;
  await act(async () => ownRoot.unmount());
  return html;
}
const MULTI = {
  questions: [
    { question: 'Which markets?', multi_select: true, options: [{ label: 'All five' }, { label: 'Only KR' }] },
  ],
};

async function oneSend(t) {
  const ui = harness(t);
  await act(async () => publishSessionGlances([{ id: LEAD, title: 'Rank model', preview: '', working: true }]));
  await act(async () => publishCatalogApprovalSessions([{ id: LEAD, awaitingApproval: true, awaitingQuestion: true }]));
  return { ...ui, rows: [user, round('r1', [send('s1', 'atask_1')]), replied] };
}

test("answered on either card, both settle into the session's answered record; closed or timed out alike", async (t) => {
  const { host, calls, show, rows } = await oneSend(t);
  // Answered on the session's own card: the chat's copy settles at once.
  await show(rows, [copy('q1', LEAD, RANK)]);
  await show(rows, [settled('q1', LEAD, RANK, ALL_FIVE)]);
  assert.deepEqual(cards(host), [], 'no live card left');
  assert.equal(records(host).length, 1);
  assert.equal(records(host)[0].outerHTML, await sessionRecord(RANK, ALL_FIVE), "the session's own answered card");
  assert.ok(records(host)[0].previousElementSibling?.classList.contains('mx-handoff-line'), 'under its line');
  // Answered on the chat's card: once, to the asking session through this chat's copy.
  await show(rows, [copy('q2', LEAD, RANK)]);
  assert.deepEqual(records(host), [], 'a new question replaces the settled card');
  await click(cards(host)[0].querySelector('.question-option'));
  assert.deepEqual(
    calls.map(([chat, id]) => [chat, id]),
    [[HOME, 'q2']]
  );
  await show(rows, [settled('q2', LEAD, RANK, ALL_FIVE)]);
  assert.deepEqual(cards(host), []);
  assert.equal(records(host)[0].outerHTML, await sessionRecord(RANK, ALL_FIVE));
  // Closed (on either card) or timed out: the session's closed record, here too.
  await show(rows, [settled('q3', LEAD, RANK, DISMISSED)]);
  assert.equal(records(host)[0].outerHTML, await sessionRecord(RANK, DISMISSED));
  assert.match(records(host)[0].textContent, /Question closed/);
  assert.equal(calls.length, 1);
});

test("a message from the chat's composer answers the handed-off question straight to its session, never the chat's agent", async (t) => {
  const { host, calls, show, rows, pane, sent, compose } = await oneSend(t);
  await show(rows, [copy('q1', LEAD, MULTI)]);
  assert.equal(pane.approvals.answerHint, 'Sending answers the question from Rank model', 'the hint names the session');
  // A pick on the card goes along with the typed answer, as in the session's own composer.
  await click(cards(host)[0].querySelector('.question-option'));
  assert.equal(calls.length, 0, 'a multi-select pick alone sends nothing');
  assert.deepEqual(await compose('  keep it small  '), { result: true });
  assert.equal(calls.length, 1);
  const [chat, id, decision] = calls[0];
  assert.deepEqual([chat, id, decision.approved, decision.reply], [HOME, 'q1', true, 'keep it small']);
  assert.deepEqual(decision.answers, [{ selected: ['All five'] }]);
  assert.deepEqual(sent, [], "no message or turn of the chat's agent");
  // Settled from that answer: the card resolves here as in the session.
  const record = `User replied in chat: "keep it small". User has answered your questions: "Which markets?"="All five". ${CLOSE}`;
  await show(rows, [settled('q1', LEAD, MULTI, record)]);
  assert.deepEqual(cards(host), []);
  assert.equal(records(host)[0].outerHTML, await sessionRecord(MULTI, record));
  assert.equal(pane.approvals.answerHint, undefined, 'a settled question is answered no more');
  assert.deepEqual(await compose('thanks'), { result: true });
  assert.deepEqual(sent, [['thanks', undefined]], 'with none pending, the next message goes to the chat');
  assert.equal(calls.length, 1);
});

test('an answer over the cap from the chat composer is refused: nothing reaches the chat or the question', async (t) => {
  const { host, calls, show, rows, pane, sent, compose } = await oneSend(t);
  await show(rows, [copy('q1', LEAD, RANK)]);
  const long = 'x'.repeat(4001);
  const outcome = await compose(long);
  assert.equal(
    outcome.error,
    'This answer is too long for the question (up to 4000 characters). Your draft has been kept.',
    'the composer keeps the draft and says why'
  );
  assert.deepEqual(calls, [], 'the question is neither answered nor dismissed');
  assert.deepEqual(sent, [], 'and nothing goes to the chat');
  assert.equal(cards(host).length, 1, 'the question still waits');
  assert.equal(pane.approvals.relay?.id, 'q1');
  // Shortened, it answers the question.
  assert.deepEqual(await compose('x'.repeat(4000)), { result: true });
  assert.deepEqual(
    calls.map(([chat, id, decision]) => [chat, id, decision.reply.length]),
    [[HOME, 'q1', 4000]]
  );
  assert.deepEqual(sent, []);
});

test('with several sessions asking, the composer answers the oldest question, the one its hint names', async (t) => {
  const { calls, show, rows, pane, sent, compose } = await oneSend(t);
  await act(async () =>
    publishSessionGlances([
      { id: LEAD, title: 'Rank model', preview: '', working: true },
      { id: TASK, title: 'Markets', preview: '', working: true },
    ])
  );
  await show(rows, [copy('q1', LEAD, RANK), copy('q2', TASK, MARKETS)]);
  assert.equal(pane.approvals.relay?.id, 'q1');
  assert.equal(pane.approvals.answerHint, 'Sending answers the question from Rank model');
  assert.deepEqual(await compose('All five'), { result: true });
  assert.deepEqual(
    calls.map(([chat, id, decision]) => [chat, id, decision.reply]),
    [[HOME, 'q1', 'All five']]
  );
  // Once it settles, the next message answers the one still waiting.
  await show(rows, [settled('q1', LEAD, RANK, ALL_FIVE), copy('q2', TASK, MARKETS)]);
  assert.equal(pane.approvals.answerHint, 'Sending answers the question from Markets');
  assert.deepEqual(await compose('API'), { result: true });
  assert.deepEqual(
    calls.map(([, id, decision]) => [id, decision.reply]),
    [
      ['q1', 'All five'],
      ['q2', 'API'],
    ]
  );
  assert.deepEqual(sent, [], "nothing reaches the chat's agent");
});

test("the chat's own question comes first: the composer answers it, not a handed-off session's", async (t) => {
  const { calls, show, rows, pane, sent, compose } = await oneSend(t);
  const own = { id: 'own1', kind: 'question', name: 'ask_user', args: MARKETS, sessionId: HOME };
  await show(rows, [copy('q1', LEAD, RANK), copy('q2', TASK, MARKETS)], { own });
  assert.equal(pane.approvals.answerHint, 'Sending answers the question');
  assert.equal(pane.approvals.relay, null);
  assert.deepEqual(await compose('API'), { result: true });
  assert.deepEqual(
    calls.map(([chat, id, decision]) => [chat, id, decision.approved, decision.reply]),
    [[HOME, 'own1', true, 'API']]
  );
  assert.deepEqual(sent, [], 'an answer, not a message');
});

test("an attachment or a slash command from the chat's composer closes the oldest handed-off question, then goes to the chat", async (t) => {
  const { calls, show, rows, sent, compose } = await oneSend(t);
  for (const [content, options] of [
    ['see this', { pastedImages: { 1: { data: 'x' } } }],
    ['/compact', undefined],
  ]) {
    calls.length = 0;
    sent.length = 0;
    await show(rows, [copy('q1', LEAD, RANK), copy('q2', TASK, MARKETS)]);
    assert.deepEqual(await compose(content, options), { result: true });
    assert.deepEqual(
      calls.map(([chat, id, decision]) => [chat, id, decision.approved, decision.reason]),
      [[HOME, 'q1', false, 'dismissed by user']],
      'the oldest question is closed, unanswered'
    );
    assert.deepEqual(sent, [[content, options]], 'then sent on as a message, as the session composer does');
  }
});
