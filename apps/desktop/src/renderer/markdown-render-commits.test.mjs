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
import { JSDOM } from 'jsdom';

import { parseMarkdownToHast } from './markdown-ast';
import { markdownComponents } from './markdown-components';
import { parseStreamingMarkdownAst } from './markdown-worker-client';
import MarkdownAstBody from './MarkdownAstBody';
import StreamingMarkdownBody from './StreamingMarkdownBody';

async function withDom(run) {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://localhost/',
  });
  const previous = new Map(
    ['window', 'document', 'IS_REACT_ACT_ENVIRONMENT'].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)])
  );
  Object.defineProperty(globalThis, 'window', { configurable: true, value: dom.window });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: dom.window.document });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const host = dom.window.document.getElementById('root');
  const root = createRoot(host);
  try {
    await run({ host, root });
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
}

function countingCopyControl() {
  const counts = { renders: 0, mounts: 0 };
  function CopyControl({ value, label, className }) {
    counts.renders += 1;
    React.useEffect(() => {
      counts.mounts += 1;
    }, []);
    return React.createElement('button', { className, 'aria-label': label, 'data-copy': value });
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
      root.render(React.createElement(MarkdownAstBody, { root: parseMarkdownToHast(second), copyControl: CopyControl }));
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
