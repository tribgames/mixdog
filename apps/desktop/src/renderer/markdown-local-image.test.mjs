import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { installTestDom } from './test-support/test-dom.mjs';
import MarkdownAstBody from './MarkdownAstBody';
import { parseMarkdownToHast } from './markdown-ast';
import { MarkdownOpenFileContext, MarkdownProjectContext, MarkdownSessionContext } from './MarkdownLink';
import { notifyMediaSessionChanged } from './remote-file-preview';
import { _runIdleReclaimForTest } from './idle-reclaim';
import { deleteSessionImagePreviews } from './image-preview-store';

const PROJECT = 'C:/Project/conversation';
const FILES = ['output/a.png', 'output/b.svg', 'output/c.pptx', 'output/broken.png', 'output/d.png'];
const CopyControl = () => null;

async function mount(t, text, configure = () => {}, session = '') {
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
  const tree = React.createElement(
    MarkdownSessionContext.Provider,
    { value: session },
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
  await act(async () => {
    root.render(tree);
  });
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  const doc = dom.window.document;
  const press = (element, init = {}) =>
    act(async () => {
      element.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true, ...init }));
    });
  return { dom, doc, opened, local, press, root, tree };
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

const settleLookups = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));

/** The picture loads, laid out at `width` x `height` (jsdom lays nothing out). */
const loadPicture = (f, width = 360, height = 203) =>
  act(async () => {
    const img = f.doc.querySelector('.markdown-local-image img');
    Object.defineProperty(img, 'offsetWidth', { configurable: true, value: width });
    Object.defineProperty(img, 'offsetHeight', { configurable: true, value: height });
    img.dispatchEvent(new f.dom.window.Event('load'));
  });

/** Unmounts the image, runs `between`, and mounts it again; nothing a lookup answers lands in between. */
const mountAgain = (f, between = () => {}) => {
  act(() => f.root.render(null));
  between();
  act(() => f.root.render(f.tree));
};

const heldBox = (f) => f.doc.querySelector('.markdown-local-image')?.getAttribute('style') || null;

test("an image mounted again holds its picture's box until the picture has loaded", async (t) => {
  const f = await mount(t, '![chart](output/a.png)', () => {}, 'box-remount');
  await loadPicture(f);
  // A transcript row scrolled back into view, or its conversation shown again, mounts the image anew; a loading box
  // there would shrink the row until the picture loads, moving the transcript by the picture's height and back.
  mountAgain(f);
  assert.equal(f.doc.querySelector('.markdown-local-image')?.getAttribute('data-state'), 'loading');
  assert.equal(heldBox(f), 'width: 360px; height: 203px;');
  await settleLookups();
  assert.equal(
    f.doc.querySelector('.markdown-local-image img')?.getAttribute('src'),
    'mixdog-media://preview/token/output/a.png'
  );
  assert.equal(heldBox(f), 'width: 360px; height: 203px;', 'held while the picture loads');
  await loadPicture(f);
  assert.equal(heldBox(f), null);
});

test("a held box goes with its conversation's previews, at idle reclaim and with a new media session", async (t) => {
  const f = await mount(t, '![chart](output/a.png)', () => {}, 'box-drop');
  const drops = {
    'conversation deleted': () => deleteSessionImagePreviews('box-drop'),
    'idle reclaim': () => _runIdleReclaimForTest(),
    'new media session': () => notifyMediaSessionChanged(),
  };
  for (const [name, drop] of Object.entries(drops)) {
    await loadPicture(f);
    mountAgain(f, drop);
    assert.equal(f.doc.querySelector('.markdown-local-image')?.getAttribute('data-state'), 'loading', name);
    assert.equal(heldBox(f), null, name);
    await settleLookups();
  }
});

test('an image that comes to show no picture holds nothing: a deleted file mounts again as its link', async (t) => {
  let removed = false;
  const f = await mount(
    t,
    '![chart](output/a.png)',
    (api) => {
      const preview = api.previewProjectFile;
      api.previewProjectFile = (project, path, token) =>
        removed ? Promise.reject(new Error('ENOENT')) : preview(project, path, token);
    },
    'box-deleted'
  );
  await loadPicture(f);
  removed = true;
  mountAgain(f);
  assert.equal(heldBox(f), 'width: 360px; height: 203px;', 'held until the lookup answers');
  await settleLookups();
  assert.equal(f.doc.querySelector('a')?.getAttribute('href'), 'output/a.png');
  mountAgain(f);
  assert.equal(f.doc.querySelector('.markdown-local-image')?.getAttribute('data-state'), 'loading');
  assert.equal(heldBox(f), null, 'the box of a picture no longer shown is not held');
  await settleLookups();
});

