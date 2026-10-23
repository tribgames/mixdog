import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { BrowserGuestStateStore } from './guest-state.ts';
import { watchPageFaults } from './page-faults.ts';
import { handleWindowOpens } from './popup-opening.ts';

const fakeGuest = (url = 'https://example.test/') => {
  const guest = new EventEmitter();
  guest.id = Math.random();
  guest.getURL = () => url;
  guest.setWindowOpenHandler = (handler) => {
    guest.openHandler = handler;
  };
  return guest;
};

test('a failed main-frame load is a fault until the next main-frame navigation', () => {
  const state = new BrowserGuestStateStore();
  const guest = fakeGuest();
  watchPageFaults(state, guest);
  guest.emit('did-fail-load', {}, -3, 'ABORTED', 'https://example.test/', true);
  assert.equal(state.for(guest).fault, '');
  guest.emit('did-fail-load', {}, -105, 'NAME_NOT_RESOLVED', 'https://example.test/', false);
  assert.equal(state.for(guest).fault, '');
  guest.emit('did-fail-load', {}, -105, 'NAME_NOT_RESOLVED', 'https://example.test/', true);
  assert.match(state.for(guest).fault, /^page failed to load: NAME_NOT_RESOLVED \(-105\) /);
  // The error document finishing keeps the failure.
  guest.emit('did-finish-load');
  assert.match(state.for(guest).fault, /^page failed to load: /);
  guest.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true });
  assert.match(state.for(guest).fault, /^page failed to load: /);
  guest.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
  assert.equal(state.for(guest).fault, '');
  guest.emit('unresponsive');
  assert.equal(state.for(guest).fault, 'page became unresponsive');
  guest.emit('responsive');
  assert.equal(state.for(guest).fault, '');
});

test('a main-frame load after a crash clears the fault and the crash flag', () => {
  const state = new BrowserGuestStateStore();
  const guest = fakeGuest();
  watchPageFaults(state, guest);
  guest.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 5 });
  assert.equal(state.for(guest).crashed, true);
  assert.equal(state.for(guest).fault, 'renderer crashed (exit 5)');
  // Not recovered yet: the next command still reloads it.
  guest.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
  assert.equal(state.for(guest).crashed, true);
  guest.emit('did-finish-load');
  assert.equal(state.for(guest).fault, '');
  assert.equal(state.for(guest).crashed, false);
  assert.equal(state.takeCrashed(guest), false);
});

const openingHost = (state, overrides = {}) => {
  const adopted = [];
  return {
    adopted,
    host: {
      state,
      urlPolicy: {},
      backgroundCount: () => 0,
      reclaimIdle: () => {},
      nativeView: () => false,
      popupWindowOptions: (native) => ({ native }),
      createPage: () => assert.fail('a non-native popup is created by Electron'),
      adoptWindow: (child) => child.window,
      adoptPopup: (opener, popup, select) => adopted.push({ opener, popup, select }),
      ...overrides,
    },
  };
};

test('window.open is allowed with popup options and the created window is adopted', () => {
  const state = new BrowserGuestStateStore();
  const guest = fakeGuest();
  const { host, adopted } = openingHost(state);
  handleWindowOpens(guest, host);
  const answer = guest.openHandler({ url: 'https://example.test/next', disposition: 'background-tab' });
  assert.deepEqual(answer, { action: 'allow', outlivesOpener: true, overrideBrowserWindowOptions: { native: false } });
  const child = { window: 'child-window', webContents: 'child-guest' };
  guest.emit('did-create-window', child, { url: 'https://example.test/next' });
  assert.deepEqual(adopted, [
    { opener: guest, popup: { window: 'child-window', guest: 'child-guest' }, select: false },
  ]);
});

test('window.open is denied and recorded once tab capacity is gone', () => {
  const state = new BrowserGuestStateStore();
  const guest = fakeGuest();
  const { host } = openingHost(state, { backgroundCount: () => 10_000 });
  handleWindowOpens(guest, host);
  assert.deepEqual(guest.openHandler({ url: 'about:blank', disposition: 'new-window' }), { action: 'deny' });
  assert.match(state.for(guest).networkFailures.at(-1), /^Blocked popup navigation: /);
});
