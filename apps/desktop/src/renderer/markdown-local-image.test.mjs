import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { installTestDom } from './test-support/test-dom.mjs';
import MarkdownAstBody from './MarkdownAstBody';
import { parseMarkdownToHast } from './markdown-ast';
import { MarkdownOpenFileContext, MarkdownProjectContext } from './MarkdownLink';

const PROJECT = 'C:/Project/conversation';
const FILES = ['output/a.png', 'output/b.svg', 'output/c.pptx', 'output/broken.png'];
const CopyControl = () => null;

async function mount(t, text, configure = () => {}) {
  const { dom, root } = installTestDom(t, { rootId: 'root' });
  const opened = [];
  const local = [];
  dom.window.HTMLDialogElement.prototype.showModal = function showModal() {
    this.open = true;
  };
  dom.window.HTMLDialogElement.prototype.close = function close() {
    this.open = false;
    this.dispatchEvent(new dom.window.Event('close'));
  };
  dom.window.mixdogDesktop = {
    listProjects: async () => [{ path: PROJECT, name: 'conversation' }],
    statProjectFile: async (_project, path) => {
      if (FILES.includes(path)) return { size: 10, mtimeMs: 1 };
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    },
    searchProjectFiles: async () => FILES,
    resolveLocalPaths: async ([absolutePath]) => {
      const relPath = absolutePath.slice(PROJECT.length + 1);
      if (!FILES.includes(relPath)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return [{ absolutePath, dir: false, name: relPath, size: 10, projectPath: PROJECT, relPath }];
    },
    previewProjectFile: async (_project, path) => {
      if (path === 'output/broken.png') throw new Error('unsupported');
      return { url: `mixdog-media://preview/token/${path}`, kind: 'image', mime: 'image/png' };
    },
    openFilePath: async (...args) => {
      local.push(args);
    },
  };
  configure(dom.window.mixdogDesktop);
  await act(async () => {
    root.render(
      React.createElement(
        MarkdownProjectContext.Provider,
        { value: PROJECT },
        React.createElement(
          MarkdownOpenFileContext.Provider,
          { value: (...args) => opened.push(args) },
          React.createElement(MarkdownAstBody, { root: parseMarkdownToHast(text), copyControl: CopyControl })
        )
      )
    );
  });
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  const doc = dom.window.document;
  const press = (element, init = {}) =>
    act(async () => {
      element.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true, ...init }));
    });
  return { dom, doc, opened, local, press };
}

const dialogImage = (doc) => doc.querySelector('dialog img');
const button = (doc, label) => doc.querySelector(`dialog button[aria-label="${label}"]`);

test('a local image becomes a thumbnail rendered with <img>, svg included', async (t) => {
  const f = await mount(t, '![chart](output/a.png)\n\n![vector](output/b.svg)');
  const thumbs = [...f.doc.querySelectorAll('button.markdown-local-image img')];
  assert.deepEqual(
    thumbs.map((img) => img.getAttribute('src')),
    ['mixdog-media://preview/token/output/a.png', 'mixdog-media://preview/token/output/b.svg']
  );
  assert.equal(f.doc.querySelector('a'), null);
  assert.equal(f.doc.querySelector('svg, iframe'), null);
});

test('a failed preview falls back to the path link', async (t) => {
  const failed = await mount(t, '![x](output/broken.png)');
  assert.equal(failed.doc.querySelector('img'), null);
  assert.equal(failed.doc.querySelector('a')?.getAttribute('href'), 'output/broken.png');
});

test('a missing preview API falls back to the path link', async (t) => {
  const noApi = await mount(t, '![x](output/a.png)', (api) => {
    delete api.previewProjectFile;
  });
  assert.equal(noApi.doc.querySelector('img'), null);
  assert.equal(noApi.doc.querySelector('a')?.getAttribute('href'), 'output/a.png');
});

test('an image that fails to load falls back to the path link', async (t) => {
  const broken = await mount(t, '![x](output/a.png)');
  await act(async () =>
    broken.doc.querySelector('.markdown-local-image img').dispatchEvent(new broken.dom.window.Event('error'))
  );
  assert.equal(broken.doc.querySelector('img'), null);
  assert.equal(broken.doc.querySelector('a')?.getAttribute('href'), 'output/a.png');
});

