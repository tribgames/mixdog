import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { installTestDom } from './test-support/test-dom.mjs';

const { petApproval } = await import('./desktop-pet-approval');
const { DECISION_RESULT_MS } = await import('./skin-companion-pet');

const who = { requester: 'Worker', agentName: 'Worker' };
const shell = {
  id: 'a1',
  kind: 'approval',
  name: 'shell',
  args: { command: 'npm run update\n# restarts the app' },
  remember: ['once', 'agent'],
};
const payment = {
  id: 'a3',
  kind: 'outbound',
  name: 'pay',
  outbound: { category: 'payment', target: 'Notion Labs', payload: '', editable: [], details: {} },
};
const secret = { id: 'a4', kind: 'secret', secret: { form: 'otp', requestId: 's1', length: 6 } };
const comment = {
  id: 'a5',
  kind: 'outbound',
  name: 'github',
  outbound: { category: 'comment', target: 'o/r#1', payload: 'hello', editable: ['payload'], details: {} },
};

test('the bubble offers the approval card rows and nothing else', async () => {
  const { approvalCardModel, approvalCardRows } = await import('./ApprovalCard');
  const item = petApproval(shell, who);
  assert.equal(item.inline, true);
  assert.equal(item.title, 'Approval: Run a command');
  assert.equal(item.requester, 'Worker');
  assert.equal(item.detail, 'npm run update');
  assert.equal(item.full, 'npm run update\n# restarts the app');
  const cardRows = approvalCardRows(approvalCardModel(shell), { agentName: 'Worker', officeLabel: '' });
  assert.deepEqual(
    item.rows.map((row) => [row.label, row.decision]),
    cardRows.map((row) => [row.label, row.decision])
  );
  assert.deepEqual([item.primary, item.deny], [0, 2]);
});

test('a request whose card takes more than a click only opens the card', () => {
  for (const request of [payment, secret, comment]) {
    const item = petApproval(request, who);
    assert.equal(item.inline, false, request.id);
    assert.deepEqual(item.rows, []);
    assert.deepEqual([item.primary, item.deny], [-1, -1]);
  }
});

async function mountPet(t, bubble, props = {}) {
  const dom = installTestDom(t, { rootId: 'root', expose: ['MouseEvent', 'KeyboardEvent', 'Event', 'HTMLElement'] });
  const { CompanionPet } = await import('./skin-companion-pet');
  const calls = { decide: [], open: 0 };
  const element = React.createElement(CompanionPet, {
    face: React.createElement('span'),
    bubble,
    collapsed: false,
    canSend: true,
    onOpen: () => calls.open++,
    onDecide: async (id, index) => {
      calls.decide.push([id, index]);
      return true;
    },
    onSend: async () => true,
    onDismiss: () => {},
    onMenu: () => {},
    onDrag: () => {},
    onNudge: () => {},
    onReset: () => {},
    onInputFocus: () => {},
    blurSignal: 0,
    ...props,
  });
  await act(async () => dom.root.render(element));
  const doc = dom.document;
  const buttons = () => [...doc.querySelectorAll('.skin-companion-bubble button')];
  const press = (label) => {
    const button = buttons().find((entry) => entry.textContent.trim() === label);
    assert.ok(button, `${label} in ${buttons().map((entry) => entry.textContent)}`);
    return act(async () => button.click());
  };
  return { doc, calls, buttons, press, labels: () => buttons().map((entry) => entry.textContent.trim()) };
}

const approvalBubble = (...requests) => ({
  kind: 'approval',
  approvals: requests.map((request) => petApproval(request, who)),
  total: requests.length,
});

test('allow and deny from the bubble send the card rows, and a short result follows', async (t) => {
  const ui = await mountPet(t, approvalBubble(shell));
  const text = () => ui.doc.querySelector('.skin-companion-bubble').textContent;
  assert.match(text(), /Approval: Run a command/);
  assert.match(text(), /Worker/);
  assert.deepEqual(ui.labels(), ['Allow just once', 'Deny', 'More details']);
  assert.equal(ui.doc.querySelector('.skin-companion-req').getAttribute('role'), 'group');

  // "자세히": the same request, in full, with every card row.
  await ui.press('More details');
  assert.deepEqual(ui.labels(), ['Allow just once', 'Always allow', 'Deny']);
  assert.match(ui.doc.querySelector('[data-full]').textContent, /restarts the app/);
  assert.equal(ui.doc.activeElement.getAttribute('aria-label'), 'Details', 'focus follows to the revealed text');

  await ui.press('Always allow');
  assert.deepEqual(ui.calls.decide, [['a1', 1]]);
  assert.equal(ui.doc.querySelector('.skin-companion-bubble').dataset.state, 'decided');
  assert.match(text(), /You allowed it/);
  await act(async () => new Promise((resolve) => setTimeout(resolve, DECISION_RESULT_MS + 100)));
  assert.equal(ui.doc.querySelector('.skin-companion-decided'), null, 'the result goes away by itself');
});

test('deny from the bubble sends the card deny row', async (t) => {
  const ui = await mountPet(t, approvalBubble(shell));
  await ui.press('Deny');
  assert.deepEqual(ui.calls.decide, [['a1', 2]]);
  assert.match(ui.doc.querySelector('.skin-companion-bubble').textContent, /You denied it/);
});

test('a request the bubble cannot decide shows its title and opens the card', async (t) => {
  const ui = await mountPet(t, approvalBubble(payment));
  assert.deepEqual(ui.labels(), ['Open']);
  assert.equal(ui.buttons()[0].getAttribute('aria-label'), 'Open approval');
  await ui.press('Open');
  assert.equal(ui.calls.open, 1);
  assert.deepEqual(ui.calls.decide, []);
});

test('with several waiting, the bubble shows the current request with a 1/N count', async (t) => {
  const bubble = { ...approvalBubble(shell), total: 2 };
  const ui = await mountPet(t, bubble);
  const title = () => ui.doc.querySelector('.skin-companion-req-title').textContent;
  assert.equal(title(), 'Approval: Run a command');
  assert.equal(ui.doc.querySelector('.skin-companion-req-pager').textContent, '1/2');
  assert.ok(!ui.labels().some((label) => label.includes('›')), 'no paging button');
});
