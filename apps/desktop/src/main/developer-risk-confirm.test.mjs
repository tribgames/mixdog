import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { HOST_CONFIRM_SURFACE_IPC } from '../shared/host-confirm-surface.ts';
import { createAllowAllActionsConfirm, isAllowAllActionsEnable } from './developer-risk-confirm.ts';
import { hostConfirmPageUrl } from './host-confirm-page.ts';
import { beginComputerOperation } from './human-only-approval.ts';
import { HOST_EXTRAS_IPC, registerHostExtrasIpc } from './ipc-host-extras.ts';
const settle = () => new Promise((resolve) => setImmediate(resolve));

/** A webContents with its own scoped ipc and main frame. */
function fakeContents(name) {
  const contents = new EventEmitter();
  contents.ipc = new EventEmitter();
  contents.mainFrame = { name: `${name} main frame` };
  contents.isDestroyed = () => false;
  return contents;
}

/** Main's surface: hidden until presented; `load` is what loadURL resolves to. */
function fakeSurface(load) {
  const surface = new EventEmitter();
  surface.webContents = fakeContents('surface');
  let destroyed = false;
  let visible = false;
  surface.isDestroyed = () => destroyed;
  surface.destroy = () => {
    if (destroyed) return;
    destroyed = true;
    surface.emit('closed');
  };
  surface.isVisible = () => visible;
  surface.show = () => {
    visible = true;
  };
  surface.bounds = { x: 0, y: 0, width: 440, height: 200 };
  surface.getBounds = () => surface.bounds;
  surface.setBounds = (bounds) => {
    surface.bounds = bounds;
  };
  surface.loadURL = (url) => {
    surface.url = url;
    surface.webContents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
    return load();
  };
  return surface;
}

/** The asking app window and its confirmation; `open` overrides how a surface opens. */
function setup({ open, load = () => Promise.resolve() } = {}) {
  const parent = new EventEmitter();
  parent.webContents = fakeContents('app');
  parent.isDestroyed = () => false;
  parent.getContentBounds = () => ({ x: 100, y: 50, width: 1240, height: 800 });
  const surfaces = [];
  const confirm = createAllowAllActionsConfirm({
    window: parent,
    nativeT: (key) => key,
    openSurface:
      open ??
      (() => {
        const surface = fakeSurface(load);
        surfaces.push(surface);
        return surface;
      }),
  });
  const surface = () => surfaces.at(-1);
  const say = (contents, message, frame = contents.mainFrame) =>
    contents.ipc.emit(HOST_CONFIRM_SURFACE_IPC, { senderFrame: frame }, message);
  const answer = (accepted) => say(surface().webContents, { type: 'answer', accepted });
  return { parent, surfaces, surface, confirm, say, answer };
}

/** Whether `pending` is still unsettled after the queue drained. */
async function stillOpen(pending) {
  let done = false;
  void pending.then(() => {
    done = true;
  });
  await settle();
  return !done;
}

/** The lock is free: Computer Use may start again. */
const lockFree = () => assert.doesNotThrow(() => beginComputerOperation()());

test('only turning ON allowAllActions needs the person', () => {
  assert.equal(isAllowAllActionsEnable('setDeveloperOption', ['allowAllActions', true]), true);
  assert.equal(isAllowAllActionsEnable('setDeveloperOption', ['allowAllActions', false]), false);
  assert.equal(isAllowAllActionsEnable('setDeveloperOption', ['cursorOAuth', true]), false);
  assert.equal(isAllowAllActionsEnable('getDeveloperSettings', ['allowAllActions', true]), false);
  assert.equal(isAllowAllActionsEnable('setDeveloperOption', []), false);
});

