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
      ipc: {
        handle: (_channel, handler) => {
          this.control = handler;
        },
      },
      mainFrame: {},
      setWindowOpenHandler() {},
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
  setTitle() {}
  setAlwaysOnTop() {}
  setContentProtection() {}
  setVisibleOnAllWorkspaces() {}
  async loadURL() {
    if (fault === 'load') throw new Error('fixture load failure');
    if (fault === 'load-hang')
      await new Promise((resolve) => {
        this.finishLoading = resolve;
      });
  }
  isDestroyed() {
    return this.destroyed === true;
  }
  destroy() {
    this.destroyed = true;
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
  setBounds() {}
}
globalThis.overlayLifecycleElectron = {
  // Loaded as ESM, so the overlay resolves its preload from the app path.
  app: { getAppPath: () => process.cwd() },
  BrowserWindow: WindowFixture,
  globalShortcut: {
    register: (_key, callback) => {
      stopShortcut = callback;
      return true;
    },
    unregister() {},
  },
  screen: Object.assign(new EventEmitter(), {
    getAllDisplays: () => [{ id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1080 } }],
  }),
};
registerHooks({
  resolve(specifier, context, next) {
    return specifier === 'electron'
      ? {
          url: 'data:text/javascript,export const {app,BrowserWindow,screen,globalShortcut}=globalThis.overlayLifecycleElectron;',
          shortCircuit: true,
        }
      : next(specifier, context);
  },
});
const { createComputerUseOverlay } = await import('./index.ts');
const { computerUseCoordinator: coordinator } = await import('../session/coordinator.ts');
const settle = () => new Promise((resolve) => setImmediate(resolve));

test('Pause retains the task and its controls; Resume continues it and emergency Stop remains separate', async () => {
  fault = '';
  const start = windows.length;
  let resumed = 0,
    paused = 0,
    stopped = 0;
  const overlay = createComputerUseOverlay({
    resume: async (generation) => {
      resumed++;
      coordinator.resumeAfterUserTakeover(generation);
    },
    pause: async () => {
      paused++;
      coordinator.pauseForUser('user_pause');
    },
    stop: async () => {
      stopped++;
      coordinator.cancelSession('toggle-fixture');
      coordinator.resumeAfterUserTakeover();
    },
  });
  try {
    coordinator.beginCommand({ sessionId: 'toggle-fixture', action: 'capture', mode: 'background' });
    await settle();
    const window = windows[start];
    const invoke = (action, generation) =>
      window.control(
        {
          sender: window.webContents,
          senderFrame: window.webContents.mainFrame,
        },
        { action, generation }
      );
    for (const action of ['dismiss', 'cancel']) await assert.rejects(invoke(action, 0), /Invalid overlay request/);
    assert.equal((await invoke('pause', coordinator.snapshot().takeoverGeneration)).accepted, true);
    assert.equal(paused, 1);
    assert.equal(stopped, 0);
    assert.equal(resumed, 0);
    assert.equal(coordinator.snapshot().userControlActive, true);
    assert.throws(() => coordinator.assertAutomationAllowed());
    assert.ok(coordinator.snapshot().pausedSessionIds.includes('toggle-fixture'));
    await settle();
    assert.equal(window.isVisible(), true);
    const generation = coordinator.snapshot().takeoverGeneration;
    assert.equal((await invoke('resume', generation - 1)).error, 'stale');
    assert.equal((await invoke('resume', generation)).accepted, true);
    assert.equal(resumed, 1);
    assert.equal(coordinator.snapshot().userControlActive, false);
    assert.equal(stopped, 0);
    assert.equal(
      (await invoke('pause', generation - 1)).accepted,
      true,
      'a stale Pause may block input, never release it'
    );
    stopShortcut();
    await settle();
    assert.equal(stopped, 1, 'the emergency shortcut ends the task');
    assert.equal(coordinator.snapshot().userControlActive, false);
    // The check state's Stop control reaches the same path over the trusted
    // channel, so a latched pause is not left with a dead toggle alone.
    assert.equal((await invoke('stop', coordinator.snapshot().takeoverGeneration)).accepted, true);
    assert.equal(stopped, 2);
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
    assert.ok(windows.slice(start).every((window) => window.isDestroyed()));
  });
}

test('an unresponsive control window is retired and its replacement waits for explicit Resume', async () => {
  fault = '';
  const start = windows.length;
  const overlay = createComputerUseOverlay({
    stop: async () => {},
    resume: async (generation) => coordinator.resumeAfterUserTakeover(generation),
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
    assert.throws(() => coordinator.assertAutomationAllowed());
    const resumed = await replacement.control(
      {
        sender: replacement.webContents,
        senderFrame: replacement.webContents.mainFrame,
      },
      { action: 'resume', generation: coordinator.snapshot().takeoverGeneration }
    );
    assert.equal(resumed.accepted, true);
    assert.equal(replacement.isVisible(), true);
    assert.equal(coordinator.snapshot().userControlActive, false);
  } finally {
    overlay.dispose();
    coordinator.reset();
  }
});

test('a hung initial load does not block replacement or resurrect the retired window when it settles', async () => {
  fault = 'load-hang';
  const start = windows.length;
  const overlay = createComputerUseOverlay({
    stop: async () => {},
    resume: async () => {},
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
    stop: async () => {
      stopped++;
    },
    resume: async () => {},
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
    assert.ok(windows.slice(start).every((window) => window.isDestroyed()));
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
