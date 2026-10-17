// The in-app download hook: a finished Blob goes to the native fileSave bridge
// when the shell has one (every kind: delivered blobs, <a download> on blob:
// and data: URLs), and to the browser path otherwise. Uses a fake bridge.
import assert from 'node:assert/strict';
import test from 'node:test';

import { deliverPreferNative } from './file-download-transfer.ts';
import { installNativeDownloadHook } from './native-download-hook.ts';
import { installTestDom } from './test-support/test-dom.mjs';

// The page probes its sink once (cached for the process), so every test shares
// the first bridge's call log.
const calls = [];

function fakeBridge(window, capabilities = { fileSave: 1 }) {
  calls.length = 0;
  window.mixdogNative = {
    platform: 'android',
    version: '1',
    call: async (method, args) => {
      calls.push([method, args]);
      switch (method) {
        case 'getNativeCapabilities':
          return capabilities;
        case 'fileSaveBegin':
          return { ok: true, handle: 'h1' };
        case 'fileSaveWrite':
          return { ok: true, handle: 'h1', written: args.offset + Buffer.from(args.data, 'base64').length };
        case 'fileSaveFinish':
          return { ok: true, handle: 'h1', displayName: 'x', size: args.size, persisted: true };
        case 'fileSaveShare':
          return { ok: true, shared: true };
        default:
          return null;
      }
    },
  };
  return calls;
}

const sent = (calls, method) => calls.filter(([name]) => name === method);

test('a finished Blob goes to the native bridge, not the browser path', async (t) => {
  const { window } = installTestDom(t);
  const calls = fakeBridge(window);
  const browser = [];
  const result = await deliverPreferNative(
    { blob: new Blob(['hello'], { type: 'text/plain' }) },
    { name: 'h.txt', mime: 'text/plain' },
    async (target) => {
      browser.push(target);
      return 'saved';
    }
  );
  assert.equal(result, 'shared');
  assert.deepEqual(browser, []);
  assert.deepEqual(sent(calls, 'fileSaveBegin')[0][1], {
    name: 'h.txt',
    mime: 'text/plain',
    size: 5,
    purpose: 'share',
  });
  assert.equal(Buffer.from(sent(calls, 'fileSaveWrite')[0][1].data, 'base64').toString(), 'hello');
});

test('a lane URL has no Blob and keeps the browser path', async (t) => {
  const { window } = installTestDom(t);
  const calls = fakeBridge(window);
  const result = await deliverPreferNative({ url: '/lane/x' }, { name: 'x', mime: 'a/b' }, async () => 'saved');
  assert.equal(result, 'saved');
  assert.deepEqual(sent(calls, 'fileSaveBegin'), []);
});

test('clicking <a download> on a blob: or data: URL saves through the bridge', async (t) => {
  const { window, document } = installTestDom(t);
  const calls = fakeBridge(window);
  window.URL.createObjectURL = () => 'blob:https://mixdog.test/abc';
  window.URL.revokeObjectURL = () => {};
  const uninstall = installNativeDownloadHook(document);
  t.after(uninstall);
  const link = document.createElement('a');
  link.href = window.URL.createObjectURL(new Blob(['blob-bytes']));
  link.setAttribute('download', 'b.bin');
  document.body.append(link);
  link.click();
  const data = document.createElement('a');
  data.href = 'data:text/plain;base64,aGk=';
  data.setAttribute('download', 'd.txt');
  document.body.append(data);
  data.click();
  await new Promise((resolve) => setTimeout(resolve, 50));
  const begins = sent(calls, 'fileSaveBegin').map(([, args]) => [args.name, args.size]);
  assert.deepEqual(begins, [
    ['b.bin', 10],
    ['d.txt', 2],
  ]);
});
