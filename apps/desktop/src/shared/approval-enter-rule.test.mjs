// The decision a notification's Allow records is the decision the card's 한 번만 허용 sends (approval-enter-rule.ts
// `approvalAllowOnceDecision`). The core answers a phone's Allow with its own copy of this rule (mixdog-core-session
// `approval_notification.rs`, tested there against Node's recorded answers, approval_notification_tests.rs
// `a_notifications_allow_and_deny_answer_as_nodes`); these cases are the JS half, written from the rule, so the two cannot drift
// unseen: change one, change the other.
import assert from 'node:assert/strict';
import test from 'node:test';
import { approvalAllowOnceDecision, approvalEnterAllowsOnce } from './approval-enter-rule.ts';

const permission = (...scopes) => ({ kind: 'permission', permission: { scopes } });

test('a tool or outbound approval is allowed once with a bare allow; an Office commit says approve', () => {
  assert.deepEqual(approvalAllowOnceDecision({ kind: 'approval', name: 'shell', args: { command: 'npm test' } }), {
    approved: true,
  });
  assert.deepEqual(approvalAllowOnceDecision({ kind: 'outbound', outbound: { category: 'comment' } }), {
    approved: true,
  });
  assert.deepEqual(
    approvalAllowOnceDecision({ name: 'shell' }),
    { approved: true },
    'a card without a kind is a tool approval'
  );
  assert.deepEqual(approvalAllowOnceDecision({ kind: 'approval', name: 'Office', args: { action: 'Commit' } }), {
    approved: true,
    response: 'approve',
  });
});

test('a permission is allowed once with its narrowest once-type option, the first of that kind', () => {
  assert.deepEqual(
    approvalAllowOnceDecision(
      permission(
        { id: 'a', kind: 'allow_always' },
        { id: 's', kind: 'allow_session' },
        { id: 'o', kind: 'allow_once' },
        { id: 'o2', kind: 'allow_once' }
      )
    ),
    { approved: true, scope: 'o' }
  );
  assert.deepEqual(
    approvalAllowOnceDecision(permission({ id: 'a', kind: 'allow_always' }, { id: 's', kind: 'allow_session' })),
    { approved: true, scope: 's' }
  );
  assert.deepEqual(
    approvalAllowOnceDecision(permission({ id: 'once' })),
    { approved: true, scope: 'once' },
    'a scope without a kind is read by its id'
  );
});

test('what a bare Enter does not allow has no once decision', () => {
  for (const approval of [
    { kind: 'outbound', outbound: { category: 'payment' } },
    { kind: 'outbound', outbound: { category: 'delete' } },
    { kind: 'approval', name: 'office', args: { action: 'rollback' } },
    { kind: 'approval', name: 'office', args: { action: 'discard' } },
    { kind: 'connector' },
    permission({ id: 'always', kind: 'allow_always' }),
    permission({ id: 'no', kind: 'reject' }),
    { kind: 'takeover' },
    { kind: 'secret' },
    { kind: 'question' },
    { kind: 'something-new' },
    null,
  ]) {
    assert.equal(approvalAllowOnceDecision(approval), null, JSON.stringify(approval));
    assert.equal(approvalEnterAllowsOnce(approval), false, JSON.stringify(approval));
  }
});
