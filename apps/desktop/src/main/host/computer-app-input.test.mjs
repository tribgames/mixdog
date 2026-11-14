import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

registerHooks({
  resolve(specifier, context, next) {
    return specifier === 'electron'
      ? {
          url: 'data:text/javascript,export const screen = { screenToDipPoint: p => p, dipToScreenPoint: p => p, getDisplayMatching: () => ({ id: 7, scaleFactor: 1.5 }) }; export const BrowserWindow = { getAllWindows: () => globalThis.appWindows || [] };',
          shortCircuit: true,
        }
      : next(specifier, context);
  },
});
const { registerComputerAppWindows, appWindowId } = await import('./computer-app-windows.ts');
const { registerComputerAppInput } = await import('./computer-app-input.ts');
const { registerComputerUseInternalWindow } = await import('../computer/overlay/internal-windows.ts');

function fakeWindow(number, { editable = true, title = 'Mixdog', parent = null } = {}) {
  const sent = [];
  const inserted = [];
  let destroyed = false;
  const window = {
    sent,
    inserted,
    destroy: () => {
      destroyed = true;
    },
    isDestroyed: () => destroyed,
    getNativeWindowHandle: () => Buffer.from([number, 0, 0, 0, 0, 0, 0, 0]),
    getMediaSourceId: () => `window:${number}:0`,
    getBounds: () => ({ x: 100, y: 50, width: 800, height: 600 }),
    getContentBounds: () => ({ x: 110, y: 80, width: 780, height: 560 }),
    getTitle: () => title,
    isFocused: () => true,
    getParentWindow: () => parent,
    webContents: {
      isDestroyed: () => destroyed,
      getZoomFactor: () => 1,
      getOSProcessId: () => 4242,
      insertText: async (text) => {
        inserted.push(text);
      },
      executeJavaScript: async () => editable,
      debugger: {
        isAttached: () => false,
        attach() {},
        detach() {},
        sendCommand: async (method, params) => {
          sent.push({ method, params });
        },
      },
    },
  };
  return window;
}

function rig(windows) {
  globalThis.appWindows = windows;
  const handlers = new Map();
  const cursors = [];
  const connection = { handleRequest: (method, run) => handlers.set(method, run) };
  registerComputerAppWindows(connection);
  registerComputerAppInput(connection, { showCursor: (...args) => cursors.push(args) });
  const ask = (method, params, signal = new AbortController().signal) => handlers.get(method)(params, signal);
  return { cursors, ask: (params, signal) => ask('host/computer/appInput', params, signal), windows: () => ask('host/computer/appWindows', {}) };
}

const base = (window) => ({ sessionThreadId: 'thr_1', windowId: appWindowId(window) });
const rejects = (promise, code) => assert.rejects(promise, (error) => error.code === code);

test('appWindows lists the live windows with their physical bounds and leaves out the overlay windows and destroyed ones', async () => {
  const main = fakeWindow(0x1ab);
  const aux = fakeWindow(0x2cd, { title: 'Login', parent: main });
  const overlay = fakeWindow(0x3ef);
  const destroyed = fakeWindow(0x4aa);
  destroyed.destroy();
  const unregister = registerComputerUseInternalWindow(overlay);
  try {
    const { windows } = await rig([main, aux, overlay, destroyed]).windows();
    assert.deepEqual(
      windows.map((entry) => [entry.windowId, entry.kind, entry.title]),
      [
        [appWindowId(main), 'main', 'Mixdog'],
        [appWindowId(aux), 'aux', 'Login'],
      ]
    );
    assert.deepEqual(windows[0].bounds, { x: 100, y: 50, width: 800, height: 600 });
    assert.equal(windows[0].scaleFactor, 1.5);
    assert.equal(windows[0].displayId, '7');
    assert.equal(windows[0].focused, true);
  } finally {
    unregister();
    delete globalThis.appWindows;
  }
});

test('a key reaches the renderer as key events, counted as presses, with the renderer pid', async () => {
  const window = fakeWindow(0x1ab);
  const { ask } = rig([window]);
  try {
    const answer = await ask({ ...base(window), op: 'key', keys: '^A' });
    assert.deepEqual(answer, { delivered: true, effect: 'delivered', presses: 1, pid: 4242 });
    assert.ok(window.sent.some((entry) => entry.params.type === 'rawKeyDown' && entry.params.modifiers === 2));
    assert.ok(window.sent.some((entry) => entry.params.type === 'keyUp'));
  } finally {
    delete globalThis.appWindows;
  }
});

test('a key the renderer has no mapping for is refused with background_unsupported and sends nothing', async () => {
  const window = fakeWindow(0x1ab);
  const { ask } = rig([window]);
  try {
    const answer = await ask({ ...base(window), op: 'key', keys: '{INSERT}' });
    assert.equal(answer.effect, 'refused');
    assert.equal(answer.code, 'background_unsupported');
    assert.equal(window.sent.length, 0);
  } finally {
    delete globalThis.appWindows;
  }
});

test('type at a point clicks it inside the renderer, inserts the text and reports the arrow', async () => {
  const window = fakeWindow(0x1ab);
  const { ask, cursors } = rig([window]);
  try {
    const answer = await ask({ ...base(window), op: 'type', text: 'héllo', x: 20, y: 30 });
    assert.deepEqual(window.inserted, ['héllo']);
    assert.deepEqual(
      window.sent.map((entry) => entry.params.type),
      ['mouseMoved', 'mousePressed', 'mouseReleased']
    );
    assert.deepEqual(window.sent[1].params, { x: 10, y: 0, button: 'left', clickCount: 1, modifiers: 0, type: 'mousePressed' });
    assert.deepEqual(answer, {
      delivered: true,
      effect: 'delivered',
      evidence: { editable: true },
      pid: 4242,
      cursor: { x: 120, y: 80 },
    });
    assert.deepEqual(cursors, [['thr_1', 120, 80, 'type']]);
  } finally {
    delete globalThis.appWindows;
  }
});

