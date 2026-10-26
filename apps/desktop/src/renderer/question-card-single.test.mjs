import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';

// react-dom decides at import time whether a DOM exists, so the globals come first.
const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'https://mixdog.test/', pretendToBeVisual: true });
dom.window.Element.prototype.scrollIntoView = () => {};
dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
const decisions = [];
dom.window.mixdogDesktop = {
  resolveToolApprovalForSession: async (_session, _id, decision) => (decisions.push(decision), true),
};
for (const key of [
  'window',
  'document',
  'HTMLElement',
  'HTMLInputElement',
  'HTMLTextAreaElement',
  'HTMLButtonElement',
  'Element',
  'Node',
  'navigator',
]) {
  Object.defineProperty(globalThis, key, {
    configurable: true,
    value: key === 'window' ? dom.window : key === 'document' ? dom.window.document : dom.window[key],
  });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { default: React, act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { projectSettledTranscriptRows } = await import('./transcript-rows.ts');
const { transcriptRowNode } = await import('./conversation-support.tsx');
const { useConversationApprovals } = await import('./use-conversation-approvals.tsx');

const questions = [
  {
    question: 'Which?',
    header: 'W',
    multi_select: true,
    options: [
      { label: 'A', description: '' },
      { label: 'B', description: '' },
    ],
  },
];
const askUser = (id, result) => ({
  kind: 'tool',
  id: `item-${id}`,
  callId: id,
  name: 'ask_user',
  args: { questions },
  result,
});

/** Mounts the conversation rows for a changing snapshot; `answerQuestion` reads the latest hook result. */
async function mountRows(first) {
  const routeSessionIdRef = { current: 's' };
  const state = { approvals: null, snapshot: first };
  function Harness({ snapshot }) {
    const { items } = snapshot;
    state.approvals = useConversationApprovals(snapshot, routeSessionIdRef);
    let turn = '';
    const turnKeys = items.map((item) => (item.kind === 'user' ? (turn = `turn:${item.id}`) : turn));
    const rows = projectSettledTranscriptRows({ sessionKey: 's', items, turnKeys, failedTurns: new Set() }).rows;
    return React.createElement(
      'div',
      null,
      rows.map((row) =>
        React.createElement(
          'div',
          { key: row.key },
          transcriptRowNode(row, {
            disclosureScope: 's',
            optimisticActivityStartedAt: 0,
            readOnly: false,
            renderAssistantRow: () => 'assistant',
            retryDisabled: false,
            settledItems: items,
            settledTurnKeys: turnKeys,
            latestCompletion: undefined,
            snapshot,
            onRetryTurn() {},
            onOpenSettings() {},
            questionCard: state.approvals.questionCard,
          })
        )
      )
    );
  }
  const doc = dom.window.document;
  const root = createRoot(doc.getElementById('root'));
  await act(async () => root.render(React.createElement(Harness, { snapshot: first })));
  return {
    doc,
    state,
    show: (snapshot) => act(async () => root.render(React.createElement(Harness, { snapshot }))),
    done: () => act(async () => root.unmount()),
  };
}

test('a remounted card (its call moved to another row) keeps the picks; an explicit call id never lands on another call', async () => {
  decisions.length = 0;
  const approval = { id: 'ap-2', kind: 'question', args: { questions } };
  const base = { sessionId: 's', busy: true };
  const ui = await mountRows({ ...base, items: [askUser('c1', null)], toolApproval: approval });
  try {
    await act(async () =>
      ui.doc.querySelector('.question-option').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
    );
    // A newer waiting call appears in another row: the approval names no call, so the card moves there.
    const later = [askUser('c1', null), { kind: 'assistant', id: 'a1', text: 'again' }, askUser('c2', null)];
    await ui.show({ ...base, items: later, toolApproval: approval });
    assert.equal(ui.doc.querySelectorAll('.question-card').length, 1);
    await ui.state.approvals.answerQuestion('hello');
    assert.deepEqual(decisions, [{ approved: true, answers: [{ selected: ['A'] }], reply: 'hello' }]);

    // An approval naming a call that has not arrived yet shows no card on another call.
    const named = { id: 'ap-3', kind: 'question', toolCallId: 'c-late', args: { questions } };
    await ui.show({ ...base, items: later, toolApproval: named });
    assert.equal(ui.doc.querySelectorAll('.question-card').length, 0);
    await ui.show({
      ...base,
      items: [...later, { kind: 'assistant', id: 'a2', text: 'x' }, askUser('c-late', null)],
      toolApproval: named,
    });
    assert.equal(ui.doc.querySelectorAll('.question-card').length, 1);
  } finally {
    await ui.done();
  }
});

const clickFirstOption = (ui) =>
  act(async () =>
    ui.doc.querySelector('.question-option').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  );

test("after this device's accepted answer, a row move leaves no enabled card and no second submit", async () => {
  decisions.length = 0;
  const approval = { id: 'ap-4', kind: 'question', args: { questions } };
  const base = { sessionId: 's', busy: true, toolApproval: approval };
  const ui = await mountRows({ ...base, items: [askUser('c1', null)] });
  try {
    await clickFirstOption(ui);
    await act(async () =>
      ui.doc
        .querySelector('button[data-action="send"]')
        .dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
    );
    assert.equal(decisions.length, 1);
    // The snapshot still holds the accepted approval; its card's row moves.
    const moved = [askUser('c1', null), { kind: 'assistant', id: 'a1', text: 'again' }, askUser('c2', null)];
    await ui.show({ ...base, items: moved });
    assert.equal(ui.doc.querySelectorAll('.question-card').length, 0, 'no card for an answered approval');
    assert.equal(ui.state.approvals.answerQuestion, null);
    assert.equal(ui.state.approvals.dismissQuestion, null);
    assert.equal(decisions.length, 1, 'no second submit');
  } finally {
    await ui.done();
  }
});

test('a reissued approval id (after the accepted one left the snapshot, result retained) can be answered again', async () => {
  decisions.length = 0;
  const approval = { id: 'ap-7', kind: 'question', args: { questions } };
  const result = { id: 'ap-7', approved: true };
  const base = { sessionId: 's', busy: true };
  const ui = await mountRows({ ...base, items: [askUser('c1', null)], toolApproval: approval });
  try {
    await clickFirstOption(ui);
    await act(async () =>
      ui.doc
        .querySelector('button[data-action="send"]')
        .dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
    );
    assert.equal(decisions.length, 1);
    await ui.show({ ...base, items: [askUser('c1', null)], toolApproval: approval });
    assert.equal(ui.state.approvals.answerQuestion, null, 'still suppressed while the same instance is pending');
    await ui.show({ ...base, items: [askUser('c1', null)], toolApproval: undefined, toolApprovalResult: result });
    assert.equal(ui.doc.querySelectorAll('.question-card').length, 0);
    await ui.show({ ...base, items: [askUser('c1', null)], toolApproval: approval, toolApprovalResult: result });
    assert.equal(ui.doc.querySelectorAll('.question-card').length, 1, 'the reissued id shows its card');
    assert.equal(typeof ui.state.approvals.answerQuestion, 'function');
    await ui.state.approvals.answerQuestion('again');
    assert.equal(decisions.length, 2);
  } finally {
    await ui.done();
  }
});

test('drafts start empty for a new approval id; a composer answer after the explicit-id row vanished keeps the picks', async () => {
  decisions.length = 0;
  const base = { sessionId: 's', busy: true };
  const first = { id: 'ap-5', kind: 'question', toolCallId: 'c-a', args: { questions } };
  const ui = await mountRows({ ...base, items: [askUser('c-a', null)], toolApproval: first });
  try {
    await clickFirstOption(ui);
    assert.equal(ui.doc.querySelectorAll('.question-option[aria-checked="true"]').length, 1);
    // The named row is gone (not in the transcript for now): the picks still go with a reply.
    await ui.show({ ...base, items: [], toolApproval: first });
    assert.equal(ui.doc.querySelectorAll('.question-card').length, 0);
    await ui.state.approvals.answerQuestion('typed');
    assert.deepEqual(decisions, [{ approved: true, answers: [{ selected: ['A'] }], reply: 'typed' }]);

    // Another approval with the same question count starts from empty drafts.
    decisions.length = 0;
    const next = { id: 'ap-6', kind: 'question', toolCallId: 'c-b', args: { questions } };
    await ui.show({ ...base, items: [askUser('c-b', null)], toolApproval: next });
    assert.equal(ui.doc.querySelectorAll('.question-option[aria-checked="true"]').length, 0);
    await ui.state.approvals.answerQuestion('typed');
    assert.deepEqual(decisions, [{ approved: true, answers: [null], reply: 'typed' }]);
  } finally {
    await ui.done();
  }
});

test('a question left without a result does not get a second card that wipes the picks of the pending one', async () => {
  decisions.length = 0;
  // An older ask_user never got its result; the pending approval belongs to the newer call.
  const items = [
    askUser('call-old', null),
    { kind: 'assistant', id: 'a1', text: 'asking again' },
    askUser('call-new', null),
  ];
  const snapshot = {
    sessionId: 's',
    busy: true,
    items,
    toolApproval: { id: 'ap-1', kind: 'question', toolCallId: 'call-new', args: { questions } },
  };
  let turn = '';
  const turnKeys = items.map((item) => (item.kind === 'user' ? (turn = `turn:${item.id}`) : turn));
  const rows = projectSettledTranscriptRows({ sessionKey: 's', items, turnKeys, failedTurns: new Set() }).rows;
  const routeSessionIdRef = { current: 's' };
  let approvals;
  function Harness({ tick }) {
    approvals = useConversationApprovals(snapshot, routeSessionIdRef);
    return React.createElement(
      'div',
      { 'data-tick': tick },
      rows.map((row) =>
        React.createElement(
          'div',
          { key: row.key },
          transcriptRowNode(row, {
            disclosureScope: 's',
            optimisticActivityStartedAt: 0,
            readOnly: false,
            renderAssistantRow: () => 'assistant',
            retryDisabled: false,
            settledItems: items,
            settledTurnKeys: turnKeys,
            latestCompletion: undefined,
            snapshot,
            onRetryTurn() {},
            onOpenSettings() {},
            questionCard: approvals.questionCard,
          })
        )
      )
    );
  }
  const doc = dom.window.document;
  const root = createRoot(doc.getElementById('root'));
  try {
    await act(async () => root.render(React.createElement(Harness, { tick: 0 })));
    assert.equal(doc.querySelectorAll('.question-card').length, 1, 'one card for the one pending approval');
    await act(async () =>
      doc.querySelector('.question-option').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
    );
    // A later render of the conversation (a background notice) must keep the pick.
    await act(async () => root.render(React.createElement(Harness, { tick: 1 })));
    await approvals.answerQuestion('hello');
    assert.deepEqual(decisions, [{ approved: true, answers: [{ selected: ['A'] }], reply: 'hello' }]);
  } finally {
    await act(async () => root.unmount());
  }
});
