import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

const exposed = new Map();
const listeners = new Map();
const ipcRenderer = {
  invoke: async () => undefined,
  send: () => undefined,
  on: (channel, fn) => {
    if (!listeners.has(channel)) listeners.set(channel, new Set());
    listeners.get(channel).add(fn);
  },
  removeListener: (channel, fn) => {
    listeners.get(channel)?.delete(fn);
  },
};
const contextBridge = {
  exposeInMainWorld: (name, api) => exposed.set(name, api),
};

globalThis.__mixdogPreloadTestElectron = { contextBridge, ipcRenderer };
registerHooks({
  resolve: (specifier, context, next) =>
    specifier === 'electron'
      ? {
          url: 'data:text/javascript,export const { contextBridge, ipcRenderer } = globalThis.__mixdogPreloadTestElectron;',
          shortCircuit: true,
        }
      : next(specifier, context),
});

import { REMOTE_WEBRTC_SENDER_IPC } from '../shared/remote-webrtc-sender.ts';

await import('./browser-login.ts');
await import('./remote-transport-peer.ts');
await import('./remote-webrtc-sender.ts');

const emit = (channel, payload) => {
  for (const fn of [...(listeners.get(channel) ?? [])]) fn({}, payload);
};

test('preload bridges return working unsubscribe functions that remove their ipcRenderer listeners', () => {
  const cases = [
    ['mixdogBrowserLogin', 'onState', 'browser-login-state', { status: 'open' }],
    ['mixdogTransportPeer', 'onCommand', 'remote-transport-peer:command', { type: 'ping' }],
    ['mixdogWebrtcSender', 'onCommand', REMOTE_WEBRTC_SENDER_IPC.command, { type: 'stop' }],
  ];
  for (const [globalName, method, channel, sample] of cases) {
    const bridge = exposed.get(globalName);
    assert.ok(bridge, `${globalName} should be exposed`);
    const received = [];
    const unsubscribe = bridge[method]((payload) => received.push(payload));
    assert.equal(typeof unsubscribe, 'function', `${globalName}.${method} must return an unsubscribe function`);
    assert.equal(listeners.get(channel)?.size, 1, `${globalName}.${method} attaches one listener`);
    emit(channel, sample);
    assert.deepEqual(received, [sample]);
    unsubscribe();
    assert.equal(listeners.get(channel)?.size ?? 0, 0, `${globalName}.${method} unsubscribe removes the listener`);
    emit(channel, sample);
    assert.deepEqual(received, [sample], 'no further events after unsubscribe');
  }
});
