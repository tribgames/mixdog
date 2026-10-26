import assert from 'node:assert/strict';
import test from 'node:test';
import { createBrowserCommandRunner } from './command-runner.ts';
import { createBrowserDisplayTracking } from './display-tracking.ts';
import { createBrowserLocalPageControl } from './local-page-control.ts';
import { browserOpenRequest, revealBrowserPage } from './page-reveal.ts';
import { restorablePages } from './restore-pages.ts';
import { BrowserSessionRegistry } from './session-registry.ts';
import { createBrowserSessionTabStrip } from './session-tab-strip.ts';

const page = (id, url = 'https://example.test/report', title = 'Report') => ({
  id,
  url,
  destroyed: false,
  isDestroyed() {
    return this.destroyed;
  },
  getURL() {
    return this.url;
  },
  getTitle: () => title,
  once() {},
  on() {},
});

/** A runner over a real session registry; `reveal` stands in for the
 *  lifecycle's panel reveal (guest-lifecycle revealPage). */
function fixture({ reveal = async () => 'shown', target = null, ensure, autoSignIn, linkedSignIn } = {}) {
  const sessions = new BrowserSessionRegistry();
  const shown = page(1);
  sessions.registerVisibleGuest(shown);
  sessions.bindVisibleGuest('s', 1, true);
  const calls = [];
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
      ensureGuest: ensure ?? (async () => shown),
      recoverCrashedGuest: async () => {},
      discardUntouchedBlank() {},
      revealPage: async (sessionId, guest) => {
        calls.push(['reveal', sessionId, guest.id]);
        return reveal();
      },
      reportOpenFailure: (sessionId, error, tabId) => calls.push(['failure', sessionId, error, tabId]),
      discardCreatedPage: (sessionId, guest) => {
        calls.push(['discard', sessionId, guest.id]);
        for (const [name, entry] of sessions.backgroundPages(sessionId)) {
          if (entry.guest === guest) sessions.deleteBackgroundPage(sessionId, name, entry);
        }
        return true;
      },
    },
    tabs: { resolveTargetGuest: (sessionId, background, tab) => (target ? target(sessionId, tab) : null) },
    downloads: {},
    taskLifecycle: { begin() {}, use() {} },
    retainGuest() {},
    drivePage: () => () => {},
    assertNoTakeover() {},
    ...(autoSignIn
      ? {
          autoSignIn: {
            afterCommand: async () => {
              calls.push(['sign-in']);
              return autoSignIn();
            },
          },
        }
      : {}),
    ...(linkedSignIn ? { linkedSignIn } : {}),
    services: {
      cdp: { waitForIdle: async () => {}, guestDebugger: async () => {} },
      reply: {
        dialogResult: () => null,
        refRecoveryFor: () => undefined,
        snapshotResult: async () => ({ text: 'ok' }),
      },
      settle: {},
      state: { invalidateInteraction() {} },
      urls: {
        validatedAgentUrl: async () => {
          throw new Error('navigation to 192.168.0.9 is blocked by the Browser Use domain policy');
        },
      },
    },
  });
  return { sessions, shown, calls, run };
}

test('open says exactly where the page is: shown, or not on screen yet', async () => {
  const shownRun = fixture();
  const shown = await shownRun.run({ action: 'open', session_id: 's', turn_id: 1 });
  assert.equal(shown.text, 'Shown in the browser panel: page p1 — Report (https://example.test/report).');
  assert.deepEqual(shownRun.calls, [['reveal', 's', 1]]);

  const pending = await fixture({ reveal: async () => 'pending' }).run({ action: 'open', session_id: 's', turn_id: 1 });
  assert.match(pending.text, /^Not on screen yet: page p1 — Report \(https:\/\/example\.test\/report\) is kept/);
  assert.match(pending.text, /Do not tell the user it is on screen\./);
  assert.doesNotMatch(pending.text, /Shown in the browser panel/);
});

