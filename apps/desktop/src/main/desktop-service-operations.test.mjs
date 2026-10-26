// The daemon service's own operation lane (desktop-service.ts): requests the
// window answers, events it republishes for paired clients, and the RPC gate.
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import test from 'node:test';

import { BROWSER_OPEN_REQUESTED_DESKTOP_EVENT } from '../shared/remote-browser.ts';
import { TERMINAL_RUN_REQUESTED_DESKTOP_EVENT } from '../shared/terminal-command.ts';
import { createDesktopService } from './desktop-service.ts';
import { viewSyncHost } from './test-support/view-sync-host.mjs';

test('window-lane operations publish their events and answer without a relay', async () => {
  const f = await viewSyncHost();
  const events = [];
  let service;
  try {
    service = await createDesktopService({
      options: f.options,
      runtime: { ...f.runtime, loadConfig: async () => ({ readConfig: () => ({}) }) },
      emit: (message) => message.kind === 'desktop-event' && events.push(message),
    });
    const invoke = (operation, ...args) => service.invoke('invokeDesktopOperation', [operation, args]);
    await assert.rejects(service.invoke('noSuchMethod', []), {
      name: 'TypeError',
      message: 'Mixdog desktop service method is unavailable.',
    });
    assert.equal(service.clientCount, 0);

    assert.equal(await invoke('browserRemoteOpen', { url: 'https://example.com' }), null);
    assert.deepEqual(events.at(-1), {
      kind: 'desktop-event',
      name: BROWSER_OPEN_REQUESTED_DESKTOP_EVENT,
      value: { url: 'https://example.com' },
    });
    assert.equal(await invoke('terminalRemoteOpen', { sessionId: 's1' }), null);
    assert.deepEqual(events.at(-1), {
      kind: 'desktop-event',
      name: TERMINAL_RUN_REQUESTED_DESKTOP_EVENT,
      value: { sessionId: 's1' },
    });

    // No relay leg: relay-bound operations answer locally.
    assert.equal(await invoke('visualizeRemoteViewing', 's1'), false);
    assert.equal(await invoke('browserRemoteFrame', {}), null);
    assert.equal(await invoke('remoteAccessPairCode', 'release'), null);
    assert.deepEqual(await invoke('remoteAccessListClaims'), []);
    assert.equal(await invoke('remoteAccessResolveClaim', 'unknown', true), false);
    assert.equal(await invoke('browserRemoteResolve', 'browser_remote_unknown', true, 1), false);
  } finally {
    await service?.dispose();
    await rm(f.directory, { recursive: true, force: true });
  }
});
