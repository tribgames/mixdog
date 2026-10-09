import assert from 'node:assert/strict';
import test from 'node:test';

import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { installTestDom } from './test-support/test-dom.mjs';

installTestDom(null, {
  html: '<!doctype html><html><body><main></main></body></html>',
  jsdom: { url: 'https://mixdog.test/' },
  actEnvironment: false,
});
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const { DELIMITED_CELL_CAP, DELIMITED_COLUMN_CAP, DELIMITED_ROW_CAP, delimiterForPath, editorViewKindForPath, parseDelimited, svgDataUrl } = await import(
  './editor-delimited.ts'
);
const { EditorDelimitedTable, EditorMarkdownPreview, EditorSvgPreview } = await import('./EditorTextViews.tsx');

async function render(element) {
  const host = document.createElement('div');
  document.querySelector('main').append(host);
  const root = createRoot(host);
  await act(async () => root.render(element));
  return { host, root };
}

test('parses RFC 4180 quoting, embedded delimiters and newlines', () => {
  const { rows, truncated } = parseDelimited('a,b\r\n"x, y","He said ""hi"""\n"line1\nline2",\n', ',');
  assert.equal(truncated, false);
  assert.deepEqual(rows, [
    ['a', 'b'],
    ['x, y', 'He said "hi"'],
    ['line1\nline2', ''],
  ]);
  assert.deepEqual(parseDelimited('a\tb\n1,2\t3', '\t').rows, [
    ['a', 'b'],
    ['1,2', '3'],
  ]);
});

test('caps parsed rows and flags truncation', () => {
  const text = Array.from({ length: DELIMITED_ROW_CAP + 5 }, (_, index) => `r${index}`).join('\n');
  const result = parseDelimited(text, ',');
  assert.equal(result.rows.length, DELIMITED_ROW_CAP);
  assert.equal(result.truncated, true);
});

test('classifies view kinds by extension', () => {
  assert.equal(editorViewKindForPath('a/b.SVG'), 'svg');
  assert.equal(editorViewKindForPath('README.md'), 'markdown');
  assert.equal(editorViewKindForPath('x.mdx'), 'markdown');
  assert.equal(editorViewKindForPath('x.markdown'), 'markdown');
  assert.equal(editorViewKindForPath('d.csv'), 'table');
  assert.equal(delimiterForPath('d.tsv'), '\t');
  assert.equal(editorViewKindForPath('main.ts'), null);
});

test('the table view renders a header, quoted cells and the truncation notice', async () => {
  const { host, root } = await render(
    React.createElement(EditorDelimitedTable, { text: 'name,note\n"Doe, Jane","said ""yes"""\n', delimiter: ',' })
  );
  try {
    assert.deepEqual(
      [...host.querySelectorAll('th')].map((cell) => cell.textContent),
      ['name', 'note']
    );
    assert.deepEqual(
      [...host.querySelectorAll('td')].map((cell) => cell.textContent),
      ['Doe, Jane', 'said "yes"']
    );
    assert.equal(host.querySelector('.editor-table-notice'), null);
  } finally {
    await act(async () => root.unmount());
  }
  const big = Array.from({ length: DELIMITED_ROW_CAP + 10 }, (_, index) => `${index},v`).join('\n');
  const second = await render(React.createElement(EditorDelimitedTable, { text: big, delimiter: ',' }));
  try {
    assert.ok(second.host.querySelector('.editor-table-notice'));
    assert.equal(second.host.querySelectorAll('tbody tr').length, DELIMITED_ROW_CAP - 1);
  } finally {
    await act(async () => second.root.unmount());
  }
});

test('the markdown preview renders formatting and keeps raw HTML as text', async () => {
  const { host, root } = await render(
    React.createElement(EditorMarkdownPreview, {
      text: '# Title\n\nSome **bold** text <b>raw</b>\n',
      projectPath: 'C:/Project/demo',
      relPath: 'README.md',
    })
  );
  try {
    for (let attempt = 0; attempt < 50 && !host.querySelector('h1'); attempt += 1) {
      await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
    }
    assert.equal(host.querySelector('h1')?.textContent, 'Title');
    assert.equal(host.querySelector('strong')?.textContent, 'bold');
    assert.equal(host.querySelector('b'), null, 'raw HTML is not injected');
    assert.match(host.textContent, /<b>raw<\/b>/);
  } finally {
    await act(async () => root.unmount());
  }
});

test('caps columns and total cells, flagging each truncation', () => {
  const wide = Array.from({ length: DELIMITED_COLUMN_CAP + 20 }, (_, index) => `c${index}`).join(',');
  const columns = parseDelimited(`${wide}\n${wide}`, ',');
  assert.equal(columns.columnsTruncated, true);
  assert.equal(columns.truncated, false);
  assert.ok(columns.rows.every((row) => row.length === DELIMITED_COLUMN_CAP));
  assert.equal(columns.rows[0].at(-1), `c${DELIMITED_COLUMN_CAP - 1}`);

  const many = Array.from({ length: 900 }, () => wide).join('\n');
  const cells = parseDelimited(many, ',');
  assert.equal(cells.truncated, true);
  assert.ok(cells.rows.length * DELIMITED_COLUMN_CAP <= DELIMITED_CELL_CAP);
  assert.equal(parseDelimited('a,b\n1,2', ',').columnsTruncated, false);
});

