// The first-open access notice through the real pane: display, dismiss, the
// button opening the existing install sheet, touches on its buttons, and PC
// switching on one origin's storage. Stubs only: no service is touched.
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
const { setRemoteConnectionState } = await import('./remote-connection-state.ts');
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
const PC_A = 'a'.repeat(32);
const PC_B = 'b'.repeat(32);
const wait = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));
const flush = () => act(async () => wait(10));

const peers = [];
class FakeChannel {
  constructor() {
    this.label = 'mixdog-input';
    this.readyState = 'open';
    this.sent = [];
  }
  send(data) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 'closed';
  }
}
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
  async setLocalDescription() {}
  async addIceCandidate() {}
  async getStats() {
    return this.report;
  }
  close() {}
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

function shimApi() {
  const host = { signals: [], listener: null };
  window.mixdogDesktop = {
    remoteBrowserWebrtc: REMOTE_WEBRTC_VERSION,
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
  return host;
}

const desktop = (body) => parseRemoteWebrtcDesktopSignal({ v: REMOTE_WEBRTC_VERSION, source, ...body });
let sessions = 0;
async function goLive(host) {
  const connectionId = `conn${String(++sessions).padStart(16, '0')}`;
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

const pushStatus = (patch, offer) =>
  act(async () =>
    peers.at(-1).channel.onmessage({
      data: JSON.stringify({
        v: REMOTE_WEBRTC_VERSION,
        kind: 'screen-status',
        status: {
          state: 'live',
          helper: 'missing',
          control: true,
          ...patch,
          helperInfo: { offer, outcome: null, detail: null, issue: null, secure: patch.secure ?? null },
        },
      }),
    })
  );

/** Opens the pane at PC `deviceId` (a `/d/<id>/` route) and brings the picture up. */
async function openPane(deviceId) {
  setRemoteConnectionState('connected');
  window.history.pushState({}, '', `/d/${deviceId}/`);
  const host = shimApi();
  const element = document.createElement('main');
  document.body.append(element);
  const root = createRoot(element);
  await act(async () =>
    root.render(React.createElement(RemoteScreenPane, { display, onClose() {}, onPickAgain() {} }))
  );
  await flush();
  await goLive(host);
  return {
    element,
    close: async () => {
      await act(async () => root.unmount());
      element.remove();
    },
  };
}

const notice = (element) => element.querySelector('.remote-screen-note-bar');
const buttonNamed = (element, label) => [...element.querySelectorAll('button')].find((b) => b.textContent === label);
const touch = (type, target) => {
  const event = new window.Event(type, { bubbles: true, cancelable: true });
  const point = { identifier: 1, clientX: 40, clientY: 40 };
  event.touches = type === 'touchend' ? [] : [point];
  event.changedTouches = [point];
  target.dispatchEvent(event);
  return event;
};

test('the notice shows once for an uninstalled PC, outside the stage; Not now keeps it gone', async () => {
  window.localStorage.clear();
  const pane = await openPane(PC_A);
  try {
    assert.equal(notice(pane.element), null, 'nothing before the PC says it is not installed');
    await pushStatus({}, 'install');
    const bar = notice(pane.element);
    assert.ok(bar, 'shown');
    assert.equal(bar.closest('.remote-screen-stage'), null, 'outside the gesture-bound stage');
    assert.match(bar.textContent, /Set up PC access/);
    await act(async () => buttonNamed(pane.element, 'Not now').click());
    assert.equal(notice(pane.element), null, 'dismissed');
    await pushStatus({}, 'install');
    assert.equal(notice(pane.element), null, 'a later status does not bring it back');
  } finally {
    await pane.close();
  }
  const again = await openPane(PC_A);
  try {
    await pushStatus({}, 'install');
    assert.equal(notice(again.element), null, 'a later open of the same PC does not show it');
  } finally {
    await again.close();
  }
});

test('the notice is never shown when installed or unsupported, and then costs nothing', async () => {
  window.localStorage.clear();
  const pane = await openPane(PC_A);
  try {
    await pushStatus({ helper: 'active' }, 'none');
    assert.equal(notice(pane.element), null);
    assert.equal(window.localStorage.length, 0, 'the once-flag is not spent');
    await pushStatus({}, 'update');
    assert.equal(notice(pane.element), null, 'an outdated install is not a first offer');
  } finally {
    await pane.close();
  }
});

test('regression: touching the notice buttons presses them and sends no remote input', async () => {
  window.localStorage.clear();
  const pane = await openPane(PC_A);
  try {
    await pushStatus({}, 'install');
    const channel = peers.at(-1).channel;
    const sentBefore = channel.sent.length;
    const approve = buttonNamed(pane.element, 'Approve PC access');
    for (const type of ['touchstart', 'touchend']) {
      const event = touch(type, approve);
      assert.equal(event.defaultPrevented, false, `${type} on the button is left alone (the click goes through)`);
    }
    assert.equal(channel.sent.length, sentBefore, 'no PC gesture was sent');
    // The stage still owns its touches.
    const stage = pane.element.querySelector('.remote-screen-stage');
    assert.equal(touch('touchstart', stage).defaultPrevented, true);
    touch('touchend', stage);

    // The click that follows opens the existing install sheet, over the live view.
    await act(async () => approve.click());
    const sheet = pane.element.querySelector('.remote-screen-sheet[role="dialog"]');
    assert.ok(sheet, 'the existing Windows-password sheet');
    assert.equal(sheet.getAttribute('aria-label'), 'Approve PC access');
    assert.equal(notice(pane.element), null, 'the notice gives way to the sheet');
    await act(async () => buttonNamed(pane.element, 'Cancel').click());
    assert.equal(pane.element.querySelector('.remote-screen-sheet'), null, 'Cancel closes it');
    assert.equal(notice(pane.element), null, 'and the notice does not return');
  } finally {
    await pane.close();
  }
});

test('the notice goes when the view stops being live', async () => {
  window.localStorage.clear();
  const pane = await openPane(PC_A);
  try {
    await pushStatus({}, 'install');
    assert.ok(notice(pane.element));
    await pushStatus({ state: 'elevation-prompt', reason: 'uac', secure: 'uac' }, 'install');
    assert.equal(notice(pane.element), null, 'the blocked view has its own button');
  } finally {
    await pane.close();
  }
});

test('two PCs on one origin storage each get the notice once', async () => {
  window.localStorage.clear();
  const open = async (id) => {
    const pane = await openPane(id);
    await pushStatus({}, 'install');
    return pane;
  };
  const a = await open(PC_A);
  assert.ok(notice(a.element), 'PC A: shown');
  await act(async () => buttonNamed(a.element, 'Not now').click());
  await a.close();

  const b = await open(PC_B);
  assert.ok(notice(b.element), 'PC B: shown although PC A already had it');
  await act(async () => buttonNamed(b.element, 'Not now').click());
  await b.close();

  for (const id of [PC_A, PC_B]) {
    const again = await open(id);
    assert.equal(notice(again.element), null, `PC ${id[0].toUpperCase()}: not shown a second time`);
    await again.close();
  }
});
