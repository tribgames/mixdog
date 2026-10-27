import assert from 'node:assert/strict';
import test from 'node:test';

import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { installTestDom } from './test-support/test-dom.mjs';

installTestDom(null, {
  html: '<!doctype html><html><body></body></html>',
  jsdom: { url: 'https://mixdog.test/' },
  expose: ['HTMLElement', 'KeyboardEvent', 'CustomEvent', 'Event', 'navigator', 'location', 'localStorage'],
});
window.requestAnimationFrame = (callback) => window.setTimeout(callback, 0);
window.cancelAnimationFrame = (handle) => window.clearTimeout(handle);

const { parseRemoteWebrtcDesktopSignal, REMOTE_WEBRTC_VERSION } = await import('../shared/remote-webrtc.ts');
const { REMOTE_CONNECTION_READY_EVENT, setRemoteConnectionState } = await import('./remote-connection-state.ts');
const { DesktopErrorBoundary } = await import('./RendererRecovery.tsx');
const { default: RemoteScreenPane } = await import('./RemoteScreenPane.tsx');

const hex = (byte) => Array.from({ length: 32 }, () => byte).join(':');
const DESKTOP_FP = { algorithm: 'sha-256', value: hex('AB') };
const PHONE_FP = { algorithm: 'sha-256', value: hex('CD') };
const sdp = (fp) => `v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\na=fingerprint:${fp.algorithm} ${fp.value}\r\n`;
const source = { kind: 'screen', screenId: '7' };
const display = { screenId: '7', label: 'Primary', primary: true, pixelWidth: 1280, pixelHeight: 720, scaleFactor: 1 };
const geometry = {
  generation: 1,
  cssWidth: 1280,
  cssHeight: 720,
  deviceScaleFactor: 1,
  pixelWidth: 1280,
  pixelHeight: 720,
};
const wait = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));
const flush = () => act(async () => wait(10));

const peers = [];
class FakeChannel {
  constructor() {
    this.label = 'mixdog-input';
    this.readyState = 'open';
  }
  send() {}
  close() {
    this.readyState = 'closed';
  }
}
/** The page's RTCPeerConnection: DTLS comes up with the desktop's certificate on `connect`. */
class FakePeer {
  constructor() {
    this.connectionState = 'new';
    this.iceConnectionState = 'new';
    this.report = new Map();
    peers.push(this);
  }
  async setRemoteDescription() {}
  async createAnswer() {
    return { type: 'answer', sdp: sdp(PHONE_FP) };
  }
  async setLocalDescription(description) {
    this.localDescription = description;
  }
  async addIceCandidate() {}
  async getStats() {
    return this.report;
  }
  close() {
    this.closed = true;
  }
  connect() {
    this.report.set('t', { id: 't', type: 'transport', dtlsState: 'connected', remoteCertificateId: 'rc' });
    this.report.set('rc', {
      id: 'rc',
      type: 'certificate',
      fingerprint: DESKTOP_FP.value,
      fingerprintAlgorithm: DESKTOP_FP.algorithm,
    });
    this.channel = new FakeChannel();
    this.ondatachannel({ channel: this.channel });
    this.ontrack({ receiver: {}, streams: ['stream'], track: {} });
    this.connectionState = 'connected';
    this.iceConnectionState = 'connected';
    this.onconnectionstatechange();
  }
}
globalThis.RTCPeerConnection = FakePeer;
window.RTCPeerConnection = FakePeer;
globalThis.RTCRtpReceiver = { getCapabilities: () => ({ codecs: [{ mimeType: 'video/VP8' }] }) };

