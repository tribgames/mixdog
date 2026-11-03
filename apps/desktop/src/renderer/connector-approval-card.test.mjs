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
  assert.equal(
    approvalCardModel({ ...card('disabled', ['auto']), account: 'me@work.com' }).requestAccount,
    'me@work.com'
  );
  assert.equal(approvalCardModel(card('disabled', ['auto'])).requestAccount, '');
});

test('an outbound card that already names its account gets no second account line', () => {
  const mail = {
    id: 'a2',
    kind: 'outbound',
    name: 'gmail',
    account: 'me@work.com',
    outbound: { category: 'email', target: 'x@y.com', account: 'me@work.com' },
  };
  assert.equal(approvalCardModel(mail).account, 'me@work.com');
  assert.equal(approvalCardModel(mail).requestAccount, '');
  assert.equal(
    approvalCardModel({ ...mail, outbound: { category: 'email', target: 'x@y.com' } }).requestAccount,
    'me@work.com'
  );
});

test('an outbound or action-kind approval offers once, this session, always and deny; a payment only once', () => {
  const rowsOf = (approval) =>
    approvalCardRows(approvalCardModel(approval), { agentName: 'Bot', officeLabel: '' }).map((row) => [
      row.label,
      row.decision.remember ?? '',
    ]);
  const outbound = { kind: 'outbound', outbound: { category: 'comment' }, remember: ['once', 'session', 'agent'] };
  assert.deepEqual(rowsOf(outbound), [
    ['Allow just once', ''],
    ['Allow for this session', 'session'],
    ['Always allow', 'agent'],
    ['Deny', ''],
  ]);
  const payment = { kind: 'outbound', outbound: { category: 'payment' }, remember: ['once'] };
  assert.deepEqual(
    rowsOf(payment).map(([label]) => label),
    ['Allow payment', 'Deny']
  );
  assert.deepEqual(
    rowsOf({ kind: 'approval', name: 'shell', remember: ['once'] }).map(([label]) => label),
    ['Allow just once', 'Deny']
  );
});

test('a tool or hook-ask card offers once, this session, always for all conversations and deny, with the scope stated', () => {
  const rows = (approval) => approvalCardRows(approvalCardModel(approval), { agentName: 'Lead', officeLabel: '' });
  const tool = { kind: 'approval', name: 'shell', remember: ['once', 'session', 'always'] };
  const list = rows(tool);
  assert.deepEqual(
    list.map((row) => [row.label, row.decision.remember ?? '']),
    [
      ['Allow just once', ''],
      ['Allow for this session', 'session'],
      ['Always allow (all conversations)', 'always'],
      ['Deny', ''],
    ]
  );
  assert.equal(list[1].desc, "For this session, shell won't ask again");
  assert.equal(list[2].desc, "With Always allow, shell won't ask again in any conversation");
  // A classified send keeps its kind's name.
  const send = rows({ kind: 'outbound', outbound: { category: 'email' }, remember: ['once', 'session', 'always'] });
  assert.equal(send[2].decision.remember, 'always');
  assert.equal(send[2].desc, "With Always allow, Send an email won't ask again in any conversation");
  // Once only: no standing choice at all.
  assert.deepEqual(
    rows({ kind: 'approval', name: 'shell', remember: ['once'] }).map((row) => row.label),
    ['Allow just once', 'Deny']
  );
});

test('a Lead hook-ask card words its session and always rows by what the grant covers', () => {
  const rows = (approval) => approvalCardRows(approvalCardModel(approval), { agentName: 'Lead', officeLabel: '' });
  // A classified call asked through the github tool: the grant is the kind, any tool.
  const kind = rows({
    kind: 'approval',
    name: 'github',
    grantAction: 'comment',
    remember: ['once', 'session', 'always'],
  });
  assert.equal(kind[1].desc, "For this session, Post a comment from any tool won't ask again");
  assert.equal(kind[2].desc, "With Always allow, Post a comment from any tool won't ask again in any conversation");
  assert.ok(!kind.some((row) => /github/.test(row.desc ?? '')));
  // A tool key names the tool, even when the card's tool differs in label.
  const tool = rows({
    kind: 'approval',
    name: 'github',
    grantAction: 'tool:github',
    remember: ['once', 'session', 'always'],
  });
  assert.equal(tool[1].desc, "For this session, github won't ask again");
  assert.equal(tool[2].desc, "With Always allow, github won't ask again in any conversation");
  const mcp = rows({
    kind: 'approval',
    name: 'mcp__acme__run',
    grantAction: 'tool:mcp__acme__run',
    remember: ['once', 'always'],
  });
  assert.equal(mcp[1].desc, "With Always allow, run (acme) won't ask again in any conversation");
});
