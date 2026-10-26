import assert from 'node:assert/strict';
import test from 'node:test';

import {
  highlightSourceLines,
  visualizePaneHasSource,
  visualizeSourceFileName,
  visualizeSourceLanguage,
} from './visualize-source.ts';

const text = (lines) => lines.map((line) => line.map((token) => token.text).join(''));

test('only HTML pages and inline content have a source; binary kinds do not', () => {
  assert.equal(visualizePaneHasSource({ kind: 'html' }), true);
  assert.equal(visualizePaneHasSource({ kind: 'inline', inline: { kind: 'mermaid', source: 'x' } }), true);
  assert.equal(visualizePaneHasSource({ kind: 'html', inline: { kind: 'chart', source: '{}' } }), true);
  for (const kind of ['pdf', 'image', 'video', 'audio', 'document']) {
    assert.equal(visualizePaneHasSource({ kind }), false, kind);
  }
});

test('languages follow the inline kind; Mermaid has none', () => {
  assert.equal(visualizeSourceLanguage(undefined), 'xml');
  assert.deepEqual(['html', 'svg', 'chart', 'markdown', 'mermaid'].map(visualizeSourceLanguage), [
    'xml',
    'xml',
    'json',
    'markdown',
    '',
  ]);
});

test('highlighted lines keep every character, split on newlines, and carry token classes', () => {
  const source = '<div class="a">\n  <b>hi</b>\n</div>\n';
  const lines = highlightSourceLines(source, 'xml');
  assert.deepEqual(text(lines), ['<div class="a">', '  <b>hi</b>', '</div>']);
  const classes = lines.flat().flatMap((token) => token.classes);
  assert.ok(
    classes.some((className) => className.includes('hljs-tag')),
    'markup is highlighted'
  );
  assert.ok(classes.some((className) => className.includes('hljs-string')));
});

test('JSON highlights, and a string spanning lines is split per line', () => {
  const lines = highlightSourceLines('{\n  "series": [1, 2]\n}', 'json');
  assert.deepEqual(text(lines), ['{', '  "series": [1, 2]', '}']);
  assert.ok(lines[1].some((token) => token.classes.some((className) => className.includes('hljs-attr'))));
});

test('unknown or empty languages and empty sources give plain lines', () => {
  assert.deepEqual(highlightSourceLines('graph TD\n  A-->B', ''), [
    [{ text: 'graph TD', classes: [] }],
    [{ text: '  A-->B', classes: [] }],
  ]);
  assert.deepEqual(text(highlightSourceLines('a\nb', 'no-such-language')), ['a', 'b']);
  assert.deepEqual(highlightSourceLines('', 'xml'), [[]]);
  assert.deepEqual(text(highlightSourceLines('a\n\nb', '')), ['a', '', 'b'], 'blank lines stay');
});

test('downloaded source gets a safe name with the right extension', () => {
  assert.equal(visualizeSourceFileName({ label: 'Flow', inline: { kind: 'mermaid', source: '' } }), 'Flow.mmd');
  assert.equal(visualizeSourceFileName({ label: 'a/b: c', inline: { kind: 'svg', source: '' } }), 'a-b- c.svg');
  assert.equal(visualizeSourceFileName({ label: 'index.html' }), 'index.html');
  assert.equal(visualizeSourceFileName({ label: 'Plan', inline: { kind: 'markdown', source: '' } }), 'Plan.md');
});
