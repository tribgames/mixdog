import assert from 'node:assert/strict';
import test from 'node:test';
import { formatHookDenialDetail, isHookApprovalDenialToolItem } from './transcript-tool-failures.mjs';

test('a not-approved call stays a visible denial; its model instruction is not shown', () => {
  const result =
    'Error: tool "github" was not approved: denied by user. Do not retry it or reach the same result another way; report it.';
  assert.equal(isHookApprovalDenialToolItem({ kind: 'tool', isError: true, result }), true);
  assert.equal(formatHookDenialDetail(result), 'was not approved: denied by user.');
  const hook = 'Error: tool "shell" denied by hook: blocked';
  assert.equal(isHookApprovalDenialToolItem({ kind: 'tool', isError: true, result: hook }), true);
  assert.equal(formatHookDenialDetail(hook), 'denied by hook: blocked');
});
