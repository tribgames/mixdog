import assert from 'node:assert/strict';
import test from 'node:test';
import { scheduleFontWarmup } from './font-warmup';
import { installTestDom } from './test-support/test-dom.mjs';

test('desktop warmup primes UI glyphs and leaves equation fonts for rendered math', (t) => {
  const { window, document } = installTestDom(t, { globals: { navigator: { userAgent: 'Electron/43.0.0' } } });
  const loaded = [];
  const pending = [];
  const faces = ['Pretendard Variable', 'KaTeX_Main', 'JetBrains Mono Variable', 'KaTeX_Size1'].map((family) => ({
    family,
    status: 'unloaded',
    async load() {
      loaded.push(family);
    },
  }));
  Object.defineProperty(document, 'fonts', { value: faces });
  window.requestIdleCallback = (callback) => pending.push(callback);
  scheduleFontWarmup();
  pending.shift()();
  assert.deepEqual(loaded, ['Pretendard Variable', 'JetBrains Mono Variable']);
});
