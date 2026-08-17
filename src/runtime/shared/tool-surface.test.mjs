import assert from 'node:assert/strict';
import test from 'node:test';

import {
  aggregateDoneCategories,
  formatAggregateHeader,
  formatToolActionHeader,
  toolLoadingTargets,
} from './tool-surface.mjs';
import { deriveToolCardModel } from './tool-card-model.mjs';

test('git has a first-class completed action label', () => {
  const args = { command: 'git status --short' };
  const categories = aggregateDoneCategories([
    { name: 'git', args },
  ]);

  assert.equal(formatAggregateHeader(categories), 'Ran 1 Git command');
  assert.equal(formatToolActionHeader('git', args), 'Ran 1 Git command');
});

test('git batches aggregate without falling through to unknown tools', () => {
  const header = formatAggregateHeader(aggregateDoneCategories([
    { name: 'git', args: { command: 'git status --short' } },
    { name: 'git', args: { command: 'git diff --stat' } },
  ]));

  assert.equal(header, 'Ran 2 Git commands');
  assert.doesNotMatch(header, /Called .* tool/);
});

test('agent spawn and terminal result use distinct lifecycle labels', () => {
  assert.equal(
    formatToolActionHeader('agent', { type: 'spawn', tag: 'review' }),
    'Called 1 agent',
  );
  assert.equal(
    formatToolActionHeader('agent', { type: 'result', status: 'completed', task_id: 'task-agent-1' }),
    'Completed 1 agent',
  );
  assert.equal(
    formatAggregateHeader(aggregateDoneCategories([
      { name: 'agent', args: { type: 'result', status: 'completed', task_id: 'task-agent-1' } },
    ])),
    'Completed 1 agent',
  );
});

test('deferred tool headers list every selected tool in input order', () => {
  const args = { names: ['grep', 'code_graph', 'grep', 'memory'] };
  assert.deepEqual(toolLoadingTargets('load_tool', args), ['grep', 'code_graph', 'memory']);
  assert.equal(formatToolActionHeader('load_tool', args, { pending: true }), 'Loading grep, code_graph, memory');
  assert.equal(formatToolActionHeader('load_tool', args), 'Loaded grep, code_graph, memory');
});

test('skill headers show the loaded skill name', () => {
  assert.equal(
    formatToolActionHeader('Skill', { name: 'gamerscroll-article' }, { pending: true }),
    'Loading gamerscroll-article',
  );
  assert.equal(
    formatToolActionHeader('Skill', { name: 'gamerscroll-article' }),
    'Loaded gamerscroll-article',
  );
});

test('aggregate loading cards preserve comma-separated tool and skill names', () => {
  const model = deriveToolCardModel({
    name: '__aggregate__',
    aggregate: true,
    args: { loadingTargets: ['grep', 'setup', 'memory'] },
    categories: { Load: 2, Skill: 1 },
    doneCategories: { Load: 2, Skill: 1 },
    count: 3,
    completedCount: 3,
    result: 'Finished',
  });
  assert.equal(model.labelText, 'Loaded grep, setup, memory');
});
