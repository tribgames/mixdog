import assert from 'node:assert/strict';
import test from 'node:test';
import { createBrowserPageSurface } from './page-surface.ts';

function surfaceWith(touched) {
  const record = { documentGeneration: 1 };
  const guest = { isDestroyed: () => false, copy() {} };
  return createBrowserPageSurface({
    ensureGuest: async () => guest,
    currentGuest: () => guest,
    userTouched: (sessionId, page) => touched.push([sessionId, page === guest]),
    state: { pageId: () => 'p1', for: () => record, invalidateInteraction() {} },
    cdp: { waitForIdle: async () => {}, guestDebugger: async () => ({}) },
  });
}

test("a person's address on a fresh tab loads only once the page's debugger and first document are up", async () => {
  // A new tab still committing its blank document: navigating it then lets
  // the debugger attach mid-navigation, and Chromium's renderer crashes.
  const attached = Promise.withResolvers();
  const loads = [];
  const record = { documentGeneration: 1 };
  const guest = {
    isDestroyed: () => false,
    loadURL: async (url) => {
      loads.push(url);
    },
  };
  const surface = createBrowserPageSurface({
    ensureGuest: async () => guest,
    currentGuest: () => guest,
    state: { pageId: () => 'p1', for: () => record, invalidateInteraction() {} },
    cdp: { waitForIdle: async () => {}, guestDebugger: () => attached.promise },
    urlPolicy: { allowPrivateNetwork: true },
    assertUrl: async () => {},
  });
  const navigating = surface.control('owner', { documentId: 'p1:1', type: 'navigate', url: 'https://pay.example/' });
  for (let turn = 0; turn < 25; turn += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(loads, [], 'not dispatched while the debugger is still attaching');
  attached.resolve({});
  await navigating;
  assert.deepEqual(loads, ['https://pay.example/']);
});

test("a person's new press or key supersedes an earlier dialog answer as the gesture behind a window", async () => {
  // Answered an alert, then clicked a button that opens one window now and
  // another from a timer: only the click's own (Chromium) gesture counts.
  const record = { documentGeneration: 1, personDialogAnswerAt: Date.now() };
  const guest = { isDestroyed: () => false };
  const surface = createBrowserPageSurface({
    ensureGuest: async () => guest,
    currentGuest: () => guest,
    state: { pageId: () => 'p1', for: () => record, invalidateInteraction() {} },
    cdp: { waitForIdle: async () => {}, guestDebugger: async () => ({}) },
  });
  await surface
    .control('owner', {
      documentId: 'p1:1',
      type: 'pointer',
      phase: 'mousePressed',
      x: 1,
      y: 1,
      button: 'left',
      buttons: 1,
      modifiers: 0,
      clickCount: 1,
    })
    .catch(() => {});
  assert.equal(record.actor, 'person');
  assert.equal(record.personDialogAnswerAt, undefined);
});

test('a human key, text or press in the page claims it; hover and wheel do not', async () => {
  const touched = [];
  const surface = surfaceWith(touched);
  const run = (input) => surface.control('owner', { documentId: 'p1:1', ...input }).catch(() => {});
  await run({ type: 'key', key: 'Control+c' });
  await run({ type: 'text', text: 'a' });
  await run({
    type: 'pointer',
    phase: 'mousePressed',
    x: 1,
    y: 1,
    button: 'left',
    buttons: 1,
    modifiers: 0,
    clickCount: 1,
  });
  assert.equal(touched.length, 3);
  assert.deepEqual(touched[0], ['owner', true]);
  // An address typed into the bar counts even when the load is refused.
  await run({ type: 'navigate', url: 'chrome://nothing' });
  assert.equal(touched.length, 4);
  touched.pop();
  await run({
    type: 'pointer',
    phase: 'mouseMoved',
    x: 1,
    y: 1,
    button: 'none',
    buttons: 0,
    modifiers: 0,
    clickCount: 0,
  });
  await run({ type: 'wheel', x: 1, y: 1, deltaX: 0, deltaY: 10 });
  assert.equal(touched.length, 3);
});
