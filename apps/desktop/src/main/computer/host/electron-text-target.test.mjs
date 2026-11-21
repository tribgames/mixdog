import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { runInNewContext } from 'node:vm';
import test from 'node:test';

registerHooks({
  resolve(specifier, context, next) {
    return specifier === 'electron'
      ? {
          url: 'data:text/javascript,export const screen = { screenToDipPoint: p => ({ x: p.x / 2, y: p.y / 2 }) }; export const BrowserWindow = { getAllWindows: () => globalThis.typingWindows || [] };',
          shortCircuit: true,
        }
      : next(specifier, context);
  },
});
const { typingTargetProbe, waitForElectronTypingTarget } = await import('./electron-text-target.ts');

const { underEndpoint } = await import('./command-fence.ts');
/** The endpoint of the relayed command these inputs belong to, admitting everything. */
const fenced = (run) => underEndpoint({ signal: new AbortController().signal, commit() {}, track() {} }, run);

test('typing requires an editable focus and refuses a different editable target, including shadow DOM', () => {
  const field = { tagName: 'INPUT', type: 'text', contains: () => false };
  const document = { activeElement: field, elementFromPoint: () => field };
  const probe = () => runInNewContext(typingTargetProbe({ x: 1, y: 2 }), { document });
  assert.equal(probe(), true);
  // Canvas-hosted editors delegate focus away from the element under the pointer.
  document.elementFromPoint = () => ({});
  assert.equal(probe(), true);
  document.elementFromPoint = () => ({ tagName: 'TEXTAREA' });
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
  // Native points are DIPs on macOS; elsewhere the screen scale (2) applies
  // first. Both then subtract the content origin and divide by the zoom.
  const [pageX, pageY] = process.platform === 'darwin' ? [100, 45] : [25, 10];
  const window = {
    isDestroyed: () => false,
    getContentBounds: () => ({ x: 100, y: 50 }),
    webContents: {
      isDestroyed: () => false,
      getZoomFactor: () => 2,
      executeJavaScript: async (script) => {
        checks++;
        return runInNewContext(script, {
          document: {
            activeElement: field,
            elementFromPoint: (x, y) => (x === pageX && y === pageY ? field : null),
          },
        });
      },
    },
  };
  assert.equal(await waitForElectronTypingTarget(window, { x: 300, y: 140 }, async () => {}), true);
  assert.equal(checks, 1);
  await assert.rejects(
    waitForElectronTypingTarget(window, undefined, async () => {
      throw new Error('cancelled');
    }),
    /cancelled/
  );
  assert.equal(checks, 1);
});

test('an unresponsive renderer cannot hold the typing readiness check indefinitely', async () => {
  const window = {
    isDestroyed: () => false,
    getContentBounds: () => ({ x: 0, y: 0 }),
    webContents: {
      isDestroyed: () => false,
      getZoomFactor: () => 1,
      executeJavaScript: () => new Promise(() => {}),
    },
  };
  assert.equal(await waitForElectronTypingTarget(window, undefined, async () => {}), false);
});

test('observation-only enabled during focus confirmation prevents text after the preparatory click', async () => {
  const { createInputDispatch } = await import('./input-dispatch.ts');
  let observeOnly = false,
    clicks = 0,
    textWrites = 0;
  globalThis.typingWindows = [
    {
      isDestroyed: () => false,
      getNativeWindowHandle: () => Buffer.from([1, 0, 0, 0]),
      getMediaSourceId: () => 'window:1:0',
      getContentBounds: () => ({ x: 0, y: 0 }),
      webContents: {
        isDestroyed: () => false,
        getZoomFactor: () => 1,
        executeJavaScript: async () => {
          observeOnly = true;
          return true;
        },
        insertText: async () => {
          textWrites++;
        },
      },
    },
  ];
  const dispatch = createInputDispatch(
    {
      assertExecutionNotAborted() {},
      isObserveOnly: () => observeOnly,
      sessionIdFor: () => 'typing-fixture',
      callPowerShell: async () => {
        clicks++;
        return { ok: true, result: { delivery_accepted: true } };
      },
    },
    { assertAction() {}, dispatchAuthority: () => ({}) }
  );
  try {
    await assert.rejects(
      fenced(() =>
        dispatch({ action: 'type', text: 'fixture' }, 'type', {
          targetWindowId: 'hwnd:0x1',
          physicalX: 2,
          physicalY: 2,
          allowedWindowIds: ['hwnd:0x1'],
        })
      ),
      /observation_only/
    );
    assert.equal(clicks, 1);
    assert.equal(textWrites, 0);
  } finally {
    delete globalThis.typingWindows;
  }
});

