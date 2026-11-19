import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { installTestDom } from './test-support/test-dom.mjs';
import { AttachmentCard, pdfPageKey, pdfPages } from './attachment-card.tsx';
import {
  codeMinimapLines,
  codeStrokes,
  delimitedSummary,
  looksLikeCode,
  textMinimapLines,
} from './file-thumbnail-art.tsx';
import { TranscriptArtifacts } from './transcript-artifacts-ui.tsx';
import { MarkdownProjectContext } from './MarkdownLink.tsx';

const office = (path) => ({
  kind: 'tool',
  name: 'office',
  args: { action: 'create' },
  result: { ok: true, artifacts: [{ path, operation: 'create' }] },
});

function mount(api) {
  const { dom, restore } = installTestDom(null, {
    html: '<!doctype html><div id="root"></div>',
    jsdom: { url: 'http://localhost/' },
    expose: ['navigator'],
  });
  dom.window.mixdogDesktop = {
    resolveLocalPaths: async ([absolutePath]) => [
      { absolutePath, dir: false, projectPath: 'C:/work', relPath: absolutePath.slice('C:/work/'.length) },
    ],
    ...api,
  };
  const root = createRoot(dom.window.document.getElementById('root'));
  return { dom, root, restore };
}

const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));

test('a document card shows the drawn sheet while converting, then the first page with its page count and size', async () => {
  let release;
  const { createObjectURL, revokeObjectURL } = URL;
  const created = [];
  const revoked = [];
  URL.createObjectURL = (blob) => {
    assert.equal(blob.type, 'image/png');
    const url = `blob:test/page-${created.length}`;
    created.push(url);
    return url;
  };
  URL.revokeObjectURL = (url) => revoked.push(url);
  const requests = [];
  const { dom, root, restore } = mount({
    statProjectFile: async () => ({ mtimeMs: 1, size: 1_468_006 }),
    previewDocumentPages: (project, relPath, _token, options) => {
      requests.push([project, relPath, options]);
      return new Promise((resolve) => {
        release = () =>
          resolve({
            format: 'pdf',
            mtimeMs: 1,
            size: 9,
            pageCount: 12,
            pages: [{ page: 1, width: 320, height: 414, mime: 'image/png', base64: 'AAAA' }],
          });
      });
    },
  });
  try {
    await act(async () =>
      root.render(
        React.createElement(
          MarkdownProjectContext.Provider,
          { value: 'C:/work' },
          React.createElement(TranscriptArtifacts, { items: [office('C:/work/review.pdf')] })
        )
      )
    );
    await settle();
    const doc = dom.window.document;
    const card = doc.querySelector('a.transcript-artifact-file');
    assert.ok(card.querySelector('.transcript-artifact-thumb svg.file-sheet.file-tone-pdf'));
    assert.equal(card.querySelector('.transcript-artifact-thumb img'), null);
    assert.equal(card.querySelector('small > span:last-child').textContent, 'Preparing preview… · 1.4 MB');
    assert.deepEqual(requests, [['C:/work', 'review.pdf', { pages: [1], maxWidth: 320 }]]);
    await act(async () => release());
    await settle();
    assert.equal(card.querySelector('.transcript-artifact-thumb svg'), null);
    // The page is an object URL over its bytes, not a base64 data URL in state.
    assert.deepEqual(created, ['blob:test/page-0']);
    assert.equal(card.querySelector('.transcript-artifact-thumb img.file-page').getAttribute('src'), created[0]);
    assert.equal(card.querySelector('.file-type-word.file-tone-pdf').textContent, 'PDF');
    assert.equal(card.querySelector('small > span:last-child').textContent, '12 pages · 1.4 MB');
    assert.equal(card.querySelector('.transcript-artifact-open').getAttribute('aria-hidden'), 'true');
    assert.deepEqual(revoked, []);
    await act(async () => root.unmount());
    assert.deepEqual(revoked, created, 'the page URL is revoked when the card goes');
  } finally {
    await act(async () => root.unmount());
    URL.createObjectURL = createObjectURL;
    URL.revokeObjectURL = revokeObjectURL;
    restore();
  }
});