/** The relay shim's api: its live-view members exist only while a host is connected. */
function shimApi() {
  const host = { up: true, signals: [], listener: null };
  const members = {
    remoteBrowserWebrtcSignal: async (signal) => {
      host.signals.push(signal);
    },
    onRemoteBrowserWebrtc: (listener) => {
      host.listener = listener;
      return () => {
        if (host.listener === listener) host.listener = null;
      };
    },
    remoteBrowserControlOrdered: async () => {},
    remoteScreenDisplays: async () => [display],
  };
  const api = {};
  Object.defineProperty(api, 'remoteBrowserWebrtc', { get: () => (host.up ? REMOTE_WEBRTC_VERSION : 0) });
  for (const [key, value] of Object.entries(members)) {
    Object.defineProperty(api, key, { get: () => (host.up ? value : undefined) });
  }
  window.mixdogDesktop = api;
  return host;
}

const desktop = (body) => parseRemoteWebrtcDesktopSignal({ v: REMOTE_WEBRTC_VERSION, source, ...body });

/** The PC offers connection `n`, DTLS comes up, and it promotes: the picture is live. */
async function goLive(host, n) {
  const connectionId = `conn${String(n).padStart(16, '0')}`;
  await act(async () =>
    host.listener(
      desktop({
        type: 'offer',
        connectionId,
        generation: 1,
        sdp: sdp(DESKTOP_FP),
        fingerprints: [DESKTOP_FP],
        iceServers: [],
        iceTransportPolicy: 'all',
        geometry,
        inputEpoch: 1,
      })
    )
  );
  await flush();
  await act(async () => peers.at(-1).connect());
  await flush();
  await act(async () =>
    host.listener(desktop({ type: 'promote', connectionId, generation: 1, inputEpoch: 2, geometryGeneration: 1 }))
  );
  await flush();
}

const readies = (host) => host.signals.filter((signal) => signal.type === 'ready').length;

/** A lost connection is retried silently (as RemoteConnectionBanner does):
 *  no state card, no text; the picture's place stays shown. */
function assertSilent(element, when) {
  assert.equal(element.querySelector('.remote-screen-stage .browser-remote-empty'), null, `no state card ${when}`);
  assert.doesNotMatch(element.textContent, /connect|Could not/i, `no connection text ${when}`);
  assert.equal(element.querySelector('.remote-screen-picture')?.style.opacity, '1', `the picture stays ${when}`);
}

test('regression: the screen pane survives the phone losing its connection and comes back silently by itself', async () => {
  setRemoteConnectionState('connected');
  const host = shimApi();
  const element = document.createElement('main');
  document.body.append(element);
  const root = createRoot(element);
  const tree = React.createElement(
    DesktopErrorBoundary,
    null,
    React.createElement(RemoteScreenPane, { display, onClose() {}, onPickAgain() {} })
  );
  try {
    await act(async () => root.render(tree));
    await flush();
    assert.equal(readies(host), 1, 'the view asks for the screen');
    await goLive(host, 1);
    assert.equal(document.querySelector('.remote-screen-picture').style.opacity, '1', 'live');

    // The network changes: the relay leg drops (the shim has no host members
    // then), the video channel closes, and the app shell re-renders.
    host.up = false;
    await act(async () => setRemoteConnectionState('reconnecting'));
    await act(async () => peers.at(-1).channel.onclose());
    await act(async () => root.render(tree));
    await flush();
    assert.equal(document.querySelector('.desktop-recovery-screen'), null, 'no renderer recovery screen');
    assertSilent(element, 'while the relay is down');
    assert.equal(readies(host), 1, 'nothing is asked of a PC that is not connected');

    // Back on a network: a new relay connection, and with it a new session.
    host.up = true;
    await act(async () => {
      setRemoteConnectionState('connected');
      window.dispatchEvent(new window.Event(REMOTE_CONNECTION_READY_EVENT));
    });
    await flush();
    assert.equal(readies(host), 2, 'the view asks for the screen again by itself');
    assertSilent(element, 'until the new session pictures');
    await goLive(host, 2);
    assert.equal(document.querySelector('.remote-screen-picture').style.opacity, '1', 'live again');
    assertSilent(element, 'live again');
  } finally {
    await act(async () => root.unmount());
    element.remove();
  }
});

