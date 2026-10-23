import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

const ELECTRON_DEFAULT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) mixdog-desktop/0.9.171 Chrome/146.0.7680.216 Electron/41.10.6 Safari/537.36';
const CHROME =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36';

class FakeSession {
  constructor(name) {
    this.name = name;
    this.userAgents = [];
    this.languages = [];
    this.requestListeners = [];
    this.headerListeners = [];
    this.webRequest = {
      onBeforeRequest: (...args) => this.requestListeners.push(args),
      onBeforeSendHeaders: (...args) => this.headerListeners.push(args),
    };
  }
  setUserAgent(userAgent, acceptLanguages) {
    this.userAgents.push(userAgent);
    this.languages.push(acceptLanguages);
  }
  setPermissionCheckHandler() {}
  setPermissionRequestHandler() {}
  setDevicePermissionHandler() {}
  on() {}
  removeListener() {}
}

const sessions = new Map();
const listeners = new Set();
const fakeApp = {
  userAgentFallback: ELECTRON_DEFAULT,
  getSystemLocale: () => 'ko-KR',
  getPreferredSystemLanguages: () => ['ko-KR', 'en-US'],
  on: (event, listener) => event === 'session-created' && listeners.add(listener),
  removeListener: (event, listener) => event === 'session-created' && listeners.delete(listener),
};
const fakeSessions = {
  defaultSession: new FakeSession('default'),
  fromPartition(name) {
    if (!sessions.has(name)) {
      const created = new FakeSession(name);
      sessions.set(name, created);
      for (const listener of [...listeners]) listener(created);
    }
    return sessions.get(name);
  },
};
globalThis.partitionIdentityFixture = { app: fakeApp, session: fakeSessions };

registerHooks({
  resolve(specifier, context, next) {
    return specifier === 'electron'
      ? {
          url:
            'data:text/javascript,' +
            encodeURIComponent(
              'export const { app, session } = globalThis.partitionIdentityFixture;'
            ),
          shortCircuit: true,
        }
      : next(specifier, context);
  },
});
const { createBrowserPartition } = await import('./partition.ts');
const { browserUserAgentOverride } = await import('./browser-identity.ts');

test('the partition and the process fallback present Chrome while app-owned sessions keep Electron', () => {
  const windowSession = new FakeSession('window');
  const partition = createBrowserPartition({
    windowSession,
    assertResolvedResourceUrlAllowed: async () => {},
    downloadsDirectory: () => '',
    sessionIdForGuest: () => undefined,
    defaultSessionId: 'default',
  });
  assert.equal(fakeApp.userAgentFallback, CHROME, 'workers and other processes get the same string');
  assert.deepEqual(partition.session.userAgents, [CHROME]);
  assert.deepEqual(partition.session.languages, ['ko-KR,ko,en-US,en']);
  assert.deepEqual(fakeSessions.defaultSession.userAgents, [ELECTRON_DEFAULT], 'the app shell detects Electron');
  assert.deepEqual(windowSession.userAgents, [ELECTRON_DEFAULT]);
  assert.deepEqual(partition.session.headerListeners, [], 'no request header is rewritten');

  // A session created later (a snapshot, an export) keeps the app's string; a
  // second host still reads the app's string, not the fallback it replaced.
  const later = fakeSessions.fromPartition('file-snapshot-1');
  assert.deepEqual(later.userAgents, [ELECTRON_DEFAULT]);
  const second = createBrowserPartition({
    windowSession: new FakeSession('window-2'),
    assertResolvedResourceUrlAllowed: async () => {},
    downloadsDirectory: () => '',
    sessionIdForGuest: () => undefined,
    defaultSessionId: 'default',
  });
  assert.equal(fakeApp.userAgentFallback, CHROME);
  assert.deepEqual(fakeSessions.defaultSession.userAgents.at(-1), ELECTRON_DEFAULT);
  assert.equal(listeners.size, 1, 'one hook per process, not one per host');
  second.dispose();
  partition.dispose();

  // The fallback stays Chrome after every host is gone (remote windows may
  // still be open), so a session created now must keep the app's string.
  assert.equal(fakeApp.userAgentFallback, CHROME);
  assert.equal(listeners.size, 1);
  const afterDispose = fakeSessions.fromPartition('connection-after-dispose');
  assert.deepEqual(afterDispose.userAgents, [ELECTRON_DEFAULT]);

  // A host created again still presents Chrome in its partition and never
  // reads the replaced fallback as the app's string.
  const again = createBrowserPartition({
    windowSession: new FakeSession('window-3'),
    assertResolvedResourceUrlAllowed: async () => {},
    downloadsDirectory: () => '',
    sessionIdForGuest: () => undefined,
    defaultSessionId: 'default',
  });
  assert.equal(again.session.userAgents.at(-1), CHROME);
  assert.equal(fakeSessions.defaultSession.userAgents.at(-1), ELECTRON_DEFAULT);
  assert.equal(listeners.size, 1);
  again.dispose();
});

test("the partition's own string needs no per-page override and never names Google Chrome", () => {
  assert.deepEqual(browserUserAgentOverride(CHROME), { userAgent: '' });
  const withLocale = browserUserAgentOverride(CHROME, 'fr-FR');
  assert.equal(withLocale.userAgent, CHROME);
  assert.equal(withLocale.acceptLanguage, 'fr-FR');
  assert.doesNotMatch(JSON.stringify(withLocale), /Google Chrome/);
});
