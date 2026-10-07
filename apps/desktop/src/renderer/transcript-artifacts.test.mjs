import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { installTestDom } from './test-support/test-dom.mjs';
import { transcriptArtifacts } from './transcript-artifacts.ts';
import { ToolActivityGroup } from './transcript-tool-ui.tsx';
import { MarkdownProjectContext } from './MarkdownLink.tsx';

const media = (result, args = { action: 'generate', kind: 'image' }) => ({ kind: 'tool', name: 'media', args, result });
const office = (path, extra = {}) => ({
  kind: 'tool',
  name: 'office',
  args: { action: 'create' },
  result: { ok: true, artifacts: [{ path, operation: 'create' }], ...extra },
});

test('completed media and Office outputs become deduplicated artifacts, including aggregate envelopes', () => {
  const image = media({ ok: true, assetId: 'image-a', output: 'C:/work/a.png' });
  const document = office('C:/work/report.docx');
  const items = [
    image,
    { ...image, result: { content: [{ type: 'text', text: JSON.stringify(image.result) }] } },
    {
      aggregate: true,
      toolMembers: [
        media({ ok: true, status: 'done', kind: 'video', assetId: 'video-b' }, { action: 'status' }),
        document,
      ],
    },
  ];
  assert.deepEqual(
    transcriptArtifacts(items).map(({ kind, name }) => ({ kind, name })),
    [
      { kind: 'image', name: 'a.png' },
      { kind: 'video', name: 'video-b' },
      { kind: 'document', name: 'report.docx' },
    ]
  );
  assert.deepEqual(transcriptArtifacts(JSON.parse(JSON.stringify(items))), transcriptArtifacts(items));
});

test('SVG files written by edit and apply_patch become image artifacts; failed, deleted and other files do not', () => {
  const edit = (file_path, extra = {}) => ({ kind: 'tool', name: 'edit', args: { file_path }, result: 'ok', ...extra });
  const patch = (text) => ({ kind: 'tool', name: 'apply_patch', args: { patch: text }, result: 'ok' });
  assert.deepEqual(
    transcriptArtifacts([
      edit('C:/work/chart.svg'),
      edit('C:/work/chart.svg'),
      edit('C:/work/app.ts'),
      edit('C:/work/failed.svg', { isError: true }),
      patch(
        [
          '*** Begin Patch',
          '*** Add File: out/new.svg',
          '+<svg/>',
          '*** Update File: old.svg',
          '*** Move to: moved.svg',
          '*** Delete File: gone.svg',
          '*** End Patch',
        ].join('\n')
      ),
    ]).map(({ kind, path }) => ({ kind, path })),
    [
      { kind: 'image', path: 'C:/work/chart.svg' },
      { kind: 'image', path: 'out/new.svg' },
      { kind: 'image', path: 'moved.svg' },
    ]
  );
});

test('input paths, lookup, pending, failed and executable outputs never become result cards', () => {
  assert.deepEqual(
    transcriptArtifacts([
      media({ ok: true, lanes: [] }, { action: 'list', path: 'a.png' }),
      { ...media(null), args: { action: 'generate', path: 'a.png' } },
      media({ ok: true, status: 'running', assetId: 'pending' }),
      media({ ok: false, assetId: 'failed', output: 'a.png' }),
      { ...office('bad.docx'), isError: true },
      office('bad.pptx', { ok: false }),
      office('danger.exe'),
      office('danger.docm'),
      { ...office('input.docx'), name: 'read' },
    ]),
    []
  );
});

test('collapsed activity exposes image, playable video, a document that opens in its conversation Project, and a deleted one as deleted', async () => {
  const { dom, restore } = installTestDom(null, {
    html: '<!doctype html><div id="root"></div>',
    jsdom: { url: 'http://localhost/' },
    expose: ['navigator'],
  });
  const opened = [];
  // jsdom has no modal dialogs; the card only needs the dialog to open.
  dom.window.HTMLDialogElement.prototype.showModal = function showModal() {
    this.open = true;
  };
  dom.window.mixdogDesktop = {
    mediaUrl: (id, variant) => `http://localhost/media/${id}/${variant}`,
    openLocalFileLink: async (...args) => {
      opened.push(args);
    },
    statProjectFile: async (_project, path) => {
      if (/gone/.test(path)) throw Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' });
      return { mtimeMs: 0, size: 1 };
    },
    resolveLocalPaths: async ([absolutePath]) => {
      if (/gone/.test(absolutePath)) throw Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' });
      return [{ absolutePath, dir: false, projectPath: 'C:/work', relPath: absolutePath.slice('C:/work/'.length) }];
    },
    previewProjectFile: async (_project, relPath) => ({
      url: `mixdog-media://preview/token/${relPath}`,
      kind: 'image',
      mime: 'image/svg+xml',
    }),
  };
  const root = createRoot(dom.window.document.getElementById('root'));
  try {
    await act(async () =>
      root.render(
        React.createElement(
          MarkdownProjectContext.Provider,
          { value: 'C:/work' },
          React.createElement(ToolActivityGroup, {
            items: [
              media({ ok: true, assetId: 'a', output: 'C:/work/a.png' }),
              media({ ok: true, assetId: 'b', output: 'C:/work/b.mp4' }, { action: 'generate', kind: 'video' }),
              office('C:/work/report #1.docx'),
              office('C:/work/gone.xlsx'),
              { kind: 'tool', name: 'edit', args: { file_path: 'C:/work/chart.svg' }, result: 'ok' },
            ],
          })
        )
      )
    );
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    const gone = dom.window.document.querySelector('.transcript-artifact-file[aria-disabled="true"]');
    assert.equal(gone.tagName, 'SPAN');
    assert.equal(gone.querySelector('.transcript-artifact-badge').textContent, 'XLSX');
    assert.equal(gone.querySelector('.transcript-artifact-caption > span').textContent, 'gone.xlsx');
    assert.equal(gone.querySelector('small').textContent, 'Deleted');
    assert.equal(dom.window.document.querySelector('.tool-activity-header').getAttribute('aria-expanded'), 'false');
    assert.ok(dom.window.document.querySelector('.transcript-artifacts img'));
    // A written SVG renders as an image through the file preview lane, never inline markup.
    const svg = dom.window.document.querySelector('img[src="mixdog-media://preview/token/chart.svg"]');
    assert.equal(svg?.closest('figure')?.querySelector('figcaption > span')?.textContent, 'chart.svg');
    // A video card shows its thumbnail; playback exists only in the dialog the user opens.
    assert.equal(dom.window.document.querySelector('.transcript-artifacts video'), null);
    const videoCard = dom.window.document.querySelector('.transcript-artifact-frame[aria-label="b.mp4"]');
    await act(async () => videoCard.click());
    const video = dom.window.document.querySelector('.transcript-artifact-preview video');
    assert.equal(video.controls, true);
    assert.equal(video.autoplay, false);
    assert.equal(video.preload, 'none');
    const link = dom.window.document.querySelector('a.transcript-artifact-file');
    await act(async () => link.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true })));
    // The renderer resolves the artifact inside its conversation Project and
    // re-encodes the name so main's URL-style parsing keeps the `#`.
    assert.deepEqual(opened, [['C:/work', 'report%20%231.docx']]);
  } finally {
    await act(async () => root.unmount());
    restore();
  }
});