test('a session the PC ended because the phone’s connection left starts again; one its user stopped does not', async () => {
  setRemoteConnectionState('connected');
  const host = shimApi();
  const element = document.createElement('main');
  document.body.append(element);
  const root = createRoot(element);
  const push = (status) =>
    act(async () =>
      peers.at(-1).channel.onmessage({
        data: JSON.stringify({
          v: REMOTE_WEBRTC_VERSION,
          kind: 'screen-status',
          status: {
            ...status,
            helperInfo: { offer: 'none', outcome: null, detail: null, issue: null, secure: null },
          },
        }),
      })
    );
  try {
    await act(async () =>
      root.render(React.createElement(RemoteScreenPane, { display, onClose() {}, onPickAgain() {} }))
    );
    await flush();
    await goLive(host, 3);
    await push({ state: 'stopped', reason: 'viewer-left', helper: 'not-needed', control: false });
    await flush();
    assert.equal(readies(host), 2, 'asked again at once: the relay is up');
    assertSilent(element, 'after a viewer-left stop');

    await goLive(host, 4);
    await push({ state: 'stopped', reason: 'user', helper: 'not-needed', control: false });
    await flush();
    await act(async () => window.dispatchEvent(new window.Event(REMOTE_CONNECTION_READY_EVENT)));
    await flush();
    assert.equal(readies(host), 2, 'a stop someone decided is not undone by a reconnect');
    assert.equal(document.querySelector('.remote-screen-stage .remote-screen-picture'), null, 'the stopped card');
  } finally {
    await act(async () => root.unmount());
    element.remove();
  }
});

test('regression: a deliberate stop overtaking a queued reconnect stands: no new session, the stopped card stays', async () => {
  setRemoteConnectionState('connected');
  const host = shimApi();
  const element = document.createElement('main');
  document.body.append(element);
  const root = createRoot(element);
  try {
    await act(async () =>
      root.render(React.createElement(RemoteScreenPane, { display, onClose() {}, onPickAgain() {} }))
    );
    await flush();
    await goLive(host, 5);
    const before = readies(host);
    // A new relay connection queues a replacement; the PC's user stops the
    // session before React commits it (one batch).
    await act(async () => {
      window.dispatchEvent(new window.Event(REMOTE_CONNECTION_READY_EVENT));
      peers.at(-1).channel.onmessage({
        data: JSON.stringify({
          v: REMOTE_WEBRTC_VERSION,
          kind: 'screen-status',
          status: {
            state: 'stopped',
            reason: 'user',
            helper: 'not-needed',
            control: false,
            helperInfo: { offer: 'none', outcome: null, detail: null, issue: null, secure: null },
          },
        }),
      });
    });
    await flush();
    assert.equal(readies(host), before, 'no ready: the stop stands');
    assert.equal(element.querySelector('.remote-screen-picture'), null, 'the stopped card is shown');
  } finally {
    await act(async () => root.unmount());
    element.remove();
  }
});

/** The page goes to the background (`hidden`) or comes back (`visible`). */
const setVisibility = (state) =>
  act(async () => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
    document.dispatchEvent(new window.Event('visibilitychange'));
  });

/** The PC's user stops the session (on the newest channel). */
const pushUserStop = () =>
  peers.at(-1).channel.onmessage({
    data: JSON.stringify({
      v: REMOTE_WEBRTC_VERSION,
      kind: 'screen-status',
      status: {
        state: 'stopped',
        reason: 'user',
        helper: 'not-needed',
        control: false,
        helperInfo: { offer: 'none', outcome: null, detail: null, issue: null, secure: null },
      },
    }),
  });
const userStop = () => act(async () => pushUserStop());

