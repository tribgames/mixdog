// `readSessionHistory` was an internal host read of a session's stored history, never a transcript read a window, a paired
// phone or a page could make. Whether an attachment belongs to a session is the core's now: desktop/attachment/resolve reads
// the stored history itself (thread/items/list), so no desktop source names the history read any more.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import test from 'node:test';

/** Source files of the app, tests excluded. */
function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx|mjs|js)$/.test(entry.name) && !/\.test\./.test(entry.name) ? [path] : [];
  });
}

test('no desktop source names the history read', () => {
  const root = join(import.meta.dirname, '..');
  const naming = sourceFiles(root)
    .filter((file) => readFileSync(file, 'utf8').includes('readSessionHistory'))
    .map((file) => relative(root, file).split(sep).join('/'))
    .sort();
  assert.deepEqual(naming, []);
});
