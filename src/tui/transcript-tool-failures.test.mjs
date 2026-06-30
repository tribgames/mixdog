import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatHookDenialDetail,
  hasUsefulFailedToolResultBody,
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

const emptyFailedItem = {
  kind: 'tool',
  name: 'grep',
  args: { pattern: 'foo' },
  result: null,
  rawResult: null,
  isError: true,
  count: 1,
  completedCount: 1,
};

const failedTaskJsonStringArgs = {
  kind: 'tool',
  name: 'shell',
  args: '{"task_id":"t1","status":"failed","error":"boom"}',
  result: null,
  rawResult: null,
  isError: true,
  count: 1,
  completedCount: 1,
};

const failedTaskInputWrapperArgs = {
  kind: 'tool',
  name: 'shell',
  args: { input: { task_id: 't2', status: 'timeout' } },
  result: null,
  rawResult: null,
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

test('fully-failed non-hook errors with visible body stay visible', () => {
  assert.equal(isFullyFailedToolBatch(noisyFailedItem), true);
  assert.equal(hasUsefulFailedToolResultBody(noisyFailedItem), true);
  assert.equal(shouldSuppressFullyFailedToolItem(noisyFailedItem), false);
});

test('fully-failed non-hook errors without useful body stay suppressed', () => {
  assert.equal(isFullyFailedToolBatch(emptyFailedItem), true);
  assert.equal(hasUsefulFailedToolResultBody(emptyFailedItem), false);
  assert.equal(shouldSuppressFullyFailedToolItem(emptyFailedItem), true);
});

test('failed background task with JSON-string args is not suppressed', () => {
  assert.equal(isFullyFailedToolBatch(failedTaskJsonStringArgs), false);
  assert.equal(shouldSuppressFullyFailedToolItem(failedTaskJsonStringArgs), false);
});

test('failed background task with input-wrapped args is not suppressed', () => {
  assert.equal(isFullyFailedToolBatch(failedTaskInputWrapperArgs), false);
  assert.equal(shouldSuppressFullyFailedToolItem(failedTaskInputWrapperArgs), false);
});

test('formatHookDenialDetail strips tool prefix', () => {
  assert.equal(
    formatHookDenialDetail(hookDeniedItem.result),
    'denied by hook: approval required but no approval UI is available (policy)',
  );
});

