// The live-view sender window main creates: on its own non-persistent session
// partition, with that session's permission handlers installed before the page
// loads, and the page's isolation and navigation denials kept.
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

import { REMOTE_WEBRTC_VERSION } from '../../shared/remote-webrtc.ts';
import { REMOTE_WEBRTC_SENDER_IPC } from '../../shared/remote-webrtc-sender.ts';
import { createRemoteWebrtcHost } from './host.ts';

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
      ipc: { on: (name, listener) => this.handlers.set(`ipc:${name}`, listener) },
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
    this.handlers.get('closed')?.();
  }
  emitSender(event) {
    this.handlers.get(`ipc:${REMOTE_WEBRTC_SENDER_IPC.event}`)(null, event);
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

test('the last viewer releases the sender, and a later viewer gets a clean capture and negotiation', async (t) => {
  windows.length = 0;
  sessions.clear();
  const sender = createRemoteWebrtcSenderWindow(page);
  const source = { kind: 'screen', screenId: '1' };
  const geometry = {
    generation: 1,
    cssWidth: 400,
    cssHeight: 300,
    deviceScaleFactor: 1,
    pixelWidth: 400,
    pixelHeight: 300,
  };
  const plan = { sourceId: 'screen:1:0', width: 400, height: 300, maxFrameRate: 30 };
  let stops = 0;
  const host = createRemoteWebrtcHost({
    sender,
    sendSignal: async () => {},
    sources: () => ({
      source,
      start() {},
      stop: () => {
        stops += 1;
      },
      page: () => ({ documentId: null, geometry }),
      dispatch: async () => {},
      capturePlan: () => plan,
    }),
    report() {},
  });
  t.after(() => {
    host.dispose();
    sender.dispose();
  });
  const ready = { v: REMOTE_WEBRTC_VERSION, source, type: 'ready', receiveCodecs: ['video/VP8'] };
  const sourceKey = 'screen:1';

  await host.signal('c1', ready, []);
  await host.signal('c2', ready, []);
  assert.equal(windows.length, 1);
  const first = windows[0];
  host.viewerLeft('c1', sourceKey);
  await host.signal('c1', { v: REMOTE_WEBRTC_VERSION, source, type: 'geometry-ack', geometryGeneration: 1 });
  assert.equal(first.destroyed, false, 'the other viewer is still negotiating');
  assert.equal(stops, 0, 'the other viewer still needs capture');
  host.viewerLeft('c2', sourceKey);
  assert.equal(first.destroyed, true, 'the last viewer left before the sender was ready');
  assert.equal(stops, 1);

  await host.signal('c2', ready, []);
  assert.equal(windows.length, 2);
  const second = windows[1];
  first.emitSender({ type: 'ready' });
  assert.deepEqual(first.sent, []);
  assert.deepEqual(second.sent, [], 'only the new renderer can declare itself ready');
  second.emitSender({ type: 'ready' });
  const commands = second.sent.map(([, command]) => command);
  assert.deepEqual(
    commands.map(({ type }) => type),
    ['source-capture', 'open']
  );
  assert.deepEqual(commands[0].plan, plan);

  const close = {
    ...ready,
    type: 'close',
    reason: 'viewer-left',
    connectionId: commands[1].connectionId,
    generation: 1,
  };
  await host.signal('c2', close);
  assert.equal(second.destroyed, true);
  await host.signal('c2', close); // A duplicate close must not leave a phantom viewer.
  await host.signal('c3', ready, []);
  host.geometryChanged(sourceKey, null);
  assert.equal(windows[2].destroyed, true, 'ending the source releases the sender too');
});
