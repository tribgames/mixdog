import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { WindowRouteRegistry } from './connections/window-routes.ts';
import { sampleProcessMemory, tagRendererSurface } from './process-memory-diagnostics.ts';

function contents(id, pid, { destroyed = false, crashed = false } = {}) {
  const readContent = () => assert.fail('diagnostics attempted to read renderer content');
  return Object.defineProperties(
    Object.assign(new EventEmitter(), {
      id,
      isDestroyed: () => destroyed,
      isCrashed: () => crashed,
      getOSProcessId: () => pid,
      getTitle: readContent,
      getURL: readContent,
      getLastWebPreferences: readContent,
      executeJavaScript: readContent,
    }),
    { session: { get: readContent }, mainFrame: { get: readContent } }
  );
}

test('memory diagnostics identify live surfaces without inferring roles from content or collapsing shared PIDs', () => {
  const local = contents(1, 710);
  const server = contents(2, 720);
  const page = contents(3, 730);
  const loginShell = contents(4, 740);
  const loginSite = contents(5, 730);
  const unowned = contents(6, 750);
  const unknownWindow = contents(7, 760);
  const routes = new WindowRouteRegistry();
  routes.register(local, 'local');
  routes.register(server, 'not-for-diagnostics/private-host');
  const loginWindow = { id: 104, webContents: loginShell };
  tagRendererSurface(loginWindow, 'browser-login-shell');
  tagRendererSurface(loginWindow, 'browser-login-site', loginSite);
  const ownerWindowIds = new Map([
    [local, 101],
    [server, 102],
    [page, 101], // Electron currently sees the adopted view in the shell.
    [unknownWindow, 107],
  ]);
  const sources = {
    getAppMetrics: () =>
      [710, 720, 730, 740, 750, 760, 770].map((pid) => ({
        pid,
        type: 'Tab',
        memory: { workingSetSize: 1024, peakWorkingSetSize: 1200, privateBytes: 800 },
      })),
    getAllWebContents: () => [
      local, server, page, loginShell, loginSite, unowned, unknownWindow,
      contents(8, 770, { destroyed: true }),
      contents(9, 770, { crashed: true }),
      contents(10, 0),
    ],
    browserPageWindow: (entry) => (entry === page ? { id: 103 } : null),
    ownerWindow: (entry) => (ownerWindowIds.has(entry) ? { id: ownerWindowIds.get(entry) } : null),
    connectionIdFor: (id) => routes.connectionIdFor(id),
    localConnectionId: 'local',
  };
  const sample = JSON.parse(JSON.stringify(sampleProcessMemory(sources)));
  assert.deepEqual(sample.rendererAttribution, [
    { rendererOsPid: 710, webContentsId: 1, windowId: 101, role: 'local-shell' },
    { rendererOsPid: 720, webContentsId: 2, windowId: 102, role: 'server-shell' },
    { rendererOsPid: 730, webContentsId: 3, windowId: 103, role: 'browser-page' },
    { rendererOsPid: 740, webContentsId: 4, windowId: 104, role: 'browser-login-shell' },
    { rendererOsPid: 730, webContentsId: 5, windowId: 104, role: 'browser-login-site' },
    { rendererOsPid: 750, webContentsId: 6, windowId: null, role: 'unclassified' },
    { rendererOsPid: 760, webContentsId: 7, windowId: 107, role: 'unclassified' },
  ]);
  assert.deepEqual(sample.processes.find(({ pid }) => pid === 730), {
    pid: 730, type: 'Tab', workingSetKb: 1024, peakWorkingSetKb: 1200, privateKb: 800,
  });
  assert.equal(sample.processes.at(-1).pid, 770, 'processes without live contents still have their own metrics');
});
