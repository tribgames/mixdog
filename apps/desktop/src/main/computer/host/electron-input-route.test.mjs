import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

registerHooks({
  resolve(specifier, context, next) {
    return specifier === 'electron'
      ? {
          url: 'data:text/javascript,export const screen = { screenToDipPoint: p => p, dipToScreenPoint: p => p }; export const BrowserWindow = { getAllWindows: () => globalThis.inputWindows || [] };',
          shortCircuit: true,
        }
      : next(specifier, context);
  },
});
const { electronKeyPresses } = await import('./input-electron-keys.ts');
const { createInputDispatch } = await import('./input-dispatch.ts');

function fixtureWindow(commands, { log = [], delayMs = 0, attachedBefore = false } = {}) {
  let attached = attachedBefore;
  return {
    isDestroyed: () => false,
    getNativeWindowHandle: () => Buffer.from([1, 0, 0, 0]),
    getMediaSourceId: () => 'window:1:0',
    getContentBounds: () => ({ x: 10, y: 20, width: 200, height: 100 }),
    webContents: {
      isDestroyed: () => false,
      getZoomFactor: () => 1,
      getOSProcessId: () => 42,
      debugger: {
        isAttached: () => attached,
        attach: () => {
          attached = true;
          log.push('attach');
        },
        detach: () => {
          attached = false;
          log.push('detach');
        },
        sendCommand: async (method, params) => {
          if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
          commands.push({ method, params });
          log.push(`${params.key}:${params.type}`);
        },
      },
    },
  };
}

function dispatcher(nativeCalls) {
  return createInputDispatch(
    {
      assertExecutionNotAborted() {},
      isObserveOnly: () => false,
      sessionIdFor: () => 'electron-input',
      callPowerShell: async (request) => {
        nativeCalls.push(request);
        return { ok: true, result: {} };
      },
    },
    { assertAction() {}, dispatchAuthority: () => ({}) }
  );
}

test('key chords parse to browser chords', () => {
  assert.deepEqual(electronKeyPresses('alt+left'), ['alt+arrowleft']);
  assert.deepEqual(electronKeyPresses('ctrl+='), ['control+=']);
  assert.deepEqual(electronKeyPresses('ctrl+shift+p'), ['control+shift+p']);
  assert.deepEqual(electronKeyPresses('enter'), ['enter']);
  assert.throws(() => electronKeyPresses('insert'), /background_unsupported/);
});

test('background key and scroll on a Mixdog window use its own input channel, never native', async () => {
  const commands = [];
  const nativeCalls = [];
  globalThis.inputWindows = [fixtureWindow(commands)];
  const target = { targetWindowId: 'hwnd:0x1', allowedWindowIds: ['hwnd:0x1'] };
  try {
    const dispatch = dispatcher(nativeCalls);
    const key = await dispatch({ action: 'key', keys: 'alt+left' }, 'key', target);
    assert.equal(key.result.path, 'electron_key_event');
    assert.equal(key.result.delivery_accepted, true);
    const down = commands.find((c) => c.params.type === 'rawKeyDown');
    assert.equal(down.params.modifiers, 1);
    assert.equal(down.params.windowsVirtualKeyCode, 37);
    assert.ok(commands.some((c) => c.params.type === 'keyUp'));

    commands.length = 0;
    const scroll = await dispatch({ action: 'scroll', direction: 'down', amount: 2 }, 'scroll', target);
    assert.equal(scroll.result.path, 'electron_wheel_event');
    assert.deepEqual(commands[0].params, {
      type: 'mouseWheel',
      x: 100,
      y: 50,
      deltaX: 0,
      deltaY: 200,
      modifiers: 0,
      button: 'none',
    });
    assert.equal(nativeCalls.length, 0);
  } finally {
    delete globalThis.inputWindows;
  }
});

const concurrentTarget = { targetWindowId: 'hwnd:0x1', allowedWindowIds: ['hwnd:0x1'] };

test('overlapping operations on one window never interleave, and the debugger is detached once by its attacher', async () => {
  const log = [];
  globalThis.inputWindows = [fixtureWindow([], { log, delayMs: 5 })];
  try {
    const dispatch = dispatcher([]);
    await Promise.all([
      dispatch({ action: 'key', keys: 'enter' }, 'key', concurrentTarget),
      dispatch({ action: 'key', keys: 'tab' }, 'key', concurrentTarget),
    ]);
    const first = log.indexOf('detach');
    const second = log.indexOf('attach', first);
    assert.equal(log[0], 'attach');
    assert.ok(first > 0 && second === first + 1, `operations overlapped: ${log.join(' ')}`);
    assert.equal(log.filter((entry) => entry === 'attach').length, 2);
    assert.equal(log.filter((entry) => entry === 'detach').length, 2);
    assert.equal(log.at(-1), 'detach');
    const firstKeys = new Set(log.slice(1, first).map((entry) => entry.split(':')[0]));
    const secondKeys = new Set(log.slice(second + 1, -1).map((entry) => entry.split(':')[0]));
    assert.equal(firstKeys.size, 1, `first operation saw ${[...firstKeys]}`);
    assert.equal(secondKeys.size, 1, `second operation saw ${[...secondKeys]}`);
    assert.notDeepEqual([...firstKeys], [...secondKeys]);
  } finally {
    delete globalThis.inputWindows;
  }
});

test('an attachment that existed before the operation is left in place', async () => {
  const log = [];
  globalThis.inputWindows = [fixtureWindow([], { log, delayMs: 1, attachedBefore: true })];
  try {
    const dispatch = dispatcher([]);
    await Promise.all([
      dispatch({ action: 'key', keys: 'enter' }, 'key', concurrentTarget),
      dispatch({ action: 'scroll', direction: 'down' }, 'scroll', concurrentTarget),
    ]);
    assert.ok(log.length > 0);
    assert.ok(!log.includes('attach') && !log.includes('detach'), log.join(' '));
  } finally {
    delete globalThis.inputWindows;
  }
});

test('foreground delivery and other windows keep the native route', async () => {
  const commands = [];
  const nativeCalls = [];
  globalThis.inputWindows = [fixtureWindow(commands)];
  try {
    const dispatch = dispatcher(nativeCalls);
    await dispatch({ action: 'key', keys: 'ctrl+a' }, 'key', {
      targetWindowId: 'hwnd:0x2',
      allowedWindowIds: ['hwnd:0x2'],
    });
    assert.equal(nativeCalls.length, 1);
    assert.equal(commands.length, 0);
  } finally {
    delete globalThis.inputWindows;
  }
});
