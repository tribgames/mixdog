import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

registerHooks({
  resolve(specifier, context, next) {
    return specifier === 'electron'
      ? { url: 'data:text/javascript,export const screen = {}; export const BrowserWindow = {};', shortCircuit: true }
      : next(specifier, context);
  },
});
const { runRendererInput } = await import('./electron-input-port.ts');
const { rendererScope } = await import('./renderer-scope.ts');
const { switchEndpoint } = await import('./command-fence.ts');
const { createKeyboardInput } = await import('../../browser/input-keyboard.ts');
const { createMouseInput } = await import('../../browser/input-mouse.ts');

/** A renderer whose debugger logs what was handed to it; `reply` decides how each hand-over is answered. */
function renderer() {
  const sent = [];
  const inserted = [];
  let attached = false;
  const contents = {
    sent,
    inserted,
    reply: async () => undefined,
    isDestroyed: () => false,
    insertText: async (text) => {
      inserted.push(text);
    },
    debugger: {
      isAttached: () => attached,
      attach() {
        attached = true;
      },
      detach() {
        attached = false;
      },
      sendCommand(method, params) {
        sent.push({ method, ...params });
        return contents.reply(method, params);
      },
    },
  };
  return contents;
}

/** A scope endpoint the test revokes; the revocation runs the abort listeners at once, as the desktop's does. */
function scope() {
  const controller = new AbortController();
  let revoked = false;
  return {
    signal: controller.signal,
    commit() {
      if (revoked) throw new Error('computer_scope_revoked');
    },
    revoke() {
      revoked = true;
      controller.abort();
    },
  };
}

/** A promise the test resolves or rejects later: the barrier that orders a revocation against a hand-over's answer. */
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const types = (contents) => contents.sent.map((entry) => entry.type);

test('Off between an accepted key down and its character: the character is refused and only the owned key up goes out', async () => {
  const contents = renderer();
  const endpoint = scope();
  const [reached, down] = [deferred(), deferred()];
  contents.reply = (_method, params) => {
    if (params.type !== 'rawKeyDown') return Promise.resolve();
    reached.resolve();
    return down.promise;
  };
  const pressing = runRendererInput(contents, endpoint, ({ send }) => createKeyboardInput(send, { allowClipboard: true }).pressKey(contents, 'enter'));
  await reached.promise;
  assert.deepEqual(types(contents), ['rawKeyDown']);
  endpoint.revoke();
  down.resolve();
  await assert.rejects(pressing, /computer_scope_revoked/);
  assert.deepEqual(types(contents), ['rawKeyDown', 'keyUp']);
  // The release is the press's own: no text, no type the caller chose.
  assert.equal(contents.sent[1].text, undefined);
  assert.equal(contents.sent[1].code, 'Enter');
});

test('a press whose reply is lost stays owned: its release goes out at the press point, then the failure stands', async () => {
  const contents = renderer();
  const endpoint = scope();
  contents.reply = (_method, params) => (params.type === 'mousePressed' ? Promise.reject(new Error('reply lost')) : Promise.resolve());
  await assert.rejects(
    runRendererInput(contents, endpoint, ({ send }) => createMouseInput(send).clickAt(contents, 10, 20)),
    /reply lost/
  );
  assert.deepEqual(types(contents), ['mouseMoved', 'mousePressed', 'mouseReleased']);
  assert.deepEqual([contents.sent[2].x, contents.sent[2].y, contents.sent[2].button], [10, 20, 'left']);
});

test('Off during a drag: the next motion is refused and the button is let go at the last accepted point, once', async () => {
  const contents = renderer();
  const endpoint = scope();
  let release;
  await runRendererInput(contents, endpoint, async ({ send }) => {
    await send(contents, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: 1, y: 1, button: 'left', clickCount: 1, modifiers: 0 });
    await send(contents, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 6, button: 'left' });
    endpoint.revoke();
    await assert.rejects(send(contents, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: 9, y: 9, button: 'left' }));
    // The operation's own release after the cleanup sends nothing again; one carrying another point never moves anything.
    release = await send(contents, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: 50, y: 50, button: 'left' });
    await assert.rejects(send(contents, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: 50, y: 50, button: 'left' }));
  });
  assert.equal(release, 'completed');
  assert.deepEqual(types(contents), ['mousePressed', 'mouseMoved', 'mouseReleased']);
  assert.deepEqual([contents.sent[2].x, contents.sent[2].y], [5, 6]);
});

test('after Off a release without a receipt, a key up of another key, text and new presses are all refused', async () => {
  const contents = renderer();
  const endpoint = scope();
  await runRendererInput(contents, endpoint, async ({ send, insertText }) => {
    await send(contents, 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 });
    endpoint.revoke();
    for (const params of [
      { type: 'keyUp', key: 'b', code: 'KeyB', windowsVirtualKeyCode: 66 },
      { type: 'char', text: 'a', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 },
      { type: 'keyDown', key: 'c', code: 'KeyC', windowsVirtualKeyCode: 67 },
    ]) {
      await assert.rejects(send(contents, 'Input.dispatchKeyEvent', params));
    }
    await assert.rejects(send(contents, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: 1, y: 1, button: 'right' }));
    await assert.rejects(insertText('x'));
    await assert.rejects(send(contents, 'Runtime.evaluate', { expression: '1' }), /does not offer/);
  });
  assert.deepEqual(types(contents), ['keyDown', 'keyUp']);
  assert.equal(contents.sent[1].code, 'KeyA');
  assert.deepEqual(contents.inserted, []);
});