test('a saved-login sign-in on open runs first and rides along; the reply is still the placement', async () => {
  const signedIn = fixture({
    autoSignIn: async () => ({
      text: 'Saved sign-in: signed in to dart.example with its saved login (the password never left the host).\n\nURL: https://dart.example/main.do\n- button "Log out"',
    }),
  });
  const result = await signedIn.run({ action: 'open', session_id: 's', turn_id: 1 });
  assert.equal(
    result.text,
    'Shown in the browser panel: page p1 — Report (https://example.test/report).\n\n' +
      'Saved sign-in: signed in to dart.example with its saved login (the password never left the host).'
  );
  assert.deepEqual(
    signedIn.calls,
    [['sign-in'], ['reveal', 's', 1]],
    'the reveal shows the page as the sign-in left it'
  );

  const needsUser = fixture({
    reveal: async () => 'pending',
    autoSignIn: async () => ({
      text: 'Saved sign-in: the site still needs the user at dart.example: one try did not finish.\n\nURL: x',
    }),
  });
  const handoff = await needsUser.run({ action: 'open', session_id: 's', turn_id: 1 });
  assert.match(handoff.text, /^Not on screen yet: page p1 — Report/);
  assert.match(
    handoff.text,
    /\n\nSaved sign-in: the site still needs the user at dart\.example: one try did not finish\.$/
  );

  // No sign-in: the placement alone.
  const none = await fixture({ autoSignIn: async () => null }).run({ action: 'open', session_id: 's', turn_id: 1 });
  assert.equal(none.text, 'Shown in the browser panel: page p1 — Report (https://example.test/report).');
});

test('a linked sign-in line leads the reply, follows an open placement, and skips sequence steps', async () => {
  const LINE = 'Linked sign-in: chatgpt.com last signed in with Google as tempest1033@gmail.com';
  const calls = [];
  const linkedSignIn = {
    beforeAction: (guest, action, command) => calls.push(['before', guest.id, action, command.ref]),
    replyLine: async ({ guest, sessionId, turnId }) => {
      calls.push(['line', guest.id, sessionId, turnId]);
      return LINE;
    },
  };
  const snapshot = await fixture({ linkedSignIn }).run({ action: 'snapshot', session_id: 's', turn_id: 3 });
  assert.equal(snapshot.text, `${LINE}\n\nok`);
  assert.deepEqual(calls, [
    ['before', 1, 'snapshot', undefined],
    ['line', 1, 's', 3],
  ]);

  const opened = await fixture({
    linkedSignIn,
    autoSignIn: async () => ({ text: 'Saved sign-in: signed in to dart.example with its saved login.\n\nURL: x' }),
  }).run({ action: 'open', session_id: 's', turn_id: 3 });
  assert.equal(
    opened.text,
    'Shown in the browser panel: page p1 — Report (https://example.test/report).\n\n' +
      `Saved sign-in: signed in to dart.example with its saved login.\n\n${LINE}`
  );

  calls.length = 0;
  const step = await fixture({ linkedSignIn }).run({
    action: 'snapshot',
    session_id: 's',
    turn_id: 3,
    internalStep: true,
  });
  assert.doesNotMatch(step.text, /Linked sign-in/);
  assert.deepEqual(
    calls.map(([kind]) => kind),
    ['before']
  );

  // No line to give, or a store that cannot be read: the reply as it was.
  for (const replyLine of [async () => '', async () => Promise.reject(new Error('vault unreadable'))]) {
    const quiet = await fixture({ linkedSignIn: { beforeAction() {}, replyLine } }).run({
      action: 'snapshot',
      session_id: 's',
      turn_id: 3,
    });
    assert.equal(quiet.text, 'ok');
  }
});

test('a page that closes while the reveal waits is a failure, not a pending reveal', async () => {
  const sessions = new BrowserSessionRegistry();
  const guest = page(8);
  sessions.registerVisibleGuest(guest);
  sessions.bindVisibleGuest('s', 8, true);
  const host = (wait) => ({
    sessionIdForGuest: (candidate) => sessions.sessionIdForGuest(candidate),
    selectGuest: (id, candidate) => sessions.selectGuest(id, candidate),
    resumeAgentFollow: () => {},
    requestSurface: () => {},
    pageId: (candidate) => `p${candidate.id}`,
    waitUntilShown: wait,
  });
  assert.equal(
    await revealBrowserPage(
      host(async () => false),
      's',
      guest,
      10
    ),
    'pending'
  );
  assert.equal(
    await revealBrowserPage(
      host(async () => true),
      's',
      guest,
      10
    ),
    'shown'
  );
  await assert.rejects(
    revealBrowserPage(
      host(async () => {
        guest.destroyed = true;
        return false;
      }),
      's',
      guest,
      10
    ),
    /the page closed before it could be shown/
  );
  // A page that left the session (its window closed) counts as closed too.
  const other = page(9);
  sessions.registerVisibleGuest(other);
  sessions.bindVisibleGuest('s', 9, true);
  await assert.rejects(
    revealBrowserPage(
      host(async () => {
        sessions.unregisterVisibleGuest(other);
        return false;
      }),
      's',
      other,
      10
    ),
    /closed before it could be shown/
  );
  // Cancelled while waiting: cancellation, not a placement.
  const stop = new AbortController();
  const live = page(10);
  sessions.registerVisibleGuest(live);
  sessions.bindVisibleGuest('s', 10, true);
  await assert.rejects(
    revealBrowserPage(
      host(async () => {
        stop.abort(new Error('browser command cancelled'));
        return false;
      }),
      's',
      live,
      10,
      stop.signal
    ),
    /browser command cancelled/
  );

  // Through the runner, the closed page is a failed open with that reason.
  const closing = fixture({
    reveal: async () => {
      throw new Error('the page closed before it could be shown');
    },
  });
  await assert.rejects(
    closing.run({ action: 'open', session_id: 's', turn_id: 1 }),
    /^Error: Could not show the page in the browser panel: the page closed before it could be shown$/
  );
  assert.deepEqual(closing.calls.at(-1), [
    'failure',
    's',
    'Could not show the page in the browser panel: the page closed before it could be shown',
    'p1',
  ]);
});

