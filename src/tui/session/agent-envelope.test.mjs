import assert from 'node:assert/strict';
import test from 'node:test';

import { agentJobResultText, parseAgentResultEnvelope } from './agent-envelope.mjs';

test('agent result attributes preserve quotes, case folding, last values, and result text', () => {
  const text = [
    'Agent Result agent="Worker One" tag=old TAG=\'review pass\' task_id=task-7 status=FAILED',
    '<result>',
    '  first line',
    'second line  ',
    '</result>',
  ].join('\n');

  assert.deepEqual(parseAgentResultEnvelope(text), {
    name: 'agent',
    label: 'failed',
    args: {
      type: 'result',
      status: 'FAILED',
      task_id: 'task-7',
      tag: 'review pass',
      agent: 'Worker One',
      provider: undefined,
      model: undefined,
      preset: undefined,
      effort: undefined,
      fast: undefined,
    },
    result: 'first line\nsecond line',
    isError: true,
  });
});

test('agent result fallbacks retain field precedence and an explicit false fast flag', () => {
  const parsed = parseAgentResultEnvelope(
    'agent result agent=Worker status=failed taskid=local tag=wire provider=wire model=small preset=wire effort=high fast=on',
    {
      status: 'completed',
      taskId: 'remote',
      tag: 'review',
      agent: 'Fallback',
      provider: 'hosted',
      model: 'large',
      preset: 'balanced',
      effort: 'low',
      fast: false,
    }
  );

  assert.deepEqual(parsed, {
    name: 'agent',
    label: 'completed',
    args: {
      type: 'result',
      status: 'completed',
      task_id: 'remote',
      tag: 'review',
      agent: 'Worker',
      provider: 'hosted',
      model: 'large',
      preset: 'balanced',
      effort: 'low',
      fast: false,
    },
    result: 'status: completed · task_id: remote',
    isError: false,
  });
});

test('agent result headers without attributes retain route defaults and reject other prose', () => {
  const parsed = parseAgentResultEnvelope('agent result api/model-v1');
  assert.equal(parsed.args.provider, 'api');
  assert.equal(parsed.args.model, 'model-v1');
  assert.equal(parsed.label, 'completed');
  assert.equal(parsed.result, 'status: completed');
  assert.equal(parsed.isError, false);
  for (const text of ['', 'ordinary agent result status=failed', 'agent results status=failed']) {
    assert.equal(parseAgentResultEnvelope(text), null);
  }
});

test('agent job result text preserves body paragraphs and falls back to status without a body', () => {
  assert.equal(
    agentJobResultText('agent task: task-1\nstatus: completed\n\n  final text  \n\nnext paragraph  '),
    'final text  \n\nnext paragraph'
  );
  assert.equal(agentJobResultText('agent task: task-1\nstatus: completed'), 'status: completed · task_id: task-1');
  assert.equal(agentJobResultText(''), '');
});