test('type into a window with no editable focus is not_editable and types nothing', async () => {
  const window = fakeWindow(0x1ab, { editable: false });
  const { ask } = rig([window]);
  try {
    const answer = await ask({ ...base(window), op: 'type', text: 'x' });
    assert.equal(answer.delivered, false);
    assert.equal(answer.effect, 'not_editable');
    assert.deepEqual(window.inserted, []);
  } finally {
    delete globalThis.appWindows;
  }
});

test('a preparatory click that fails is click_unconfirmed and nothing is typed', async () => {
  const window = fakeWindow(0x1ab);
  window.webContents.getZoomFactor = () => 0;
  const { ask } = rig([window]);
  try {
    const answer = await ask({ ...base(window), op: 'type', text: 'x', x: 5, y: 5 });
    assert.equal(answer.effect, 'click_unconfirmed');
    // A click that failed without saying whether it landed is treated as possibly landed (`preparatoryClickFailure`).
    assert.equal(answer.inputMayHaveExecuted, true);
    assert.match(answer.text, /zoom is unreadable/);
    assert.deepEqual(window.inserted, []);
  } finally {
    delete globalThis.appWindows;
  }
});

test('a wheel is one mouseWheel at the point or the middle of the content, signed by the deltas', async () => {
  const window = fakeWindow(0x1ab);
  const { ask, cursors } = rig([window]);
  try {
    const answer = await ask({ ...base(window), op: 'wheel', dx: 0, dy: -200, modifiers: 'ctrl' });
    assert.equal(answer.effect, 'delivered');
    assert.deepEqual(window.sent[0].params, { type: 'mouseWheel', x: 390, y: 280, deltaX: 0, deltaY: -200, modifiers: 2, button: 'none' });
    window.sent.length = 0;
    await ask({ ...base(window), op: 'wheel', dx: 300, dy: 0, x: 20, y: 30 });
    assert.deepEqual(window.sent[0].params, { type: 'mouseWheel', x: 10, y: 0, deltaX: 300, deltaY: 0, modifiers: 0, button: 'none' });
    assert.deepEqual(cursors.at(-1), ['thr_1', 120, 80, 'scroll']);
  } finally {
    delete globalThis.appWindows;
  }
});

test('click presses count up for a double click and a move is one pointer move', async () => {
  const window = fakeWindow(0x1ab);
  const { ask } = rig([window]);
  try {
    const answer = await ask({ ...base(window), op: 'click', x: 20, y: 30, clicks: 2, button: 'right' });
    assert.equal(answer.effect, 'delivered');
    assert.deepEqual(answer.cursor, { x: 120, y: 80 });
    const pressed = window.sent.filter((entry) => entry.params.type === 'mousePressed');
    assert.deepEqual(pressed.map((entry) => [entry.params.button, entry.params.clickCount]), [['right', 1], ['right', 2]]);
    window.sent.length = 0;
    await ask({ ...base(window), op: 'move', x: 20, y: 30 });
    assert.deepEqual(window.sent.map((entry) => entry.params.type), ['mouseMoved']);
  } finally {
    delete globalThis.appWindows;
  }
});

test('a window that is not app-owned, and malformed fields, are -32602', async () => {
  const window = fakeWindow(0x1ab);
  const { ask } = rig([window]);
  try {
    await rejects(ask({ sessionThreadId: 'thr_1', windowId: 'hwnd:0x999', op: 'key', keys: 'a' }), -32602);
    await rejects(ask({ ...base(window), op: 'sideways' }), -32602);
    await rejects(ask({ ...base(window), op: 'key' }), -32602);
    await rejects(ask({ ...base(window), op: 'click', x: 1 }), -32602);
    await rejects(ask({ ...base(window), op: 'click', x: 1, y: 1, clicks: 4 }), -32602);
    await rejects(ask({ ...base(window), op: 'wheel', dy: 'a' }), -32602);
    await rejects(ask('not an object'), -32602);
    assert.equal(window.sent.length, 0);
  } finally {
    delete globalThis.appWindows;
  }
});

test('an overlay window is not app-owned for input', async () => {
  const overlay = fakeWindow(0x3ef);
  const unregister = registerComputerUseInternalWindow(overlay);
  const { ask } = rig([overlay]);
  try {
    await rejects(ask({ ...base(overlay), op: 'key', keys: 'a' }), -32602);
  } finally {
    unregister();
    delete globalThis.appWindows;
  }
});

test('a window that closes between steps is window_gone, and an abort stops the input', async () => {
  const window = fakeWindow(0x1ab);
  const { ask } = rig([window]);
  try {
    window.webContents.debugger.sendCommand = async () => {
      window.destroy();
      throw new Error('Object has been destroyed');
    };
    assert.deepEqual(await ask({ ...base(window), op: 'key', keys: 'a' }), { delivered: false, effect: 'window_gone' });
    const live = fakeWindow(0x1ac);
    globalThis.appWindows = [live];
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(ask({ ...base(live), op: 'key', keys: 'a' }, controller.signal));
    assert.equal(live.sent.length, 0);
  } finally {
    delete globalThis.appWindows;
  }
});