test('an operation queued behind a held one is refused once Off came, and stays refused after On with a new scope', async () => {
  const contents = renderer();
  const old = scope();
  const [started, held] = [deferred(), deferred()];
  const first = runRendererInput(contents, old, async ({ send }) => {
    await send(contents, 'Input.dispatchMouseEvent', { type: 'mouseWheel', x: 1, y: 1, deltaX: 0, deltaY: 1 });
    started.resolve();
    await held.promise;
  });
  await started.promise;
  const queued = runRendererInput(contents, old, ({ send }) => send(contents, 'Input.dispatchMouseEvent', { type: 'mouseWheel', x: 2, y: 2, deltaX: 0, deltaY: 1 }));
  old.revoke();
  const fresh = scope();
  held.resolve();
  await first;
  await assert.rejects(queued, /computer_scope_revoked/);
  await runRendererInput(contents, fresh, ({ send }) => send(contents, 'Input.dispatchMouseEvent', { type: 'mouseWheel', x: 3, y: 3, deltaX: 0, deltaY: 1 }));
  assert.deepEqual(contents.sent.map((entry) => entry.x), [1, 3]);
});

test('a revoked scope nested inside a live one refuses alone', async () => {
  const contents = renderer();
  const live = scope();
  const nested = scope();
  nested.revoke();
  await assert.rejects(runRendererInput(contents, nested, ({ insertText }) => insertText('nested')));
  await runRendererInput(contents, live, ({ insertText }) => insertText('live'));
  assert.deepEqual(contents.inserted, ['live']);
});

test("the desktop host's endpoint: Off while a press awaits its debugger reply lets go of it then, not at the operation's exit", async () => {
  const contents = renderer();
  // The command's endpoint (its scope): revoked by the scope's revocation, counting each hand-over.
  const revocation = new AbortController();
  let revoked = false;
  const tracked = [];
  const command = {
    signal: revocation.signal,
    commit() {
      if (revoked) throw new Error('computer_scope_revoked: off');
    },
    track: (reply) => tracked.push(reply),
  };
  const { scope: endpoint, close } = rendererScope(command, 'click', () => {});
  const [reached, reply] = [deferred(), deferred()];
  contents.reply = (_method, params) => {
    if (params.type !== 'mousePressed') return Promise.resolve();
    reached.resolve();
    return reply.promise;
  };
  const clicking = runRendererInput(contents, endpoint, ({ send }) => createMouseInput(send).clickAt(contents, 3, 4));
  await reached.promise;
  assert.ok(tracked.length > 0, "each hand-over is counted by the command's own endpoint");
  revoked = true;
  revocation.abort(new Error('computer_scope_revoked: off'));
  // The reply is still outstanding: the release already went out, from the press's receipt.
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(types(contents), ['mouseMoved', 'mousePressed', 'mouseReleased']);
  reply.resolve();
  // The operation's own release then finds its receipt already consumed and sends nothing.
  await Promise.allSettled([clicking]);
  close();
  assert.deepEqual(types(contents), ['mouseMoved', 'mousePressed', 'mouseReleased']);
  assert.deepEqual([contents.sent[2].x, contents.sent[2].y], [3, 4]);
});

test('a press still held when the operation ends is let go of at its exit, and nothing else is sent', async () => {
  const contents = renderer();
  const endpoint = scope();
  await assert.rejects(
    runRendererInput(contents, endpoint, async ({ send }) => {
      await send(contents, 'Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16 });
      throw new Error('the operation failed between steps');
    }),
    /between steps/
  );
  assert.deepEqual(types(contents), ['rawKeyDown', 'keyUp']);
});

test("the desktop host's endpoint latches: one kept across Off and On refuses, a new one works, a closed one refuses", async () => {
  let off = false;
  // The desktop's own switch as a command endpoint (`switchEndpoint`): its signal never aborts, so only the latch keeps Off.
  const command = switchEndpoint(new AbortController().signal, () => !off);
  const kept = rendererScope(command, 'type', () => {});
  off = true;
  assert.throws(() => kept.scope.commit(), /computer use is unavailable/);
  off = false;
  assert.throws(() => kept.scope.commit(), /computer use is unavailable/, 'the latch is read before the endpoint, which admits again');
  const contents = renderer();
  await assert.rejects(runRendererInput(contents, kept.scope, ({ insertText }) => insertText('old')));
  const fresh = rendererScope(command, 'type', () => {});
  await runRendererInput(contents, fresh.scope, ({ insertText }) => insertText('new'));
  fresh.close();
  assert.throws(() => fresh.scope.commit(), /endpoint is closed/);
  assert.ok(fresh.scope.signal.aborted);
  assert.deepEqual(contents.inserted, ['new']);
  kept.close();
});
