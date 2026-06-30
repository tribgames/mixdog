import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  appendPromptHistory,
  buildMergedPromptHistory,
  loadPromptHistory,
  pushSessionPromptHistory,
  promptHistoryKey,
} from './prompt-history-store.mjs';

test('promptHistoryKey normalizes whitespace', () => {
  assert.equal(promptHistoryKey('  hello   world  '), 'hello world');
  assert.equal(promptHistoryKey('   '), '');
});

test('buildMergedPromptHistory prefers session order and dedupes', () => {
  const merged = buildMergedPromptHistory(
    ['newest', 'older'],
    ['stale', 'newest', 'from-disk'],
    50,
  );
  assert.deepEqual(merged, ['newest', 'older', 'from-disk', 'stale']);
});

test('appendPromptHistory persists per cwd across reload', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-prompt-history-'));
  const previous = process.env.MIXDOG_DATA_DIR;
  process.env.MIXDOG_DATA_DIR = dataDir;
  try {
    const cwd = join(dataDir, 'project-a');
    assert.deepEqual(appendPromptHistory(cwd, 'first prompt'), ['first prompt']);
    assert.deepEqual(appendPromptHistory(cwd, 'second prompt'), ['first prompt', 'second prompt']);
    assert.deepEqual(appendPromptHistory(cwd, 'first   prompt'), ['second prompt', 'first   prompt']);
    const loaded = loadPromptHistory(cwd);
    assert.deepEqual(loaded, ['second prompt', 'first   prompt']);
  } finally {
    if (previous === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previous;
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('pushSessionPromptHistory is cwd-session newest-first with dedupe', () => {
  let session = pushSessionPromptHistory([], 'alpha');
  session = pushSessionPromptHistory(session, 'beta');
  session = pushSessionPromptHistory(session, 'alpha');
  assert.deepEqual(session, ['alpha', 'beta']);
});

