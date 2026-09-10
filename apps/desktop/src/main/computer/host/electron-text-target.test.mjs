import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { runInNewContext } from 'node:vm';
import test from 'node:test';

registerHooks({
  resolve(specifier, context, next) {
    return specifier === 'electron' ? {
      url: 'data:text/javascript,export const screen = { screenToDipPoint: p => ({ x: p.x / 2, y: p.y / 2 }) }; export const BrowserWindow = { getAllWindows: () => globalThis.typingWindows || [] };',
      shortCircuit: true,
    } : next(specifier, context);
  },
});
const { typingTargetProbe, waitForElectronTypingTarget } = await import('./electron-text-target.ts');

test('typing requires an editable focus matching the requested point, including shadow DOM', () => {
  const field = { tagName: 'INPUT', type: 'text', contains: () => false };
  const document = { activeElement: field, elementFromPoint: () => field };
  const probe = () => runInNewContext(typingTargetProbe({ x: 1, y: 2 }), { document });
  assert.equal(probe(), true);
  document.elementFromPoint = () => ({});
  assert.equal(probe(), false);
  document.elementFromPoint = () => field;
  for (const property of ['disabled', 'readOnly']) {
    field[property] = true;
    assert.equal(probe(), false);
    field[property] = false;
  }
  field.type = 'checkbox';
  assert.equal(probe(), false);
  field.type = 'password';
  const shadowRoot = { activeElement: field, elementFromPoint: () => field };
  document.activeElement = { shadowRoot };
  document.elementFromPoint = () => ({ shadowRoot });
  assert.equal(probe(), true);
});

test('typing readiness converts physical coordinates and zoom and stops on cancellation', async () => {
  let checks = 0;
  const field = { tagName: 'TEXTAREA' };
  const window = {
    isDestroyed: () => false, getContentBounds: () => ({ x: 100, y: 50 }),
    webContents: {
      isDestroyed: () => false, getZoomFactor: () => 2,
      executeJavaScript: async (script) => {
        checks++;
        return runInNewContext(script, { document: {
          activeElement: field,
          elementFromPoint: (x, y) => x === 25 && y === 10 ? field : null,
        } });
      },
    },
  };
  assert.equal(await waitForElectronTypingTarget(window, { x: 300, y: 140 }, async () => {}), true);
  assert.equal(checks, 1);
  await assert.rejects(waitForElectronTypingTarget(window, undefined, async () => {
    throw new Error('cancelled');
  }), /cancelled/);
  assert.equal(checks, 1);
});

test('an unresponsive renderer cannot hold the typing readiness check indefinitely', async () => {
  const window = {
    isDestroyed: () => false, getContentBounds: () => ({ x: 0, y: 0 }),
    webContents: {
      isDestroyed: () => false, getZoomFactor: () => 1,
      executeJavaScript: () => new Promise(() => {}),
    },
  };
  assert.equal(await waitForElectronTypingTarget(window, undefined, async () => {}), false);
});

test('observation-only enabled during focus confirmation prevents text after the preparatory click', async () => {
  const { createInputDispatch } = await import('./input-dispatch.ts');
  let observeOnly = false, clicks = 0, textWrites = 0;
  globalThis.typingWindows = [{
    isDestroyed: () => false, getNativeWindowHandle: () => Buffer.from([1, 0, 0, 0]),
    getContentBounds: () => ({ x: 0, y: 0 }),
    webContents: {
      isDestroyed: () => false, getZoomFactor: () => 1,
      executeJavaScript: async () => { observeOnly = true; return true; },
      insertText: async () => { textWrites++; },
    },
  }];
  const dispatch = createInputDispatch({
    assertExecutionNotAborted() {}, isObserveOnly: () => observeOnly, sessionIdFor: () => 'typing-fixture',
    callPowerShell: async () => { clicks++; return { ok: true, result: { delivery_accepted: true } }; },
  }, { assertAction() {}, dispatchAuthority: () => ({}) });
  try {
    await assert.rejects(dispatch({ action: 'type', text: 'fixture' }, 'type',
      { targetWindowId: 'hwnd:0x1', physicalX: 2, physicalY: 2, allowedWindowIds: ['hwnd:0x1'] }), /observation_only/);
    assert.equal(clicks, 1);
    assert.equal(textWrites, 0);
  } finally { delete globalThis.typingWindows; }
});
