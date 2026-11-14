// Channel parity: DESKTOP_IPC (the channel names shared by main, preload and renderer) against what the preload exposes
// and what main registers. A channel the preload invokes must have a handler in main; one it sends must have a listener;
// one it subscribes to must be sent from main. A channel the preload does not name is a member of the renderer's direct
// API (the renderer reaches the core itself) or the event channel of one, and says so here.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { DESKTOP_IPC } from './contract-ipc.ts';
import { HOST_EXTRA_IPC } from './contract-ipc-host.ts';
import { DIRECT_KEYS, HOST_KEYS } from './desktop-api-split.ts';

const SRC = fileURLToPath(new URL('../', import.meta.url));

function sources(directory) {
  const walk = (dir) =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : walk(path.join(dir, entry.name));
      return [path.join(dir, entry.name)];
    });
  return walk(path.join(SRC, directory))
    .filter((file) => /\.tsx?$/.test(file) && !/\.(test|d)\./.test(file))
    .map((file) => fs.readFileSync(file, 'utf8'))
    .join('\n');
}

const MAIN = sources('main');
const PRELOAD = sources('preload');

/** `HOST_EXTRAS_IPC` is the host-extras table of main/ipc-host-extras.ts: DESKTOP_IPC channels under their own names. */
const channel = (name) => String.raw`(?:DESKTOP_IPC|HOST_EXTRAS_IPC)\.${name}\b`;
const call = (callee, name) => new RegExp(String.raw`(?:^|[^A-Za-z0-9_])${callee}\(\s*${channel(name)}`);

/** How the preload reaches a channel: `invoke`, `send` (fire and forget to `ipcMain.on`), `listen` (main sends), or `null`. */
function preloadKind(name) {
  if (call('(?:invokeIpc|[A-Za-z]*\\.invoke)', name).test(PRELOAD)) return 'invoke';
  if (call('[A-Za-z]*\\.(?:send|sendSync)', name).test(PRELOAD)) return 'send';
  if (call('(?:subscribeIpc|[A-Za-z]*\\.on)', name).test(PRELOAD)) return 'listen';
  return new RegExp(channel(name)).test(PRELOAD) ? 'other' : null;
}

/** `handle(DESKTOP_IPC.x, fn)`, or a `[DESKTOP_IPC.x, fn]` row of a table a registration loop hands to `ipcMain.handle`. */
const mainHandles = (name) =>
  call('(?:handle|[A-Za-z]*\\.handle)', name).test(MAIN) ||
  new RegExp(String.raw`\[\s*(?://[^\n]*\n\s*)*${channel(name)}\s*,\s*(?:async\s*)?\(`).test(MAIN);
const mainListens = (name) => call('[A-Za-z]*\\.(?:on|once|removeListener)', name).test(MAIN);
const mainNames = (name) => new RegExp(channel(name)).test(MAIN);

const KEYS = Object.keys(DESKTOP_IPC);
const DIRECT = new Set(Object.values(DIRECT_KEYS).flat());

/**
 * Channels the preload does not name that are not the name of a direct member: the events that the direct members
 * `subscribe*` to, which the renderer receives over its own core connection and main still publishes for the windows
 * that were not given a core connection of their own.
 */
const DIRECT_EVENT_CHANNELS = new Set([
  'folderChanged',
  'lspDiagnostics',
  'lspStatus',
  'relayPayloadRefused',
  'remoteAccessInfo',
  'remotePairCode',
  'settingsChanged',
  'turnReviewChanged',
  'orchestrationModeChanged',
  'activityRailPinsChanged',
  'providerModelsChanged',
  'terminalRunClaim',
  'state',
  'sessionState',
  'sessionStateResync',
  'sessionsChanged',
  'agentPoolChanged',
  'remoteClientClaim',
  'remoteAccessSettingsChanged',
  'stateResync',
  'termData',
  'termSizeOwner',
  'termActivityChanged',
]);

test('channel names are unique, and the core port channels are not a DesktopApi channel', () => {
  const values = [...Object.values(DESKTOP_IPC), ...Object.values(HOST_EXTRA_IPC)];
  assert.equal(new Set(values).size, values.length, 'two channels share a name');
  assert.ok(KEYS.length > 300, 'DESKTOP_IPC is the table of the desktop channels');
});

test('main registers or sends every channel of DESKTOP_IPC', () => {
  const unnamed = KEYS.filter((name) => !mainNames(name));
  assert.deepEqual(unnamed, [], 'a channel nothing in main handles, listens to or sends');
});

test('every channel the preload names is served by main in the way the preload uses it', () => {
  const wrong = [];
  for (const name of KEYS) {
    const kind = preloadKind(name);
    if (kind === null) continue;
    if (kind === 'invoke' && !mainHandles(name)) wrong.push(`${name}: the preload invokes it and main has no handler`);
    if (kind === 'send' && !mainListens(name)) wrong.push(`${name}: the preload sends it and main has no listener`);
    if (kind === 'listen' && (mainHandles(name) || !mainNames(name))) wrong.push(`${name}: the preload listens and main never sends it`);
    if (kind === 'other' && !mainNames(name)) wrong.push(`${name}: the preload names it and main does not`);
  }
  assert.deepEqual(wrong, []);
});

test('a channel the preload does not name belongs to the direct half of DesktopApi', () => {
  const stray = KEYS.filter((name) => preloadKind(name) === null && !DIRECT.has(name) && !DIRECT_EVENT_CHANNELS.has(name));
  assert.deepEqual(stray, [], 'a channel that neither the preload nor the direct API reaches');
  const stale = [...DIRECT_EVENT_CHANNELS].filter((name) => !(name in DESKTOP_IPC) || preloadKind(name) !== null);
  assert.deepEqual(stale, [], 'a listed event channel is gone, or the preload names it now: delete it');
});

test('the host half of DesktopApi is served through the preload, never through the direct half', () => {
  const host = new Set(Object.values(HOST_KEYS).flat());
  const missing = [...host].filter((name) => name in DESKTOP_IPC && preloadKind(name) === null);
  assert.deepEqual(missing, [], 'a host member with a channel the preload never reaches');
  const both = [...host].filter((name) => DIRECT.has(name));
  assert.deepEqual(both, []);
});

test('the core port hand-off channels are opened by main and answered in the preload', () => {
  for (const value of Object.values(HOST_EXTRA_IPC)) {
    assert.ok(MAIN.includes(value) || /HOST_EXTRA_IPC/.test(MAIN), `${value} is not used by main`);
  }
  assert.ok(/HOST_EXTRA_IPC|mixdog:core-port/.test(PRELOAD), 'the preload does not use the core port channels');
});