test('a document card whose preview fails keeps the drawn sheet; a CSV draws a table from its rows', async () => {
  const { dom, root, restore } = mount({
    statProjectFile: async () => ({ mtimeMs: 1, size: 2048 }),
    previewDocumentPages: async () => {
      throw new Error('LibreOffice is not installed');
    },
    readProjectFile: async () => ({
      content: 'id,name,total\n1,"Kim, J",30\n2,Lee,40\n',
      mtimeMs: 1,
      binary: false,
      tooLarge: false,
      encoding: 'utf8',
    }),
  });
  try {
    await act(async () =>
      root.render(
        React.createElement(
          MarkdownProjectContext.Provider,
          { value: 'C:/work' },
          React.createElement(TranscriptArtifacts, {
            items: [office('C:/work/deck.pptx'), office('C:/work/orders.csv')],
          })
        )
      )
    );
    await settle();
    const [deck, orders] = dom.window.document.querySelectorAll('.transcript-artifact-file');
    assert.ok(deck.querySelector('.transcript-artifact-thumb svg.file-sheet.file-tone-pptx'));
    assert.equal(deck.querySelector('small > span:last-child').textContent, '2 KB');
    assert.ok(orders.querySelector('.transcript-artifact-thumb .file-table'));
    assert.equal(orders.querySelectorAll('.file-table-cell').length, 9);
    assert.equal(orders.querySelectorAll('.file-table-cell.head').length, 3);
    assert.equal(orders.querySelector('.file-type-word.file-tone-xlsx').textContent, 'CSV');
    assert.equal(orders.querySelector('small > span:last-child').textContent, '2 rows · 3 columns · 2 KB');
  } finally {
    await act(async () => root.unmount());
    restore();
  }
});

test('code minimap merges punctuation and same-kind runs and keeps indentation', () => {
  assert.deepEqual(codeStrokes('  const total = sum(a, 10);'), [
    { kind: 'space', width: 2 },
    { kind: 'keyword', width: 5 },
    { kind: 'space', width: 1 },
    { kind: 'ident', width: 5 },
    { kind: 'space', width: 1 },
    { kind: 'punct', width: 1 },
    { kind: 'space', width: 1 },
    { kind: 'ident', width: 6 },
    { kind: 'space', width: 1 },
    { kind: 'number', width: 4 },
  ]);
  assert.deepEqual(codeStrokes("log('done') // ok   "), [
    { kind: 'ident', width: 4 },
    { kind: 'string', width: 7 },
    { kind: 'space', width: 1 },
    { kind: 'comment', width: 5 },
  ]);
  const source = Array.from({ length: 20 }, (_, index) => `let v${index} = ${index};`).join('\n');
  assert.equal(codeMinimapLines(source).length, 14);
});

test('prose minimap draws headings, wrapped lines and gaps; pastes are told apart', () => {
  const notes = `# Meeting notes\n\n${'word '.repeat(18)}\nShort line\n\n\n- item one`;
  assert.deepEqual(textMinimapLines(notes), [
    { kind: 'heading', width: 10 },
    { kind: 'gap', width: 0 },
    { kind: 'line', width: 34 },
    { kind: 'line', width: 34 },
    { kind: 'line', width: 8 },
    { kind: 'line', width: 9 },
    { kind: 'gap', width: 0 },
    { kind: 'line', width: 7 },
  ]);
  assert.equal(looksLikeCode('const a = 1;\nif (a) {\n  run();\n}'), true);
  assert.equal(looksLikeCode('def main():\n    print("hi")\n    return 0'), true);
  assert.equal(
    looksLikeCode('Dear team,\n\nThe release is ready. Please review the notes below.\n- fixes\n- docs'),
    false
  );
  assert.deepEqual(delimitedSummary('a\tb\n1\t2\n', '\t'), {
    rows: [
      ['a', 'b'],
      ['1', '2'],
    ],
    rowCount: 1,
    columnCount: 2,
  });
});