test('the table view shows a column notice for very wide files', async () => {
  const wide = Array.from({ length: DELIMITED_COLUMN_CAP + 5 }, (_, index) => `c${index}`).join(',');
  const { host, root } = await render(React.createElement(EditorDelimitedTable, { text: `${wide}\n${wide}`, delimiter: ',' }));
  try {
    assert.equal(host.querySelectorAll('th').length, DELIMITED_COLUMN_CAP);
    assert.equal(host.querySelectorAll('.editor-table-notice').length, 1);
  } finally {
    await act(async () => root.unmount());
  }
});

test('the markdown preview resolves sibling images and links from a nested folder', async () => {
  const project = 'C:/Project/demo';
  const files = ['docs/guide/logo.png', 'docs/shared/pic.png', 'docs/guide/notes/b.md'];
  const previewed = [];
  const opened = [];
  window.mixdogDesktop = {
    listProjects: async () => [{ path: project, name: 'demo' }],
    statProjectFile: async (_project, path) => {
      if (files.includes(path)) return { size: 1, mtimeMs: 1 };
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    },
    searchProjectFiles: async () => [],
    previewProjectFile: async (_project, path) => {
      previewed.push(path);
      return { url: `mixdog-media://preview/${path}`, kind: 'image', mime: 'image/png' };
    },
  };
  const { host, root } = await render(
    React.createElement(EditorMarkdownPreview, {
      text: '![logo](logo.png)\n\n![pic](../shared/pic.png)\n\n[notes](notes/b.md)\n',
      projectPath: project,
      relPath: 'docs/guide/README.md',
      onOpenFile: (...args) => opened.push(args),
    })
  );
  try {
    for (let attempt = 0; attempt < 50 && !host.querySelector('a'); attempt += 1) {
      await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
    }
    await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
    assert.deepEqual(previewed.sort(), ['docs/guide/logo.png', 'docs/shared/pic.png']);
    await act(async () => {
      host.querySelector('a').dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
    assert.deepEqual(opened, [[project, 'docs/guide/notes/b.md', undefined]]);
  } finally {
    await act(async () => root.unmount());
  }
});

test('documentRelativePath keeps encoded characters for the resolver single decode', async () => {
  const { documentRelativePath } = await import('./MarkdownLink.tsx');
  assert.equal(documentRelativePath('docs', 'figure%231.png'), 'docs/figure%231.png');
  assert.equal(documentRelativePath('docs', '100%25.png'), 'docs/100%25.png');
  assert.equal(documentRelativePath('docs', 'my%20fig.png'), 'docs/my%20fig.png');
  assert.equal(documentRelativePath('docs/a', '../b/x%23.png'), 'docs/b/x%23.png');
  assert.equal(documentRelativePath('my docs/50%/#x', 'f.png'), 'my%20docs/50%25/%23x/f.png');
  assert.equal(documentRelativePath('docs', '../../x.png'), '../../x.png');
  assert.equal(documentRelativePath('docs', '/abs/x.png'), '/abs/x.png');
  assert.equal(documentRelativePath('', 'x.png'), 'x.png');
});

test('the markdown preview opens other-Project links with their access token', async () => {
  const project = 'C:/Project/demo';
  window.mixdogDesktop = {
    listProjects: async () => [],
    statProjectFile: async () => ({ size: 1, mtimeMs: 1 }),
    searchProjectFiles: async () => [],
    resolveLocalPaths: async () => [
      { projectPath: 'D:/other', relPath: 'x/y.md', accessToken: 'tok', absolutePath: 'D:/other/x/y.md' },
    ],
  };
  const opened = [];
  const { host, root } = await render(
    React.createElement(EditorMarkdownPreview, {
      text: '[other](D:/other/x/y.md)\n',
      projectPath: project,
      relPath: 'README.md',
      onOpenFile: (...args) => opened.push(args),
    })
  );
  try {
    await act(async () => new Promise((resolve) => setTimeout(resolve, 50)));
    await act(async () => {
      host.querySelector('a').dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    await act(async () => new Promise((resolve) => setTimeout(resolve, 50)));
    assert.deepEqual(opened, [['D:/other', 'x/y.md', undefined, 'tok']]);
  } finally {
    await act(async () => root.unmount());
  }
});

test('the SVG preview retries when its source changes after a failure', async () => {
  const bad = svgDataUrl('<svg');
  const good = svgDataUrl('<svg xmlns="http://www.w3.org/2000/svg"/>');
  const props = (url, error) => ({ url, name: 'a.svg', error, onComplete() {}, onFail() {} });
  const { host, root } = await render(React.createElement(EditorSvgPreview, props(bad, '')));
  try {
    await act(async () => host.querySelector('img').dispatchEvent(new window.Event('error')));
    await act(async () => root.render(React.createElement(EditorSvgPreview, props(bad, 'could not display'))));
    assert.equal(host.querySelector('img'), null);
    assert.equal(host.querySelector('[role="alert"]')?.textContent, 'could not display');
    await act(async () => root.render(React.createElement(EditorSvgPreview, props(good, 'could not display'))));
    assert.equal(host.querySelector('img')?.getAttribute('src'), good);
    assert.equal(host.querySelector('[role="alert"]'), null);
  } finally {
    await act(async () => root.unmount());
  }
});

test('the SVG preview is an image and never injects markup', async () => {
  const source = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>';
  const url = svgDataUrl(source);
  const { host, root } = await render(
    React.createElement(EditorSvgPreview, { url, name: 'a.svg', error: '', onComplete() {}, onFail() {} })
  );
  try {
    assert.equal(host.querySelector('img')?.getAttribute('src'), url);
    assert.equal(host.querySelector('script'), null);
    assert.equal(host.querySelector('svg'), null);
    assert.equal(decodeURIComponent(url.split(',')[1]), source);
  } finally {
    await act(async () => root.unmount());
  }
});
