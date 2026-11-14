import assert from 'node:assert/strict';
import { test } from 'node:test';

import { methodTable } from '../../../../../packages/protocol/src/index.ts';

// host/window/* is served only while the core owns the server windows (CORE_WINDOWS reads the
// environment when connection.ts loads), so the flag is set before the host module is imported.
process.env.MIXDOG_CORE_WINDOWS = '1';
const { createDesktopHost } = await import('./index.ts');

/**
 * host/* methods the protocol lists that this desktop does not serve yet. Each entry names the task
 * that owns the handler; the entry is deleted by that task.
 * @type {Record<string, string>}
 */
const PENDING = {
  'host/browser/pages/resolve': 's4-host-page-methods (wired by s4-wire-desktop)',
  'host/browser/pages/list': 's4-host-page-methods (wired by s4-wire-desktop)',
  'host/browser/pages/close': 's4-host-page-methods (wired by s4-wire-desktop)',
  'host/browser/pages/surface': 's4-host-page-methods (wired by s4-wire-desktop)',
  'host/browser/page/navigate': 's4-host-page-methods (wired by s4-wire-desktop)',
  'host/browser/page/stop': 's4-host-page-methods (wired by s4-wire-desktop)',
  'host/browser/page/eval': 's4-host-page-methods (wired by s4-wire-desktop)',
  'host/browser/page/read': 's4-host-page-methods (wired by s4-wire-desktop)',
  'host/browser/page/renderCheckpoint': 's4-host-page-methods (wired by s4-wire-desktop)',
  'host/browser/page/domQuiet': 's4-host-page-methods (wired by s4-wire-desktop)',
  'host/browser/page/dialog/answer': 's4-host-page-methods (wired by s4-wire-desktop)',
  'host/browser/page/sync': 's4-host-page-methods (wired by s4-wire-desktop)',
  'host/browser/cdp/send': 's4-host-page-methods (wired by s4-wire-desktop)',
  'host/browser/snapshot': 's4-host-snapshot (wired by s4-wire-desktop)',
  'host/browser/ref/call': 's4-host-snapshot (wired by s4-wire-desktop)',
  'host/browser/screenshot': 's4-host-snapshot (wired by s4-wire-desktop)',
  'host/browser/input/batch': 's4-host-input-batch (wired by s4-wire-desktop)',
  'host/browser/cookies': 's4-host-session-methods (wired by s4-wire-desktop)',
  'host/browser/storage': 's4-host-session-methods (wired by s4-wire-desktop)',
  'host/browser/initScripts': 's4-host-session-methods (wired by s4-wire-desktop)',
  'host/browser/intercept': 's4-host-session-methods (wired by s4-wire-desktop)',
  'host/browser/performance': 's4-host-session-methods (wired by s4-wire-desktop)',
  'host/browser/emulation': 's4-host-session-methods (wired by s4-wire-desktop)',
  'host/browser/downloads': 's4-host-session-methods (wired by s4-wire-desktop)',
  'host/browser/upload': 's4-host-session-methods (wired by s4-wire-desktop)',
  'host/browser/lease/release': 's4-host-lease (wired by s4-wire-desktop)',
  'host/computer/pixels': 's3-22 (wired by DESKTOP-WIRE-G4)',
  'host/computer/appWindows': 's3-21 (wired by DESKTOP-WIRE-G4)',
  'host/computer/appInput': 's3-21 (wired by DESKTOP-WIRE-G4)',
  'host/computer/permissions': 's3-23 (wired by DESKTOP-WIRE-G4)',
  'host/computer/command': 's3-23 (wired by DESKTOP-WIRE-G4)',
  'host/computer/cursorPrepare': 's3-20 (wired by DESKTOP-WIRE-G4)',
};

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
    browser: () => {
      throw new Error('not used at registration');
    },
    onVisualizePublishFailed() {},
    onBrowserViewFailed() {},
    onUpdaterInstallFailed() {},
    visualize: () => ({}),
    files: () => ({}),
    resolveProxy: async (url) => url,
    computer: () => null,
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
