import test from 'node:test';
import assert from 'node:assert/strict';

import {
  appendLiveTranscriptRows,
  projectSettledTranscriptRows,
} from './transcript-rows.ts';
import {
  desktopToolActivityCategory,
  desktopToolActivityCategoryGroups,
  desktopToolActivityCategorySummary,
  desktopToolActivityItemPresentation,
  flattenedToolActivityItems,
  formatTokenCount,
} from './TranscriptView.tsx';

function project(items, turnKeys = items.map(() => 'turn')) {
  return projectSettledTranscriptRows({
    sessionKey: 'session',
    items,
    turnKeys,
    failedTurns: new Set(),
  });
}

test('formats desktop token counts with compact uppercase units', () => {
  assert.equal(formatTokenCount(999), '999');
  assert.equal(formatTokenCount(78_087), '78.1K');
  assert.equal(formatTokenCount(272_000), '272K');
  assert.equal(formatTokenCount(1_200_000), '1.2M');
});

test('groups consecutive mixed-category tools into one activity row', () => {
  const shell = { kind: 'tool', id: 'shell', name: 'shell', result: 'ok' };
  const search = { kind: 'tool', id: 'search', name: 'grep', result: 'ok' };
  const rows = project([shell, search]).rows;

  assert.equal(rows.length, 1);
  assert.equal(rows[0]._tag, 'ToolActivity');
  assert.deepEqual(rows[0].items, [shell, search]);
});

test('a visible assistant message seals the current tool activity run', () => {
  const first = { kind: 'tool', id: 'first', name: 'read', result: 'ok' };
  const message = { kind: 'assistant', id: 'message', text: 'Next check.' };
  const second = { kind: 'tool', id: 'second', name: 'shell', result: 'ok' };
  const rows = project([first, message, second]).rows;

  assert.deepEqual(rows.map((row) => row._tag), [
    'ToolActivity',
    'AssistantPart',
    'ToolActivity',
  ]);
  assert.deepEqual(rows[0].items, [first]);
  assert.deepEqual(rows[2].items, [second]);
});

test('thinking remains a separate row after grouped tool activity', () => {
  const settled = project([
    { kind: 'tool', id: 'tool', name: 'shell', result: 'ok' },
  ]);
  const rows = appendLiveTranscriptRows({
    sessionKey: 'session',
    settled,
    thinking: true,
  });

  assert.deepEqual(rows.map((row) => row._tag), ['ToolActivity', 'Thinking']);
});

test('desktop activity expansion flattens aggregate members in call order', () => {
  const read = { kind: 'tool', id: 'read', name: 'read', args: { file_path: 'a.ts' }, result: 'A' };
  const search = { kind: 'tool', id: 'search', name: 'grep', args: { pattern: 'x' }, result: 'B' };
  const shell = { kind: 'tool', id: 'shell', name: 'shell', result: 'C' };
  const aggregate = {
    kind: 'tool',
    id: 'aggregate',
    aggregate: true,
    toolMembers: [read, search],
  };

  assert.deepEqual(flattenedToolActivityItems([aggregate, shell]), [read, search, shell]);
});

test('desktop activity summary merges work units into localized categories', () => {
  const categories = {
    'Read|Reading|Read|file|files': { category: 'Read', count: 2 },
    'Search|Searching|Searched|pattern|patterns': { category: 'Search', count: 3 },
    'unknown': { category: 'Custom', count: 1 },
  };
  assert.equal(
    desktopToolActivityCategorySummary(categories, Object.keys(categories)),
    'File reading 2 · Search 3 · External tools 1',
  );
});

test('desktop activity drills through repeated categories but keeps singleton tools direct', () => {
  const groups = desktopToolActivityCategoryGroups([
    { kind: 'tool', id: 'git-1', name: 'git', args: { command: 'git status' }, result: 'clean' },
    { kind: 'tool', id: 'shell-1', name: 'shell', args: { command: 'npm test' }, result: 'ok' },
    { kind: 'tool', id: 'git-2', name: 'git', args: { command: 'git diff' }, result: 'diff' },
  ]);

  assert.deepEqual(groups.map(({ category, count, items }) => ({
    category,
    count,
    ids: items.map((item) => item.id),
  })), [
    { category: 'Git', count: 2, ids: ['git-1', 'git-2'] },
    { category: 'Shell', count: 1, ids: ['shell-1'] },
  ]);
});

