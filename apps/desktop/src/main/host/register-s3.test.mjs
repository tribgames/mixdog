import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { registerHooks } from 'node:module';
import { test } from 'node:test';

import { createComputerPresence } from '../computer/presence/mirror.ts';

// The handlers reach Electron's screen and windows at import; outside Electron a stand-in answers.
registerHooks({
  resolve(specifier, context, next) {
    return specifier === 'electron'
      ? {
          url: 'data:text/javascript,export default "";export const screen = {};export const BrowserWindow = { getAllWindows: () => [] };export const app = {};',
          shortCircuit: true,
        }
      : next(specifier, context);
  },
});
const { registerComputerHost } = await import('./register-s3.ts');

function fakeConnection() {
  const handlers = new Map();
  const requests = [];
  return {
    requests,
    handlers,
    handleRequest: (method, handler) => handlers.set(method, handler),
    onClose: () => {},
    request: async (method, params) => {
      requests.push([method, params]);
      return { ok: true };
    },
  };
}

const section = {
  active: true,
  observeOnly: false,
  controller: null,
  sessionThreadId: 't1',
  sessions: [{ sessionThreadId: 't1', observeOnly: false, mode: 'background' }],
};

function rig() {
  const connection = fakeConnection();
  const mirror = createComputerPresence({ notifyPointerReleased: () => {}, now: () => 1 });
  const power = new EventEmitter();
  const screen = new EventEmitter();
  let ready;
  const stop = registerComputerHost(connection, {
    mirror,
    permissions: { read: () => ({ screen_capture: true, accessibility: true, input: true }), request: () => {} },
    environment: { ready: new Promise((resolve) => (ready = resolve)), sources: () => ({ power, screen }) },
    legacyScreen: () => null,
    legacyCommand: () => null,
  });
  return { connection, mirror, power, stop, ready };
}

test('every handler of the computer host is registered, with no desktop host running', async () => {
  const { connection, stop } = rig();
  for (const method of [
    'host/computer/capture',
    'host/computer/displays',
    'host/computer/foregroundLease',
    'host/computer/internalWindows',
    'host/computer/pointerFeedback',
    'host/computer/cursorPrepare',
    'host/computer/appWindows',
    'host/computer/appInput',
    'host/computer/pixels',
    'host/computer/permissions',
    'host/computer/command',
  ]) {
    assert.ok(connection.handlers.has(method), `${method} is served`);
  }
  await assert.rejects(connection.handlers.get('host/computer/command')({ command: {} }, new AbortController().signal), /unavailable/);
  stop();
});

test('a lock or suspend after the app is ready is a takeover for the core only while the core drives the computer', async () => {
  const { connection, mirror, power, stop, ready } = rig();
  power.emit('lock-screen');
  assert.deepEqual(connection.requests, [], 'not bound before the app is ready');
  ready();
  await new Promise((resolve) => setImmediate(resolve));
  power.emit('lock-screen');
  assert.deepEqual(connection.requests, [], 'no core session: the core is not told');
  mirror.applySection(section);
  power.emit('lock-screen');
  assert.deepEqual(connection.requests, [['computer/userControl', { action: 'takeover', reason: 'desktop_unavailable' }]]);
  stop();
  power.emit('lock-screen');
  assert.equal(connection.requests.length, 1, 'stopped');
});

test('a stop before the app is ready binds nothing', async () => {
  const { connection, power, stop, ready } = rig();
  stop();
  ready();
  await new Promise((resolve) => setImmediate(resolve));
  power.emit('lock-screen');
  assert.deepEqual(connection.requests, []);
});
