import test from 'node:test';
import assert from 'node:assert/strict';

import {
  appendLiveTranscriptRows,
  projectSettledTranscriptRows,
} from './transcript-rows.ts';
import {
  desktopToolActivityCategorySummary,
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
