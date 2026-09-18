import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { registerHooks } from 'node:module';
import test from 'node:test';

const windows = [];
let fault = '';
class WindowFixture extends EventEmitter {
  constructor(options) {
    super();
    windows.push(this);
    this.options = options;
    this.bounds = options;
    this.webContents = Object.assign(new EventEmitter(), {
      setWindowOpenHandler() {},
      executeJavaScript: async (script) => {
        if (this.isDestroyed()) {
          this.scriptsAfterClose = (this.scriptsAfterClose || 0) + 1;
          throw new Error('fixture script sent after close');
        }
        if (fault === 'script-hang')
          await new Promise((resolve) => {
            this.finishScript = resolve;
          });
        if (this.isDestroyed()) throw new Error('fixture renderer is closed');
        if (script.includes('window.mixdogAgentCursor(')) this.rendered = true;
        return { handler: true, ring: true, opacity: 1 };
      },
    });
  }
  getNativeWindowHandle() {
    const handle = Buffer.alloc(8);
    handle.writeBigUInt64LE(BigInt(windows.indexOf(this) + 1));
    return handle;
  }
  setTitle() {
    if (fault === 'setup') throw new Error('fixture setup failure');
  }
  setContentProtection() {}
  setVisibleOnAllWorkspaces() {}
  setAlwaysOnTop(value) {
    this.topmost = value;
  }
  setIgnoreMouseEvents(value) {
    this.clickThrough = value;
  }
  async loadURL() {
    if (fault === 'load-hang')
      await new Promise((resolve) => {
        this.finishLoading = resolve;
      });
  }
  isDestroyed() {
    return this.destroyed === true;
  }
  destroy() {
    if (this.isDestroyed()) return;
    this.destroyed = true;
    this.visible = false;
    this.emit('closed');
  }
  isVisible() {
    return this.visible === true;
  }
  showInactive() {
    this.visible = true;
  }
  hide() {
    this.visible = false;
  }
  setBounds(bounds) {
    this.bounds = bounds;
  }
  getBounds() {
    return this.bounds;
  }
  moveAbove(source) {
    if (source === 'window:57005:0') throw new Error('fixture target no longer exists');
    this.source = source;
  }
}
const screen = Object.assign(new EventEmitter(), {
  screenToDipPoint: (point) => point,
  getAllDisplays: () => [{ bounds: { x: 0, y: 0, width: 1920, height: 1080 } }],
});
globalThis.cursorLifecycleElectron = { BrowserWindow: WindowFixture, screen };
registerHooks({
  resolve(specifier, context, next) {
    return specifier === 'electron'
      ? {
          url: 'data:text/javascript,export const {BrowserWindow,screen}=globalThis.cursorLifecycleElectron;',
          shortCircuit: true,
        }
      : next(specifier, context);
  },
});
const { createComputerUseCursorOverlay } = await import('./cursor-overlay.ts');
const { prepareCursorFeedback } = await import('./cursor-readiness.ts');
const { filterComputerUseInternalWindows } = await import('./internal-windows.ts');
const { computerUseCoordinator: coordinator } = await import('../session/coordinator.ts');
const settle = () => new Promise((resolve) => setImmediate(resolve));
const begin = (sessionId, mode = 'background') => coordinator.beginCommand({ sessionId, action: 'click', mode });
const idOf = (window) => `hwnd:0x${(windows.indexOf(window) + 1).toString(16)}`;
const show = (sessionId, windowId = 'hwnd:0xABC', mode = 'background') =>
  coordinator.showCursor({
    sessionId,
    windowId,
    mode,
    action: 'type',
    effect: 'type',
    x: 200,
    y: 100,
  });

for (const stage of ['load', 'script']) {
  for (const exit of ['end', 'pause', 'dispose']) {
    test(`${exit} releases a cursor window while ${stage} initialization is hung`, async () => {
      fault = `${stage}-hang`;
      const start = windows.length;
      const overlay = createComputerUseCursorOverlay();
      begin('pending');
      const preparation = prepareCursorFeedback('pending');
      try {
        await settle();
        const window = windows[start];
        assert.ok(window);
        assert.deepEqual(filterComputerUseInternalWindows([{ id: idOf(window) }]), []);
        if (exit === 'end') coordinator.endExecution('pending');
        else if (exit === 'pause') coordinator.pauseForUser('user_pause');
        else overlay.dispose();
        assert.equal(window.isDestroyed(), true, 'the pending native window must be owned before readiness');
        assert.deepEqual(filterComputerUseInternalWindows([{ id: idOf(window) }]), [{ id: idOf(window) }]);
        assert.equal(await preparation, 'unavailable', 'closing must settle the pending readiness promise');
        assert.equal(window.isVisible(), false);
      } finally {
        overlay.dispose();
        coordinator.reset();
        fault = '';
        for (const window of windows.slice(start)) {
          window.destroy();
          window.finishLoading?.();
          window.finishScript?.();
        }
        await preparation;
      }
    });
  }
}

