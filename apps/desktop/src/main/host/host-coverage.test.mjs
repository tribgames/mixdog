import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { registerHooks } from 'node:module';
import { test } from 'node:test';

import { createComputerPresence } from '../computer/presence/mirror.ts';
import { methodTable } from '../../../../../packages/protocol/src/index.ts';

// The core computer host's modules read Electron's screen and windows at import; outside Electron stand-ins answer.
registerHooks({
  resolve(specifier, context, next) {
    return specifier === 'electron'
      ? {
          url: 'data:text/javascript,export default "";export const screen = {};export const BrowserWindow = { getAllWindows: () => [] };',
          shortCircuit: true,
        }
      : next(specifier, context);
  },
});
const { createDesktopHost } = await import('./index.ts');

/**
 * host/* methods the protocol lists that this desktop does not serve yet. Each entry names the task
 * that owns the handler; the entry is deleted by that task.
 * @type {Record<string, string>}
 */
const PENDING = {};

function served() {
  const requests = new Set();
  const notifications = new Set();
  const connection = {
    request: async () => ({}),
    notify() {},
    sendBinary() {},
    handleRequest: (method) => requests.add(method),
    handleNotification: (method) => notifications.add(method),
    servedMethods: () => [...requests, ...notifications],
    onClose() {},
  };
  createDesktopHost({
    connection,
    hostId: 'host-1',
    showScreenIndicator: () => ({ update() {}, close() {} }),
    browser: () => {
      throw new Error('not used at registration');
    },
    onVisualizePublishFailed() {},
    onBrowserViewFailed() {},
    onUpdaterInstallFailed() {},
    visualize: () => ({}),
    files: () => ({}),
    resolveProxy: async (url) => url,
    computer: {
      mirror: createComputerPresence({ notifyPointerReleased() {}, now: () => 1 }),
      permissions: { read: () => ({}), request() {} },
      environment: { ready: new Promise(() => {}), sources: () => ({ power: new EventEmitter(), screen: new EventEmitter() }) },
      desktopHostScreen: () => null,
      desktopHostCommand: () => null,
    },
    updater: { check: async () => ({}), getState: () => ({}), confirmBusy: async () => false, install: async () => {} },
    notifications: { createNotification() {}, playSound: async () => {}, activate() {}, isSupported: () => true, idleSeconds: () => 0 },
    windows: { open: async () => true, close() {}, focus() {} },
  });
  return connection.servedMethods();
}

// A notification with delivery 'app' (host/state/updated: the hostState section) goes to every app client through the
// section machinery, not to the host role, so only requests and connection-delivered notifications need a host handler.
const hostMethods = (rows) =>
  rows.filter((row) => row.delivery !== 'app').map((row) => row.method).filter((method) => method.startsWith('host/'));

test('every host/* server request and notification in the method table has a desktop handler', () => {
  const servedMethods = new Set(served());
  const missing = [...hostMethods(methodTable.serverRequests), ...hostMethods(methodTable.serverNotifications)].filter(
    (method) => !servedMethods.has(method) && !(method in PENDING)
  );
  assert.deepEqual(missing, [], `host methods with no handler (add one, or list it in PENDING with its task id): ${missing.join(', ')}`);
});

test('a PENDING entry names a task and still lacks its handler', () => {
  const servedMethods = new Set(served());
  for (const [method, task] of Object.entries(PENDING)) {
    assert.ok(task && typeof task === 'string', `${method} names the task that owns it`);
    assert.ok(!servedMethods.has(method), `${method} is served now: delete its PENDING entry`);
  }
});

test('the method table lists host methods to check', () => {
  assert.ok(hostMethods(methodTable.serverRequests).length > 0);
  assert.ok(hostMethods(methodTable.serverNotifications).length > 0);
});
