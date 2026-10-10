import assert from 'node:assert/strict';
import test from 'node:test';

import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { installTestDom } from './test-support/test-dom.mjs';

const { dom } = installTestDom(null, {
  html: '<!doctype html><html><body></body></html>',
  jsdom: {
    url: 'https://mixdog.test/',
  },
  expose: [
    'navigator',
    'Element',
    'HTMLElement',
    'HTMLInputElement',
    'HTMLTextAreaElement',
    'HTMLSelectElement',
    'HTMLVideoElement',
    'Image',
    'FileReader',
  ],
  actEnvironment: false,
});
// Studio builds reference and share files itself; the jsdom reader accepts
// only jsdom Blobs.
globalThis.Blob = dom.window.Blob;
globalThis.File = dom.window.File;
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

const PIXEL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ' +
  'AAAADUlEQVR42mNk+M/wHwAEAQH/2kGLWQAAAABJRU5ErkJggg==';
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

const { writeStudioAssetReferences, writeStudioDraftReferences } = await import('./studio-draft-cache.ts');
const { StudioPane } = await import('./StudioView.tsx');

test('Studio detail opens media, reveals its folder, and navigates with plain arrow keys', async () => {
  window.localStorage.clear();
  const opened = [];
  const openedReferences = [];
  const revealed = [];
  const generations = [];
  const rememberedDefaults = [];
  const referenceStore = memoryReferenceStore();
  await writeStudioAssetReferences('asset-older', [{ base64: 'cmVmZXJlbmNl', mime: 'image/png' }], referenceStore);
  await writeStudioDraftReferences(
    [
      { base64: 'Zmlyc3Q=', mime: 'image/png' },
      { base64: 'c2Vjb25k', mime: 'image/jpeg' },
    ],
    referenceStore
  );
  const api = {
    mediaUrl: () => PIXEL,
    openAttachmentImage: async (url, name) => {
      openedReferences.push({ url, name });
    },
    openMediaAsset: async (id) => {
      opened.push(id);
    },
    openMediaFolder: async (id) => {
      revealed.push(id);
    },
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
      if (capability === 'setMediaDefault') {
        rememberedDefaults.push(args[0]);
        return { value: args[0], snapshot: null };
      }
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
    assert.deepEqual(
      rememberedDefaults,
      [{ kind: 'image', lane: 'gemini', model: 'image-model' }],
      'the settled Studio selection is pushed to the runtime once as the media default'
    );
    const referenceButtons = [...host.querySelectorAll('.studio-ref-open')];
    assert.equal(referenceButtons.length, 2);
    await act(async () => referenceButtons[0].click());
    assert.deepEqual(openedReferences, [
      {
        url: 'data:image/png;base64,Zmlyc3Q=',
        name: 'reference-1.png',
      },
    ]);

    const referenceTiles = [...host.querySelectorAll('.studio-ref')];
    const dataTransfer = {
      effectAllowed: '',
      dropEffect: '',
      value: '',
      setData(_type, value) {
        this.value = value;
      },
      getData() {
        return this.value;
      },
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
    assert.equal(host.querySelector('.studio-ref-open img')?.src, 'data:image/jpeg;base64,c2Vjb25k');

    await act(async () => host.querySelectorAll('.studio-tile-open')[0].click());
    assert.equal(host.querySelector('.studio-detail-prompt')?.textContent, 'Newer image');

    await act(async () => {
      window.dispatchEvent(
        new window.KeyboardEvent('keydown', {
          key: 'ArrowRight',
          bubbles: true,
        })
      );
    });
    assert.equal(host.querySelector('.studio-detail-prompt')?.textContent, 'Older image');

    await act(async () => host.querySelector('.studio-detail-media-open').click());
    assert.deepEqual(opened, ['asset-older']);

    const folder = [...host.querySelectorAll('.studio-detail-actions button')].find((button) =>
      button.textContent.includes('Open Folder')
    );
    assert.ok(folder);
    await act(async () => folder.click());
    assert.deepEqual(revealed, ['asset-older']);

    const prompt = host.querySelector('textarea[aria-label="Generation prompt"]');
    await act(async () => {
      prompt.dispatchEvent(
        new window.KeyboardEvent('keydown', {
          key: 'ArrowLeft',
          bubbles: true,
        })
      );
    });
    assert.equal(
      host.querySelector('.studio-detail-prompt')?.textContent,
      'Older image',
      'typing controls must retain their own arrow-key behavior'
    );

    await act(async () => {
      window.dispatchEvent(
        new window.KeyboardEvent('keydown', {
          key: 'ArrowLeft',
          bubbles: true,
        })
      );
    });
    assert.equal(host.querySelector('.studio-detail-prompt')?.textContent, 'Newer image');
    await act(async () => {
      window.dispatchEvent(
        new window.KeyboardEvent('keydown', {
          key: 'ArrowRight',
          bubbles: true,
        })
      );
    });
    assert.equal(host.querySelector('.studio-detail-prompt')?.textContent, 'Older image');

    const regenerate = [...host.querySelectorAll('.studio-detail-actions button')].find((button) =>
      button.textContent.includes('Regenerate')
    );
    assert.ok(regenerate);
    await act(async () => regenerate.click());
    assert.deepEqual(generations[0].references, [{ base64: 'cmVmZXJlbmNl', mime: 'image/png' }]);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

test('Studio detail keeps an expanded prompt until another asset opens', async () => {
  window.localStorage.clear();
  const api = {
    mediaUrl: () => PIXEL,
    invokeCapability: async ({ capability, args = [] }) => {
      if (capability === 'listMediaLanes') return { value: [lane], snapshot: null };
      if (capability === 'listMediaAssets') {
        const rows = args[0]?.kind === 'image' ? assets : [];
        return { value: { assets: rows, total: rows.length }, snapshot: null };
      }
      if (capability === 'readMediaAsset') {
        return { value: { base64: PIXEL.split(',')[1], mime: 'image/png' }, snapshot: null };
      }
      if (capability === 'setMediaDefault') return { value: args[0], snapshot: null };
      throw new Error(`unexpected capability: ${capability}`);
    },
  };
  const referenceStore = {
    async read() {
      return undefined;
    },
    async write() {},
    async remove() {},
  };
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  const promptOpen = () => host.querySelector('.studio-detail-prompt')?.getAttribute('data-open') === 'true';

  try {
    await act(async () => {
      root.render(React.createElement(StudioPane, { api, referenceStore }));
      await new Promise((resolve) => setTimeout(resolve, 25));
    });
    await act(async () => host.querySelectorAll('.studio-tile-open')[0].click());
    await act(async () => host.querySelector('.studio-detail-prompt').click());
    assert.equal(promptOpen(), true);

    // A broken display rendition re-runs the preview read for the SAME asset;
    // that must not fold the prompt the reader just expanded.
    await act(async () => {
      host.querySelector('.studio-detail-media-open img').dispatchEvent(new window.Event('error'));
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    assert.equal(host.querySelector('.studio-detail-prompt')?.textContent, 'Newer image');
    assert.equal(promptOpen(), true);

    await act(async () => {
      window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    });
    assert.equal(host.querySelector('.studio-detail-prompt')?.textContent, 'Older image');
    assert.equal(promptOpen(), false, 'a newly opened asset starts with its prompt collapsed');
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

test('Studio becomes ready while its first thumbnail is still loading', async () => {
  window.localStorage.clear();
  let readyCount = 0;
  const referenceStore = memoryReferenceStore();
  const api = {
    mediaUrl: () => '',
    invokeCapability: async ({ capability, args = [] }) => {
      if (capability === 'listMediaLanes') return { value: [lane], snapshot: null };
      if (capability === 'listMediaAssets') {
        const rows = args[0]?.kind === 'image' ? assets.slice(0, 1) : [];
        return { value: { assets: rows, total: rows.length }, snapshot: null };
      }
      if (capability === 'readMediaAsset') return new Promise(() => {});
      if (capability === 'setMediaDefault') return { value: args[0], snapshot: null };
      throw new Error(`unexpected capability: ${capability}`);
    },
  };
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);

  try {
    await act(async () => {
      root.render(
        React.createElement(StudioPane, {
          api,
          referenceStore,
          onReady: () => {
            readyCount += 1;
          },
        })
      );
    });
    for (let attempt = 0; attempt < 10 && readyCount === 0; attempt += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
    }
    assert.equal(readyCount, 1);
    assert.ok(
      host.querySelector('.studio-thumbnail-loading'),
      'the pane should reveal independently while the tile keeps its own loader'
    );
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

/** Studio host for the detail tests: the two images, an optional larger
 *  total, and every capability call recorded. */
function detailApi({ total = assets.length, calls = [] } = {}) {
  return {
    mediaUrl: () => PIXEL,
    invokeCapability: async ({ capability, args = [] }) => {
      calls.push({ capability, args });
      if (capability === 'listMediaLanes') return { value: [lane], snapshot: null };
      if (capability === 'listMediaAssets') {
        const images = args[0]?.kind === 'image';
        const rows = images && !args[0]?.offset ? assets : [];
        return { value: { assets: rows, total: images ? total : 0 }, snapshot: null };
      }
      if (capability === 'readMediaAsset') {
        return { value: { base64: PIXEL.split(',')[1], mime: 'image/png' }, snapshot: null };
      }
      if (capability === 'setMediaDefault') return { value: args[0], snapshot: null };
      if (capability === 'deleteMediaAsset') return { value: { id: args[0], deleted: true }, snapshot: null };
      throw new Error(`unexpected capability: ${capability}`);
    },
  };
}

function memoryReferenceStore() {
  const values = new Map();
  return {
    async read(key) {
      return values.get(key);
    },
    async write(key, value) {
      values.set(key, structuredClone(value));
    },
    async remove(key) {
      values.delete(key);
    },
  };
}

async function renderStudio(api, referenceStore) {
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(React.createElement(StudioPane, { api, referenceStore }));
    await new Promise((resolve) => setTimeout(resolve, 25));
  });
  return {
    host,
    async unmount() {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

const settle = (ms = 20) => act(async () => new Promise((resolve) => setTimeout(resolve, ms)));
const detailPrompt = (host) => host.querySelector('.studio-detail-prompt')?.textContent;
const detailAction = (host, label) =>
  [...host.querySelectorAll('.studio-detail-actions button')].find((button) => button.textContent.includes(label));

test('Studio detail pages with its arrows and a touch swipe, and pulls the next page near the end', async () => {
  window.localStorage.clear();
  const calls = [];
  const studio = await renderStudio(detailApi({ total: 3, calls }), memoryReferenceStore());
  const { host } = studio;
  const nav = (direction) => host.querySelector(`.studio-detail-nav[data-direction="${direction}"]`);
  // jsdom ships no PointerEvent; a MouseEvent carrying the pointer fields
  // React reads drives the same handlers.
  const drag = async (dx, dy, pointerType = 'touch') => {
    const target = host.querySelector('.studio-detail-media-open img');
    const pointer = (type, x, y) => {
      const event = new window.MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y });
      Object.defineProperty(event, 'pointerType', { value: pointerType });
      Object.defineProperty(event, 'pointerId', { value: 7 });
      target.dispatchEvent(event);
    };
    await act(async () => {
      pointer('pointerdown', 200, 200);
      pointer('pointerup', 200 + dx, 200 + dy);
    });
  };

  try {
    await act(async () => host.querySelectorAll('.studio-tile-open')[0].click());
    assert.equal(detailPrompt(host), 'Newer image');
    assert.equal(nav('previous'), null, 'the first asset has nothing before it');
    await act(async () => nav('next').click());
    assert.equal(detailPrompt(host), 'Older image');
    assert.equal(nav('next'), null, 'the last loaded asset has nothing after it');
    await settle();
    assert.ok(
      calls.some(({ capability, args }) => capability === 'listMediaAssets' && args[0]?.offset === 2),
      'paging toward the end of the loaded list requests the next page'
    );

    await drag(40, 0);
    assert.equal(detailPrompt(host), 'Older image', 'a short drag is not a swipe');
    await drag(120, 100);
    assert.equal(detailPrompt(host), 'Older image', 'a mostly vertical drag is not a swipe');
    await drag(120, 0, 'mouse');
    assert.equal(detailPrompt(host), 'Older image', 'a mouse drag never pages');
    await drag(120, 10);
    assert.equal(detailPrompt(host), 'Newer image', 'a rightward swipe pages back');
    await drag(-120, -10);
    assert.equal(detailPrompt(host), 'Older image', 'a leftward swipe pages forward');
  } finally {
    await studio.unmount();
  }
});

test('Studio detail reuses a prompt, adds the asset as a reference, and deletes it through More', async () => {
  window.localStorage.clear();
  const calls = [];
  const referenceStore = memoryReferenceStore();
  await writeStudioAssetReferences('asset-older', [{ base64: 'cmVmZXJlbmNl', mime: 'image/png' }], referenceStore);
  const studio = await renderStudio(detailApi({ calls }), referenceStore);
  const { host } = studio;
  const composer = () => host.querySelector('textarea[aria-label="Generation prompt"]');
  const referenceSources = () =>
    [...host.querySelectorAll('.studio-ref-open img')].map((image) => image.getAttribute('src'));

  try {
    await act(async () => host.querySelectorAll('.studio-tile-open')[1].click());
    await act(async () => detailAction(host, 'Reuse prompt').click());
    await settle();
    assert.equal(host.querySelector('.studio-detail'), null, 'reuse hands the recipe to the composer and closes');
    assert.equal(composer().value, 'Older image');
    assert.deepEqual(referenceSources(), ['data:image/png;base64,cmVmZXJlbmNl'], 'the recipe brings its references');

    await act(async () => host.querySelectorAll('.studio-tile-open')[0].click());
    await act(async () => detailAction(host, 'Use as reference').click());
    await settle();
    assert.equal(host.querySelector('.studio-detail'), null);
    assert.deepEqual(
      referenceSources(),
      ['data:image/png;base64,cmVmZXJlbmNl', PIXEL],
      'the asset joins the next run as a reference'
    );
    assert.ok(
      calls.some(
        ({ capability, args }) =>
          capability === 'readMediaAsset' && args[0] === 'asset-newer' && args[1]?.variant === 'original'
      ),
      'the reference is read from the original'
    );

    await act(async () => host.querySelectorAll('.studio-tile-open')[0].click());
    const more = host.querySelector('.studio-detail-more > button');
    await act(async () => more.click());
    assert.equal(more.getAttribute('aria-expanded'), 'true');
    await act(async () => host.querySelector('.studio-detail-menu [role="menuitem"]').click());
    await settle();
    assert.ok(calls.some(({ capability, args }) => capability === 'deleteMediaAsset' && args[0] === 'asset-newer'));
    assert.equal(host.querySelector('.studio-detail'), null, 'deleting the open asset closes the detail');
    assert.equal(host.querySelectorAll('.studio-tile-open').length, 1);
  } finally {
    await studio.unmount();
  }
});

test('Studio select-all covers unloaded pages, so a bulk delete empties the tab', async () => {
  window.localStorage.clear();
  let stored = Array.from({ length: 130 }, (_, index) => ({
    ...assets[0],
    id: `bulk-${index}`,
    prompt: `Bulk ${index}`,
    createdAt: 130 - index,
  }));
  const api = {
    mediaUrl: () => PIXEL,
    invokeCapability: async ({ capability, args = [] }) => {
      if (capability === 'listMediaLanes') return { value: [lane], snapshot: null };
      if (capability === 'listMediaAssets') {
        const rows = stored.filter((asset) => asset.kind === args[0]?.kind);
        const offset = args[0]?.offset || 0;
        return { value: { assets: rows.slice(offset, offset + args[0].limit), total: rows.length }, snapshot: null };
      }
      if (capability === 'readMediaAsset') {
        return { value: { base64: PIXEL.split(',')[1], mime: 'image/png' }, snapshot: null };
      }
      if (capability === 'setMediaDefault') return { value: args[0], snapshot: null };
      if (capability === 'deleteMediaAssets') {
        const filter = args[0];
        const ids = stored
          .filter(
            (asset) => (!filter.kind || asset.kind === filter.kind) && (!filter.ids || filter.ids.includes(asset.id))
          )
          .map((asset) => asset.id);
        if (!filter.dryRun) stored = stored.filter((asset) => !ids.includes(asset.id));
        return { value: { ids }, snapshot: null };
      }
      throw new Error(`unexpected capability: ${capability}`);
    },
  };
  const confirm = window.confirm;
  window.confirm = () => true;
  const studio = await renderStudio(api, memoryReferenceStore());
  const { host } = studio;
  const button = (label) => [...host.querySelectorAll('button')].find((entry) => entry.textContent.trim() === label);
  const tiles = () => host.querySelectorAll('.studio-tile:not(.studio-tile--pending)').length;

  try {
    await settle();
    assert.equal(tiles(), 60, 'the gallery holds only its first page');
    await act(async () => host.querySelector('button[aria-label="Clean up"]').click());
    await act(async () => button('Select items').click());
    await act(async () => button('Select all').click());
    await settle();
    assert.equal(host.querySelector('.studio-cleanup-count').textContent, '130 selected');
    await act(async () => button('Delete selected').click());
    await settle(60);
    assert.equal(stored.length, 0, 'every asset in the tab is deleted');
    assert.equal(tiles(), 0, 'no next page refills the grid');
  } finally {
    await studio.unmount();
    window.confirm = confirm;
  }
});

test('Studio detail on the web app folds its rail on tap and saves through the share sheet', async () => {
  window.localStorage.clear();
  const opened = [];
  const shared = [];
  // The relay shim marks a web-app surface before Studio mounts.
  window.mixdogRemoteServer = 'https://relay.test';
  Object.defineProperty(window.navigator, 'canShare', { configurable: true, value: () => true });
  Object.defineProperty(window.navigator, 'share', {
    configurable: true,
    value: async (data) => {
      shared.push(data);
    },
  });
  const api = {
    ...detailApi(),
    openMediaAsset: async (id) => {
      opened.push(id);
    },
  };
  const studio = await renderStudio(api, memoryReferenceStore());
  const { host } = studio;
  const details = () => host.querySelector('.studio-detail')?.getAttribute('data-details');

  try {
    await settle(40);
    await act(async () => host.querySelectorAll('.studio-tile-open')[0].click());
    const media = host.querySelector('.studio-detail-media-open');
    assert.equal(media.getAttribute('aria-label'), 'Toggle details');
    await act(async () => media.click());
    assert.equal(details(), 'hidden', 'a tap folds the rail away');
    assert.deepEqual(opened, [], 'nothing opens on the desktop host');
    await act(async () => media.click());
    assert.equal(details(), null, 'a second tap brings the rail back');

    assert.equal(detailAction(host, 'Open Folder'), undefined, 'the host folder is out of reach from the web app');
    await act(async () => detailAction(host, 'Save').click());
    await settle();
    assert.equal(shared.length, 1);
    const [file] = shared[0].files;
    assert.equal(file.name, 'mixdog-asset-newer.png');
    assert.equal(file.type, 'image/png');
  } finally {
    await studio.unmount();
    delete window.mixdogRemoteServer;
    delete window.navigator.canShare;
    delete window.navigator.share;
  }
});