test('an unresponsive cursor renderer retires without retaining a stuck creation slot', async () => {
  fault = 'load-hang';
  const start = windows.length;
  const overlay = createComputerUseCursorOverlay();
  begin('recover');
  const preparation = prepareCursorFeedback('recover');
  try {
    await settle();
    const failed = windows[start];
    failed.emit('unresponsive');
    assert.equal(failed.isDestroyed(), true);
    assert.equal(await preparation, 'unavailable');
    fault = '';
    assert.equal(await prepareCursorFeedback('recover'), 'ready');
    assert.equal(windows.length, start + 2, 'a later request gets one replacement, never a retry loop');
    failed.finishLoading();
    await settle();
    assert.equal(failed.isVisible(), false, 'late initialization must not revive a retired surface');
  } finally {
    overlay.dispose();
    coordinator.reset();
    fault = '';
    for (const window of windows.slice(start)) {
      window.destroy();
      window.finishLoading?.();
      window.finishScript?.();
    }
    await preparation;
  }
});

test('late initialization cannot touch a closed renderer or disturb its replacement', async () => {
  fault = 'load-hang';
  const start = windows.length;
  const overlay = createComputerUseCursorOverlay();
  begin('reused');
  const preparation = prepareCursorFeedback('reused');
  try {
    await settle();
    const retired = windows[start];
    coordinator.endExecution('reused');
    assert.equal(await preparation, 'unavailable');
    fault = '';
    begin('reused');
    assert.equal(await prepareCursorFeedback('reused'), 'ready');
    show('reused');
    await settle();
    const replacement = windows[start + 1];
    assert.equal(replacement.isVisible(), true);
    retired.finishLoading();
    await settle();
    assert.equal(retired.scriptsAfterClose || 0, 0, 'cancelled initialization must not issue later renderer commands');
    assert.equal(replacement.isDestroyed(), false);
    assert.equal(replacement.isVisible(), true);
  } finally {
    overlay.dispose();
    coordinator.reset();
    fault = '';
    for (const window of windows.slice(start)) {
      window.destroy();
      window.finishLoading?.();
    }
    await preparation;
  }
});

test('repeated cursor lifetimes release native windows, internal ids and display listeners', async () => {
  fault = '';
  const start = windows.length;
  const events = ['display-metrics-changed', 'display-added', 'display-removed'];
  const listeners = events.map((event) => screen.listenerCount(event));
  const overlay = createComputerUseCursorOverlay();
  try {
    for (let index = 0; index < 200; index++) {
      const sessionId = `repeat-${index}`;
      begin(sessionId);
      assert.equal(await prepareCursorFeedback(sessionId), 'ready');
      show(sessionId);
      await settle();
      const window = windows[start + index];
      assert.equal(window.isVisible(), true);
      assert.equal(window.options.focusable, false);
      assert.equal(window.clickThrough, true);
      assert.equal(window.topmost, false);
      assert.equal(window.source, 'window:2748:0');
      coordinator.endExecution(sessionId);
      assert.equal(window.isDestroyed(), true);
      assert.deepEqual(filterComputerUseInternalWindows([{ id: idOf(window) }]), [{ id: idOf(window) }]);
    }
  } finally {
    overlay.dispose();
    coordinator.reset();
  }
  assert.deepEqual(
    events.map((event) => screen.listenerCount(event)),
    listeners
  );
  assert.equal(windows.slice(start).filter((window) => !window.isDestroyed()).length, 0);
  begin('after-dispose');
  show('after-dispose');
  await settle();
  assert.equal(windows.length, start + 200, 'a disposed subscriber cannot create another window');
  coordinator.reset();
});

test('ending one background session leaves the other visible and a missing target never becomes topmost', async () => {
  fault = '';
  const start = windows.length;
  const overlay = createComputerUseCursorOverlay();
  try {
    for (const id of ['a', 'b']) {
      begin(id);
      assert.equal(await prepareCursorFeedback(id), 'ready');
      show(id, id === 'a' ? 'hwnd:0xABC' : 'hwnd:0xDEF');
    }
    await settle();
    assert.ok(windows.slice(start).every((window) => window.isVisible()));
    coordinator.endExecution('a');
    assert.equal(windows[start].isDestroyed(), true);
    assert.equal(windows[start + 1].isVisible(), true);
    show('b', 'hwnd:0xDEAD');
    await settle();
    assert.equal(
      windows[start + 1].isVisible(),
      false,
      'missing targets must hide feedback rather than float elsewhere'
    );
    assert.equal(windows[start + 1].topmost, false);
  } finally {
    overlay.dispose();
    coordinator.reset();
  }
});

test('failure before renderer loading releases the allocated window and permits a fresh request', async () => {
  fault = 'setup';
  const start = windows.length;
  const overlay = createComputerUseCursorOverlay();
  begin('setup-failure');
  try {
    assert.equal(await prepareCursorFeedback('setup-failure'), 'unavailable');
    assert.equal(windows[start].isDestroyed(), true);
    assert.deepEqual(filterComputerUseInternalWindows([{ id: idOf(windows[start]) }]), [{ id: idOf(windows[start]) }]);
    fault = '';
    assert.equal(await prepareCursorFeedback('setup-failure'), 'ready');
    assert.equal(windows.length, start + 2);
  } finally {
    fault = '';
    overlay.dispose();
    coordinator.reset();
  }
});
