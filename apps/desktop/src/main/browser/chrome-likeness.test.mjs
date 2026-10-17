import assert from 'node:assert/strict';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

import { CHROME_LIKENESS_SCRIPT } from './chrome-likeness.ts';

/** A frame's world as the script meets it: the engine says `denied` for
 *  every permission nobody granted. */
function frame({
  secure = true,
  top = 'self',
  engineState = 'denied',
  chrome = {},
  refused = [],
  hostAnswers = true,
} = {}) {
  /** The host's side of the state question: `prompt` unless a person refused. */
  class XMLHttpRequest {
    open(_method, url) {
      this.url = new URL(url);
    }
    send() {
      if (!hostAnswers) throw new Error('blocked by the page CSP');
      const prompt = !refused.includes(this.url.searchParams.get('name'));
      this.responseText = JSON.stringify({ prompt });
    }
  }
  class PermissionStatus {
    constructor(name) {
      this._name = name;
    }
    get name() {
      return this._name;
    }
    get state() {
      return engineState;
    }
  }
  const Notification = function Notification() {};
  Object.defineProperty(Notification, 'permission', { get: () => engineState, configurable: true });
  const window = {
    isSecureContext: secure,
    location: { origin: 'https://site.test', href: 'https://site.test/app' },
    chrome,
    PermissionStatus,
    Notification,
    performance: {
      timeOrigin: 1_000_000,
      now: () => 42,
      getEntriesByType: () => [
        {
          type: 'navigate',
          responseStart: 100,
          domContentLoadedEventEnd: 300,
          loadEventEnd: 500,
          nextHopProtocol: 'h2',
        },
      ],
      getEntriesByName: () => [{ startTime: 200 }],
    },
  };
  window.top = top === 'self' ? window : top;
  runInNewContext(CHROME_LIKENESS_SCRIPT, { window, setTimeout, XMLHttpRequest, URL, URLSearchParams });
  return window;
}

test('window.chrome carries what Chrome carries, as native functions', () => {
  const { chrome } = frame();
  assert.deepEqual(Object.keys(chrome), ['loadTimes', 'csi', 'app']);
  for (const fn of [chrome.loadTimes, chrome.csi, chrome.app.getDetails]) {
    assert.equal(Function.prototype.toString.call(fn), 'function () { [native code] }');
  }
  assert.equal(chrome.loadTimes.name, '');
  assert.equal('prototype' in chrome.loadTimes, true);
  assert.deepEqual(Object.keys(chrome.app), [
    'isInstalled',
    'getDetails',
    'getIsInstalled',
    'installState',
    'runningState',
    'InstallState',
    'RunningState',
  ]);
  const times = chrome.loadTimes();
  assert.equal(times.startLoadTime, 1000);
  assert.equal(times.commitLoadTime, 1000.1);
  assert.equal(times.firstPaintTime, 1000.2);
  assert.equal(times.npnNegotiatedProtocol, 'h2');
  assert.equal(times.wasFetchedViaSpdy, true);
  assert.deepEqual({ ...chrome.csi() }, { startE: 1_000_000, onloadT: 1_000_300, pageT: 42, tran: 15 });
  assert.equal(chrome.app.runningState(), 'cannot_run');
});

test('an engine that grows its own window.chrome members keeps them', () => {
  const loadTimes = () => 'engine';
  assert.equal(frame({ chrome: { loadTimes } }).chrome.loadTimes, loadTimes);
});

test('a permission a person refused stays denied; only undecided ones read as prompt', () => {
  const read = (window, name) =>
    Reflect.get(window.PermissionStatus.prototype, 'state', new window.PermissionStatus(name));
  const page = frame({ refused: ['notifications', 'video_capture'] });
  assert.equal(read(page, 'notifications'), 'denied');
  assert.equal(page.Notification.permission, 'denied');
  assert.equal(read(page, 'video_capture'), 'denied');
  assert.equal(read(page, 'geolocation'), 'prompt', 'an undecided one still reads as prompt');
  const unanswered = frame({ hostAnswers: false });
  assert.equal(read(unanswered, 'geolocation'), 'denied', 'without the host the engine answer stands');
});

test("a permission nobody decided reads as Chrome's default only where Chrome would ask", () => {
  const read = (window, name) =>
    Reflect.get(window.PermissionStatus.prototype, 'state', new window.PermissionStatus(name));
  const page = frame();
  assert.equal(read(page, 'notifications'), 'prompt');
  assert.equal(read(page, 'video_capture'), 'prompt', 'the engine names camera video_capture');
  assert.equal(read(page, 'background-sync'), 'denied', 'a permission Chrome does not ask for keeps the engine answer');
  assert.equal(page.Notification.permission, 'default');
  const getter = Object.getOwnPropertyDescriptor(page.PermissionStatus.prototype, 'state').get;
  assert.equal(getter.name, 'get state');
  assert.equal(Function.prototype.toString.call(getter), 'function () { [native code] }');

  const granted = frame({ engineState: 'granted' });
  assert.equal(read(granted, 'notifications'), 'granted');
  assert.equal(granted.Notification.permission, 'granted');

  const insecure = frame({ secure: false });
  assert.equal(read(insecure, 'notifications'), 'denied');
  const crossOrigin = frame({
    top: {
      get location() {
        throw new Error('cross-origin');
      },
    },
  });
  assert.equal(read(crossOrigin, 'notifications'), 'denied');
  assert.equal(crossOrigin.Notification.permission, 'denied');
});
