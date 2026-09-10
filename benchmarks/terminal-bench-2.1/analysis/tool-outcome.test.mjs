import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyToolOutcome } from './tool-outcome.mjs';

test('loader fulfillment is independent of successful invocation', () => {
  for (const output of [
    'Loaded deferred tools: \nmissing: git, git_stage, github',
    'blocked: browser',
    JSON.stringify({ loaded: ['read'], missing: ['git'] }),
    JSON.stringify({ blocked: [{ name: 'git', reason: 'readonly' }] }),
  ]) {
    assert.equal(classifyToolOutcome({ name: 'load_tool', status: 'completed', output }), 'unfulfilled');
  }
  assert.equal(classifyToolOutcome({
    name: 'load_tool', status: 'completed', output: '{"loaded":["git"],"missing":[],"blocked":[]}',
  }), 'ok');
});

test('command exits use trace evidence or legacy envelope, never arbitrary output prose', () => {
  const item = { name: 'shell', status: 'completed', output: 'the command failed' };
  assert.equal(classifyToolOutcome(item, 127), 'command-failure');
  assert.equal(classifyToolOutcome(item, 0), 'ok');
  assert.equal(classifyToolOutcome({ ...item, output: '[exit code: 1]\nmissing Python' }), 'command-failure');
  assert.equal(classifyToolOutcome({ ...item, output: 'example: [exit code: 1]' }), 'ok');
  assert.equal(classifyToolOutcome({ name: 'read', output: '[exit code: 1]' }), 'ok');
});

test('tool errors and skipped calls stay distinct', () => {
  assert.equal(classifyToolOutcome({ name: 'shell', status: 'failed' }, 1), 'tool-failure');
  assert.equal(classifyToolOutcome({ name: 'read', output: 'Error: file missing' }), 'tool-failure');
  assert.equal(classifyToolOutcome({ name: 'shell', status: 'skipped' }), 'skipped');
});
