import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { registerHooks } from 'node:module';
import test from 'node:test';

// The production bundle supplies __dirname; these fixtures never create native windows.
globalThis.__dirname = process.cwd();
const windows = [];
let fault = '';
let stopShortcut;
class WindowFixture extends EventEmitter {
  constructor() {
    super();
    windows.push(this);
    this.webContents = Object.assign(new EventEmitter(), {
      ipc: { handle: (_channel, handler) => { this.control = handler; } },
      mainFrame: {}, setWindowOpenHandler() {},
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
  async loadURL() {
    if (fault === 'load') throw new Error('fixture load failure');
    if (fault === 'load-hang') await new Promise(resolve => { this.finishLoading = resolve; });
  }
  isDestroyed() { return this.destroyed === true; }
  destroy() { this.destroyed = true; this.emit('closed'); }
  isVisible() { return this.visible === true; }
  showInactive() { this.visible = true; }
  hide() { this.visible = false; }
  setBounds() {}
}
globalThis.overlayLifecycleElectron = {
  BrowserWindow: WindowFixture,
  globalShortcut: { register: (_key, callback) => { stopShortcut = callback; return true; }, unregister() {} },
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

test('dismissing a recovery overlay preserves the pause, cancels pending resume and leaves Stop available', async () => {
  fault = '';
  const start = windows.length;
  let resumeSignal, stopped = 0;
  const overlay = createComputerUseOverlay({
    resume: (_generation, signal) => new Promise((_, reject) => {
      resumeSignal = signal;
      signal.addEventListener('abort', () => reject(new Error('computer_resume_cancelled')), { once: true });
    }),
    stop: async () => {
      stopped++;
      coordinator.cancelSession('dismiss-fixture');
      coordinator.resumeAfterUserTakeover();
    },
  });
  try {
    coordinator.beginCommand({ sessionId: 'dismiss-fixture', action: 'capture', mode: 'background' });
    await settle();
    const window = windows[start];
    const invoke = (action, generation) => window.control({
      sender: window.webContents, senderFrame: window.webContents.mainFrame,
    }, { action, generation });
    assert.equal((await invoke('dismiss', 0)).accepted, false, 'running automation cannot hide its controls');
    coordinator.pauseForUser('input_observation_unavailable');
    await settle();
    const generation = coordinator.snapshot().takeoverGeneration;
    const resuming = invoke('resume', generation);
    await settle();
    assert.equal((await invoke('dismiss', generation - 1)).error, 'stale');
    assert.equal((await invoke('dismiss', generation)).accepted, true);
    assert.equal(resumeSignal.aborted, true);
    await resuming;
    await new Promise(resolve => setTimeout(resolve, 220));
    assert.equal(window.isVisible(), false);
    assert.equal(coordinator.snapshot().userControlActive, true);
    assert.throws(() => coordinator.assertAutomationAllowed());
    coordinator.finishCommand('dismiss-fixture');
    await settle();
    assert.equal(window.isVisible(), false, 'same-generation updates cannot resurrect dismissed controls');
    stopShortcut();
    await settle();
    assert.equal(stopped, 1, 'the emergency Stop shortcut works even while the overlay is hidden');
    assert.equal(coordinator.snapshot().userControlActive, false);
  } finally {
    overlay.dispose();
    coordinator.reset();
  }
});

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

test('an unresponsive control window is retired and its replacement can dismiss without resuming input', async () => {
  fault = '';
  const start = windows.length;
  const overlay = createComputerUseOverlay({
    stop: async () => {}, resume: async () => {},
    pause: async () => coordinator.pauseForUser('user_pause'),
  });
  try {
    coordinator.beginCommand({ sessionId: 'hung-fixture', action: 'capture', mode: 'background' });
    await settle();
    const hung = windows[start];
    hung.webContents.executeJavaScript = () => new Promise(() => {});
    coordinator.pauseForUser('input_observation_unavailable');
    await settle();
    hung.emit('unresponsive');
    await settle();
    await settle();
    assert.equal(coordinator.snapshot().userControlActive, true);
    assert.equal(hung.isDestroyed(), true, 'never retain controls whose renderer cannot receive a click');
    assert.equal(windows.length, start + 2);
    const replacement = windows[start + 1];
    assert.equal(replacement.isVisible(), true);
    hung.emit('responsive');
    hung.webContents.emit('render-process-gone', {}, { reason: 'killed' });
    await settle();
    assert.equal(windows.length, start + 2, 'late events from the retired renderer must not retire its replacement');
    const dismissed = await replacement.control({
      sender: replacement.webContents, senderFrame: replacement.webContents.mainFrame,
    }, { action: 'dismiss', generation: coordinator.snapshot().takeoverGeneration });
    assert.equal(dismissed.accepted, true);
    await new Promise(resolve => setTimeout(resolve, 220));
    assert.equal(replacement.isVisible(), false);
    assert.equal(coordinator.snapshot().userControlActive, true);
    assert.throws(() => coordinator.assertAutomationAllowed());
  } finally {
    overlay.dispose();
    coordinator.reset();
  }
});

test('a hung initial load does not block replacement or resurrect the retired window when it settles', async () => {
  fault = 'load-hang';
  const start = windows.length;
  const overlay = createComputerUseOverlay({
    stop: async () => {}, resume: async () => {},
    pause: async () => coordinator.pauseForUser('user_pause'),
  });
  try {
    coordinator.beginCommand({ sessionId: 'load-hung-fixture', action: 'capture', mode: 'background' });
    await settle();
    const hung = windows[start];
    fault = '';
    hung.emit('unresponsive');
    await settle();
    await settle();
    assert.equal(hung.isDestroyed(), true);
    assert.equal(windows.length, start + 2);
    const replacement = windows[start + 1];
    assert.equal(replacement.isVisible(), true);
    hung.finishLoading();
    await settle();
    await settle();
    coordinator.finishCommand('load-hung-fixture');
    await settle();
    assert.equal(windows.length, start + 2);
    assert.equal(replacement.isDestroyed(), false);
    assert.equal(replacement.isVisible(), true);
    assert.equal(coordinator.snapshot().userControlActive, true);
  } finally {
    fault = '';
    overlay.dispose();
    coordinator.reset();
  }
});

test('repeated unresponsive renderers are removed without an automatic restart loop', async () => {
  fault = '';
  const start = windows.length;
  let stopped = 0;
  const overlay = createComputerUseOverlay({
    stop: async () => { stopped++; }, resume: async () => {},
    pause: async () => coordinator.pauseForUser('user_pause'),
  });
  try {
    coordinator.beginCommand({ sessionId: 'repeated-hung-fixture', action: 'capture', mode: 'background' });
    await settle();
    windows[start].emit('unresponsive');
    await settle();
    await settle();
    windows[start + 1].emit('unresponsive');
    await settle();
    await settle();
    assert.equal(windows.length, start + 2);
    assert.ok(windows.slice(start).every(window => window.isDestroyed()));
    assert.equal(coordinator.snapshot().userControlActive, true);
    assert.throws(() => coordinator.assertAutomationAllowed());
    stopShortcut();
    await settle();
    assert.equal(stopped, 1, 'host Stop remains available when both control renderers have failed');
  } finally {
    overlay.dispose();
    coordinator.reset();
  }
});

test('a crashed control renderer pauses input and is replaced with live controls', async () => {
  fault = '';
  const start = windows.length;
  const overlay = createComputerUseOverlay({
    stop: async () => {},
    resume: async () => {},
    pause: async () => coordinator.pauseForUser('user_pause'),
  });
  try {
    coordinator.beginCommand({ sessionId: 'crash-fixture', action: 'capture', mode: 'background' });
    await settle();
    windows[start].webContents.emit('render-process-gone', {}, { reason: 'crashed' });
    await settle();
    await settle();
    assert.equal(windows[start].isDestroyed(), true);
    assert.equal(coordinator.snapshot().userControlActive, true);
    assert.equal(windows.length, start + 2);
    assert.equal(windows[start + 1].isVisible(), true);
    windows[start + 1].webContents.emit('render-process-gone', {}, { reason: 'crashed' });
    await settle();
    await settle();
    assert.equal(windows.length, start + 2);
    assert.equal(coordinator.snapshot().userControlActive, true);
  } finally {
    overlay.dispose();
    coordinator.reset();
  }
});
