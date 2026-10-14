import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { createBrowserDisplayTracking } from './display-tracking.ts';

function fakeGuest() {
  const guest = new EventEmitter();
  guest.throttled = undefined;
  guest.isDestroyed = () => false;
  guest.isOffscreen = () => false;
  guest.setBackgroundThrottling = (value) => {
    guest.throttled = value;
  };
  return guest;
}

function fixture() {
  const guest = fakeGuest();
  const sessions = {
    sessionIdForGuest: (candidate) => (candidate === guest ? 's' : undefined),
    currentGuest: (sessionId) => (sessionId === 's' ? guest : null),
    visibleGuests: (sessionId) => (sessionId === 's' ? [guest] : []),
    backgroundPages: () => new Map(),
  };
  return { guest, display: createBrowserDisplayTracking(sessions) };
}

test('a panel report runs the page until it is withdrawn or the page dies', () => {
  const { guest, display } = fixture();
  display.track(guest);
  assert.equal(guest.throttled, true);
  display.setPanelActive(guest, true);
  assert.equal(guest.throttled, false);
  guest.emit('destroyed');
  assert.equal(display.power.isActive(guest), false);
});

test('native and remote displays run the session page until released', () => {
  const { guest, display } = fixture();
  display.track(guest);
  display.setNativeShown('s', guest);
  assert.equal(guest.throttled, false);
  display.setNativeShown('s', null);
  assert.equal(guest.throttled, true);
  display.setRemoteViewing('s', true);
  assert.equal(display.isRemoteViewing('s'), true);
  assert.equal(guest.throttled, false);
  display.release('s');
  assert.equal(display.isRemoteViewing('s'), false);
  assert.equal(display.power.isActive(guest), false);
});
