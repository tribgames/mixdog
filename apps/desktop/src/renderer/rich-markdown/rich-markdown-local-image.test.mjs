import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { installTestDom } from '../test-support/test-dom.mjs';
import { RichMarkdownLocalImage } from './RichMarkdownNodeViews';

const PROJECT = 'C:/Project/notes';

test("a document's local image mounted again holds its picture's box until the picture has loaded", async (t) => {
  const { dom, root } = installTestDom(t, { rootId: 'root' });
  dom.window.mixdogDesktop = {
    listProjects: async () => [{ path: PROJECT, name: 'notes' }],
    statProjectFile: async () => ({ size: 10, mtimeMs: 1 }),
    searchProjectFiles: async () => ['docs/chart.png'],
    resolveLocalPaths: async ([absolutePath]) => [
      { absolutePath, dir: false, name: 'chart.png', size: 10, projectPath: PROJECT, relPath: 'docs/chart.png' },
    ],
    previewProjectFile: async (_project, path) => ({
      url: `mixdog-media://preview/token/${path}`,
      kind: 'image',
      mime: 'image/png',
    }),
  };
  const doc = dom.window.document;
  const image = React.createElement(RichMarkdownLocalImage, { projectPath: PROJECT, path: 'docs/chart.png', alt: '' });
  const settleLookups = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  const loadPicture = () =>
    act(async () => {
      const img = doc.querySelector('img');
      Object.defineProperty(img, 'offsetWidth', { configurable: true, value: 640 });
      Object.defineProperty(img, 'offsetHeight', { configurable: true, value: 360 });
      img.dispatchEvent(new dom.window.Event('load'));
    });
  await act(async () => root.render(image));
  await settleLookups();
  await loadPicture();
  // The document shown again mounts the image anew; the 48px loading box there would shrink its line until the
  // lookup answers, and grow it back once the picture loads.
  act(() => root.render(null));
  act(() => root.render(image));
  assert.equal(
    doc.querySelector('.rich-markdown-image-loading')?.getAttribute('style'),
    'width: 640px; height: 360px;'
  );
  await settleLookups();
  assert.equal(doc.querySelector('img')?.getAttribute('src'), 'mixdog-media://preview/token/docs/chart.png');
  assert.equal(doc.querySelector('img')?.getAttribute('style'), 'width: 640px; height: 360px;', 'held while it loads');
  await loadPicture();
  assert.equal(doc.querySelector('img')?.getAttribute('style') || null, null);
});