test('the reveal request carries the opened tab and title, and a failed open its error', async () => {
  const sessions = new BrowserSessionRegistry();
  const guest = page(4, 'https://dart.example/', 'OpenDART');
  sessions.registerVisibleGuest(guest);
  sessions.bindVisibleGuest('task', 4, true);
  const requests = [];
  await revealBrowserPage(
    {
      sessionIdForGuest: (candidate) => sessions.sessionIdForGuest(candidate),
      selectGuest() {},
      resumeAgentFollow() {},
      requestSurface: (id, detail) => requests.push(browserOpenRequest(id, true, detail)),
      pageId: (candidate) => `p${candidate.id}`,
      waitUntilShown: async () => true,
    },
    'task',
    guest,
    10
  );
  assert.deepEqual(requests, [{ sessionId: 'task', reveal: true, tabId: 'p4', title: 'OpenDART' }]);
  assert.deepEqual(browserOpenRequest('task', true, { error: 'navigation to x is blocked', tabId: 'p4' }), {
    sessionId: 'task',
    reveal: true,
    tabId: 'p4',
    error: 'navigation to x is blocked',
  });
  // Other requests keep their shape.
  assert.deepEqual(browserOpenRequest('task', 'hide', { tabId: 'p4' }), { sessionId: 'task', hide: true });
  assert.deepEqual(browserOpenRequest('task', 'handoff'), { sessionId: 'task', reveal: true, handoff: true });
  assert.deepEqual(browserOpenRequest('task', false), { sessionId: 'task', reveal: false });

  // A failed open reports its reason to the shell; a cancelled one does not.
  const failed = fixture({
    reveal: async () => {
      throw new Error('desktop window is unavailable');
    },
  });
  await assert.rejects(failed.run({ action: 'open', session_id: 's', turn_id: 1 }));
  assert.deepEqual(failed.calls.at(-1), [
    'failure',
    's',
    'Could not show the page in the browser panel: desktop window is unavailable',
    'p1',
  ]);
  const stop = new AbortController();
  const cancelled = fixture({
    reveal: async () => {
      stop.abort(new Error('browser command cancelled'));
      throw new Error('browser command cancelled');
    },
  });
  await assert.rejects(cancelled.run({ action: 'open', session_id: 's', turn_id: 1 }, stop.signal));
  assert.equal(cancelled.calls.filter(([kind]) => kind === 'failure').length, 0);
});

test('an open the panel cannot take fails with the reason, and claims nothing', async () => {
  const f = fixture({
    reveal: async () => {
      throw new Error('desktop window is unavailable');
    },
  });
  await assert.rejects(
    f.run({ action: 'open', session_id: 's', turn_id: 1 }),
    /^Error: Could not show the page in the browser panel: desktop window is unavailable$/
  );
});

test('an open with no page to show fails and leaves no blank behind', async () => {
  const blank = page(9, 'about:blank', '');
  const f = fixture({ ensure: async () => blank });
  f.sessions.unregisterVisibleGuest(f.shown);
  await assert.rejects(f.run({ action: 'open', session_id: 's', turn_id: 1 }), /no page is open in this conversation/);
  assert.deepEqual(
    f.calls,
    [
      ['discard', 's', 9],
      [
        'failure',
        's',
        'Could not show a page: no page is open in this conversation; navigate to one first.',
        undefined,
      ],
    ],
    'the page it made is closed, never revealed, and the shell hears why'
  );
});

