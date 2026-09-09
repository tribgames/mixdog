import assert from 'node:assert/strict';
import test from 'node:test';
import { BrowserGuestStateStore } from './guest-state.ts';
import { createBrowserRemoteControl } from './remote-control.ts';

function fixture() {
  const state = new BrowserGuestStateStore();
  const calls = [];
  let pixels = 'first image';
  let revision = 'first revision';
  let guest = {
    getURL: () => 'https://fixture.example/',
    getTitle: () => 'Fixture',
    isDestroyed: () => false,
    isLoadingMainFrame: () => false,
    navigationHistory: { canGoBack: () => false, canGoForward: () => false },
  };
  const cdp = {
    waitForInitialDocument: async () => {},
    guestDebugger: async () => ({}),
    sendCdpInput: async (_guest, _debugger, method, params) => { calls.push({ method, params }); },
  };
  const remote = createBrowserRemoteControl({
    state, cdp,
    ensureGuest: async () => guest,
    revision: async () => revision,
    captureScreenshot: async () => ({ data: pixels, width: 100, height: 50, mimeType: 'image/jpeg' }),
  });
  return {
    state, calls, cdp, remote,
    guest: () => guest,
    changeImage: () => { pixels = 'blinking caret'; revision = 'typed value'; },
    replaceGuest: () => { guest = { ...guest }; },
  };
}

test('remote text and keys continue through changing pixels and consumed image frames', async () => {
  const f = fixture();
  const frame = await f.remote.remoteBrowserFrame('s');
  const identity = { frameId: frame.frameId, documentId: frame.documentId };
  f.changeImage();
  f.state.invalidateInteraction(f.guest());
  for (const text of ['a', '@', '한']) {
    await f.remote.remoteBrowserControl('s', { type: 'text', text, ...identity });
  }
  await f.remote.remoteBrowserControl('s', { type: 'key', key: 'Backspace', ...identity });
  assert.deepEqual(f.calls.filter((call) => call.method === 'Input.insertText').map((call) => call.params.text), ['a', '@', '한']);
  assert.ok(f.calls.some((call) => call.method === 'Input.dispatchKeyEvent' && call.params.key === 'Backspace'));
  const next = await f.remote.remoteBrowserFrame('s');
  assert.equal(next.documentId, frame.documentId);
});

test('remote keyboard input from an old page, destroyed page, crash, or dialog is never sent', async () => {
  for (const change of [
    (f) => f.state.beginDocument(f.guest()),
    (f) => f.replaceGuest(),
    (f) => { f.guest().isDestroyed = () => true; },
    (f) => f.state.markCrashed(f.guest(), 'renderer gone'),
    (f) => { f.state.for(f.guest()).pendingDialog = { type: 'alert' }; },
  ]) {
    const f = fixture();
    const frame = await f.remote.remoteBrowserFrame('s');
    change(f);
    await assert.rejects(f.remote.remoteBrowserControl('s', {
      type: 'text', text: 'not sent', frameId: frame.frameId, documentId: frame.documentId,
    }), /page changed|dialog is blocking/);
    assert.deepEqual(f.calls, []);
  }
});

test('navigation during keyboard attachment and during frame capture cannot retarget input', async () => {
  const f = fixture();
  const frame = await f.remote.remoteBrowserFrame('s');
  f.cdp.guestDebugger = async () => { f.state.beginDocument(f.guest()); return {}; };
  await assert.rejects(f.remote.remoteBrowserControl('s', {
    type: 'text', text: 'not sent', frameId: frame.frameId, documentId: frame.documentId,
  }), /page changed/);
  assert.deepEqual(f.calls, []);

  const remote = createBrowserRemoteControl({
    state: f.state, cdp: f.cdp, ensureGuest: async () => f.guest(),
    captureScreenshot: async () => {
      f.state.beginDocument(f.guest());
      return { data: 'same pixels', width: 100, height: 50, mimeType: 'image/jpeg' };
    },
  });
  await assert.rejects(remote.remoteBrowserFrame('s'), /changed during capture/);
});
