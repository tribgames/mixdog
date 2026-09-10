import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { registerHooks } from 'node:module';
import test from 'node:test';

// The production bundle supplies __dirname; these fixtures never create native windows.
globalThis.__dirname = process.cwd();
const windows = [];
let fault = '';
class WindowFixture extends EventEmitter {
  constructor() {
    super();
    windows.push(this);
    this.webContents = Object.assign(new EventEmitter(), {
      ipc: { handle() {} }, setWindowOpenHandler() {},
      executeJavaScript: async () => {
        if (fault === 'script') throw new Error('fixture script failure');
      },
    });
  }
  getNativeWindowHandle() {
    const handle = Buffer.alloc(8);
    handle.writeBigUInt64LE(BigInt(windows.indexOf(this) + 1));
    return handle;
  }
  setTitle() {} setAlwaysOnTop() {} setContentProtection() {} setVisibleOnAllWorkspaces() {}
  async loadURL() { if (fault === 'load') throw new Error('fixture load failure'); }
  isDestroyed() { return this.destroyed === true; }
  destroy() { this.destroyed = true; this.emit('closed'); }
  isVisible() { return this.visible === true; }
  showInactive() { this.visible = true; }
  hide() { this.visible = false; }
  setBounds() {}
}
globalThis.overlayLifecycleElectron = {
  BrowserWindow: WindowFixture,
  globalShortcut: { register: () => true, unregister() {} },
  screen: Object.assign(new EventEmitter(), {
    getAllDisplays: () => [{ id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1080 } }],
  }),
};
registerHooks({
  resolve(specifier, context, next) {
    return specifier === 'electron'
      ? { url: 'data:text/javascript,export const {BrowserWindow,screen,globalShortcut}=globalThis.overlayLifecycleElectron;', shortCircuit: true }
      : next(specifier, context);
  },
});
const { createComputerUseOverlay } = await import('./index.ts');
const { computerUseCoordinator: coordinator } = await import('../session/coordinator.ts');
const settle = () => new Promise(resolve => setImmediate(resolve));

for (const stage of ['load', 'script']) {
  test(`failed overlay ${stage} is destroyed and a subsequent update can recover`, async () => {
    fault = stage;
    const start = windows.length;
    const overlay = createComputerUseOverlay({ stop: async () => {}, resume: async () => {} });
    try {
      coordinator.beginCommand({ sessionId: 'fixture', action: 'capture', mode: 'background' });
      await settle();
      assert.equal(windows.length, start + 1);
      assert.equal(windows[start].isDestroyed(), true);
      fault = '';
      coordinator.finishCommand('fixture');
      await settle();
      assert.equal(windows.length, start + 2);
      assert.equal(windows[start + 1].isVisible(), true);
    } finally {
      overlay.dispose();
      coordinator.reset();
    }
    assert.ok(windows.slice(start).every(window => window.isDestroyed()));
  });
}
