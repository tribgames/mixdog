import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import { transcriptArtifacts } from './transcript-artifacts.ts';
import { ToolActivityGroup } from './transcript-tool-ui.tsx';
import { MarkdownProjectContext } from './MarkdownLink.tsx';

const media = (result, args = { action: 'generate', kind: 'image' }) =>
  ({ kind: 'tool', name: 'media', args, result });
const office = (path, extra = {}) => ({
  kind: 'tool', name: 'office', args: { action: 'create' },
  result: { ok: true, artifacts: [{ path, operation: 'create' }], ...extra },
});

test('completed media and Office outputs become deduplicated artifacts, including aggregate envelopes', () => {
  const image = media({ ok: true, assetId: 'image-a', output: 'C:/work/a.png' });
  const document = office('C:/work/report.docx');
  const items = [
    image,
    { ...image, result: { content: [{ type: 'text', text: JSON.stringify(image.result) }] } },
    { aggregate: true, toolMembers: [
      media({ ok: true, status: 'done', kind: 'video', assetId: 'video-b' }, { action: 'status' }),
      document,
    ] },
  ];
  assert.deepEqual(transcriptArtifacts(items).map(({ kind, name }) => ({ kind, name })), [
    { kind: 'image', name: 'a.png' }, { kind: 'video', name: 'video-b' },
    { kind: 'document', name: 'report.docx' },
  ]);
  assert.deepEqual(transcriptArtifacts(JSON.parse(JSON.stringify(items))), transcriptArtifacts(items));
});

test('input paths, lookup, pending, failed and executable outputs never become result cards', () => {
  assert.deepEqual(transcriptArtifacts([
    media({ ok: true, lanes: [] }, { action: 'list', path: 'a.png' }),
    { ...media(null), args: { action: 'generate', path: 'a.png' } },
    media({ ok: true, status: 'running', assetId: 'pending' }),
    media({ ok: false, assetId: 'failed', output: 'a.png' }),
    { ...office('bad.docx'), isError: true },
    office('bad.pptx', { ok: false }),
    office('danger.exe'),
    office('danger.docm'),
    { ...office('input.docx'), name: 'read' },
  ]), []);
});

test('collapsed activity exposes image, playable video and a document that opens in its conversation Project', async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost/' });
  const previous = new Map(['window', 'document', 'navigator', 'IS_REACT_ACT_ENVIRONMENT']
    .map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const key of ['window', 'document', 'navigator']) {
    Object.defineProperty(globalThis, key, { configurable: true, value: key === 'window' ? dom.window : dom.window[key] });
  }
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const opened = [];
  dom.window.mixdogDesktop = {
    mediaUrl: (id, variant) => `http://localhost/media/${id}/${variant}`,
    openLocalFileLink: async (...args) => { opened.push(args); },
  };
  const root = createRoot(dom.window.document.getElementById('root'));
  try {
    await act(async () => root.render(
      React.createElement(MarkdownProjectContext.Provider, { value: 'C:/work' },
        React.createElement(ToolActivityGroup, { items: [
          media({ ok: true, assetId: 'a', output: 'C:/work/a.png' }),
          media({ ok: true, assetId: 'b', output: 'C:/work/b.mp4' }, { action: 'generate', kind: 'video' }),
          office('C:/work/report #1.docx'),
        ] })),
    ));
    assert.equal(dom.window.document.querySelector('.tool-activity-header').getAttribute('aria-expanded'), 'false');
    assert.ok(dom.window.document.querySelector('.transcript-artifacts img'));
    const video = dom.window.document.querySelector('video');
    assert.equal(video.controls, true);
    assert.equal(video.autoplay, false);
    assert.equal(video.preload, 'none');
    const link = dom.window.document.querySelector('a.transcript-artifact-file');
    await act(async () => link.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true })));
    assert.deepEqual(opened, [['C:/work', 'C:/work/report%20%231.docx']]);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
});