test('non-image local targets and remote images keep their behavior', async (t) => {
  const f = await mount(t, '![deck](output/c.pptx)\n\n![remote](https://example.com/r.png)');
  assert.equal(f.doc.querySelector('.markdown-local-image'), null);
  assert.equal(f.doc.querySelector('a')?.getAttribute('href'), 'output/c.pptx');
  assert.equal(f.doc.querySelector('img')?.getAttribute('src'), 'https://example.com/r.png');
});

test('the lightbox navigates across the message images, zooms, pans and closes', async (t) => {
  const f = await mount(t, '![one](output/a.png)\n\n![two](output/b.svg)');
  assert.equal(f.doc.querySelector('dialog'), null);
  await f.press(f.doc.querySelector('button.markdown-local-image'));
  assert.equal(dialogImage(f.doc).getAttribute('src'), 'mixdog-media://preview/token/output/a.png');
  assert.match(f.doc.querySelector('.image-lightbox-count').textContent, /1 \/ 2/);

  await f.press(button(f.doc, 'Next image'));
  assert.equal(dialogImage(f.doc).getAttribute('src'), 'mixdog-media://preview/token/output/b.svg');
  const dialog = f.doc.querySelector('dialog');
  const key = (name) =>
    act(async () => {
      dialog.dispatchEvent(new f.dom.window.KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }));
    });
  await key('ArrowRight');
  assert.equal(dialogImage(f.doc).getAttribute('src'), 'mixdog-media://preview/token/output/a.png');
  await key('ArrowLeft');
  assert.equal(dialogImage(f.doc).getAttribute('src'), 'mixdog-media://preview/token/output/b.svg');

  await f.press(button(f.doc, 'Zoom in'));
  assert.match(dialogImage(f.doc).style.transform, /scale\(1\.25\)/);
  await act(async () =>
    f.doc
      .querySelector('.image-lightbox-stage')
      .dispatchEvent(new f.dom.window.WheelEvent('wheel', { deltaY: -100, bubbles: true, cancelable: true }))
  );
  assert.match(dialogImage(f.doc).style.transform, /scale\(1\.5625\)/);
  const stage = f.doc.querySelector('.image-lightbox-stage');
  const pointer = (type, x) => new f.dom.window.MouseEvent(type, { bubbles: true, clientX: x, clientY: 0 });
  await act(async () => stage.dispatchEvent(pointer('pointerdown', 10)));
  await act(async () => stage.dispatchEvent(pointer('pointermove', 40)));
  await act(async () => stage.dispatchEvent(pointer('pointerup', 40)));
  assert.match(dialogImage(f.doc).style.transform, /translate\(30px, 0px\)/);
  await f.press(button(f.doc, 'Fit to window'));
  assert.match(dialogImage(f.doc).style.transform, /translate\(0px, 0px\) scale\(1\)/);
  await f.press(button(f.doc, 'Zoom out'));
  assert.match(dialogImage(f.doc).style.transform, /scale\(0\.8\)/);

  await f.press(button(f.doc, 'Close preview'));
  assert.equal(f.doc.querySelector('dialog'), null);
});

test('the lightbox opens the file in a tab or the default app, and closes on the backdrop', async (t) => {
  const f = await mount(t, '![one](output/a.png)');
  await f.press(f.doc.querySelector('button.markdown-local-image'));
  assert.equal(button(f.doc, 'Previous image'), null);
  await f.press(button(f.doc, 'Open in default app'));
  assert.deepEqual(f.local, [[PROJECT, 'output/a.png', undefined]]);
  await f.press(button(f.doc, 'Open in tab'));
  assert.deepEqual(f.opened, [[PROJECT, 'output/a.png']]);
  assert.equal(f.doc.querySelector('dialog'), null);

  await f.press(f.doc.querySelector('button.markdown-local-image'));
  await f.press(f.doc.querySelector('dialog'));
  assert.equal(f.doc.querySelector('dialog'), null);
});
