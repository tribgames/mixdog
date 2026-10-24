import assert from 'node:assert/strict';
import test from 'node:test';

import { bindRequestedAddress, requestBrowserPage } from './browser-page-request.ts';

const readyGuest = () => ({
  getWebContentsId: () => 7,
  addEventListener() {},
  removeEventListener() {},
});

test('a requested address carries its request id to the pane that loads it', () => {
  const guest = readyGuest();
  const loaded = [];
  const binding = bindRequestedAddress(
    's-req',
    () => guest,
    (...args) => {
      loaded.push(args);
      return true;
    }
  );
  requestBrowserPage('s-req', 'http://127.0.0.1:8765/', { newTab: true, agent: true, requestId: 'r1' });
  assert.deepEqual(loaded.at(-1), ['http://127.0.0.1:8765/', true, 'r1']);
  requestBrowserPage('s-req', 'https://example.com/', { newTab: true });
  assert.deepEqual(loaded.at(-1), ['https://example.com/', true, undefined]);
  binding.dispose();
});

test('while no pane can load it only the latest pending request (and its id) is kept', () => {
  requestBrowserPage('s-late', 'http://a/', { newTab: true, requestId: 'ra' });
  requestBrowserPage('s-late', 'http://b/', { newTab: true, requestId: 'rb' });
  const loaded = [];
  const binding = bindRequestedAddress(
    's-late',
    () => readyGuest(),
    (...args) => {
      loaded.push(args);
      return true;
    }
  );
  binding.sync();
  assert.deepEqual(loaded, [['http://b/', true, 'rb']]);
  binding.dispose();
});
