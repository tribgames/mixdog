// A code block's content is cut into stretches of lines that render to the
// same text and highlighting as the content whole.
import assert from 'node:assert/strict';
import test from 'node:test';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { lineStretches } from './markdown-code-lines';

const span = (className, ...children) => React.createElement('span', { className, key: className }, ...children);
const markupOf = (children) => renderToStaticMarkup(React.createElement(React.Fragment, null, ...children));
const textOf = (markup) => markup.replace(/<[^>]*>/g, '');

test('stretches end after a line break and hold every line once', () => {
  const lines = Array.from({ length: 10 }, (_, index) => (index % 4 === 3 ? '' : `line ${index}`));
  const text = `${lines.join('\n')}\n`;
  const stretches = lineStretches(text, 4);

  assert.deepEqual(
    stretches.map((stretch) => markupOf(stretch.children)),
    ['line 0\nline 1\nline 2\n\n', 'line 4\nline 5\nline 6\n\n', 'line 8\nline 9\n']
  );
});

test('a last line still arriving is the last stretch', () => {
  assert.deepEqual(
    lineStretches('a\nb\nc', 2).map((stretch) => markupOf(stretch.children)),
    ['a\nb\n', 'c']
  );
  assert.equal(lineStretches('', 2).length, 1, 'code without text is one empty stretch');
});

test('an element a stretch ends in closes there and opens again in the next', () => {
  const children = [
    span('keyword', 'const'),
    ' a = 1;\n',
    span('comment', '/* one\n', span('doc', 'two\nthree\nfour'), '\nfive */'),
    '\nend\n',
  ];
  const stretches = lineStretches(children, 2);

  assert.deepEqual(
    stretches.map((stretch) => markupOf(stretch.children)),
    [
      '<span class="keyword">const</span> a = 1;\n<span class="comment">/* one\n</span>',
      '<span class="comment"><span class="doc">two\nthree\n</span></span>',
      '<span class="comment"><span class="doc">four</span>\nfive */</span>\n',
      'end\n',
    ]
  );
  assert.equal(stretches.map((stretch) => textOf(markupOf(stretch.children))).join(''), textOf(markupOf(children)));
});

test('an element that ends on a stretch boundary is not opened again empty', () => {
  const stretches = lineStretches([span('comment', '// a\n// b\n'), 'c\n'], 2);
  assert.deepEqual(
    stretches.map((stretch) => markupOf(stretch.children)),
    ['<span class="comment">// a\n// b\n</span>', 'c\n']
  );
});

test('a stretch is told from one that renders otherwise', () => {
  const [first, second] = lineStretches('same\nsame\nsame\nsame\nother\nsame\n', 2);
  assert.equal(second.hash, first.hash, 'the same lines elsewhere');
  assert.notEqual(lineStretches('same\nsame\nother\nsame\n', 2)[1].hash, first.hash, 'other text');

  const [keyword] = lineStretches([span('keyword', 'same\n'), 'same\n'], 2);
  assert.notEqual(keyword.hash, first.hash, 'the same text highlighted');
  assert.notEqual(lineStretches([span('comment', 'same\n'), 'same\n'], 2)[0].hash, keyword.hash, 'under another class');
  assert.notEqual(lineStretches([span('keyword', 'same\nsa'), 'me\n'], 2)[0].hash, keyword.hash, 'over other text');

  // An element opened in an earlier stretch tells the later ones too.
  const within = lineStretches([span('comment', 'a\nb\nsame\nsame\n')], 2);
  assert.notEqual(within[1].hash, first.hash);
});
