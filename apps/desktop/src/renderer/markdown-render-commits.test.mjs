/**
 * markdown-render-commits.test.mjs — per-delta render cost of live markdown.
 *
 * A streamed token must not rebuild or remount the markdown tree: component
 * types stay stable across parses, a bare delta renders nothing below the
 * streaming body, and each landed (or cached) parse commits exactly once.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { installTestDom } from './test-support/test-dom.mjs';

import { parseMarkdownToHast } from './markdown-ast';
import { markdownComponents } from './markdown-components';
import {
  parseStreamingMarkdownAst,
  preloadSyncMarkdownParser,
  SYNC_MARKDOWN_PARSE_MAX_UTF16_UNITS,
} from './markdown-worker-client';
import MarkdownAstBody from './MarkdownAstBody';
import StreamingMarkdownBody from './StreamingMarkdownBody';
import { TranscriptRow } from './transcript-row';
import { preloadMarkdownBody } from './markdown-body-loader';

test('preloaded history paints rich markdown without another lazy fallback', async () => {
  const text = '## Ready history\n\nA **formatted** answer.';
  await withDom(async ({ host, root }) => {
    await preloadMarkdownBody();
    await parseStreamingMarkdownAst(text);
    let firstCommit = null;
    await act(async () =>
      root.render(
        React.createElement(
          React.Profiler,
          {
            id: 'history',
            onRender: () => {
              firstCommit ??= {
                heading: host.querySelector('h2')?.textContent,
                strong: host.querySelector('strong')?.textContent,
                pending: Boolean(host.querySelector('[data-transcript-pending]')),
              };
            },
          },
          React.createElement(TranscriptRow, {
            item: { id: 'ready-history', kind: 'assistant', text },
          })
        )
      )
    );
    assert.deepEqual(firstCommit, { heading: 'Ready history', strong: 'formatted', pending: false });
  });
});

const SETTLED_REPLY = [
  '## Settled reply',
  '',
  'See https://example.com/docs/streaming and [the guide](https://example.org/a/b) for **details**.',
  '',
  '- first item',
  '- second item',
  '',
  '| col 1 | col 2 |',
  '| --- | --- |',
  '| a | b |',
  '',
  '```ts',
  'const answer: number = 42;',
  '```',
  '',
  'Summary paragraph.',
].join('\n');

function firstCommitShape(host) {
  return {
    heading: host.querySelector('h2')?.textContent,
    links: [...host.querySelectorAll('a[href]')].map((link) => link.getAttribute('href')),
    table: Boolean(host.querySelector('.markdown-table table')),
    code: Boolean(host.querySelector('.markdown-code:not(.markdown-code-fallback)')),
    fallback: Boolean(host.querySelector('.markdown-code-fallback, .markdown-plain')),
    pending: Boolean(host.querySelector('[data-transcript-pending]')),
  };
}

test('a reply that arrives settled paints its final structure in the first commit once the parser is loaded', async () => {
  await withDom(async ({ host, root }) => {
    await preloadMarkdownBody();
    await preloadSyncMarkdownParser();
    // Never parsed before: the worker has no answer for it yet.
    const text = `${SETTLED_REPLY}\n\nUnique ${Date.now()}.`;
    let firstCommit = null;
    await act(async () =>
      root.render(
        React.createElement(
          React.Profiler,
          { id: 'settled', onRender: () => (firstCommit ??= firstCommitShape(host)) },
          React.createElement(TranscriptRow, { item: { id: 'settled-reply', kind: 'assistant', text } })
        )
      )
    );
    assert.deepEqual(firstCommit, {
      heading: 'Settled reply',
      links: ['https://example.com/docs/streaming', 'https://example.org/a/b'],
      table: true,
      code: true,
      fallback: false,
      pending: false,
    });
  });
});

/** A distinct settled reply of exactly `units` UTF-16 code units. */
function settledReplyOf(units, tag) {
  let text = `## ${tag}\n\n`;
  while (text.length < units) text += `${SETTLED_REPLY.replace('Settled reply', `${tag} part`)}\n\n`;
  return text.slice(0, units);
}

