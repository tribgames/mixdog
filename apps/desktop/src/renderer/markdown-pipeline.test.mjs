/**
 * markdown-pipeline.test.mjs — desktop/web markdown element coverage.
 *
 * Pins the worker AST pipeline (parseMarkdownToHast) and the streaming source
 * fallback so the two never diverge from the terminal surfaces covered by
 * scripts/markdown-surface-test.mjs.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { JSDOM } from 'jsdom';
import { installTestDom } from './test-support/test-dom.mjs';

import { parseMarkdownToHast } from './markdown-ast';
import { parseStreamingMarkdownAst, preloadSyncMarkdownParser } from './markdown-worker-client';
import MarkdownBody from './MarkdownBody';
import MarkdownAstBody from './MarkdownAstBody';
import { MarkdownSourceFallback } from './MarkdownSourceFallback';
import StreamingMarkdownBody from './StreamingMarkdownBody';
import { healStreamingMarkdownTail } from './streaming-markdown';

function flatten(node) {
  if (node.type === 'text') return JSON.stringify(node.value);
  const tag = node.tagName ? node.tagName : '';
  const children = (node.children ?? []).map(flatten).join(',');
  return tag ? `${tag}(${children})` : children;
}

function ast(source) {
  return parseMarkdownToHast(source).children.map(flatten).join('|');
}

test('strong closes against a punctuation + letter boundary', () => {
  assert.match(ast('**0.118%**tail'), /strong\("0\.118%"\)/);
});

test('strong containing inline code closes before a Korean suffix', () => {
  const rendered = ast('현재 Chrome은 **디시인사이드 `AI 활용 마이너 갤러리`**를 보고 있습니다.');
  assert.match(rendered, /strong\("디시인사이드 ",code\("AI 활용 마이너 갤러리"\)\)/);
  assert.match(rendered, /"를 보고 있습니다\."/);
});

const CopyControl = () => null;
const strongRenderers = {
  settled: (text) => React.createElement(MarkdownBody, { text, copyControl: CopyControl }),
  worker: (text) =>
    React.createElement(MarkdownAstBody, {
      root: parseMarkdownToHast(text),
      copyControl: CopyControl,
    }),
};

for (const [name, render] of Object.entries(strongRenderers)) {
  test(`${name}: strong preserves mixed code and prose before Korean suffixes`, async () => {
    const cases = [
      {
        source: '네, 재영님. **`src/workflows/default/`가 코워크(Cowork)**입니다.',
        // The folder mention keeps its inline code as written.
        text: '네, 재영님. src/workflows/default/가 코워크(Cowork)입니다.',
        strong: ['src/workflows/default/가 코워크(Cowork)'],
        code: ['src/workflows/default/'],
      },
      {
        source: '**앞 `코드` 뒤(설명)**입니다.',
        text: '앞 코드 뒤(설명)입니다.',
        strong: ['앞 코드 뒤(설명)'],
        code: ['코드'],
      },
      {
        source: '**`첫째`와 `둘째`(설명)**입니다.',
        text: '첫째와 둘째(설명)입니다.',
        strong: ['첫째와 둘째(설명)'],
        code: ['첫째', '둘째'],
      },
      {
        source: '**`첫째`**와 **`둘째`(설명)**입니다.',
        text: '첫째와 둘째(설명)입니다.',
        strong: ['첫째', '둘째(설명)'],
        code: ['첫째', '둘째'],
      },
      {
        source: '__앞 `코드` 뒤(설명)__입니다.',
        text: '앞 코드 뒤(설명)입니다.',
        strong: ['앞 코드 뒤(설명)'],
        code: ['코드'],
      },
    ];
    for (const sample of cases) {
      await parseStreamingMarkdownAst(sample.source);
      const dom = new JSDOM(renderToStaticMarkup(render(sample.source)));
      try {
        const { body } = dom.window.document;
        assert.equal(body.textContent, sample.text, sample.source);
        assert.deepEqual(
          [...body.querySelectorAll('strong')].map((node) => node.textContent),
          sample.strong
        );
        assert.deepEqual(
          [...body.querySelectorAll('strong code')].map((node) => node.textContent),
          sample.code
        );
        if (sample.source.includes('src/workflows/default/')) {
          assert.equal(body.querySelector('strong a')?.getAttribute('href'), 'src/workflows/default/');
          assert.match(ast(sample.source), /strong\(a\(code\("src\/workflows\/default\/"\)\)/);
        }
      } finally {
        dom.window.close();
      }
    }
  });

  test(`${name}: repair leaves code literals, unfinished markers and normal emphasis intact`, async () => {
    for (const source of [
      '`**문구(설명)**입니다`',
      '```text\n**문구(설명)**입니다\n```',
      '**앞 `코드` 뒤(설명)',
      '** `코드` **입니다.',
    ]) {
      await parseStreamingMarkdownAst(source);
      const markup = renderToStaticMarkup(render(source));
      assert.equal(markup.includes('<strong>'), false, source);
    }
    await parseStreamingMarkdownAst('**정상**입니다. *기울임*과 `코드`입니다.');
    const markup = renderToStaticMarkup(render('**정상**입니다. *기울임*과 `코드`입니다.'));
    assert.match(markup, /<strong>정상<\/strong>입니다\./);
    assert.match(markup, /<em>기울임<\/em>/);
    assert.match(markup, /<code>코드<\/code>/);
  });
}

test('strikethrough is pair-only', () => {
  assert.match(ast('~~gone~~ kept'), /del\("gone"\)/);
  assert.equal(ast('1~2 range').includes('del('), false);
});

test('task boxes become checkbox inputs', () => {
  const rendered = ast('- [ ] todo\n- [x] done');
  assert.match(rendered, /input\(\)/);
});

test('a bare <br> becomes a line break, other tags stay literal', () => {
  const cell = ast('| a |\n|---|\n| x<br>y |');
  assert.match(cell, /td\("x",br\(\)/);
  assert.equal(cell.includes('"<br>"'), false);
  assert.match(ast('one<br />two'), /br\(\)/);
  assert.match(ast("a <br class='x'> b"), /"<br class='x'>"/);
});

test('raw HTML stays literal but comments are dropped', () => {
  assert.match(ast('text <b>x</b> end'), /"<b>"/);
  assert.equal(ast('<!-- hidden -->').includes('hidden'), false);
});

test('source fallback adopts heading, list and emphasis grammar', () => {
  const markup = renderToStaticMarkup(
    React.createElement(MarkdownSourceFallback, {
      text: '## Head\n\n- one\n- two\n\n*it* and ~~gone~~ and **strong**',
    })
  );
  assert.match(markup, /<h2>Head<\/h2>/);
  assert.match(markup, /<ul><li>one<\/li><li>two<\/li><\/ul>/);
  assert.match(markup, /<em>it<\/em>/);
  assert.match(markup, /<del>gone<\/del>/);
  assert.match(markup, /<strong>strong<\/strong>/);
});

test('source fallback keeps fenced code in its final card grammar', () => {
  const markup = renderToStaticMarkup(
    React.createElement(MarkdownSourceFallback, { text: '```js\nconst a = 1;\n```' })
  );
  assert.match(markup, /markdown-code/);
  assert.match(markup, /const a = 1;/);
});

test('streaming markdown never exposes source while its first AST is pending', async () => {
  const { dom, restore } = installTestDom(null, { jsdom: { url: 'http://localhost/' } });
  const root = createRoot(dom.window.document.getElementById('root'));
  const CopyControl = () => null;
  try {
    await act(async () => {
      root.render(
        React.createElement(StreamingMarkdownBody, {
          text: 'first line',
          parse: false,
          copyControl: CopyControl,
        })
      );
    });
    assert.equal(dom.window.document.getElementById('root').textContent, '');
    assert.equal(dom.window.document.querySelector('[data-transcript-pending]'), null);

    await act(async () => {
      root.render(
        React.createElement(StreamingMarkdownBody, {
          text: 'first line\nsecond line',
          parse: false,
          copyControl: CopyControl,
        })
      );
    });
    assert.equal(dom.window.document.getElementById('root').textContent, '');
  } finally {
    await act(async () => root.unmount());
    restore();
  }
});

test('a partially arrived closing fence never parses as a code line', () => {
  const code = (text) => {
    const markup = renderToStaticMarkup(
      React.createElement(MarkdownAstBody, {
        root: parseMarkdownToHast(healStreamingMarkdownTail(text)),
        copyControl: CopyControl,
      })
    );
    return new JSDOM(markup).window.document.querySelector('code')?.textContent;
  };
  const body = '```ts\nconst streamed = true;\nexport const done = streamed;\n';
  const settled = code(`${body}\`\`\``);
  assert.equal(code(`${body}\``), settled);
  assert.equal(code(`${body}\`\``), settled);
  assert.equal(code(`${body.replaceAll('```', '~~~')}~`), settled);
});

test('a streaming tail never shows syntax that is about to become something else', () => {
  const heal = (text) => healStreamingMarkdownTail(text);
  // Closers go before trailing whitespace, where they can still close.
  assert.equal(heal('a **compact '), 'a **compact** ');
  assert.equal(heal('a ~~strike~'), 'a ~~strike~~');
  // An opener with nothing after it yet is held back.
  assert.equal(heal('Here is a **'), 'Here is a ');
  assert.equal(heal('with `'), 'with ');
  assert.equal(heal('and ~'), 'and ');
  // A line holding only a block marker: setext underline, lazy digit,
  // growing heading, half a fence.
  assert.equal(heal('Keys map to values.\n-'), 'Keys map to values.\n');
  assert.equal(heal('A line\n= '), 'A line\n');
  assert.equal(heal('1. One\n2'), '1. One\n');
  assert.equal(heal('Intro\n\n##'), 'Intro\n\n');
  assert.equal(heal('Intro\n\n``'), 'Intro\n\n');
  // The code card waits for its opening line, then streams as code.
  assert.equal(heal('Intro\n\n```pyt'), 'Intro\n\n');
  assert.equal(heal('Intro\n\n```python\nx = 1'), 'Intro\n\n```python\nx = 1');
  // Content after the marker shows at once.
  assert.equal(heal('Intro\n- F'), 'Intro\n- F');
  assert.equal(heal('Intro\n2. T'), 'Intro\n2. T');
});

test('a streaming table appears only once its delimiter row is complete', () => {
  const render = (text) => {
    const markup = renderToStaticMarkup(
      React.createElement(MarkdownAstBody, {
        root: parseMarkdownToHast(healStreamingMarkdownTail(text)),
        copyControl: CopyControl,
      })
    );
    const document = new JSDOM(markup).window.document;
    return { table: document.querySelector('table') !== null, text: document.body.textContent };
  };
  const lead = '정리하면 다음과 같습니다.\n\n';
  for (const partial of [
    '| 항목 | 값 | 비',
    '| 항목 | 값 | 비고 |',
    '| 항목 | 값 | 비고 |\n',
    '| 항목 | 값 | 비고 |\n|---|--',
    '| 항목 | 값 | 비고 |\n|---|---|',
  ]) {
    const shown = render(lead + partial);
    assert.equal(shown.table, false, partial);
    assert.equal(shown.text.includes('|'), false, `raw pipes stay hidden: ${partial}`);
    assert.match(shown.text, /정리하면/);
  }
  assert.equal(render(`${lead}| 항목 | 값 | 비고 |\n|---|---|---|`).table, true);
  assert.equal(render(`${lead}| 항목 | 값 | 비고 |\n|---|---|---|\n| A | 1 |`).table, true);
  // Inside an open fence pipes are code, never held back.
  assert.match(render('```\n| a | b |').text, /\| a \| b \|/);
  // A line with a pipe may still head a table while it is the block's last
  // line; once the next line shows it is prose, it paints.
  assert.equal(render('use a | b here').text.includes('|'), false);
  assert.match(render('use a | b here\nand more').text, /a \| b/);
  // A head directly under a paragraph line, or without a leading pipe, is
  // held too, with the paragraph above it shown.
  const caption = 'The surfaces compare like this:\n';
  for (const partial of ['| A | B', '| A | B |\n', '| A | B |\n|--', 'A | B', 'A | B\n---', 'A | B\n---|']) {
    const shown = render(caption + partial);
    assert.equal(shown.table, false, partial);
    assert.equal(shown.text.includes('|'), false, `raw pipes stay hidden: ${partial}`);
    assert.match(shown.text, /compare like this/);
  }
  assert.equal(render(`${caption}| A | B |\n|---|---|`).table, true);
  assert.equal(render(`${caption}| A | B |\n|---|---|\n`).table, true, 'a delimiter row ended by its newline');
  assert.equal(render(`${caption}A | B\n---|---\n1 | 2`).table, true);
});

test('a block cut from the live tail keeps its last parse until its own parse lands', async () => {
  const { dom, restore } = installTestDom(null, { jsdom: { url: 'http://localhost/' } });
  const host = dom.window.document.getElementById('root');
  const root = createRoot(host);
  const render = (text) => root.render(React.createElement(StreamingMarkdownBody, { text, copyControl: () => null }));
  const tail = 'Frozen **block** one\n\nNext block starting';
  const frozen = 'Frozen **block** one\n\n';
  try {
    await act(async () => {
      render(tail);
      await parseStreamingMarkdownAst(tail);
    });
    await act(async () => {});
    assert.match(host.textContent, /Next block starting/);
    // The next block started: this chunk freezes to its own block. Its parse
    // is still in flight, so the previous parse stays instead of a blank.
    act(() => render(frozen));
    assert.match(host.textContent, /Frozen block one/);
    await act(async () => {
      await parseStreamingMarkdownAst(frozen);
    });
    await act(async () => {});
    assert.equal(host.textContent.trim(), 'Frozen block one');
    assert.equal(host.querySelector('strong')?.textContent, 'block');
  } finally {
    await act(async () => root.unmount());
    restore();
  }
});

test('streaming fenced scripts keep final card geometry while their first AST is pending', async () => {
  const { dom, restore } = installTestDom(null, { jsdom: { url: 'http://localhost/' } });
  const host = dom.window.document.getElementById('root');
  const root = createRoot(host);
  const CopyControl = () => null;
  try {
    await act(async () => {
      root.render(
        React.createElement(StreamingMarkdownBody, {
          text: '```ts',
          parse: false,
          sync: true,
          copyControl: CopyControl,
        })
      );
    });
    const openingFallback = host.querySelector('.markdown-code-fallback');
    assert.ok(openingFallback);
    assert.equal(openingFallback.querySelector('header span')?.textContent, 'ts');
    assert.equal(openingFallback.querySelector('code')?.textContent, '');
    assert.equal(host.textContent.includes('```'), false);

    await act(async () => {
      root.render(
        React.createElement(StreamingMarkdownBody, {
          text: '```ts\nconst answer = 42;',
          parse: false,
          sync: true,
          copyControl: CopyControl,
        })
      );
    });
    assert.equal(host.querySelector('.markdown-code-fallback code')?.textContent, 'const answer = 42;');
  } finally {
    await act(async () => root.unmount());
    restore();
  }
});

test('a settled fence commits its code card in the first render once the parser is loaded', async () => {
  const { dom, restore } = installTestDom(null, { jsdom: { url: 'http://localhost/' } });
  const host = dom.window.document.getElementById('root');
  const root = createRoot(host);
  const text = 'Run this:\n\n```ts\nconst held = true;\n```';
  try {
    await preloadSyncMarkdownParser();
    act(() => {
      root.render(React.createElement(StreamingMarkdownBody, { text, copyControl: () => null }));
    });
    // No source projection first: it painted at another height than the card.
    assert.equal(host.querySelector('.markdown-code-fallback'), null);
    assert.equal(host.querySelector('[data-transcript-pending]'), null);
    assert.match(host.textContent, /const held = true;/);
  } finally {
    await act(async () => root.unmount());
    restore();
  }
});
