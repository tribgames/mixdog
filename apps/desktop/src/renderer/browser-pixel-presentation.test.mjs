import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import { createBrowserPixelPresentation } from './browser-pixel-presentation.ts';

const textureBridgeBundle = await build({
  entryPoints: [fileURLToPath(new URL('../preload/browser-texture.ts', import.meta.url))],
  bundle: true,
  write: false,
  platform: 'node',
  format: 'cjs',
  external: ['electron'],
});

function fixture(t) {
  const dom = new JSDOM('<div id="pixels"></div>');
  for (const name of ['document', 'Image', 'HTMLCanvasElement', 'Event']) {
    const old = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, value: dom.window[name] });
    t.after(() => (old ? Object.defineProperty(globalThis, name, old) : delete globalThis[name]));
  }
  dom.window.Image.prototype.decode = async () => {};
  t.after(() => dom.window.close());
  const container = dom.window.document.getElementById('pixels');
  const image = { current: null };
  const textures = [];
  const presentation = createBrowserPixelPresentation({
    container: () => container,
    image,
    canvasId: 'gpu',
    texture: (id) => textures.push(id),
  });
  const frame = (id, extra = {}) => ({
    documentId: 'p1:1',
    frameId: id,
    title: 'Page',
    width: 600,
    height: 400,
    viewportWidth: 600,
    viewportHeight: 400,
    surfaceWidth: 600,
    surfaceHeight: 400,
    image: { mimeType: 'image/png', data: id },
    ...extra,
  });
  return { container, image, textures, presentation, frame };
}

test('decoded pixels update the image and its hidden state without publishing pane metadata', async (t) => {
  const f = fixture(t);
  f.presentation.resize(600, 400);
  for (const id of ['one', 'two', 'three']) {
    const frame = f.frame(id);
    await f.presentation.prepare(frame);
    f.presentation.update(frame);
    assert.equal(f.image.current.src, `data:image/png;base64,${id}`);
    assert.equal(f.image.current.hidden, false);
  }
  f.presentation.resize(700, 400);
  assert.equal(f.image.current.hidden, true);
  const next = f.frame('four', { title: 'Changed', surfaceWidth: 700 });
  await f.presentation.prepare(next);
  f.presentation.update(next);
  assert.equal(f.image.current.hidden, false);
});

test('GPU frames are painted once and a replacement document cannot retain old pixels', (t) => {
  const f = fixture(t);
  f.presentation.resize(600, 400);
  const frame = f.frame('gpu1', { image: undefined, textureId: 'gpu1' });
  f.presentation.update(frame);
  const canvas = f.image.current;
  assert.equal(canvas.tagName, 'CANVAS');
  f.presentation.update({ ...frame, title: 'Changed' });
  assert.equal(f.image.current, canvas);
  assert.deepEqual(f.textures, ['gpu1']);
  f.presentation.update({ ...frame, image: undefined, textureId: undefined, documentId: 'p1:2' });
  assert.equal(f.image.current, null);
  assert.equal(f.container.children.length, 0);
});

/** The pane's presentation wired to the real preload texture bridge, whose
 *  receiver drops a texture it believes is already painted. */
function bridgedFixture(t) {
  const dom = new JSDOM('<div id="pixels"></div>');
  for (const name of ['document', 'Image', 'HTMLCanvasElement', 'Event']) {
    const old = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, value: dom.window[name] });
    t.after(() => (old ? Object.defineProperty(globalThis, name, old) : delete globalThis[name]));
  }
  dom.window.Image.prototype.decode = async () => {};
  const painted = [];
  dom.window.HTMLCanvasElement.prototype.getContext = () => ({ drawImage: (video) => painted.push(video.id) });
  t.after(() => dom.window.close());
  let receive;
  const module = { exports: {} };
  runInNewContext(textureBridgeBundle.outputFiles[0].text, {
    module,
    exports: module.exports,
    window: dom.window,
    document: dom.window.document,
    HTMLCanvasElement: dom.window.HTMLCanvasElement,
    require: (specifier) => {
      assert.equal(specifier, 'electron');
      return {
        ipcRenderer: { invoke: async () => ({}) },
        sharedTexture: {
          setSharedTextureReceiver: (listener) => {
            receive = listener;
          },
        },
      };
    },
  });
  const bridge = module.exports.createBrowserTextureBridge();
  const container = dom.window.document.getElementById('pixels');
  const image = { current: null };
  const presentation = createBrowserPixelPresentation({
    container: () => container,
    image,
    canvasId: 'gpu',
    metadata: () => {},
    texture: (id, canvas) => bridge.browserPresentTexture('s', id, canvas),
    textureRetired: () => bridge.browserDiscardTexture('s'),
  });
  return {
    image,
    painted,
    presentation,
    /** One display read: the host sends the texture during the frame request. */
    async read(frame) {
      await bridge.browserPageFrame('s');
      if (frame.textureId) {
        const video = { id: frame.textureId, displayWidth: 600, displayHeight: 400, close() {} };
        await receive({ importedSharedTexture: { release() {}, getVideoFrame: () => video } }, 's', frame.textureId);
      }
      await presentation.prepare(frame);
      presentation.update(frame);
    },
  };
}

test('a GPU frame paints again after an image or an empty document replaced its canvas', async (t) => {
  const f = bridgedFixture(t);
  const base = { documentId: 'p1:1', title: 'Page', width: 600, height: 400, viewportWidth: 600, viewportHeight: 400 };
  const gpu = { ...base, frameId: 'gpu1', textureId: 'gpu1' };
  await f.read(gpu);
  // A popup's pixels arrive as an image while the opener's texture is unchanged.
  await f.read({ ...base, documentId: 'p2:1', frameId: 'png', image: { mimeType: 'image/png', data: 'png' } });
  assert.equal(f.image.current.tagName, 'IMG');
  await f.read(gpu);
  assert.equal(f.image.current.tagName, 'CANVAS');
  // A document with no pixels yet clears the surface the same way.
  await f.read({ ...base, documentId: 'p3:1', frameId: 'empty' });
  assert.equal(f.image.current, null);
  await f.read(gpu);
  assert.equal(f.image.current.tagName, 'CANVAS');
  assert.deepEqual(f.painted, ['gpu1', 'gpu1', 'gpu1']);
});

test('a GPU frame that fails to paint retires nothing and paints on the next read', async (t) => {
  const f = bridgedFixture(t);
  const base = { documentId: 'p1:1', title: 'Page', width: 600, height: 400, viewportWidth: 600, viewportHeight: 400 };
  await f.read({ ...base, frameId: 'png', image: { mimeType: 'image/png', data: 'png' } });
  const image = f.image.current;
  // No texture arrived for this read: presentation fails and keeps the image.
  assert.throws(() => f.presentation.update({ ...base, frameId: 'gpu2', textureId: 'gpu2' }), /frame is not ready/);
  assert.equal(f.image.current, image);
  await f.read({ ...base, frameId: 'gpu2', textureId: 'gpu2' });
  assert.equal(f.image.current.tagName, 'CANVAS');
  assert.deepEqual(f.painted, ['gpu2']);
});
