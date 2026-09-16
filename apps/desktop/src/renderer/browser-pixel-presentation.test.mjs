import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { createBrowserPixelPresentation } from './browser-pixel-presentation.ts';

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
  const metadata = [];
  const textures = [];
  const presentation = createBrowserPixelPresentation({
    container: () => container,
    image,
    canvasId: 'gpu',
    metadata: (frame) => metadata.push(frame),
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
  return { container, image, metadata, textures, presentation, frame };
}

test('decoded pixels update without re-publishing unchanged pane metadata', async (t) => {
  const f = fixture(t);
  f.presentation.resize(600, 400);
  for (const id of ['one', 'two', 'three']) {
    const frame = f.frame(id);
    await f.presentation.prepare(frame);
    f.presentation.update(frame);
    assert.equal(f.image.current.src, `data:image/png;base64,${id}`);
    assert.equal(f.image.current.hidden, false);
  }
  assert.equal(f.metadata.length, 1);
  assert.equal(f.metadata[0].image, undefined);
  f.presentation.resize(700, 400);
  assert.equal(f.image.current.hidden, true);
  const next = f.frame('four', { title: 'Changed', surfaceWidth: 700 });
  await f.presentation.prepare(next);
  f.presentation.update(next);
  assert.equal(f.image.current.hidden, false);
  assert.equal(f.metadata.length, 2);
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
