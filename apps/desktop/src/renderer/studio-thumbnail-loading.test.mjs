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
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator });
for (const key of [
  'Element',
  'HTMLElement',
  'HTMLInputElement',
  'HTMLTextAreaElement',
  'HTMLSelectElement',
  'HTMLVideoElement',
  'Image',
  'FileReader',
]) {
  globalThis[key] = dom.window[key];
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
window.requestAnimationFrame = (callback) => window.setTimeout(callback, 0);
window.cancelAnimationFrame = (handle) => window.clearTimeout(handle);
globalThis.ResizeObserver = class {
  observe() {}
  disconnect() {}
};
dom.window.HTMLElement.prototype.attachEvent = () => {};
dom.window.HTMLElement.prototype.detachEvent = () => {};

const { StudioPane } = await import('./StudioView.tsx');
const { STUDIO_THUMBNAIL_TIMEOUT_MS, runStudioThumbnailTask } = await import('./studio-thumbnail-task.ts');
const payload = { base64: 'dGh1bWI=', mime: 'image/png', variant: 'thumb' };
const assets = ['first', 'second'].map((id, index) => ({
  id,
  kind: 'image',
  lane: 'gemini',
  model: 'image-model',
  prompt: id,
  options: { aspectRatio: '1:1' },
  mime: 'image/png',
  bytes: 10,
  createdAt: 2 - index,
}));

for (const failure of ['rejected read', 'empty read', 'stalled read', 'failed decode', 'stalled decode']) {
  test(`Studio ends loading after ${failure} and loads the next thumbnail`, async () => {
    window.localStorage.clear();
    const originalTimeout = globalThis.setTimeout;
    const originalImage = globalThis.Image;
    // Exercise the production timeout path without waiting fifteen seconds.
    globalThis.setTimeout = (callback, delay, ...args) =>
      originalTimeout(callback, delay === STUDIO_THUMBNAIL_TIMEOUT_MS ? 20 : delay, ...args);
    globalThis.Image = class {
      set src(_value) {
        if (failure === 'failed decode') queueMicrotask(() => this.onerror?.());
      }
    };
    let finishRead;
    const reads = [];
    const api = {
      mediaUrl: (id) => `https://mixdog.test/media/${id}`,
      invokeCapability: async ({ capability, args = [] }) => {
        let value = null;
        if (capability === 'listMediaLanes') value = [];
        if (capability === 'listMediaAssets') {
          const rows = args[0].kind === 'image' ? assets : [];
          value = { assets: rows, total: rows.length };
        }
        if (capability === 'readMediaAsset') {
          reads.push(args[0]);
          if (args[0] === 'second') value = payload;
          else if (failure === 'rejected read') throw new Error('read failed');
          else if (failure === 'stalled read') {
            value = await new Promise((resolve) => {
              finishRead = resolve;
            });
          } else if (failure.includes('decode')) value = { ...payload, variant: 'original' };
        }
        return { value, snapshot: null };
      },
    };
    const host = document.createElement('main');
    document.body.append(host);
    const root = createRoot(host);
    try {
      await act(async () => {
        root.render(React.createElement(StudioPane, { api }));
      });
      await act(async () => {
        await new Promise((resolve) => originalTimeout(resolve, 60));
      });
      const first = host.querySelector('[data-studio-asset-id="first"]');
      const second = host.querySelector('[data-studio-asset-id="second"]');
      assert.ok(first);
      assert.equal(first.querySelector('.studio-thumbnail-loading'), null);
      assert.ok(first.querySelector('.studio-tile-glyph'));
      assert.equal(second.querySelector('img')?.getAttribute('src'), 'data:image/png;base64,dGh1bWI=');
      await act(async () => {
        second.querySelector('img').dispatchEvent(new window.Event('load'));
      });
      assert.equal(second.querySelector('.studio-thumbnail-loading'), null);
      assert.deepEqual(reads, ['first', 'second']);
      if (finishRead) {
        await act(async () => {
          finishRead(payload);
        });
        assert.ok(first.querySelector('.studio-tile-glyph'), 'late results must not revive expired work');
      }
    } finally {
      await act(async () => root.unmount());
      host.remove();
      globalThis.setTimeout = originalTimeout;
      globalThis.Image = originalImage;
    }
  });
}

test('thumbnail hydration cancels active work on unmount and skips already-cancelled work', async () => {
  const parent = new AbortController();
  let signal;
  const request = runStudioThumbnailTask(async (current) => {
    signal = current;
    await new Promise(() => {});
  }, parent.signal);
  parent.abort();
  await assert.rejects(request, /cancelled/);
  assert.equal(signal.aborted, true);
  let started = false;
  await assert.rejects(
    runStudioThumbnailTask(async () => {
      started = true;
    }, parent.signal),
    /cancelled/
  );
  assert.equal(started, false);
});

for (const interruption of ['direct load', 'deactivation', 'unmount']) {
  test(`late Studio thumbnail fallback is ignored after ${interruption}`, async () => {
    window.localStorage.clear();
    window.localStorage.setItem('mixdog.studio-draft.v1', JSON.stringify({ kind: 'video' }));
    let finishRead;
    const cached = [];
    const api = {
      mediaUrl: (id) => `https://mixdog.test/media/${id}`,
      invokeCapability: async ({ capability, args = [] }) => {
        let value = null;
        if (capability === 'listMediaLanes') value = [];
        if (capability === 'listMediaAssets') {
          const rows = args[0].kind === 'video' ? [{ ...assets[0], kind: 'video', mime: 'video/mp4' }] : [];
          value = { assets: rows, total: rows.length };
        }
        if (capability === 'readMediaAsset') {
          value = await new Promise((resolve) => {
            finishRead = resolve;
          });
        }
        if (capability === 'cacheMediaThumbnail') cached.push(args);
        return { value, snapshot: null };
      },
    };
    const referenceStore = { read: async () => [], write: async () => {}, remove: async () => {} };
    const host = document.createElement('main');
    document.body.append(host);
    const root = createRoot(host);
    let mounted = true;
    try {
      await act(async () => root.render(React.createElement(StudioPane, { api, referenceStore })));
      const image = host.querySelector('[data-studio-asset-id="first"] img');
      assert.equal(image?.getAttribute('src'), 'https://mixdog.test/media/first');
      // Video tiles retain their direct URL while the 120ms stall timer starts fallback.
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 150));
      });
      assert.equal(typeof finishRead, 'function');
      await act(async () => {
        if (interruption === 'direct load') image.dispatchEvent(new window.Event('load'));
        else if (interruption === 'deactivation') {
          root.render(React.createElement(StudioPane, { api, referenceStore, active: false }));
        } else {
          root.unmount();
          mounted = false;
        }
      });
      await act(async () => finishRead(payload));
      assert.deepEqual(cached, [], 'discarded fallback results must not be persisted');
      if (mounted) {
        assert.equal(
          host.querySelector('[data-studio-asset-id="first"] img')?.getAttribute('src'),
          'https://mixdog.test/media/first'
        );
      } else {
        assert.equal(host.childElementCount, 0);
      }
    } finally {
      if (mounted) await act(async () => root.unmount());
      host.remove();
    }
  });
}
