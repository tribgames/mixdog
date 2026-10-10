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
// jsdom has no CSS.escape or ResizeObserver, which the grid library measures with.
globalThis.CSS ??= { escape: (value) => String(value).replace(/[^\w-]/g, (char) => `\\${char}`) };
// The grid scrolls a newly added row into view; jsdom has no scrollIntoView.
globalThis.Element ??= window.Element;
window.Element.prototype.scrollIntoView ??= function scrollIntoView() {};
// React's IE input polyfill runs on focus in this jsdom setup and needs these.
for (const name of ['attachEvent', 'detachEvent']) window.HTMLElement.prototype[name] ??= function noop() {};
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

const {
  DELIMITED_CELL_CAP,
  DELIMITED_COLUMN_CAP,
  DELIMITED_ROW_CAP,
  applyDelimitedToModel,
  deleteColumn,
  deleteRow,
  delimiterForPath,
  detectDelimitedFormat,
  editorViewKindForPath,
  insertColumn,
  insertRow,
  numericColumns,
  parseClipboardBlock,
  parseDelimited,
  pasteGrid,
  serializeDelimited,
  setCell,
  svgDataUrl,
} = await import('./editor-delimited.ts');
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

function fakeModel(initial) {
  const model = {
    value: initial,
    edits: [],
    stops: 0,
    getValue: () => model.value,
    getFullModelRange: () => 'FULL',
    pushStackElement: () => {
      model.stops += 1;
    },
    pushEditOperations: (_before, edits) => {
      model.edits.push(edits);
      model.value = edits[0].text;
      return null;
    },
  };
  return model;
}

test('serializeDelimited quotes only when needed and keeps the line ending', () => {
  assert.equal(
    serializeDelimited([['a', 'b,c', 'say "x"', ' pad', 'end ', 'l1\nl2', 'cr\rx']], ','),
    'a,"b,c","say ""x"""," pad","end ","l1\nl2","cr\rx"'
  );
  assert.equal(serializeDelimited([['a,b', 'c d']], '\t'), 'a,b\tc d');
  assert.equal(serializeDelimited([['a'], ['b']], ',', { eol: '\r\n', trailingNewline: true }), 'a\r\nb\r\n');
  assert.equal(serializeDelimited([['a'], ['b']], ',', { eol: '\n', trailingNewline: false }), 'a\nb');
  assert.deepEqual(detectDelimitedFormat('a\r\nb\r\n'), { eol: '\r\n', trailingNewline: true });
  assert.deepEqual(detectDelimitedFormat('a\nb'), { eol: '\n', trailingNewline: false });
});

test('parse then serialize round-trips minimally quoted RFC 4180 text byte for byte', () => {
  const samples = [
    'name,note\r\n"Doe, Jane","said ""yes"""\r\n',
    'a,b,c\n1,,3\n"multi\nline",x,y',
    'a,b\n\n1\n',
    'x\r\n" lead",trail \r\n',
  ];
  for (const text of samples) {
    const format = detectDelimitedFormat(text);
    const sample = text.includes('" lead"') ? text.replace('trail ', '"trail "') : text;
    assert.equal(serializeDelimited(parseDelimited(sample, ',').rows, ',', detectDelimitedFormat(sample)), sample);
    assert.ok(format);
  }
  const tsv = 'a\tb\n1,2\t"x\ty"\n';
  assert.equal(serializeDelimited(parseDelimited(tsv, '\t').rows, '\t', detectDelimitedFormat(tsv)), tsv);
});

test('a cell edit writes the serialized grid to the model as one edit', () => {
  const text = 'name,qty\r\napple,1\r\n';
  const model = fakeModel(text);
  const rows = setCell(parseDelimited(text, ',').rows, 1, 0, 'big, red');
  applyDelimitedToModel(model, serializeDelimited(rows, ',', detectDelimitedFormat(text)));
  assert.equal(model.edits.length, 1);
  assert.equal(model.edits[0].length, 1);
  assert.equal(model.edits[0][0].range, 'FULL');
  assert.equal(model.value, 'name,qty\r\n"big, red",1\r\n');
  applyDelimitedToModel(model, model.value);
  assert.equal(model.edits.length, 1, 'an unchanged grid writes nothing');
});

