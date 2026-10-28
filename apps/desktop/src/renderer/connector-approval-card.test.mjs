import assert from 'node:assert/strict';
import test from 'node:test';

const { approvalCardModel, approvalCardRows } = await import('./ApprovalCard.tsx');
const { approvalAllowIsPointerOnly, approvalAllowOnceDecision } = await import('../shared/approval-enter-rule.ts');

// A bot's widening of one connector tool (human-gate/requests.mjs kind `connector`).
const card = (from, choices) => ({
  id: 'appr_1',
  name: 'setup',
  kind: 'connector',
  agentId: 'trader',
  remember: ['once'],
  connector: { server: 'mt5', tool: 'trade_send_market_order', from, requested: 'needs_approval', choices },
});
const rows = (approval) =>
  approvalCardRows(approvalCardModel(approval), { agentName: 'Trader', officeLabel: '' }).map((row) => [
    row.label,
    row.decision,
  ]);

test('a disabled tool offers Allow (needs_approval), Always allow (auto) and Deny, each as that level only', () => {
  assert.deepEqual(rows(card('disabled', ['needs_approval', 'auto'])), [
    ['Allow', { approved: true, response: 'approve', scope: 'needs_approval' }],
    ['Always allow', { approved: true, response: 'approve', scope: 'auto' }],
    ['Deny', { approved: false }],
  ]);
});

test('a tool that already asks offers only Always allow and Deny', () => {
  assert.deepEqual(rows(card('needs_approval', ['auto'])), [
    ['Always allow', { approved: true, response: 'approve', scope: 'auto' }],
    ['Deny', { approved: false }],
  ]);
});

test('it is allowed only by a click on the card: no Enter, no notification Allow', () => {
  const approval = card('disabled', ['needs_approval', 'auto']);
  assert.equal(approvalAllowIsPointerOnly(approval), true);
  assert.equal(approvalAllowOnceDecision(approval), null);
});
test('the card model carries the request account only when the request has one', () => {
  assert.equal(approvalCardModel({ ...card('disabled', ['auto']), account: 'me@work.com' }).requestAccount, 'me@work.com');
  assert.equal(approvalCardModel(card('disabled', ['auto'])).requestAccount, '');
});

test('an outbound card that already names its account gets no second account line', () => {
  const mail = { id: 'a2', kind: 'outbound', name: 'gmail', account: 'me@work.com', outbound: { category: 'email', target: 'x@y.com', account: 'me@work.com' } };
  assert.equal(approvalCardModel(mail).account, 'me@work.com');
  assert.equal(approvalCardModel(mail).requestAccount, '');
  assert.equal(approvalCardModel({ ...mail, outbound: { category: 'email', target: 'x@y.com' } }).requestAccount, 'me@work.com');
});
