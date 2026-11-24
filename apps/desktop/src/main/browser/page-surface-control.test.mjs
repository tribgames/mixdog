import assert from 'node:assert/strict';
import test from 'node:test';

import { engineLane } from '../host/browser-engine/engine-lane.test-helper.mjs';
import { createBrowserCdpCalls } from './cdp-calls.ts';
import { BrowserGuestStateStore, browserDocumentId } from './host-state.ts';
import { createPageInputDispatcher } from './page-surface-control.ts';

/** A person's pane on one page: `onSend` sees every event before the page takes it. */
function personPane(onSend = () => {}) {
  const state = new BrowserGuestStateStore();
  const page = { isDestroyed: () => false };
  const dispatch = createPageInputDispatcher({
    state,
    cdp: { waitForIdle: async () => {} },
    urlPolicy: {},
    assertUrl: async () => {},
    dispatchInput: async (target, method, params, _signal, guard) => {
      guard();
      onSend({ state, page, method, params });
    },
  });
  const input = (action) => {
    const documentId = browserDocumentId(state, page);
    return dispatch(page, { documentId, ...action }, () => {
      if (browserDocumentId(state, page) !== documentId) throw new Error('Browser page changed; input was not sent.');
    });
  };
  return { state, page, input, held: () => state.holdsUnfinishedWork(page, false) };
}

const press = { type: 'pointer', phase: 'mousePressed', x: 1, y: 1, button: 'left', buttons: 1, modifiers: 0, clickCount: 1 };

test("text a person typed, pasted or composed holds the page once the page took it", async () => {
  for (const action of [
    { type: 'text', text: 'hi' },
    { type: 'key', key: 'a' },
    { type: 'key', key: 'Backspace' },
    { type: 'key', key: 'Control+v' },
    { type: 'composition-end', text: '한' },
  ]) {
    const pane = personPane();
    await pane.input(action);
    assert.equal(pane.held(), true, JSON.stringify(action));
  }
});

test('a click, a navigation key or an unfinished composition holds nothing', async () => {
  for (const action of [
    press,
    { type: 'key', key: 'ArrowDown' },
    { type: 'key', key: 'Escape' },
    { type: 'composition', text: '하', selectionStart: 1, selectionEnd: 1 },
    { type: 'wheel', x: 1, y: 1, deltaX: 0, deltaY: 40 },
  ]) {
    const pane = personPane();
    await pane.input(action);
    assert.equal(pane.held(), false, JSON.stringify(action));
    if (action === press) assert.equal(pane.state.for(pane.page).userInput, true, 'the press is still the person’s');
  }
});

test('an edit the page never took holds nothing: refused, revoked or blocked', async () => {
  const refused = personPane(() => {
    throw new Error('Browser input expired; input was not sent.');
  });
  await assert.rejects(refused.input({ type: 'text', text: 'hi' }), /expired/);
  assert.equal(refused.held(), false);

  // The page moved on before the key's events went out.
  const revoked = personPane();
  const sending = revoked.input({ type: 'key', key: 'a' });
  revoked.state.beginDocument(revoked.page);
  await assert.rejects(sending, /page changed/);
  assert.equal(revoked.held(), false);

  const blocked = personPane();
  blocked.state.for(blocked.page).pendingDialog = { type: 'alert', message: '', openedAt: 0 };
  await assert.rejects(blocked.input({ type: 'text', text: 'hi' }), /dialog is blocking/);
  blocked.state.for(blocked.page).pendingDialog = null;
  assert.equal(blocked.held(), false);
});

test("the person's and the agent's input over the same CDP transport, even at once, each count only as their own", async () => {
  const state = new BrowserGuestStateStore();
  let scrolled;
  const scrolling = new Promise((resolve) => (scrolled = resolve));
  const calls = createBrowserCdpCalls({
    state,
    sendCdp: async (_guest, _cdp, _method, params, _timeout, _signal, _session, beforeDispatch) => {
      beforeDispatch?.();
      // A phone's scroll still on its way to the page.
      if (params.type === 'mouseWheel') await scrolling;
    },
    guestDebugger: async () => ({}),
  });
  const page = {
    isDestroyed: () => false,
    isOffscreen: () => false,
    getZoomFactor: () => 1,
    getURL: () => 'https://a.example/',
  };
  const dispatch = createPageInputDispatcher({
    state,
    cdp: { waitForIdle: async () => {}, guestDebugger: async () => ({}), sendCdpInput: calls.sendCdpInput },
    urlPolicy: {},
    assertUrl: async () => {},
  });
  const agent = engineLane({ state, cdp: { sendCdpInput: calls.sendCdpInput } });
  const person = (action) => dispatch(page, { documentId: browserDocumentId(state, page), ...action }, () => {});

  const wheel = person({ type: 'wheel', x: 1, y: 1, deltaX: 0, deltaY: 40 });
  await new Promise(setImmediate);
  assert.equal((await agent.input(page, [{ op: 'type', text: 'Ada' }])).outcome, 'completed');
  scrolled();
  await wheel;
  assert.equal(state.for(page).agentEdits, true, 'the person’s scroll meanwhile takes nothing from the agent’s edit');
  assert.equal(state.for(page).userEdits, false, 'the agent’s typing is never the person’s');

  const other = { ...page };
  for (const action of [
    { type: 'text', text: 'mine' },
    { type: 'key', key: 'Backspace' },
  ]) {
    await dispatch(other, { documentId: browserDocumentId(state, other), ...action }, () => {});
  }
  assert.equal(state.for(other).userEdits, true);
  assert.equal(state.for(other).agentEdits, false, 'a person’s typing is never the agent’s');
});

test('an edit that went with a document replaced while it was sent holds nothing in the new one', async () => {
  const pane = personPane(({ state, page }) => {
    state.beginDocument(page);
    state.commitDocument(page);
  });
  await pane.input({ type: 'text', text: 'hi' });
  assert.equal(pane.held(), false);
});