test('table summary keeps a quoted multiline field in one cell (CSV and TSV)', () => {
  assert.deepEqual(delimitedSummary('id,note,total\r\n1,"line one\r\nline two, ""quoted""",30\n\n2,plain,40\n', ','), {
    rows: [
      ['id', 'note', 'total'],
      ['1', 'line one\r\nline two, "quoted"', '30'],
      ['2', 'plain', '40'],
    ],
    rowCount: 2,
    columnCount: 3,
  });
  assert.deepEqual(delimitedSummary('a\tb\n"x\ny"\tz\n', '\t'), {
    rows: [
      ['a', 'b'],
      ['x\ny', 'z'],
    ],
    rowCount: 1,
    columnCount: 2,
  });
});

/** Settles until `done()` holds (a digest resolves off the main thread). */
async function settleUntil(done) {
  for (let step = 0; step < 50 && !done(); step++) await settle();
}

const pageSrc = (dom) => dom.window.document.querySelector('img.file-page')?.getAttribute('src') ?? null;

test("the PDF page cache does not keep the PDF's bytes once its card is gone", async () => {
  const { root, restore } = mount({});
  const content = `JVBERi0x${'A'.repeat(4096)}`;
  const key = await pdfPageKey(content);
  try {
    await act(async () => root.render(React.createElement(AttachmentCard, { kind: 'pdf', name: 'big.pdf', content })));
    await settleUntil(() => pdfPages.has(key));
  } finally {
    await act(async () => root.unmount());
    restore();
  }
  assert.ok(pdfPages.has(key), 'the page is cached');
  assert.ok(
    [...pdfPages.keys()].every((cached) => cached.length < 100),
    'no key holds the base64 data'
  );
});

test("two PDFs a short hash cannot tell apart never share a first page", async () => {
  // Equal length and equal 32-bit FNV-1a: a length-plus-FNV key gave B the page of A.
  const [first, second] = ['JVBERi0xq9cCAA', 'JVBERi0xmHADAA'];
  assert.notEqual(await pdfPageKey(first), await pdfPageKey(second));
  pdfPages.set(await pdfPageKey(first), Promise.resolve('data:image/png;base64,PAGE-A'));
  const { dom, root, restore } = mount({});
  try {
    await act(async () =>
      root.render(React.createElement(AttachmentCard, { kind: 'pdf', name: 'b.pdf', content: second }))
    );
    const key = await pdfPageKey(second);
    await settleUntil(() => pdfPages.has(key));
    await settle();
    assert.notEqual(pageSrc(dom), 'data:image/png;base64,PAGE-A');
  } finally {
    await act(async () => root.unmount());
    restore();
  }
});

test('a PDF card with a trusted identity is cached under it, not under its bytes', async () => {
  pdfPages.set(await pdfPageKey('', 'msg-7\0file-1'), Promise.resolve('data:image/png;base64,SENT'));
  const { dom, root, restore } = mount({});
  try {
    await act(async () =>
      root.render(
        React.createElement(AttachmentCard, {
          kind: 'pdf',
          name: 'sent.pdf',
          content: 'JVBERi0xsent',
          contentId: 'msg-7\0file-1',
        })
      )
    );
    await settleUntil(() => pageSrc(dom) !== null);
    assert.equal(pageSrc(dom), 'data:image/png;base64,SENT');
  } finally {
    await act(async () => root.unmount());
    restore();
  }
});