test('paste grows rows and columns from the selection', () => {
  const rows = parseDelimited('a,b\n1,2', ',').rows;
  const block = parseClipboardBlock('x\ty\tz\n7\t8\t9\n', ',').rows;
  assert.deepEqual(block, [
    ['x', 'y', 'z'],
    ['7', '8', '9'],
  ]);
  const grown = pasteGrid(rows, 1, 1, block);
  assert.deepEqual(grown, [
    ['a', 'b'],
    ['1', 'x', 'y', 'z'],
    ['', '7', '8', '9'],
  ]);
  assert.deepEqual(parseClipboardBlock('p,q\nr,s', ',').rows, [
    ['p', 'q'],
    ['r', 's'],
  ]);
  assert.equal(parseClipboardBlock('p,q\nr,s', ',').refused, false);
  assert.deepEqual(
    rows,
    [
      ['a', 'b'],
      ['1', '2'],
    ],
    'the source grid is not mutated'
  );
});

test('row and column insert and delete', () => {
  const rows = [
    ['h1', 'h2'],
    ['a', 'b'],
    ['c', 'd'],
  ];
  assert.deepEqual(insertRow(rows, 1), [
    ['h1', 'h2'],
    ['', ''],
    ['a', 'b'],
    ['c', 'd'],
  ]);
  assert.deepEqual(insertRow(rows, 3).at(-1), ['', '']);
  assert.deepEqual(deleteRow(rows, 1), [
    ['h1', 'h2'],
    ['c', 'd'],
  ]);
  assert.deepEqual(insertColumn(rows, 1), [
    ['h1', '', 'h2'],
    ['a', '', 'b'],
    ['c', '', 'd'],
  ]);
  assert.deepEqual(insertColumn(rows, 2), [
    ['h1', 'h2', ''],
    ['a', 'b', ''],
    ['c', 'd', ''],
  ]);
  assert.deepEqual(deleteColumn(rows, 0), [['h2'], ['b'], ['d']]);
});

test('numeric columns ignore the header and empty cells', () => {
  const rows = [
    ['name', 'qty', 'mixed', 'blank'],
    ['a', '1', '1', ''],
    ['b', '-2.5e3', 'x', ''],
    ['c', '', '3', ''],
  ];
  assert.deepEqual(numericColumns(rows), [false, true, false, false]);
});

async function renderGrid(text, modelRef) {
  return render(React.createElement(EditorDelimitedTable, { text, delimiter: ',', modelRef }));
}

test('Ctrl/Cmd+S from a focused grid cell triggers save and is not consumed by the grid otherwise', async () => {
  let saves = 0;
  const { host, root } = await render(
    React.createElement(EditorDelimitedTable, {
      text: 'a,b\n1,2\n',
      delimiter: ',',
      onSave: () => {
        saves += 1;
      },
    })
  );
  try {
    const cell = host.querySelector('.rdg-cell[role="gridcell"]');
    const press = (init) => {
      const event = new window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
      cell.dispatchEvent(event);
      return event;
    };
    const plain = press({ key: 's' });
    assert.equal(plain.defaultPrevented, false);
    const ctrl = press({ key: 's', ctrlKey: true });
    assert.equal(ctrl.defaultPrevented, true);
    press({ key: 'S', metaKey: true });
    await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
    assert.equal(saves, 2);
  } finally {
    await act(async () => root.unmount());
  }
});

