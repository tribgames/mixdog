import assert from 'node:assert/strict';
import test from 'node:test';

import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'https://mixdog.test/',
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: dom.window.navigator,
});
globalThis.Element = dom.window.Element;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.HTMLInputElement = dom.window.HTMLInputElement;
globalThis.HTMLTextAreaElement = dom.window.HTMLTextAreaElement;
globalThis.HTMLSelectElement = dom.window.HTMLSelectElement;
globalThis.HTMLVideoElement = dom.window.HTMLVideoElement;
globalThis.Image = dom.window.Image;
globalThis.FileReader = dom.window.FileReader;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
dom.window.HTMLElement.prototype.attachEvent = () => {};
dom.window.HTMLElement.prototype.detachEvent = () => {};
window.matchMedia = () => ({
  matches: false,
  addEventListener() {},
  removeEventListener() {},
});
window.requestAnimationFrame = (callback) => window.setTimeout(callback, 0);
window.cancelAnimationFrame = (handle) => window.clearTimeout(handle);
globalThis.ResizeObserver = class {
  observe() {}
  disconnect() {}
};

const PIXEL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ'
  + 'AAAADUlEQVR42mNk+M/wHwAEAQH/2kGLWQAAAABJRU5ErkJggg==';
const assets = [
  {
    id: 'asset-newer',
    kind: 'image',
    lane: 'gemini',
    model: 'image-model',
    prompt: 'Newer image',
    options: { aspectRatio: '1:1' },
    mime: 'image/png',
    bytes: 100,
    createdAt: 2,
  },
  {
    id: 'asset-older',
    kind: 'image',
    lane: 'gemini',
    model: 'image-model',
    prompt: 'Older image',
    options: { aspectRatio: '1:1' },
    mime: 'image/png',
    bytes: 100,
    createdAt: 1,
  },
];
const lane = {
  id: 'gemini',
  label: 'Gemini',
  authType: 'api',
  authProvider: 'google',
  authenticated: true,
  kinds: ['image'],
  image: {
    models: [{ id: 'image-model', label: 'Image model' }],
    defaultModel: 'image-model',
    controls: { aspectRatio: ['1:1'], maxReferences: 3 },
  },
  video: null,
};

const {
  writeStudioAssetReferences,
  writeStudioDraftReferences,
} = await import('./studio-draft-cache.ts');
const { StudioPane } = await import('./StudioView.tsx');