test('regression: leaving the app and coming back does not undo a deliberate stop; while live it resumes', async () => {
  setRemoteConnectionState('connected');
  const host = shimApi();
  const element = document.createElement('main');
  document.body.append(element);
  const root = createRoot(element);
  try {
    await act(async () =>
      root.render(React.createElement(RemoteScreenPane, { display, onClose() {}, onPickAgain() {} }))
    );
    await flush();
    await goLive(host, 6);

    // Live: away and back asks for the screen again, and it is live again.
    const live = readies(host);
    await setVisibility('hidden');
    await flush();
    await setVisibility('visible');
    await flush();
    assert.equal(readies(host), live + 1, 'shown again: a new ready');
    await goLive(host, 7);
    assert.equal(element.querySelector('.remote-screen-picture')?.style.opacity, '1', 'live again');

    // Stopped on purpose by the PC's user: away and back changes nothing.
    await userStop();
    await flush();
    const stopped = readies(host);
    await setVisibility('hidden');
    await flush();
    await setVisibility('visible');
    await flush();
    assert.equal(readies(host), stopped, 'no ready: the stop stands');
    assert.equal(element.querySelector('.remote-screen-picture'), null, 'the stopped card stays');
  } finally {
    delete document.visibilityState;
    await act(async () => root.unmount());
    element.remove();
  }
});

test('regression: a late offer to a replacement a deliberate stop left unstarted opens no peer; after View again it does', async () => {
  setRemoteConnectionState('connected');
  const host = shimApi();
  const element = document.createElement('main');
  document.body.append(element);
  const root = createRoot(element);
  const answers = () => host.signals.filter((signal) => signal.type === 'answer').length;
  const offer = (n) =>
    act(async () =>
      host.listener(
        desktop({
          type: 'offer',
          connectionId: `conn${String(n).padStart(16, '0')}`,
          generation: 1,
          sdp: sdp(DESKTOP_FP),
          fingerprints: [DESKTOP_FP],
          iceServers: [],
          iceTransportPolicy: 'all',
          geometry,
          inputEpoch: 1,
        })
      )
    );
  try {
    await act(async () =>
      root.render(React.createElement(RemoteScreenPane, { display, onClose() {}, onPickAgain() {} }))
    );
    await flush();
    await goLive(host, 8);
    // A queued replacement, overtaken by the PC's user stopping the session
    // before React commits it (one batch).
    await act(async () => {
      window.dispatchEvent(new window.Event(REMOTE_CONNECTION_READY_EVENT));
      pushUserStop();
    });
    await flush();
    const before = { peers: peers.length, answers: answers(), readies: readies(host) };

    await offer(9);
    await flush();
    assert.equal(peers.length, before.peers, 'no peer for an offer nobody asked for');
    assert.equal(answers(), before.answers, 'no answer');
    assert.equal(readies(host), before.readies);
    assert.equal(element.querySelector('.remote-screen-picture'), null, 'the stopped card stays');

    // View again: the user asks for it, and the same offer is taken.
    const again = [...element.querySelectorAll('button')].find((button) => button.textContent === 'View again');
    await act(async () => again.click());
    await flush();
    assert.equal(readies(host), before.readies + 1, 'asked for again');
    await goLive(host, 9);
    assert.equal(peers.length, before.peers + 1, 'a peer for the asked-for session');
    assert.equal(answers(), before.answers + 1, 'answered');
    assert.equal(element.querySelector('.remote-screen-picture')?.style.opacity, '1', 'live again');
  } finally {
    await act(async () => root.unmount());
    element.remove();
  }
});

test('an unrelated render error during an outage is a render failure, not a connection one', async () => {
  setRemoteConnectionState('reconnecting');
  const element = document.createElement('main');
  document.body.append(element);
  const root = createRoot(element);
  const quiet = console.error;
  console.error = () => {};
  const Broken = () => {
    throw new TypeError('unrelated');
  };
  try {
    await act(async () => root.render(React.createElement(DesktopErrorBoundary, null, React.createElement(Broken))));
    assert.equal(
      element.querySelector('.desktop-recovery-screen h1')?.textContent,
      'Mixdog could not show this screen'
    );
    assert.match(element.textContent, /Your work continues on your PC\. Retry this screen or reload the interface\./);
    assert.doesNotMatch(element.textContent, /connection|desktop/i);
  } finally {
    console.error = quiet;
    await act(async () => root.unmount());
    element.remove();
    setRemoteConnectionState('connected');
  }
});
