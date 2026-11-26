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

test('an outbound approval offers once, this conversation, this agent and deny; a payment only once', () => {
  const rowsOf = (approval) =>
    approvalCardRows(approvalCardModel(approval), { agentName: 'Bot', officeLabel: '' }).map((row) => [
      row.label,
      row.decision.remember ?? '',
    ]);
  const outbound = { kind: 'outbound', outbound: { category: 'comment' }, remember: ['once', 'session', 'agent'] };
  assert.deepEqual(rowsOf(outbound), [
    ['Allow just once', ''],
    ['Allow for this conversation', 'session'],
    ['Allow for this agent', 'agent'],
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

test('a tool or hook-ask card offers once, this conversation, always for every agent and deny, each saying it is for this tool', () => {
  const rows = (approval) => approvalCardRows(approvalCardModel(approval), { agentName: 'Lead', officeLabel: '' });
  const tool = { kind: 'approval', name: 'shell', remember: ['once', 'session', 'always'] };
  const list = rows(tool);
  assert.deepEqual(
    list.map((row) => [row.label, row.decision.remember ?? '']),
    [
      ['Allow just once', ''],
      ['Allow for this conversation', 'session'],
      ['Always allow', 'always'],
      ['Deny', ''],
    ]
  );
  assert.equal(
    list[1].desc,
    "shell won't ask again in this conversation until you close, delete, or reset it, change its agent, or restart the app."
  );
  assert.equal(list[2].desc, "shell won't ask again for any agent, in any conversation");
  // Once only: no standing choice at all.
  assert.deepEqual(
    rows({ kind: 'approval', name: 'shell', remember: ['once'] }).map((row) => row.label),
    ['Allow just once', 'Deny']
  );
});

test('each remembered choice names what is stored: the action category for category grants and the tool for tool grants', () => {
  const rows = (approval) => approvalCardRows(approvalCardModel(approval), { agentName: 'Mailer', officeLabel: '' });
  // A bot's outbound category grant covers any tool of that action category.
  const categorySend = rows({
    kind: 'outbound',
    name: 'mcp__gmail-2__send_email',
    grantAction: 'email',
    outbound: { category: 'email' },
    remember: ['once', 'session', 'agent'],
  });
  assert.deepEqual(
    categorySend.map((row) => [row.label, row.decision.remember ?? '']),
    [
      ['Allow just once', ''],
      ['Allow for this conversation', 'session'],
      ['Allow for this agent', 'agent'],
      ['Deny', ''],
    ]
  );
  assert.equal(
    categorySend[1].desc,
    "Send an email from any tool won't ask again in this conversation until you close, delete, or reset it, change its agent, or restart the app."
  );
  assert.equal(categorySend[2].desc, "Send an email from any tool won't ask again for Mailer, in any conversation");
  for (const row of categorySend) {
    assert.ok(!/send_email|gmail/.test(row.desc ?? ''), `${row.label}: ${row.desc}`);
  }
  // An outbound card without grantAction still describes its outbound action category.
  const implicitCategory = rows({
    kind: 'outbound',
    name: 'github',
    outbound: { category: 'comment' },
    remember: ['once', 'agent'],
  });
  assert.equal(implicitCategory[1].desc, "Post a comment from any tool won't ask again for Mailer, in any conversation");
  // A per-tool grant (e.g. a hook ask on an outbound call) names that tool, never the category.
  const toolSend = rows({
    kind: 'outbound',
    name: 'mcp__gmail-2__send_email',
    grantAction: 'tool:mcp__gmail__send_email',
    outbound: { category: 'email' },
    remember: ['once', 'session', 'agent', 'always'],
  });
  assert.deepEqual(
    toolSend.map((row) => [row.label, row.decision.remember ?? '']),
    [
      ['Allow just once', ''],
      ['Allow for this conversation', 'session'],
      ['Allow for this agent', 'agent'],
      ['Always allow', 'always'],
      ['Deny', ''],
    ]
  );
  assert.equal(
    toolSend[1].desc,
    "send_email (gmail) won't ask again in this conversation until you close, delete, or reset it, change its agent, or restart the app."
  );
  assert.equal(toolSend[2].desc, "send_email (gmail) won't ask again for Mailer, in any conversation");
  assert.equal(toolSend[3].desc, "send_email (gmail) won't ask again for any agent, in any conversation");
  // A hook's ask on a plain tool names that tool.
  const tool = rows({
    kind: 'approval',
    name: 'github',
    grantAction: 'tool:github',
    remember: ['once', 'session', 'always'],
  });
  assert.equal(tool[2].desc, "github won't ask again for any agent, in any conversation");
  for (const row of [...toolSend, ...tool]) {
    assert.ok(!/any tool|Send an email|Post a comment/.test(row.desc ?? ''), `${row.label}: ${row.desc}`);
  }
});