test("the surface's static page: Cancel first and focused, danger action, no script", async () => {
  const t = setup();
  const pending = t.confirm();
  await settle();
  const html = decodeURIComponent(t.surface().url.replace(/^data:text\/html;charset=utf-8,/, ''));
  assert.ok(html.includes('<h3 id="title">Allow all actions</h3>'));
  assert.ok(
    html.includes(
      'Turning this on lets agents act without asking you first, except for payments and permanent deletes. Use it only if you accept that risk.'
    )
  );
  assert.ok(html.indexOf('id="cancel" type="button" autofocus>Cancel<') < html.indexOf('id="accept"'));
  assert.ok(html.includes('id="accept" type="button" class="danger">Accept risk and turn on<'));
  assert.ok(html.includes(`content="default-src 'none'; style-src 'unsafe-inline'"`));
  assert.ok(!/<script/i.test(html));
  t.answer(false);
  assert.equal(await pending, false);
  const hostile = decodeURIComponent(
    hostConfirmPageUrl({ title: '<img src=x>', description: '"&', confirmLabel: 'a', cancelLabel: 'b', danger: true })
  );
  assert.ok(!hostile.includes('<img') && hostile.includes('&#60;img'));
});

test('the surface shows over the asking window once measured, or at its default height once loaded', async () => {
  const t = setup();
  const pending = t.confirm();
  await settle();
  assert.equal(t.surface().isVisible(), false, 'hidden until laid out');
  t.say(t.surface().webContents, { type: 'size', height: 231.2 });
  assert.equal(t.surface().isVisible(), true);
  assert.deepEqual(t.surface().bounds, { x: 500, y: 334, width: 440, height: 232 });
  t.answer(false);
  await pending;

  const unmeasured = t.confirm();
  await settle();
  t.surface().webContents.emit('did-finish-load');
  assert.equal(t.surface().isVisible(), true);
  t.answer(false);
  await unmeasured;
});

test('a scripted true from the app renderer, after any unrelated input, is refused; only the surface answers', async () => {
  const t = setup();
  const pending = t.confirm();
  await settle();
  const app = t.parent.webContents;
  app.emit('before-mouse-event', {}, { type: 'mouseUp', button: 'right' });
  app.emit('before-input-event', {}, { type: 'keyDown', key: 'Enter' });
  // The app renderer's own channel, and its frame posing on the surface's channel.
  t.say(app, { type: 'answer', accepted: true });
  t.say(t.surface().webContents, { type: 'answer', accepted: true }, app.mainFrame);
  // A frame inside the surface other than its main frame.
  t.say(t.surface().webContents, { type: 'answer', accepted: true }, { name: 'subframe' });
  assert.equal(await stillOpen(pending), true, 'none of those answers it');
  // The window's IPC has no route for an answer at all.
  const handlers = new Map();
  registerHostExtrasIpc({
    handle: (channel, handler) => handlers.set(channel, handler),
    removeHandler: () => {},
    host: { invokeCapability: async () => ({}) },
    confirmAllowAllActions: async () => false,
    signInFocus: null,
  });
  assert.deepEqual([...handlers.keys()].sort(), Object.values(HOST_EXTRAS_IPC).sort());
  assert.ok(![...handlers.keys()].some((channel) => /confirm|answer/i.test(channel)));
  t.answer(true);
  assert.equal(await pending, true, "the surface's own yes is taken");
  assert.equal(t.surface().isDestroyed(), true, 'the surface closes with the answer');
  t.answer(false);
  lockFree();
});

test('while the question is open Computer Use is refused, so it cannot answer it; an agent op in flight goes first', async () => {
  const t = setup();
  const release = beginComputerOperation();
  const pending = t.confirm();
  await settle();
  assert.equal(t.surfaces.length, 0, 'not opened while Computer Use is mid-operation');
  assert.throws(() => beginComputerOperation(), /human-only approval is pending/, 'no new operation queues behind it');
  release();
  await settle();
  assert.equal(t.surfaces.length, 1);
  assert.throws(() => beginComputerOperation(), /human-only approval is pending/, 'refused while the question is open');
  t.answer(false);
  assert.equal(await pending, false, 'Cancel or Escape does not turn it on');
  lockFree();
});