test('a URL the policy blocks closes the tab its command opened', async () => {
  const fresh = page(5, '', '');
  let made = null;
  const f = fixture({
    target: (sessionId, tab) => {
      made = { guest: fresh, kind: 'agent', lastUsedAt: 0, window: { isDestroyed: () => false } };
      f.sessions.setBackgroundPage(sessionId, tab, made);
      return { guest: fresh, background: true, tabName: tab };
    },
  });
  await assert.rejects(
    f.run({ action: 'navigate', session_id: 's', turn_id: 1, url: 'http://192.168.0.9/', background: true, tab: 'x' }),
    /blocked by the Browser Use domain policy\. The blank tab this command opened was closed\./
  );
  assert.equal(f.sessions.backgroundPages('s').size, 0, 'no tab is left');
  assert.deepEqual(f.calls, [['discard', 's', 5]]);

  // A page the session already had is never closed for a refused address.
  const kept = fixture({ target: () => ({ guest: kept.shown, background: false }) });
  await assert.rejects(kept.run({ action: 'navigate', session_id: 's', turn_id: 1, url: 'http://192.168.0.9/' }));
  assert.deepEqual(kept.calls, []);
});

test('a reveal waits for a panel to show the page, and gives up when none does', async () => {
  const sessions = new BrowserSessionRegistry();
  const display = createBrowserDisplayTracking(sessions);
  const guest = { ...page(3), once() {}, setBackgroundThrottling() {}, isOffscreen: () => false };
  display.track(guest);
  const waiting = display.waitUntilShown(guest, 1_000);
  display.setPanelActive(guest, true);
  assert.equal(await waiting, true);
  assert.equal(await display.waitUntilShown(guest, 10), true, 'already shown');
  display.setPanelActive(guest, false);
  assert.equal(await display.waitUntilShown(guest, 10), false);
});

test('"보기" shows that exact tab without making, keeping or claiming a page', async () => {
  const sessions = new BrowserSessionRegistry();
  const selected = [];
  const follow = [];
  const strip = createBrowserSessionTabStrip({
    tabs: {
      displayTabs: () => [],
      selectDisplayTab: (sessionId, tabId, options) => {
        if (tabId !== 'p4') throw new Error('Browser tab is no longer available in this session.');
        selected.push([sessionId, tabId, options]);
      },
      createDisplayTab() {},
      closeDisplayTab() {},
    },
    agentFollow: {
      isPaused: () => false,
      pause: (id) => follow.push(['pause', id]),
      resume: (id) => follow.push(['resume', id]),
    },
    currentGuest: () => null,
    lifecycle: { claimPage: () => assert.fail('a view is not a claim'), replacementPage: () => null },
    pageId: (guest) => `p${guest.id}`,
    retainGuest: () => assert.fail('a view keeps nothing'),
  });
  strip.select('task', 'p4', 'view');
  assert.deepEqual(selected, [['task', 'p4', { retain: false }]]);
  assert.deepEqual(follow, [['pause', 'task']], 'panes stop following the agent away from it');
  assert.throws(() => strip.select('task', 'p7', 'view'), /no longer available/);

  // The pane's control path takes it with no page of its own: a session
  // with none (after a restart) gets the tab's absence, never a new page.
  const controls = [];
  const local = createBrowserLocalPageControl({
    currentGuest: (id) => sessions.currentGuest(id),
    state: {},
    retainGuest: () => assert.fail('nothing is kept'),
    queue: {
      executeLocal: () => assert.fail('no queued input'),
      interruptForLocal: () => assert.fail('the agent keeps working'),
      holdLocal() {},
    },
    control: async (sessionId, input) => {
      controls.push([sessionId, input.tabId]);
      strip.select(sessionId, input.tabId, input.follow);
    },
    bounded: (promise) => promise,
  });
  await local('task', { type: 'select-tab', tabId: 'p4', follow: 'view', documentId: 'p4:0' });
  await assert.rejects(
    local('task', { type: 'select-tab', tabId: 'p7', follow: 'view', documentId: 'p7:0' }),
    /no longer available/
  );
  assert.deepEqual(controls, [
    ['task', 'p4'],
    ['task', 'p7'],
  ]);
});

test('a restore drops pages with nothing to come back to instead of showing blanks', () => {
  const saved = [
    { kind: 'primary', url: 'about:blank' },
    { kind: 'agent', name: 'a', url: 'https://example.test/a' },
    { kind: 'user', name: 'b', url: '' },
    { kind: 'agent', name: 'c', url: 'http://169.254.169.254/latest' },
  ];
  assert.deepEqual(
    restorablePages(saved, {}).map(({ page, url }) => [page.name ?? page.kind, url]),
    [['a', 'https://example.test/a']]
  );
});