test('a lookup that settles after its image is gone shows in no later mount', async (t) => {
  let settleLate = () => {};
  let removed = false;
  const f = await mount(
    t,
    '![chart](output/a.png)',
    (api) => {
      api.previewProjectFile = (_project, path) =>
        removed
          ? Promise.reject(new Error('ENOENT'))
          : new Promise((resolve) => {
              settleLate = () =>
                resolve({ url: `mixdog-media://preview/late/${path}`, kind: 'image', mime: 'image/png' });
            });
    },
    'box-late'
  );
  act(() => f.root.render(null));
  removed = true;
  await act(async () => settleLate());
  act(() => f.root.render(f.tree));
  assert.equal(f.doc.querySelector('img'), null, 'the late answer is not painted');
  await settleLookups();
  assert.equal(f.doc.querySelector('img'), null);
  assert.equal(f.doc.querySelector('a')?.getAttribute('href'), 'output/a.png', 'the removed file shows its link');
});

test('an image mounted again paints no URL an earlier mount resolved', async (t) => {
  let token = 'first';
  const f = await mount(
    t,
    '![chart](output/a.png)',
    (api) => {
      api.previewProjectFile = async (_project, path) => ({
        url: `mixdog-media://preview/${token}/${path}`,
        kind: 'image',
        mime: 'image/png',
      });
    },
    'box-token'
  );
  await loadPicture(f);
  // Its owner dropped the first token meanwhile (main keeps 256 previews, the remote lane 48 blob URLs).
  token = 'second';
  mountAgain(f);
  assert.equal(f.doc.querySelector('img'), null, 'no picture before the lookup answers');
  await settleLookups();
  assert.equal(
    f.doc.querySelector('.markdown-local-image img')?.getAttribute('src'),
    'mixdog-media://preview/second/output/a.png'
  );
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

test('an image outside the Project is resolved for the conversation that links it, as its link is', async (t) => {
  const elsewhere = '/elsewhere/out.png';
  const f = await mount(
    t,
    `![x](${elsewhere})`,
    (api) => {
      const stat = api.statProjectFile;
      api.statProjectFile = async (project, path, token) =>
        project === '/elsewhere' ? { size: 10, mtimeMs: 1 } : stat(project, path, token);
      // A paired device's host finds a path outside every Project only in a conversation that links it.
      api.resolveLocalPaths = async ([absolutePath], sessionId) =>
        absolutePath === elsewhere && sessionId === 'session-1'
          ? [{ absolutePath, dir: false, name: 'out.png', size: 10, projectPath: '/elsewhere', relPath: 'out.png' }]
          : [];
    },
    'session-1'
  );
  assert.equal(
    f.doc.querySelector('.markdown-local-image img')?.getAttribute('src'),
    'mixdog-media://preview/token/out.png'
  );
});

test('a picture that fails to load gives way for itself alone: the next URL is shown, a kept copy that fails shows the link', async (t) => {
  let media = 1;
  const kept = 'data:image/png;base64,AAAA';
  const f = await mount(t, '![a](output/a.png)\n\n![d](output/d.png)', (api) => {
    // d.png's preview is a small data URL: it is also the copy kept of it.
    api.previewProjectFile = async (_project, path) => ({
      url: path === 'output/d.png' ? kept : `mixdog-media://preview/${media}/${path}`,
      kind: 'image',
      mime: 'image/png',
    });
  });
  const sources = () => [...f.doc.querySelectorAll('.markdown-local-image img')].map((img) => img.getAttribute('src'));
  const fail = (src) =>
    act(async () =>
      f.doc.querySelector(`.markdown-local-image img[src="${src}"]`).dispatchEvent(new f.dom.window.Event('error'))
    );
  assert.deepEqual(sources(), ['mixdog-media://preview/1/output/a.png', kept]);
  await fail('mixdog-media://preview/1/output/a.png');
  assert.deepEqual(sources(), [kept], 'the image that failed shows its link');
  // A new media session: the image resolves again, to a URL that has not failed.
  media = 2;
  await act(async () => notifyMediaSessionChanged());
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  assert.deepEqual(sources(), ['mixdog-media://preview/2/output/a.png', kept]);
  await fail(kept);
  assert.deepEqual(sources(), ['mixdog-media://preview/2/output/a.png'], 'a kept copy that fails shows the link too');
  assert.deepEqual(
    [...f.doc.querySelectorAll('a')].map((link) => link.getAttribute('href')),
    ['output/d.png']
  );
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

test('on a paired device the lightbox drops the host-only default app and offers Download / Share', async (t) => {
  t.after(() => {
    delete globalThis.window.mixdogRemoteServer;
  });
  const f = await mount(t, '![one](output/a.png)', () => {
    globalThis.window.mixdogRemoteServer = 'wss://relay.example';
  });
  await f.press(f.doc.querySelector('button.markdown-local-image'));
  assert.equal(button(f.doc, 'Open in default app'), null);
  assert.ok(button(f.doc, 'Download / Share'), 'device save is offered');
  assert.equal(button(f.doc, 'Save as'), null);
  assert.deepEqual(f.local, []);
});

test('on the desktop the lightbox offers the default app, not Download / Share', async (t) => {
  const f = await mount(t, '![one](output/a.png)');
  await f.press(f.doc.querySelector('button.markdown-local-image'));
  assert.ok(button(f.doc, 'Open in default app'));
  assert.equal(button(f.doc, 'Download / Share'), null);
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
