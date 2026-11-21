import assert from 'node:assert/strict';
import test from 'node:test';

import {
  aggregateDoneCategories,
  classifyToolCategory,
  formatAggregateHeader,
  formatToolActionHeader,
  isTaskWaitToolCall,
  summarizeToolArgs,
  toolWorkUnit,
  toolLoadingTargets,
} from '../../src/rows/tool-surface.mjs';
import { deriveToolCardModel } from '../../src/rows/tool-card-model.mjs';
import { codeGraphLabel } from '../../src/rows/tool-primitives.mjs';

test('git has a first-class completed action label', () => {
  const args = { command: 'git status --short' };
  const categories = aggregateDoneCategories([{ name: 'git', args }]);

  assert.equal(formatAggregateHeader(categories), 'Ran 1 Git command');
  assert.equal(formatToolActionHeader('git', args), 'Ran 1 Git command');
});

test('git batches aggregate without falling through to unknown tools', () => {
  const header = formatAggregateHeader(
    aggregateDoneCategories([
      { name: 'git', args: { command: 'git status --short' } },
      { name: 'git', args: { command: 'git diff --stat' } },
    ])
  );

  assert.equal(header, 'Ran 2 Git commands');
  assert.doesNotMatch(header, /Called .* tool/);
});

test('agent spawn and terminal result use distinct lifecycle labels', () => {
  assert.equal(formatToolActionHeader('agent', { type: 'spawn', tag: 'review' }), 'Called 1 agent');
  assert.equal(
    formatToolActionHeader('agent', { type: 'result', status: 'completed', task_id: 'task-agent-1' }),
    'Completed 1 agent'
  );
  assert.equal(
    formatAggregateHeader(
      aggregateDoneCategories([
        { name: 'agent', args: { type: 'result', status: 'completed', task_id: 'task-agent-1' } },
      ])
    ),
    'Completed 1 agent'
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
    'Loading gamerscroll-article'
  );
  assert.equal(formatToolActionHeader('Skill', { name: 'gamerscroll-article' }), 'Loaded gamerscroll-article');
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

test('code_graph categories use the shared mode policy', () => {
  for (const args of [
    { mode: 'search' },
    { action: 'find_symbol' },
    { mode: 'prewarm' },
    { mode: 'index' },
    { mode: 'build' },
    { mode: 'refresh' },
    { mode: 'references' },
    {},
  ]) {
    assert.equal(classifyToolCategory('code_graph', args), codeGraphLabel(args));
  }
  assert.equal(classifyToolCategory('code_graph', { mode: 'search' }), 'Search');
  assert.equal(classifyToolCategory('code_graph', { mode: 'prewarm' }), 'Setup');
  assert.equal(classifyToolCategory('code_graph', {}), 'Read');
});

test('task wait display policy is scoped to the wait action', () => {
  assert.equal(isTaskWaitToolCall('task', { action: 'wait', task_id: 'task_1' }), true);
  assert.equal(isTaskWaitToolCall('functions.task', '{"action":"WAIT","task_id":"task_1"}'), true);
  assert.equal(isTaskWaitToolCall('task', { action: 'read', task_id: 'task_1' }), false);
  assert.equal(isTaskWaitToolCall('shell', { action: 'wait' }), false);
});

test('desktop-specialized tools share their category and work-unit identity', () => {
  for (const [name, category] of [
    ['browser', 'Browser'],
    ['browser_devtools', 'Browser'],
    ['computer', 'Computer'],
    ['office', 'Office'],
    ['media', 'Media'],
    ['tidy', 'Tidy'],
    ['bridge', 'Agent'],
  ]) {
    assert.equal(classifyToolCategory(name), category);
    assert.equal(toolWorkUnit(name).category, category);
  }
});

test('goal, plan, reaction, handoff, terminal run and session close each read as their own work', () => {
  const header = (name, args) => formatToolActionHeader(name, args);
  assert.equal(classifyToolCategory('goal', { action: 'complete' }), 'Goal');
  assert.equal(header('goal', { action: 'complete' }), 'Completed 1 goal');
  // One todo call is one plan update, whatever number of steps it carries.
  assert.equal(header('todo', { op: 'set', items: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] }), 'Updated 1 plan');
  assert.equal(header('react', { emoji: '👍' }), 'Reacted 1 message');
  assert.equal(header('handoff_user', { handoff: { kind: 'takeover', need: 'sign_in' } }), 'Handed over 1 step to user');
  assert.equal(header('terminal', { action: 'run', command: 'npm run dev' }), 'Ran 1 terminal command');
  assert.equal(header('terminal', { action: 'read', tab: 1 }), 'Read 1 terminal output');
  assert.equal(header('session', { action: 'close' }), 'Closed 1 session');
  assert.equal(header('session', { action: 'list-worktrees' }), 'Listed 1 worktree');
  assert.equal(summarizeToolArgs('todo', { op: 'advance', note: 'shot taken' }), 'advance · shot taken');
  assert.equal(summarizeToolArgs('react', { emoji: '👍' }), '👍');
});

test('a GitHub action without a phrase of its own still reads as English', () => {
  assert.equal(summarizeToolArgs('github', { action: 'release.list' }), 'List releases');
  assert.equal(summarizeToolArgs('github', { action: 'notification.list' }), 'List notifications');
  assert.equal(summarizeToolArgs('github', { action: 'pr.list', repo: 'a/b' }), 'List PRs a/b');
  assert.equal(summarizeToolArgs('github', { action: 'pr.checkout', number: 4 }), 'Check out PR 4');
  assert.equal(summarizeToolArgs('github', { action: 'run.rerun', id: 9 }), 'Rerun 9');
});
