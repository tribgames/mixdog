import test from 'node:test';
import assert from 'node:assert/strict';

import {
  agentIdFromName,
  availableAgentId,
  availableWorkflowId,
  workflowIdFromName,
} from '../src/session-runtime/workflow.mjs';

test('workflow names produce readable internal IDs without exposing an ID field', () => {
  assert.equal(workflowIdFromName('Daily Review'), 'daily-review');
  assert.equal(workflowIdFromName('  Café_release plan  '), 'cafe-release-plan');
});

test('non-Latin workflow names produce stable opaque internal IDs', () => {
  const id = workflowIdFromName('매일 코드 검토');
  assert.match(id, /^workflow-[a-f0-9]{10}$/);
  assert.equal(workflowIdFromName('매일 코드 검토'), id);
  assert.notEqual(workflowIdFromName('주간 코드 검토'), id);
});

test('duplicate generated workflow IDs receive the first free numeric suffix', () => {
  const taken = new Set(['daily-review', 'daily-review-2', 'daily-review-3']);
  assert.equal(availableWorkflowId('daily-review', (id) => taken.has(id)), 'daily-review-4');
  assert.equal(availableWorkflowId('new-plan', (id) => taken.has(id)), 'new-plan');
});

test('agent names produce hidden internal IDs with non-Latin and duplicate handling', () => {
  assert.equal(agentIdFromName('Release Reviewer'), 'release-reviewer');
  const opaque = agentIdFromName('릴리스 검토자');
  assert.match(opaque, /^agent-[a-f0-9]{10}$/);
  assert.equal(agentIdFromName('릴리스 검토자'), opaque);
  const taken = new Set(['release-reviewer', 'release-reviewer-2']);
  assert.equal(availableAgentId('Release Reviewer', (id) => taken.has(id)), 'release-reviewer-3');
});