test('replies mounting in one commit share one frame of synchronous parsing; one reply still parses at once', async () => {
  await preloadMarkdownBody();
  await preloadSyncMarkdownParser();
  // Let any frame reset queued by an earlier test fire before taking over.
  await new Promise((resolve) => setTimeout(resolve, 40));
  const { CopyControl } = countingCopyControl();
  const stamp = Date.now();
  const mounted = [1, 2, 3, 4, 5].map((n) => settledReplyOf(3000, `Burst ${stamp} ${n}`));
  const single = settledReplyOf(SYNC_MARKDOWN_PARSE_MAX_UTF16_UNITS, `Single ${stamp}`);
  assert.equal(single.length, SYNC_MARKDOWN_PARSE_MAX_UTF16_UNITS);
  // A reply still waiting for its parse shows the source projection (fenced
  // code) and a pending marker; a parsed one has table and code-card structure.
  const shape = (host) => ({
    pending: host.querySelectorAll('[data-transcript-pending]').length,
    // Source painted while waiting: fallback code cards, plain prose or raw table pipes.
    source: Boolean(host.querySelector('.markdown-code-fallback, .markdown-plain')) || host.textContent.includes('| '),
    table: Boolean(host.querySelector('.markdown-table-frame table')),
  });
  await withDom(async ({ host, root }) => {
    // Frames fire only when the test says so.
    const frames = [];
    globalThis.requestAnimationFrame = (callback) => frames.push(callback);
    const nextFrame = () => {
      for (const callback of frames.splice(0)) callback(0);
    };
    const bodies = [];
    for (const text of mounted) {
      bodies.push(React.createElement(StreamingMarkdownBody, { key: text, text, copyControl: CopyControl }));
    }
    const commits = [];
    await act(async () =>
      root.render(
        React.createElement(React.Profiler, { id: 'burst', onRender: () => commits.push(shape(host)) }, bodies)
      )
    );
    assert.deepEqual(
      commits[0],
      { pending: 4, source: false, table: true },
      'one reply fills the frame; the rest wait for the worker, painting no raw source'
    );
    assert.equal(frames.length, 1, 'the allowance renews through a single animation frame');
    // The worker path still delivers every reply.
    await act(async () => {
      await Promise.all(mounted.map((text) => parseStreamingMarkdownAst(text)));
    });
    assert.deepEqual(shape(host), { pending: 0, source: false, table: true });

    // More than the old 16ms wall-clock window later, still no frame: still spent.
    await new Promise((resolve) => setTimeout(resolve, 40));
    const early = settledReplyOf(1200, `Early ${stamp}`);
    const unrenewed = [];
    await act(async () =>
      root.render(
        React.createElement(
          React.Profiler,
          { id: 'early', onRender: () => unrenewed.push(shape(host)) },
          React.createElement(StreamingMarkdownBody, { key: early, text: early, copyControl: CopyControl })
        )
      )
    );
    assert.equal(unrenewed[0].pending, 1, 'no frame, no new allowance');

    // A frame boundary renews it: a single reply of the largest size paints parsed in its first commit.
    nextFrame();
    const first = [];
    await act(async () =>
      root.render(
        React.createElement(
          React.Profiler,
          { id: 'single', onRender: () => first.push(shape(host)) },
          React.createElement(StreamingMarkdownBody, { key: single, text: single, copyControl: CopyControl })
        )
      )
    );
    assert.deepEqual(first[0], { pending: 0, source: false, table: true }, 'a single reply parses on its first frame');

    // Larger than the cap never parses synchronously, frame or not.
    nextFrame();
    const tooLarge = settledReplyOf(SYNC_MARKDOWN_PARSE_MAX_UTF16_UNITS + 1, `Large ${stamp}`);
    const larger = [];
    await act(async () =>
      root.render(
        React.createElement(
          React.Profiler,
          { id: 'large', onRender: () => larger.push(shape(host)) },
          React.createElement(StreamingMarkdownBody, { key: tooLarge, text: tooLarge, copyControl: CopyControl })
        )
      )
    );
    assert.deepEqual(larger[0], { pending: 1, source: false, table: false });
    nextFrame();
  });
});

