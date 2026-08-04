import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeHookUpdatedToolOutput,
  resolveToolResultAfterHook,
} from '../src/runtime/agent/orchestrator/session/loop.mjs';

const structuredImage = {
  content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abc' } }],
};

test('resolveToolResultAfterHook leaves original result when hook omits override', () => {
  assert.equal(resolveToolResultAfterHook('tool body', {}), 'tool body');
  assert.equal(resolveToolResultAfterHook('tool body', { blocked: undefined }), 'tool body');
  assert.deepEqual(resolveToolResultAfterHook(structuredImage, {}), structuredImage);
});

test('resolveToolResultAfterHook does not treat updatedToolOutput undefined as override', () => {
  assert.equal(resolveToolResultAfterHook('keep-me', { updatedToolOutput: undefined }), 'keep-me');
  assert.deepEqual(resolveToolResultAfterHook(structuredImage, { updatedToolOutput: undefined }), structuredImage);
});

test('resolveToolResultAfterHook applies intentional empty-string override', () => {
  assert.equal(resolveToolResultAfterHook('tool body', { updatedToolOutput: '' }), '');
});

test('resolveToolResultAfterHook preserves structured tool output when no override', () => {
  const original = {
    content: [
      { type: 'text', text: 'page 1' },
      { type: 'image', source: { type: 'base64', media_type: 'application/pdf', data: 'pdf' } },
    ],
  };
  assert.deepEqual(resolveToolResultAfterHook(original, null), original);
  assert.deepEqual(resolveToolResultAfterHook(original, { handlersRun: 0 }), original);
});

test('normalizeHookUpdatedToolOutput flattens text-only MCP envelopes for hook overrides', () => {
  assert.equal(
    normalizeHookUpdatedToolOutput({ content: [{ type: 'text', text: 'line1' }, { type: 'text', text: 'line2' }] }),
    'line1\nline2',
  );
});

test('normalizeHookUpdatedToolOutput keeps structured media blocks on hook override', () => {
  assert.deepEqual(normalizeHookUpdatedToolOutput(structuredImage), structuredImage);
});

