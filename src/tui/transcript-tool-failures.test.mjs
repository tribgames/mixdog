import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatHookDenialDetail,
  isFullyFailedToolBatch,
  isHookApprovalDenialToolItem,
  isHookApprovalDenialToolResult,
  shouldSuppressFullyFailedToolItem,
} from './transcript-tool-failures.mjs';

const hookDeniedItem = {
  kind: 'tool',
  name: 'shell',
  args: { command: 'rm -rf /' },
  result: 'Error: tool "shell" denied by hook: approval required but no approval UI is available (policy)',
  isError: true,
  count: 1,
  completedCount: 1,
};

const noisyFailedItem = {
  kind: 'tool',
  name: 'grep',
  args: { pattern: 'foo' },
  result: 'no matches',
  isError: true,
  count: 1,
  completedCount: 1,
};

test('detects hook denial result text', () => {
  assert.equal(
    isHookApprovalDenialToolResult('Error: tool "read" denied by hook: blocked'),
    true,
  );
  assert.equal(
    isHookApprovalDenialToolResult('Error: tool "shell" denied by hook: approval required but no approval UI is available'),
    true,
  );
  assert.equal(isHookApprovalDenialToolResult('grep: no matches'), false);
});

test('fully-failed hook denials are not suppressed', () => {
  assert.equal(isFullyFailedToolBatch(hookDeniedItem), true);
  assert.equal(isHookApprovalDenialToolItem(hookDeniedItem), true);
  assert.equal(shouldSuppressFullyFailedToolItem(hookDeniedItem), false);
});

test('fully-failed non-hook errors stay suppressed', () => {
  assert.equal(isFullyFailedToolBatch(noisyFailedItem), true);
  assert.equal(shouldSuppressFullyFailedToolItem(noisyFailedItem), true);
});

test('formatHookDenialDetail strips tool prefix', () => {
  assert.equal(
    formatHookDenialDetail(hookDeniedItem.result),
    'denied by hook: approval required but no approval UI is available (policy)',
  );
});