test('Studio detail opens media, reveals its folder, and navigates with plain arrow keys', async () => {
  window.localStorage.clear();
  const opened = [];
  const openedReferences = [];
  const revealed = [];
  const generations = [];
  const referenceValues = new Map();
  const referenceStore = {
    async read(key) { return referenceValues.get(key); },
    async write(key, value) { referenceValues.set(key, structuredClone(value)); },
    async remove(key) { referenceValues.delete(key); },
  };
  await writeStudioAssetReferences('asset-older', [
    { base64: 'cmVmZXJlbmNl', mime: 'image/png' },
  ], referenceStore);
  await writeStudioDraftReferences([
    { base64: 'Zmlyc3Q=', mime: 'image/png' },
    { base64: 'c2Vjb25k', mime: 'image/jpeg' },
  ], referenceStore);
  const api = {
    mediaUrl: () => PIXEL,
    openAttachmentImage: async (url, name) => { openedReferences.push({ url, name }); },
    openMediaAsset: async (id) => { opened.push(id); },
    openMediaFolder: async (id) => { revealed.push(id); },
    invokeCapability: async ({ capability, args = [] }) => {
      if (capability === 'listMediaLanes') return { value: [lane], snapshot: null };
      if (capability === 'listMediaAssets') {
        const kind = args[0]?.kind;
        const rows = kind === 'image' ? assets : [];
        return { value: { assets: rows, total: rows.length }, snapshot: null };
      }
      if (capability === 'readMediaAsset') {
        return { value: { base64: PIXEL.split(',')[1], mime: 'image/png' }, snapshot: null };
      }
      if (capability === 'startMediaJob') {
        generations.push(args[0]);
        return {
          value: {
            id: 'regenerated-job',
            status: 'running',
            kind: 'image',
            lane: 'gemini',
            model: 'image-model',
            options: args[0].options,
            progress: 0,
            assetId: null,
            error: null,
          },
          snapshot: null,
        };
      }
      if (capability === 'getMediaJob') return { value: null, snapshot: null };
      throw new Error(`unexpected capability: ${capability}`);
    },
  };
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);

  try {
    await act(async () => {
      root.render(React.createElement(StudioPane, { api, referenceStore }));
      await new Promise((resolve) => setTimeout(resolve, 25));
    });
    const tiles = [...host.querySelectorAll('.studio-tile-open')];
    assert.equal(tiles.length, 2);
    const referenceButtons = [...host.querySelectorAll('.studio-ref-open')];
    assert.equal(referenceButtons.length, 2);
    await act(async () => referenceButtons[0].click());
    assert.deepEqual(openedReferences, [{
      url: 'data:image/png;base64,Zmlyc3Q=',
      name: 'reference-1.png',
    }]);

    const referenceTiles = [...host.querySelectorAll('.studio-ref')];
    const dataTransfer = {
      effectAllowed: '',
      dropEffect: '',
      value: '',
      setData(_type, value) { this.value = value; },
      getData() { return this.value; },
    };
    referenceTiles[1].getBoundingClientRect = () => ({
      left: 0,
      width: 44,
      top: 0,
      right: 44,
      bottom: 44,
      height: 44,
      x: 0,
      y: 0,
      toJSON() {},
    });
    const drag = (type, target, clientX = 0) => {
      const event = new window.Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'dataTransfer', { value: dataTransfer });
      Object.defineProperty(event, 'clientX', { value: clientX });
      target.dispatchEvent(event);
    };
    await act(async () => {
      drag('dragstart', referenceTiles[0]);
      drag('dragover', referenceTiles[1], 40);
      drag('drop', referenceTiles[1], 40);
    });
    assert.equal(host.querySelector('.studio-ref-open img')?.src,
      'data:image/jpeg;base64,c2Vjb25k');

    await act(async () => host.querySelectorAll('.studio-tile-open')[0].click());
    assert.equal(host.querySelector('.studio-detail-prompt')?.textContent, 'Newer image');

    await act(async () => {
      window.dispatchEvent(new window.KeyboardEvent('keydown', {
        key: 'ArrowRight',
        bubbles: true,
      }));
    });
    assert.equal(host.querySelector('.studio-detail-prompt')?.textContent, 'Older image');

    await act(async () => host.querySelector('.studio-detail-media-open').click());
    assert.deepEqual(opened, ['asset-older']);

    const folder = [...host.querySelectorAll('.studio-detail-actions button')]
      .find((button) => button.textContent.includes('Open Folder'));
    assert.ok(folder);
    await act(async () => folder.click());
    assert.deepEqual(revealed, ['asset-older']);

    const prompt = host.querySelector('textarea[aria-label="Generation prompt"]');
    await act(async () => {
      prompt.dispatchEvent(new window.KeyboardEvent('keydown', {
        key: 'ArrowLeft',
        bubbles: true,
      }));
    });
    assert.equal(host.querySelector('.studio-detail-prompt')?.textContent, 'Older image',
      'typing controls must retain their own arrow-key behavior');

    await act(async () => {
      window.dispatchEvent(new window.KeyboardEvent('keydown', {
        key: 'ArrowLeft',
        bubbles: true,
      }));
    });
    assert.equal(host.querySelector('.studio-detail-prompt')?.textContent, 'Newer image');
    await act(async () => {
      window.dispatchEvent(new window.KeyboardEvent('keydown', {
        key: 'ArrowRight',
        bubbles: true,
      }));
    });
    assert.equal(host.querySelector('.studio-detail-prompt')?.textContent, 'Older image');

    const regenerate = [...host.querySelectorAll('.studio-detail-actions button')]
      .find((button) => button.textContent.includes('Regenerate'));
    assert.ok(regenerate);
    await act(async () => regenerate.click());
    assert.deepEqual(generations[0].references, [
      { base64: 'cmVmZXJlbmNl', mime: 'image/png' },
    ]);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

test('Studio becomes ready while its first thumbnail is still loading', async () => {
  window.localStorage.clear();
  let readyCount = 0;
  const referenceValues = new Map();
  const referenceStore = {
    async read(key) { return referenceValues.get(key); },
    async write(key, value) { referenceValues.set(key, structuredClone(value)); },
    async remove(key) { referenceValues.delete(key); },
  };
  const api = {
    mediaUrl: () => '',
    invokeCapability: async ({ capability, args = [] }) => {
      if (capability === 'listMediaLanes') return { value: [lane], snapshot: null };
      if (capability === 'listMediaAssets') {
        const rows = args[0]?.kind === 'image' ? assets.slice(0, 1) : [];
        return { value: { assets: rows, total: rows.length }, snapshot: null };
      }
      if (capability === 'readMediaAsset') return new Promise(() => {});
      throw new Error(`unexpected capability: ${capability}`);
    },
  };
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);

  try {
    await act(async () => {
      root.render(React.createElement(StudioPane, {
        api,
        referenceStore,
        onReady: () => { readyCount += 1; },
      }));
    });
    for (let attempt = 0; attempt < 10 && readyCount === 0; attempt += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
    }
    assert.equal(readyCount, 1);
    assert.ok(host.querySelector('.studio-thumbnail-loading'),
      'the pane should reveal independently while the tile keeps its own loader');
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
