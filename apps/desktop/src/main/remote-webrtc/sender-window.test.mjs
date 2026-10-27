// The live-view sender window main creates: on its own non-persistent session
// partition, with that session's permission handlers installed before the page
// loads, and the page's isolation and navigation denials kept.
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

const windows = [];
const sessions = new Map();

function fakeSession(partition) {
  const handlers = {};
  return {
    partition,
    handlers,
    setPermissionCheckHandler: (handler) => (handlers.check = handler),
    setPermissionRequestHandler: (handler) => (handlers.request = handler),
    setDevicePermissionHandler: (handler) => (handlers.device = handler),
    webRequest: { onHeadersReceived: (handler) => (handlers.headers = handler) },
  };
}

class FakeWindow {
  constructor(options) {
    this.options = options;
    this.destroyed = false;
    this.handlers = new Map();
    this.sent = [];
    this.denyOpen = null;
    this.webContents = {
      id: windows.length + 1,
      ipc: { on: () => undefined },
      on: (name, listener) => this.handlers.set(`contents:${name}`, listener),
      setWindowOpenHandler: (handler) => (this.denyOpen = handler),
      send: (channel, payload) => this.sent.push([channel, payload]),
    };
    windows.push(this);
  }
  on(name, listener) {
    this.handlers.set(name, listener);
  }
  isDestroyed() {
    return this.destroyed;
  }
  destroy() {
    this.destroyed = true;
  }
  loadFile(file) {
    this.loaded = file;
    return Promise.resolve();
  }
  loadURL(url) {
    this.loaded = url;
    return Promise.resolve();
  }
}

globalThis.__senderWindowElectron = {
  BrowserWindow: FakeWindow,
  session: {
    fromPartition(partition) {
      if (!sessions.has(partition)) sessions.set(partition, fakeSession(partition));
      return sessions.get(partition);
    },
  },
};
registerHooks({
  resolve(specifier, context, next) {
    return specifier === 'electron'
      ? {
          url:
            'data:text/javascript,export const BrowserWindow=globalThis.__senderWindowElectron.BrowserWindow;' +
            'export const session=globalThis.__senderWindowElectron.session;' +
            'export const app={getAppPath:()=>"/app"};',
          shortCircuit: true,
        }
      : next(specifier, context);
  },
});

const { createRemoteWebrtcSenderWindow } = await import('./sender-window.ts');
const { REMOTE_WEBRTC_SENDER_PARTITION, remoteWebrtcSenderPageUrl } = await import('./sender-session.ts');

const page = { file: '/app/out/renderer/remote-webrtc-sender.html' };
const ask = (target, contents, permission, details) => {
  let answer;
  target.handlers.request(contents, permission, (value) => (answer = value), details);
  return answer;
};

test('the sender window runs on its own non-persistent partition with the capture policy installed', () => {
  windows.length = 0;
  sessions.clear();
  const bridge = createRemoteWebrtcSenderWindow(page);
  assert.equal(windows.length, 0, 'nothing opens before the first command');
  bridge.send({ type: 'source-draw', sourceKey: 'screen:1' });
  assert.equal(windows.length, 1);

  const preferences = windows[0].options.webPreferences;
  assert.equal(REMOTE_WEBRTC_SENDER_PARTITION.startsWith('persist:'), false);
  assert.equal(preferences.partition, REMOTE_WEBRTC_SENDER_PARTITION);
  assert.equal(preferences.contextIsolation, true);
  assert.equal(preferences.sandbox, true);
  assert.equal(preferences.nodeIntegration, false);
  assert.deepEqual([...sessions.keys()], [REMOTE_WEBRTC_SENDER_PARTITION], 'only that partition is touched');
  assert.deepEqual(windows[0].denyOpen(), { action: 'deny' });

  const target = sessions.get(REMOTE_WEBRTC_SENDER_PARTITION);
  const contents = windows[0].webContents;
  const video = { mediaTypes: ['video'], requestingUrl: remoteWebrtcSenderPageUrl(page), isMainFrame: true };
  assert.equal(ask(target, contents, 'media', video), true);
  assert.equal(ask(target, contents, 'media', { ...video, mediaTypes: ['video', 'audio'] }), false);
  assert.equal(ask(target, contents, 'clipboard-sanitized-write', video), false);
  assert.equal(ask(target, { id: 99 }, 'media', video), false, 'another window is refused');
  assert.equal(target.handlers.check(contents, 'media', 'file://', {}), false);
  assert.equal(target.handlers.headers, undefined, 'the built page carries its CSP in the document, not a header');
  bridge.dispose();
});

test('a recreated sender window is the one the policy trusts', () => {
  windows.length = 0;
  sessions.clear();
  const bridge = createRemoteWebrtcSenderWindow(page);
  bridge.send({ type: 'source-draw', sourceKey: 'screen:1' });
  const first = windows[0];
  first.handlers.get('contents:render-process-gone')();
  assert.equal(first.destroyed, true);
  bridge.send({ type: 'source-draw', sourceKey: 'screen:1' });
  const second = windows[1];
  assert.notEqual(second, first);
  const target = sessions.get(REMOTE_WEBRTC_SENDER_PARTITION);
  const video = { mediaTypes: ['video'], requestingUrl: remoteWebrtcSenderPageUrl(page), isMainFrame: true };
  assert.equal(ask(target, second.webContents, 'media', video), true);
  assert.equal(ask(target, first.webContents, 'media', video), false);
  bridge.dispose();
});