test('streaming more text never changes the blocks that were already complete', async () => {
  await withDom(async ({ host, root }) => {
    await preloadMarkdownBody();
    await preloadSyncMarkdownParser();
    const text = `${SETTLED_REPLY}\n\nTail ${Date.now()} keeps growing word by word.`;
    // Cut points through every construct: mid-link, mid-list, mid-table,
    // inside the open fence, and the settled end.
    const cuts = [];
    for (let at = 40; at < text.length; at += 17) cuts.push(at);
    cuts.push(text.length);
    const render = (end, streaming) =>
      act(async () =>
        root.render(
          React.createElement(TranscriptRow, {
            item: { id: 'growing-reply', kind: 'assistant', text: text.slice(0, end), streaming },
          })
        )
      );
    let complete = [];
    for (const [index, end] of cuts.entries()) {
      const streaming = index < cuts.length - 1;
      await render(end, streaming);
      const markdown = host.querySelector('.markdown');
      assert.ok(markdown, `markdown at ${end}`);
      assert.equal(host.querySelector('[data-transcript-pending]'), null, `no unparsed block at ${end}`);
      // Every top-level block but the last is complete: the next delta must
      // keep the same element with the same rendered markup.
      for (const block of complete) {
        assert.ok(block.node.isConnected, `complete block remounted at ${end}: ${block.html.slice(0, 60)}`);
        assert.equal(block.node.outerHTML, block.html, `complete block changed at ${end}`);
      }
      const blocks = [...markdown.children].filter((node) => !node.hasAttribute('hidden'));
      complete = blocks.slice(0, -1).map((node) => ({ node, html: node.outerHTML }));
    }
    assert.deepEqual(
      { ...firstCommitShape(host), heading: host.querySelector('h2')?.textContent },
      {
        heading: 'Settled reply',
        links: ['https://example.com/docs/streaming', 'https://example.org/a/b'],
        table: true,
        code: true,
        fallback: false,
        pending: false,
      }
    );
  });
});

async function withDom(run) {
  const { dom, restore } = installTestDom(null, { jsdom: { url: 'http://localhost/' } });
  const host = dom.window.document.getElementById('root');
  const root = createRoot(host);
  try {
    await run({ host, root });
  } finally {
    await act(async () => root.unmount());
    restore();
  }
}

function countingCopyControl() {
  const counts = { renders: 0, mounts: 0 };
  function CopyControl({ value, label, className }) {
    counts.renders += 1;
    React.useEffect(() => {
      counts.mounts += 1;
    }, []);
    return React.createElement('button', { type: 'button', className, 'aria-label': label, 'data-copy': value });
  }
  return { CopyControl, counts };
}

test('markdown component types are created once per copy control', () => {
  const First = () => null;
  const Second = () => null;
  const components = markdownComponents(First);
  assert.equal(markdownComponents(First), components);
  assert.equal(markdownComponents(First).pre, components.pre);
  assert.equal(markdownComponents(First).table, components.table);
  assert.notEqual(markdownComponents(Second).pre, components.pre);
});

test('table cells holding Han or Kana are marked to wrap between characters', () => {
  const text = '| 언어 | 제목 |\n|---|---|\n| 한국어 | 지표 분석 |\n| 일본어 | 指標分析を見る |\n| 중국어 | **继续**查看 |';
  const html = renderToStaticMarkup(
    React.createElement(MarkdownAstBody, { root: parseMarkdownToHast(text), copyControl: () => null })
  );
  const cells = [...html.matchAll(/<(td|th)([^>]*)>(.*?)<\/\1>/g)].map(([, , attrs, body]) => [
    body.replace(/<[^>]+>/g, ''),
    attrs.includes('data-cjk'),
  ]);
  assert.deepEqual(cells, [
    ['언어', false],
    ['제목', false],
    ['한국어', false],
    ['지표 분석', false],
    ['일본어', false],
    ['指標分析を見る', true],
    ['중국어', false],
    ['继续查看', true],
  ]);
});

