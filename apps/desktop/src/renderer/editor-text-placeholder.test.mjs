import test from 'node:test';
import assert from 'node:assert/strict';

import { peekEditorFileLoad, takeEditorFileLoad } from './editor-file-loader.ts';
import { editorPlaceholderLines, editorTextPlaceholderEligible } from './editor-text-placeholder.tsx';

test('only files that open in the Monaco source view get a text cover', () => {
  assert.equal(editorTextPlaceholderEligible('src/app.ts'), true);
  assert.equal(editorTextPlaceholderEligible('Makefile'), true);
  // Rendered kinds, previews and documents open in a different view.
  assert.equal(editorTextPlaceholderEligible('README.md'), false);
  assert.equal(editorTextPlaceholderEligible('logo.svg'), false);
  assert.equal(editorTextPlaceholderEligible('data.csv'), false);
  assert.equal(editorTextPlaceholderEligible('photo.png'), false);
  assert.equal(editorTextPlaceholderEligible('report.docx'), false);
});

test('cover lines are bounded but the line count covers the whole file', () => {
  const content = Array.from({ length: 5000 }, (_, index) => `line ${index}`).join('\n');
  const { lines, lineCount } = editorPlaceholderLines(content);
  assert.equal(lineCount, 5000);
  assert.equal(lines.length, 160);
  assert.equal(lines[0], 'line 0');
  assert.equal(lines[159], 'line 159');
});

test('cover lines drop CR endings and cap very long lines', () => {
  const { lines, lineCount } = editorPlaceholderLines(`a\r\n${'x'.repeat(1000)}\nlast`);
  assert.equal(lineCount, 3);
  assert.deepEqual(lines, ['a', 'x'.repeat(400), 'last']);
  assert.deepEqual(editorPlaceholderLines(''), { lines: [''], lineCount: 1 });
  assert.deepEqual(editorPlaceholderLines('one\n'), { lines: ['one', ''], lineCount: 2 });
});

test('the text cover and the editor session share one file read', async () => {
  let reads = 0;
  const api = {
    readProjectFile: async () => {
      reads += 1;
      return { content: 'hello\n', mtimeMs: 1, binary: false, tooLarge: false, encoding: 'utf8' };
    },
    readEditorBackup: async () => null,
  };
  const cover = peekEditorFileLoad(api, '/p', 'src/shared-read.ts');
  assert.equal(peekEditorFileLoad(api, '/p', 'src/shared-read.ts'), cover);
  // The editor session takes the entry the cover left in place.
  const session = takeEditorFileLoad(api, '/p', 'src/shared-read.ts', undefined, true, true);
  assert.equal(session, cover);
  assert.equal((await session).file.content, 'hello\n');
  assert.equal(reads, 1);
});