test('a failed preparatory click retains uncertainty and never sends app-owned text', async () => {
  const { createInputDispatch } = await import('./input-dispatch.ts');
  for (const uncertain of [true, false]) {
    let textWrites = 0;
    globalThis.typingWindows = [
      {
        isDestroyed: () => false,
        getNativeWindowHandle: () => Buffer.from([1, 0, 0, 0]),
        getMediaSourceId: () => 'window:1:0',
        webContents: {
          isDestroyed: () => false,
          insertText: async () => {
            textWrites++;
          },
        },
      },
    ];
    const dispatch = createInputDispatch(
      {
        assertExecutionNotAborted() {},
        isObserveOnly: () => false,
        sessionIdFor: () => 'typing-fixture',
        callPowerShell: async () => ({
          ok: true,
          result: {
            action: 'click',
            code: 'background_unsupported',
            text: 'fixture refusal',
            delivery_accepted: uncertain ? null : false,
            input_may_have_executed: uncertain,
          },
        }),
      },
      { assertAction() {}, dispatchAuthority: () => ({}) }
    );
    try {
      const response = await fenced(() =>
        dispatch({ action: 'type', text: 'must not be typed' }, 'type', {
          targetWindowId: 'hwnd:0x1',
          physicalX: 2,
          physicalY: 2,
          allowedWindowIds: ['hwnd:0x1'],
        })
      );
      assert.equal(response.result.action, 'type');
      assert.equal(response.result.code, 'background_unsupported');
      assert.equal(response.result.input_may_have_executed, uncertain);
      assert.equal(response.result.delivery_accepted, uncertain ? null : false);
      assert.equal(textWrites, 0);
    } finally {
      delete globalThis.typingWindows;
    }
  }
});

test('a saved-login worker step is authorized, merged into the worker request and refused unavailable before any write', async () => {
  const { createInputDispatch } = await import('./input-dispatch.ts');
  const requests = [];
  const dispatch = createInputDispatch(
    {
      assertExecutionNotAborted() {},
      isObserveOnly: () => false,
      sessionIdFor: () => 'saved-login-fixture',
      callPowerShell: async (request) => {
        requests.push(request);
        return { ok: true, result: { action: request.action } };
      },
    },
    { assertAction() {}, dispatchAuthority: () => ({ authorization_expires_at: 7 }) }
  );
  const target = { targetWindowId: 'hwnd:0x1', allowedWindowIds: ['hwnd:0x1'] };
  const checked = await dispatch(
    { action: 'fill_saved_login', saved_login_step: 'check', field: 'password' },
    'fill_saved_login',
    target
  );
  assert.equal(checked.result.action, 'saved_login_check');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].action, 'saved_login_check');
  assert.equal(requests[0].field, 'password');
  assert.equal(requests[0].text, null);
  assert.equal(requests[0].authorization_expires_at, 7);
  assert.equal(requests[0].session_id, 'saved-login-fixture');
  await assert.rejects(
    dispatch({ action: 'fill_saved_login', saved_login_step: 'type', field: 'password' }, 'fill_saved_login', target),
    /saved_login_unavailable/
  );
  assert.equal(requests.length, 1);
});