test("a sent PDF's card is cached under its message and token", async () => {
  const [{ registerSentAttachments, sentAttachmentIdentity }, { TranscriptRow }] = await Promise.all([
    import('./attachment-menu.ts'),
    import('./transcript-row.tsx'),
  ]);
  const token = '[PDF #1: report.pdf]';
  registerSentAttachments('sent-pdf-1', [
    {
      token,
      kind: 'pdf',
      name: 'report.pdf',
      mimeType: 'application/pdf',
      data: Buffer.from('%PDF-1.4 sent').toString('base64'),
    },
  ]);
  pdfPages.set(
    await pdfPageKey('', sentAttachmentIdentity('sent-pdf-1', token)),
    Promise.resolve('data:image/png;base64,SENT-PAGE')
  );
  const { dom, root, restore } = mount({});
  try {
    await act(async () =>
      root.render(React.createElement(TranscriptRow, { item: { kind: 'user', id: 'sent-pdf-1', text: token } }))
    );
    await settleUntil(() => pageSrc(dom) !== null);
    assert.equal(pageSrc(dom), 'data:image/png;base64,SENT-PAGE');
  } finally {
    await act(async () => root.unmount());
    restore();
  }
});

test('attachment cards draw content thumbnails over a name bar, with no gradient or tag pill', async () => {
  const { dom, root, restore } = mount({});
  pdfPages.set(await pdfPageKey('JVBERi0='), Promise.resolve('data:image/png;base64,PAGE'));
  try {
    await act(async () =>
      root.render(
        React.createElement(
          'div',
          null,
          React.createElement(AttachmentCard, { kind: 'pdf', name: 'brief.pdf', content: 'JVBERi0=' }),
          React.createElement(AttachmentCard, { kind: 'office', name: 'plan.xlsx', meta: '12 KB' }),
          React.createElement(AttachmentCard, { kind: 'text', name: 'app.ts', content: 'export const a = 1;\n' }),
          React.createElement(AttachmentCard, {
            kind: 'pasted',
            name: 'Pasted text #1',
            content: '# Notes\n\nThe plan is simple and short.',
            meta: '3 lines',
          }),
          React.createElement(AttachmentCard, { kind: 'image', name: 'a.png', imageUrl: 'data:image/png;base64,AA' })
        )
      )
    );
    await settle();
    const [pdf, sheet, code, pasted, image] = dom.window.document.querySelectorAll('.attachment-card');
    // The page and both minimaps share one inset paper frame inside the shot.
    assert.equal(
      pdf.querySelector('.attachment-card-shot > .attachment-card-frame > img.file-page').getAttribute('src'),
      'data:image/png;base64,PAGE'
    );
    assert.ok(code.querySelector('.attachment-card-shot > .attachment-card-frame > .file-minimap'));
    assert.ok(pasted.querySelector('.attachment-card-shot > .attachment-card-frame > .file-minimap.paper'));
    assert.equal(sheet.querySelector('.attachment-card-frame'), null);
    for (const card of [pdf, sheet, code, pasted, image]) {
      assert.equal(card.querySelector('.attachment-card-tag'), null);
      assert.equal(card.getAttribute('style'), null);
    }
    assert.ok(sheet.querySelector('.attachment-card-shot svg.file-sheet.file-tone-xlsx'));
    assert.equal(sheet.querySelector('.attachment-card-bar .attachment-card-name').textContent, 'plan.xlsx');
    assert.equal(sheet.querySelector('.attachment-card-bar .file-type-word').textContent, 'XLSX');
    assert.equal(sheet.dataset.tooltip, 'plan.xlsx · 12 KB');
    assert.ok(code.querySelector('.attachment-card-shot .file-minimap:not(.paper) b.keyword'));
    assert.equal(code.querySelector('.file-type-word.file-tone-code').textContent, 'TS');
    assert.ok(pasted.querySelector('.attachment-card-shot .file-minimap.paper .heading'));
    assert.equal(pasted.querySelector('.attachment-card-name').textContent, 'Paste · 3 lines');
    assert.equal(pasted.dataset.tooltip, 'Paste · 3 lines');
    assert.equal(image.querySelector('.attachment-card-bar'), null);
    assert.equal(image.querySelector('img').getAttribute('alt'), 'a.png');
  } finally {
    await act(async () => root.unmount());
    restore();
  }
});
