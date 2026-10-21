import assert from 'node:assert/strict';
import test from 'node:test';
import { createBrowserCommandRunner } from './command-runner.ts';
import { BrowserSessionRegistry } from './session-registry.ts';

const guest = (id) => ({
  id,
  destroyed: false,
  isDestroyed() {
    return this.destroyed;
  },
  getURL: () => 'https://example.test/',
});

function fixture() {
  const sessions = new BrowserSessionRegistry();
  const lifecycleCalls = [];
  const primary = guest(1);
  sessions.registerVisibleGuest(primary);
  sessions.bindVisibleGuest('s', 1, true);
  const popup = guest(2);
  sessions.setBackgroundPage('s', 'popup-1', {
    guest: popup,
    kind: 'popup',
    lastUsedAt: 0,
    window: { isDestroyed: () => false },
  });
  const helper = guest(3);
  sessions.setBackgroundPage('s', 'bg', {
    guest: helper,
    kind: 'agent',
    lastUsedAt: 0,
    window: { isDestroyed: () => false },
  });
  let target = null;
  const run = createBrowserCommandRunner({
    state: { peek: () => undefined, for: () => ({}), redactText: (_guest, text) => text },
    approvals: { approve: async () => {} },
    browserSessions: sessions,
    lifecycle: {
      restoreSession: async () => {},
      ensureGuest: async () => primary,
      recoverCrashedGuest: async () => {},
      discardUntouchedBlank: (session, page) => lifecycleCalls.push(['discard', session, page.id]),
    },
    tabs: { resolveTargetGuest: () => target },
    downloads: {},
    taskLifecycle: { begin() {}, use() {} },
    retainGuest() {},
    drivePage: () => () => {},
    assertNoTakeover() {},
    services: {
      cdp: { waitForIdle: async () => {} },
      reply: {
        dialogResult: () => null,
        refRecoveryFor: () => undefined,
        snapshotResult: async () => ({ text: 'ok' }),
      },
      settle: {},
    },
  });
  return {
    lifecycleCalls,
    sessions,
    primary,
    popup,
    helper,
    drive: async (turn, next, extra = {}) => {
      target = next;
      await run({ action: 'snapshot', session_id: 's', turn_id: turn, ...extra });
    },
  };
}

test('a command records the page it drove with the turn it ran in', async () => {
  const f = fixture();
  await f.drive(3, null);
  assert.deepEqual(f.sessions.agentPage('s'), { guest: f.primary, turn: 3, paused: false });
  await f.drive(4, { guest: f.popup, background: false, tabName: 'popup-1' }, { tab: 'popup-1' });
  assert.deepEqual(f.sessions.agentPage('s'), { guest: f.popup, turn: 4, paused: false });
});

test('moving to another page offers the blank for closing; a hidden helper does not', async () => {
  const f = fixture();
  await f.drive(2, { guest: f.popup, background: false, tabName: 'popup-1' }, { tab: 'popup-1' });
  assert.deepEqual(
    f.lifecycleCalls.filter(([kind]) => kind === 'discard'),
    [['discard', 's', 2]]
  );
  await f.drive(3, { guest: f.helper, background: true, tabName: 'bg' }, { background: true, tab: 'bg' });
  assert.equal(f.lifecycleCalls.filter(([kind]) => kind === 'discard').length, 1);
});

test('a hidden background:true helper page is not the page the panel follows', async () => {
  const f = fixture();
  await f.drive(5, { guest: f.popup, background: false, tabName: 'popup-1' }, { tab: 'popup-1' });
  await f.drive(6, { guest: f.helper, background: true, tabName: 'bg' }, { background: true, tab: 'bg' });
  assert.deepEqual(f.sessions.agentPage('s'), { guest: f.popup, turn: 5, paused: false });
});
