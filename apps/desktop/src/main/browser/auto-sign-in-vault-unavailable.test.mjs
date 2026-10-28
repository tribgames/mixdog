import assert from 'node:assert/strict';
import test from 'node:test';

import { createBrowserAutoSignIn } from './auto-sign-in.ts';
import { createBrowserCommandRunner } from './command-runner.ts';
import { BrowserSessionRegistry } from './session-registry.ts';

const LOGIN_URL = 'https://shop.example.com/login';

const page = (id, url) => ({
  id,
  url,
  destroyed: false,
  isDestroyed() {
    return this.destroyed;
  },
  getURL() {
    return this.url;
  },
  getTitle: () => 'Sign in',
  isLoading: () => false,
  async loadURL(next) {
    this.url = next;
  },
  once() {},
  on() {},
});

/** A browser command runner over the real auto sign-in, whose vault cannot be read. */
function fixture({ vaultError = new Error('The stored browser credential vault could not be opened.') } = {}) {
  const sessions = new BrowserSessionRegistry();
  const shown = page(1, LOGIN_URL);
  sessions.registerVisibleGuest(shown);
  sessions.bindVisibleGuest('s', 1, true);
  const fresh = page(5, '');
  const calls = { vault: 0, fills: 0, lifecycle: [] };
  const autoSignIn = createBrowserAutoSignIn({
    enabled: () => true,
    suggestions: async () => {
      calls.vault++;
      throw vaultError;
    },
    withCredential: async () => {
      throw new Error('no credential may be requested');
    },
    fill: async () => {
      calls.fills++;
      return { usernameFilled: true, passwordFilled: true };
    },
    submit: async () => {},
    collect: async () => [{ password: true, challenge: false, wording: false, check: 'none' }],
    invalidate: () => {},
  });
  const run = createBrowserCommandRunner({
    state: {
      peek: () => undefined,
      for: () => ({ networkFailures: [] }),
      pageId: (guest) => `p${guest.id}`,
      redactText: (_guest, text) => text,
      invalidateInteraction() {},
    },
    approvals: { approve: async () => {} },
    browserSessions: sessions,
    lifecycle: {
      restoreSession: async () => {},
      ensureGuest: async () => shown,
      recoverCrashedGuest: async () => {},
      discardUntouchedBlank() {},
      revealPage: async (sessionId, guest) => {
        calls.lifecycle.push(['reveal', guest.id]);
        return 'shown';
      },
      reportOpenFailure: (_sessionId, error) => calls.lifecycle.push(['failure', error]),
      discardCreatedPage: (sessionId, guest) => {
        calls.lifecycle.push(['discard', guest.id]);
        return true;
      },
    },
    tabs: {
      resolveTargetGuest: (sessionId, background, tab) => {
        if (!tab) return null;
        sessions.setBackgroundPage(sessionId, tab, {
          guest: fresh,
          kind: 'agent',
          lastUsedAt: 0,
          window: { isDestroyed: () => false },
        });
        return { guest: fresh, background: true, tabName: tab };
      },
    },
    downloads: {},
    taskLifecycle: { begin() {}, use() {} },
    retainGuest() {},
    drivePage: () => () => {},
    assertNoTakeover() {},
    autoSignIn,
    services: {
      cdp: {
        waitForIdle: async () => {},
        guestDebugger: async () => {},
        bounded: (promise) => promise,
      },
      reply: {
        dialogResult: () => null,
        refRecoveryFor: () => undefined,
        snapshotResult: async (guest) => ({ text: `URL: ${guest.getURL()}\n- textbox "Password"` }),
      },
      settle: {},
      state: { invalidateInteraction() {}, for: () => ({ networkFailures: [] }) },
      urls: { validatedAgentUrl: async (url) => url },
      downloadsForSession: () => [],
    },
  });
  return { sessions, calls, run, shown, fresh };
}

test('open on a login page still opens it when the saved-login vault cannot be read', async () => {
  const f = fixture();
  const result = await f.run({ action: 'open', session_id: 's', turn_id: 1 });
  assert.match(result.text, /^Shown in the browser panel: page p1/);
  assert.equal(f.calls.vault, 1, 'the vault was consulted');
  assert.equal(f.calls.fills, 0, 'no sign-in was attempted');
  assert.deepEqual(f.calls.lifecycle, [['reveal', 1]], 'no failure was reported and no tab was discarded');
});

test('navigate to a login page keeps the new tab and its snapshot when the vault cannot be read', async () => {
  for (const vaultError of [
    new Error('The stored browser credential vault could not be opened.'),
    new Error('Credential encryption is unavailable.'),
  ]) {
    const f = fixture({ vaultError });
    const result = await f.run({
      action: 'navigate',
      session_id: 's',
      turn_id: 1,
      url: LOGIN_URL,
      background: true,
      tab: 'login',
    });
    assert.match(result.text, new RegExp(`URL: ${LOGIN_URL.replace(/[.]/g, '\\.')}`));
    assert.equal(f.calls.vault, 1);
    assert.equal(f.calls.fills, 0);
    assert.deepEqual(f.calls.lifecycle, [], 'the new tab is not discarded');
    assert.equal(f.sessions.backgroundPages('s').size, 1, 'the tab stays');
  }
});
