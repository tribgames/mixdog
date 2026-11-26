// A snapshot render clears its request filter and its abort listener when it ends.
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

let beforeRequestListener = null;
let loadedUrl = '';
const sessionFake = {
  protocol: { handle() {} },
  async clearData() {},
  setPermissionRequestHandler() {},
  setPermissionCheckHandler() {},
  webRequest: {
    onBeforeRequest: (_filter, listener) => {
      beforeRequestListener = listener;
    },
  },
};

class FakeWindow {
  constructor() {
    this.id = 1;
    this.webContents = {
      id: 7,
      session: sessionFake,
      on() {},
      setWindowOpenHandler() {},
      capturePage: async () => ({
        getSize: () => ({ width: 10 }),
        isEmpty: () => false,
        toPNG: () => Buffer.from('png'),
      }),
    };
  }
  async loadURL(url) {
    loadedUrl = url;
  }
  destroy() {
    this.webContents.session = undefined;
  }
}

globalThis.__snapshotElectron = {
  BrowserWindow: FakeWindow,
  net: { fetch: async () => new Response('x') },
  session: { fromPartition: () => sessionFake },
};
registerHooks({
  resolve(specifier, context, next) {
    return specifier === 'electron'
      ? {
          url:
            'data:text/javascript,export const BrowserWindow=globalThis.__snapshotElectron.BrowserWindow;' +
            'export const net=globalThis.__snapshotElectron.net;' +
            'export const session=globalThis.__snapshotElectron.session;',
          shortCircuit: true,
        }
      : next(specifier, context);
  },
});

const { renderFileSnapshot } = await import('./file-snapshot.ts');
const { pathToFileURL } = await import('node:url');
const { tmpdir } = await import('node:os');
const { join } = await import('node:path');

test('a finished snapshot render leaves no request filter and no abort listener behind', async () => {
  const listeners = new Set();
  const signal = {
    aborted: false,
    throwIfAborted() {},
    addEventListener: (_type, listener) => listeners.add(listener),
    removeEventListener: (_type, listener) => listeners.delete(listener),
  };
  const file = join(tmpdir(), 'page.html');
  await renderFileSnapshot({ fileUrl: pathToFileURL(file).href, root: tmpdir(), signal });
  assert.equal(listeners.size, 0);
  let cancelled = false;
  beforeRequestListener({ id: 1, webContentsId: 7, url: loadedUrl }, (answer) => {
    cancelled = answer.cancel;
  });
  assert.equal(cancelled, true, 'the finished snapshot window is unregistered from the shared filter');
});