test('the grid shows editable cells and writes edits through the model', async () => {
  const model = fakeModel('name,qty\napple,1\n');
  const { host, root } = await renderGrid(model.value, { current: model });
  try {
    assert.ok(host.querySelector('[role="grid"]'));
    assert.equal(host.querySelector('.editor-table-notice'), null);
    assert.equal(host.querySelector('button.editor-table-add-row'), null, 'no separate add-row bar');
    const ghost = host.querySelector('.rdg-cell.editor-table-ghost-cell .editor-table-add-row');
    assert.ok(ghost, 'the add-row ghost row is the last grid row');
    assert.ok(host.querySelector('.rdg-cell.editor-table-rownum'), 'row-number column');
    await act(async () => ghost.click());
    assert.equal(model.edits.length, 1);
    assert.equal(model.value, 'name,qty\napple,1\n,\n');
  } finally {
    await act(async () => root.unmount());
  }
});

test('truncated files are read-only with the existing notice and never written', async () => {
  const big = Array.from({ length: DELIMITED_ROW_CAP + 10 }, (_, index) => `${index},v`).join('\n');
  const model = fakeModel(big);
  const first = await renderGrid(big, { current: model });
  try {
    assert.ok(first.host.querySelector('.editor-table-notice'));
    assert.equal(first.host.querySelector('.editor-table-add-row'), null);
    assert.equal(first.host.querySelector('.editor-table-view').getAttribute('data-readonly'), 'true');
  } finally {
    await act(async () => first.root.unmount());
  }
  const wide = Array.from({ length: DELIMITED_COLUMN_CAP + 5 }, (_, index) => `c${index}`).join(',');
  const second = await renderGrid(`${wide}\n${wide}`, { current: model });
  try {
    assert.equal(second.host.querySelectorAll('.editor-table-notice').length, 1);
    assert.equal(second.host.querySelector('.editor-table-add-row'), null);
  } finally {
    await act(async () => second.root.unmount());
  }
  assert.equal(model.edits.length, 0);
});

test('parseDelimited reports unterminated and stray quotes with positions', () => {
  assert.deepEqual(parseDelimited('a,b\n1,2\n', ',').diagnostics, []);
  assert.deepEqual(parseDelimited('a,"b\nc,d', ',').diagnostics, [
    { kind: 'unterminatedQuote', line: 1, row: 1, column: 2 },
  ]);
  assert.deepEqual(parseDelimited('a,b\nx,"y\nz', ',').diagnostics, [
    { kind: 'unterminatedQuote', line: 2, row: 2, column: 2 },
  ]);
  assert.deepEqual(parseDelimited('a,b\nx,y"z\n', ',').diagnostics, [
    { kind: 'strayQuote', line: 2, row: 2, column: 2 },
  ]);
  assert.deepEqual(parseDelimited('"a"b,c', ',').diagnostics, [{ kind: 'strayQuote', line: 1, row: 1, column: 1 }]);
});

test('malformed CSV is read-only with a notice and never written', async () => {
  for (const bad of ['a,"b\nc,d', 'a,b\nx,y"z\n']) {
    const model = fakeModel(bad);
    const { host, root } = await renderGrid(bad, { current: model });
    try {
      assert.ok(host.querySelector('[role="grid"]'), 'still viewable');
      assert.equal(host.querySelectorAll('.editor-table-notice').length, 1);
      assert.equal(host.querySelector('.editor-table-add-row'), null);
      assert.equal(host.querySelector('.editor-table-view').getAttribute('data-readonly'), 'true');
    } finally {
      await act(async () => root.unmount());
    }
    assert.equal(model.edits.length, 0);
    assert.equal(model.value, bad);
  }
});

