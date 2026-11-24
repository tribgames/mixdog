// A snapshot render clears its request filter and its abort listener when it ends.
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

const filters = [];
const sessionFake = {
  protocol: { handle() {} },
  async clearData() {},
  setPermissionRequestHandler() {},
  webRequest: { onBeforeRequest: (...args) => filters.push(args.length === 1 && args[0] === null ? null : args) },
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
  async loadURL() {}
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
  assert.equal(filters.length, 2);
  assert.equal(filters.at(-1), null, 'the filter that held the window is cleared');
});