test('desktop activity normalizes common provider tool aliases', () => {
  assert.equal(desktopToolActivityCategory('write', { filePath: 'src/a.ts' }), 'Patch');
  assert.equal(desktopToolActivityCategory('patch', { patch: '*** Begin Patch' }), 'Patch');
  assert.equal(desktopToolActivityCategory('webfetch', { url: 'https://example.com' }), 'Web Research');
  assert.equal(desktopToolActivityCategory('websearch', { query: 'mixdog' }), 'Web Research');
  assert.equal(desktopToolActivityCategory('question', { questions: [] }), 'Setup');
  assert.equal(desktopToolActivityCategory('todowrite', { todos: [] }), 'Setup');
});

test('desktop activity item headers remove atomic counts and represented argument keys', () => {
  const git = desktopToolActivityItemPresentation({
    kind: 'tool',
    id: 'git',
    name: 'git',
    args: { command: 'git status --short' },
    result: 'clean',
    rawResult: 'clean',
    completedAt: 1,
  });
  assert.equal(git.title, 'Git');
  assert.equal(git.subject, 'git status --short');
  assert.equal(git.resultLabel, '');
  assert.deepEqual(git.fields, []);
  assert.doesNotMatch(`${git.title} ${git.subject} ${git.resultLabel}`, /1 Git command|command=|Finished/);

  const edit = desktopToolActivityItemPresentation({
    kind: 'tool',
    id: 'edit',
    name: 'edit',
    args: {
      file_path: 'src/a.ts',
      old_string: 'old',
      new_string: 'new',
      replace_all: false,
    },
    result: 'updated',
    completedAt: 1,
  });
  assert.equal(edit.title, 'Edit');
  assert.equal(edit.subject, 'src/a.ts');
  assert.equal(edit.beforeText, 'old');
  assert.equal(edit.afterText, 'new');
  assert.deepEqual(edit.fields, []);
});

test('desktop activity renders plans, todos, and questions as structured rows', () => {
  const plan = desktopToolActivityItemPresentation({
    kind: 'tool',
    id: 'plan',
    name: 'update_plan',
    args: {
      plan: [
        { step: 'Check', status: 'completed' },
        { step: 'Ship', status: 'in_progress' },
      ],
    },
    result: 'Updated',
    completedAt: 1,
  });
  assert.equal(plan.structuredKind, 'plan');
  assert.equal(plan.resultLabel, '1/2');
  assert.deepEqual(plan.structuredRows.map(({ text, status }) => ({ text, status })), [
    { text: 'Check', status: 'completed' },
    { text: 'Ship', status: 'in_progress' },
  ]);

  const question = desktopToolActivityItemPresentation({
    kind: 'tool',
    id: 'question',
    name: 'question',
    args: { questions: [{ question: 'Choose?' }] },
    result: 'A',
    completedAt: 1,
  });
  assert.equal(question.structuredKind, 'questions');
  assert.equal(question.resultLabel, '1/1');
  assert.equal(question.structuredRows[0].answer, 'A');
});

test('desktop activity masks secret fields and keeps routine load results collapsed', () => {
  const unknown = desktopToolActivityItemPresentation({
    kind: 'tool',
    id: 'secret',
    name: 'unknown_tool',
    args: { foo: 'bar', api_key: 'secret' },
    result: 'ok',
    completedAt: 1,
  });
  assert.equal(unknown.subject, 'foo=bar · api_key=••••••');
  assert.equal(unknown.fields.find((field) => field.key === 'api_key')?.value, '••••••');

  const skill = desktopToolActivityItemPresentation({
    kind: 'tool',
    id: 'skill',
    name: 'skill',
    args: { name: 'setup' },
    result: 'Loaded skill',
    completedAt: 1,
  });
  assert.equal(skill.title, 'Skill');
  assert.equal(skill.subject, 'setup');
  assert.equal(skill.resultLabel, '');
  assert.equal(skill.hasDetails, false);
});

test('desktop activity keeps failures visible and suppresses image marker bodies', () => {
  const failed = desktopToolActivityItemPresentation({
    kind: 'tool',
    id: 'failed',
    name: 'shell',
    args: { command: 'npm test' },
    result: 'Error: tests failed',
    rawResult: 'Error: tests failed',
    isError: true,
    completedAt: 1,
  });
  assert.equal(failed.tone, 'error');
  assert.match(failed.resultLabel, /tests failed/i);
  assert.equal(failed.outputText, 'Error: tests failed');

  const image = desktopToolActivityItemPresentation({
    kind: 'tool',
    id: 'image',
    name: 'view_image',
    args: { path: 'shot.png' },
    result: '[image: shot.png]',
    completedAt: 1,
  });
  assert.equal(image.title, 'Image');
  assert.equal(image.resultLabel, 'Image');
  assert.equal(image.hasDetails, false);
});