test('Ctrl+Z / Ctrl+Y in the grid step the model history and redraw the table', async () => {
  const model = fakeModel('name,qty\napple,1\n');
  const past = [];
  const future = [];
  const push = model.pushEditOperations;
  model.pushEditOperations = (before, edits) => {
    past.push(model.value);
    future.length = 0;
    return push(before, edits);
  };
  model.undo = () => {
    if (!past.length) return;
    future.push(model.value);
    model.value = past.pop();
  };
  model.redo = () => {
    if (!future.length) return;
    past.push(model.value);
    model.value = future.pop();
  };
  function Owner() {
    const [snapshot, setSnapshot] = React.useState(model.value);
    return React.createElement(EditorDelimitedTable, {
      text: snapshot,
      delimiter: ',',
      modelRef: { current: model },
      onTextChange: setSnapshot,
    });
  }
  const { host, root } = await render(React.createElement(Owner));
  const rowCount = () => host.querySelectorAll('.rdg-row').length;
  const press = async (init) => {
    const event = new window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
    await act(async () => host.querySelector('.rdg-cell[role="gridcell"]').dispatchEvent(event));
    return event;
  };
  try {
    const before = rowCount();
    await act(async () => host.querySelector('.editor-table-add-row').click());
    assert.equal(model.value, 'name,qty\napple,1\n,\n');
    assert.equal(rowCount(), before + 1);
    const undo = await press({ key: 'z', ctrlKey: true });
    assert.equal(undo.defaultPrevented, true);
    assert.equal(model.value, 'name,qty\napple,1\n');
    assert.equal(rowCount(), before, 'the grid redraws from the undone model');
    await press({ key: 'y', ctrlKey: true });
    assert.equal(model.value, 'name,qty\napple,1\n,\n');
    await press({ key: 'Z', ctrlKey: true, shiftKey: true });
    assert.equal(model.value, 'name,qty\napple,1\n,\n', 'Ctrl+Shift+Z is redo, with nothing left to redo');
    await press({ key: 'z', metaKey: true });
    assert.equal(model.value, 'name,qty\napple,1\n');
  } finally {
    await act(async () => root.unmount());
  }
});

test('a grid edit survives the next render: the owner snapshot follows onTextChange', async () => {
  const model = fakeModel('name,qty\napple,1\n');
  // The owner (EditorPane) passes a snapshot taken when Table mode opened.
  function Owner() {
    const [snapshot, setSnapshot] = React.useState(model.value);
    return React.createElement(EditorDelimitedTable, {
      text: snapshot,
      delimiter: ',',
      modelRef: { current: model },
      onTextChange: setSnapshot,
    });
  }
  const { host, root } = await render(React.createElement(Owner));
  try {
    await act(async () => host.querySelector('.editor-table-add-row').click());
    await act(async () => host.querySelector('.editor-table-add-row').click());
    assert.equal(model.edits.length, 2, 'the second add builds on the first, not on the stale snapshot');
    assert.equal(model.value, 'name,qty\napple,1\n,\n,\n');
  } finally {
    await act(async () => root.unmount());
  }
});

test('a read-only file gets a read-only grid that never writes the model', async () => {
  const model = fakeModel('name,qty\napple,1\n');
  const { host, root } = await render(
    React.createElement(EditorDelimitedTable, {
      text: model.value,
      delimiter: ',',
      modelRef: { current: model },
      readOnly: true,
    })
  );
  try {
    assert.equal(host.querySelector('.editor-table-view').getAttribute('data-readonly'), 'true');
    assert.equal(host.querySelector('.editor-table-add-row'), null);
  } finally {
    await act(async () => root.unmount());
  }
  assert.equal(model.edits.length, 0);
});

test('two grids on one model never write from a stale snapshot', async () => {
  const model = fakeModel('h\n1\n');
  const owners = [];
  function Owner({ index }) {
    const [snapshot, setSnapshot] = React.useState(model.value);
    owners[index] = setSnapshot;
    return React.createElement(EditorDelimitedTable, {
      text: snapshot,
      delimiter: ',',
      modelRef: { current: model },
      onTextChange: setSnapshot,
    });
  }
  const a = await render(React.createElement(Owner, { index: 0 }));
  const b = await render(React.createElement(Owner, { index: 1 }));
  try {
    await act(async () => a.host.querySelector('.editor-table-add-row').click());
    await act(async () => a.host.querySelector('.editor-table-add-row').click());
    assert.equal(model.value, 'h\n1\n\n\n');
    // B still shows its old snapshot: its edit must not overwrite A's rows.
    await act(async () => b.host.querySelector('.editor-table-add-row').click());
    assert.equal(model.value, 'h\n1\n\n\n');
    // Once synced (EditorPane does this from onDidChangeContent) B builds on top.
    await act(async () => b.host.querySelector('.editor-table-add-row').click());
    assert.equal(model.value, 'h\n1\n\n\n\n');
  } finally {
    await act(async () => a.root.unmount());
    await act(async () => b.root.unmount());
  }
});