test('an undeliverable question is a no and releases the lock', async (t) => {
  await t.test('the surface cannot be created', async () => {
    const s = setup({
      open: () => {
        throw new Error('no window');
      },
    });
    assert.equal(await s.confirm(), false);
    lockFree();
  });
  await t.test('its page cannot load', async () => {
    const s = setup({ load: () => Promise.reject(new Error('ERR_FAILED')) });
    assert.equal(await s.confirm(), false);
    assert.equal(s.surface().isDestroyed(), true);
    lockFree();
  });
  const cases = [
    ['its preload fails', (s) => s.surface().webContents.emit('preload-error')],
    ['it crashes', (s) => s.surface().webContents.emit('render-process-gone')],
    [
      'it reloads after its own page loaded',
      (s) => s.surface().webContents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false }),
    ],
    ['it hangs', (s) => s.surface().emit('unresponsive')],
    ['it is closed', (s) => s.surface().destroy()],
    [
      'the app window reloads',
      (s) => s.parent.webContents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false }),
    ],
    ['the app renderer crashes', (s) => s.parent.webContents.emit('render-process-gone')],
    ['the app window closes', (s) => s.parent.emit('closed')],
  ];
  for (const [name, end] of cases) {
    await t.test(name, async () => {
      const s = setup();
      const pending = s.confirm();
      await settle();
      end(s);
      assert.equal(await pending, false);
      assert.equal(s.surface().isDestroyed(), true);
      lockFree();
    });
  }
  await t.test('an in-page navigation of the app window does not end it', async () => {
    const s = setup();
    const pending = s.confirm();
    await settle();
    s.parent.webContents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true });
    assert.equal(await stillOpen(pending), true);
    s.answer(false);
    await pending;
  });
  const abandons = [
    ['reloads', (s) => s.parent.webContents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })],
    ['loses its renderer', (s) => s.parent.webContents.emit('render-process-gone')],
  ];
  for (const [name, abandon] of abandons) {
    await t.test(`the app window ${name} while the surface is still opening`, async () => {
      let opened = () => {};
      const late = fakeSurface(() => Promise.resolve());
      const s = setup({
        open: () =>
          new Promise((resolve) => {
            opened = () => resolve(late);
          }),
      });
      const pending = s.confirm();
      await settle();
      abandon(s);
      assert.equal(await pending, false, 'declined at once, before the surface exists');
      lockFree();
      opened();
      await settle();
      assert.equal(late.isDestroyed(), true, 'the surface returned afterwards is closed unused');
      assert.equal(late.url, undefined, 'and never loads the question');
      s.say(late.webContents, { type: 'answer', accepted: true });
    });
  }
  await t.test('the app window was already gone', async () => {
    const s = setup();
    s.parent.isDestroyed = () => true;
    assert.equal(await s.confirm(), false);
    assert.equal(s.surfaces.length, 0);
    lockFree();
  });
});

/** The window's IPC with the real confirmation. */
function windowHost(confirmAllowAllActions) {
  const handlers = new Map();
  const calls = [];
  registerHostExtrasIpc({
    handle: (channel, handler) => handlers.set(channel, handler),
    removeHandler: (channel) => handlers.delete(channel),
    host: {
      invokeCapability: async (capability, args) => {
        calls.push([capability, args]);
        return { value: capability };
      },
    },
    confirmAllowAllActions,
    prepareConfirmedAllowAllActions: () => async () => calls.push(['applyConfirmedAllowAllActions', []]),
    signInFocus: null,
  });
  return { calls, enable: () => handlers.get(HOST_EXTRAS_IPC.enableAllowAllActions)({}) };
}

test('declining leaves the option off; only the surface yes is applied, by main', async () => {
  const t = setup();
  const wired = windowHost(t.confirm);
  let enabling = wired.enable();
  await settle();
  t.say(t.parent.webContents, { type: 'answer', accepted: true });
  t.answer(false);
  await enabling;
  assert.deepEqual(wired.calls, [['getDeveloperSettings', []]]);

  enabling = wired.enable();
  await settle();
  t.answer(true);
  await enabling;
  assert.deepEqual(wired.calls.slice(1), [
    ['applyConfirmedAllowAllActions', []],
    ['getDeveloperSettings', []],
  ]);
});