test('code cards, copy buttons and table wrappers survive a new parse', async () => {
  const { CopyControl, counts } = countingCopyControl();
  const first = 'Intro\n\n```js\nconst a = 1;\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\nTail';
  const second = `${first} grows\n\nMore prose.`;
  await withDom(async ({ host, root }) => {
    await act(async () => {
      root.render(React.createElement(MarkdownAstBody, { root: parseMarkdownToHast(first), copyControl: CopyControl }));
    });
    const card = host.querySelector('.markdown-code');
    const copy = host.querySelector('.markdown-code-copy');
    const table = host.querySelector('.markdown-table');
    assert.ok(card && copy && table);
    assert.equal(counts.mounts, 1);

    await act(async () => {
      root.render(
        React.createElement(MarkdownAstBody, { root: parseMarkdownToHast(second), copyControl: CopyControl })
      );
    });
    assert.equal(host.querySelector('.markdown-code'), card);
    assert.equal(host.querySelector('.markdown-code-copy'), copy);
    assert.equal(host.querySelector('.markdown-table'), table);
    assert.equal(counts.mounts, 1);
    assert.match(host.textContent, /More prose\./);
  });
});

test('a delta whose parse is cached commits once', async () => {
  const { CopyControl } = countingCopyControl();
  const deltas = [
    'Cached delta\n\n```js\nconst a',
    'Cached delta\n\n```js\nconst a = 1;',
    'Cached delta\n\n```js\nconst a = 1;\n```\n\nDone',
  ];
  for (const text of deltas) await parseStreamingMarkdownAst(text);
  let commits = 0;
  const render = (text) =>
    React.createElement(
      React.Profiler,
      { id: 'markdown', onRender: () => (commits += 1) },
      React.createElement(StreamingMarkdownBody, { text, copyControl: CopyControl })
    );
  await withDom(async ({ host, root }) => {
    await act(async () => root.render(render(deltas[0])));
    const card = host.querySelector('.markdown-code');
    assert.ok(card);
    for (const text of deltas.slice(1)) {
      commits = 0;
      await act(async () => root.render(render(text)));
      assert.equal(commits, 1, text);
      assert.equal(host.querySelector('.markdown-code'), card);
    }
    assert.equal(host.querySelector('.markdown-code code')?.textContent, 'const a = 1;');
    assert.match(host.textContent, /Done$/);
  });
});

test('each streamed delta renders the markdown tree once, from its landed parse', async () => {
  const { CopyControl, counts } = countingCopyControl();
  const deltas = [
    'Worker delta\n\n```ts\nlet total = 0;',
    'Worker delta\n\n```ts\nlet total = 0;\ntotal += 1;',
    'Worker delta\n\n```ts\nlet total = 0;\ntotal += 1;\n```\n\n| k | v |\n|---|---|\n| a | 1 |',
    'Worker delta\n\n```ts\nlet total = 0;\ntotal += 1;\n```\n\n| k | v |\n|---|---|\n| a | 1 |\n| b | 2 |',
  ];
  const render = (text) => React.createElement(StreamingMarkdownBody, { text, copyControl: CopyControl });
  await withDom(async ({ host, root }) => {
    await act(async () => root.render(render(deltas[0])));
    await act(async () => {
      await parseStreamingMarkdownAst(deltas[0]);
    });
    const card = host.querySelector('.markdown-code');
    assert.ok(card);
    const mounts = counts.mounts;
    let table = null;
    for (const text of deltas.slice(1)) {
      const renders = counts.renders;
      await act(async () => root.render(render(text)));
      await act(async () => {
        await parseStreamingMarkdownAst(text);
      });
      assert.equal(counts.renders - renders, 1, text);
      assert.equal(host.querySelector('.markdown-code'), card);
      if (table) assert.equal(host.querySelector('.markdown-table'), table);
      table = host.querySelector('.markdown-table');
    }
    assert.equal(counts.mounts, mounts);
    const final = deltas.at(-1);
    assert.equal(
      host.innerHTML,
      renderToStaticMarkup(
        React.createElement(MarkdownAstBody, { root: parseMarkdownToHast(final), copyControl: CopyControl })
      )
    );
  });
});