test('a final record that is one empty field keeps its record', () => {
  const text = 'header\n""';
  const rows = parseDelimited(text, ',').rows;
  assert.deepEqual(rows, [['header'], ['']]);
  const out = serializeDelimited(rows, ',', detectDelimitedFormat(text));
  assert.equal(out, text);
  assert.deepEqual(
    parseDelimited(serializeDelimited(setCell(rows, 0, 0, 'h2'), ',', detectDelimitedFormat(text)), ',').rows,
    [['h2'], ['']]
  );
  assert.equal(serializeDelimited([['a'], ['']], ',', { eol: '\n', trailingNewline: true }), 'a\n\n');
});

test('the header editor is a textarea that keeps newlines', async () => {
  const model = fakeModel('a,b\n1,2\n');
  const { host, root } = await renderGrid(model.value, { current: model });
  try {
    await act(async () => {
      host
        .querySelector('.editor-table-header-text')
        .dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true }));
    });
    const area = () => host.querySelector('textarea.editor-table-editor');
    assert.ok(area(), 'multiline editor');
    const setValue = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    await act(async () => {
      setValue.call(area(), 'first');
      area().dispatchEvent(new window.KeyboardEvent('keyup', { key: 'x', bubbles: true }));
    });
    area().setSelectionRange(5, 5);
    await act(async () => {
      area().dispatchEvent(
        new window.KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true, cancelable: true })
      );
    });
    assert.equal(area().value, 'first\n');
    assert.equal(model.edits.length, 0, 'Shift+Enter does not commit');
    await act(async () => {
      setValue.call(area(), 'first\nsecond!');
      area().dispatchEvent(new window.KeyboardEvent('keyup', { key: 'x', bubbles: true }));
    });
    await act(async () => {
      area().dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    });
    assert.equal(model.value, '"first\nsecond!",b\n1,2\n');
  } finally {
    await act(async () => root.unmount());
  }
});

test('oversized or malformed clipboard data is refused with a notice', async () => {
  const wide = Array.from({ length: DELIMITED_COLUMN_CAP + 1 }, (_, index) => `c${index}`).join('\t');
  assert.equal(parseClipboardBlock(wide, ',').refused, true);
  assert.equal(parseClipboardBlock('a,"b', ',').refused, true);
  assert.equal(parseClipboardBlock('a,b', ',').refused, false);
  const model = fakeModel('a,b\n1,2\n');
  const { host, root } = await renderGrid(model.value, { current: model });
  try {
    await act(async () => {
      const cell = host.querySelectorAll('.rdg-row .rdg-cell')[1];
      cell.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true, button: 0 }));
      cell.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    });
    const paste = new window.Event('paste', { bubbles: true, cancelable: true });
    paste.clipboardData = { getData: () => wide };
    await act(async () => {
      host.querySelectorAll('.rdg-row .rdg-cell')[1].dispatchEvent(paste);
    });
    assert.equal(model.edits.length, 0, 'nothing is partially pasted');
    assert.equal(host.querySelectorAll('.editor-table-notice').length, 1);
  } finally {
    await act(async () => root.unmount());
  }
});

test('source-mode text changes re-parse into the grid', async () => {
  const model = fakeModel('a,b\n1,2\n');
  const { host, root } = await renderGrid(model.value, { current: model });
  try {
    model.value = 'a,b\n1,2\n3,4\n';
    await act(async () =>
      root.render(
        React.createElement(EditorDelimitedTable, {
          text: 'a,b\n1,2\n3,4\n',
          delimiter: ',',
          modelRef: { current: model },
        })
      )
    );
    await act(async () => host.querySelector('.editor-table-add-row').click());
    assert.equal(model.value, 'a,b\n1,2\n3,4\n,\n');
  } finally {
    await act(async () => root.unmount());
  }
});
