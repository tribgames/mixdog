import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createVisualizeService } from './service.ts';

function makeHarness(overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-vis-lease-404-'));
  const htmlPath = join(root, 'index.html');
  writeFileSync(htmlPath, '<h1>hello</h1>', 'utf8');
  const versionsDir = join(root, 'versions');
  let leaseSeq = 0;
  let prepareCalls = 0;
  const revoked = [];
  const events = [];

  const service = createVisualizeService({
    windowAvailable: () => true,
    browserAvailable: () => false,
    versions: { directory: versionsDir },
    preparePane: async (target) => {
      prepareCalls += 1;
      return `http://127.0.0.1:4100/lease-${++leaseSeq}/${target.target}`;
    },
    prepareInlinePage: async () => `http://127.0.0.1:4100/inline-${++leaseSeq}/index.html`,
    revokeInlinePage: (url) => revoked.push(url),
    publish: (event) => events.push(event),
    watch: () => () => {},
    annotate: async () => [],
    capture: async () => Buffer.from('PNG'),
    onScreen: async () => 'visible',
    delay: async () => {},
    reloadDebounceMs: 60_000,
    ...overrides,
  });

  const cleanup = () => {
    service.dispose();
    rmSync(root, { recursive: true, force: true });
  };

  return {
    root,
    htmlPath,
    service,
    events,
    revoked,
    getPrepareCalls: () => prepareCalls,
    cleanup,
  };
}

test('expired live HTML lease 404 auto-refreshes to a fresh lease URL with zero lingering problems or extra versions', async () => {
  const { root, service, events, getPrepareCalls, cleanup } = makeHarness();
  try {
    await service.execute({ action: 'open', sessionId: 's1', cwd: root, input: { targets: ['index.html'] } });
    const beforeTab = service.snapshot()[0].tabs[0];
    const oldUrl = beforeTab.panes[0].url;
    const versionsBefore = beforeTab.versions?.length ?? 0;
    const preparesBefore = getPrepareCalls();

    // Simulate the page server returning 404 for the expired lease token.
    service.reportNavigation(oldUrl, 404);
    assert.equal(service.snapshot()[0].tabs[0].problems, undefined, 'transient 404 is suppressed during recovery');

    await service.settled();

    const afterTab = service.snapshot()[0].tabs[0];
    assert.notEqual(afterTab.panes[0].url, oldUrl, 'expired lease was replaced with a fresh lease URL');
    assert.equal(getPrepareCalls(), preparesBefore + 1, 'pane was re-prepared exactly once');
    assert.equal(afterTab.problems, undefined, 'no lingering 404 problem after recovery');
    assert.equal(afterTab.versions?.length ?? 0, versionsBefore, 'lease refresh does not record a duplicate version');
    assert.equal(events.at(-1)?.state.tabs[0].panes[0].url, afterTab.panes[0].url);
  } finally {
    cleanup();
  }
});

test('broken subpage 404 on a freshly refreshed lease does not loop and records the 404 problem', async () => {
  const { root, service, getPrepareCalls, cleanup } = makeHarness();
  try {
    await service.execute({ action: 'open', sessionId: 's1', cwd: root, input: { targets: ['index.html'] } });
    const oldUrl = service.snapshot()[0].tabs[0].panes[0].url;

    // First 404 triggers the one-shot lease refresh.
    service.reportNavigation(oldUrl, 404);
    await service.settled();
    const refreshedUrl = service.snapshot()[0].tabs[0].panes[0].url;
    assert.notEqual(refreshedUrl, oldUrl);
    const preparesAfterFirst = getPrepareCalls();

    // A broken subpage under the freshly issued lease still returns 404: must not loop and must record the problem.
    const brokenSubpage = refreshedUrl.replace(/index\.html$/, 'does-not-exist.html');
    service.reportNavigation(brokenSubpage, 404);
    await service.settled();

    assert.equal(getPrepareCalls(), preparesAfterFirst, 'freshly refreshed lease does not trigger another refresh');
    const afterTab = service.snapshot()[0].tabs[0];
    assert.equal(afterTab.panes[0].url, refreshedUrl);
    assert.equal(afterTab.problems?.length, 1);
    assert.match(afterTab.problems[0].message, /HTTP 404/);
  } finally {
    cleanup();
  }
});

test('deleted file on expired lease 404 marks missing: true without recording a 404 problem', async () => {
  const { root, htmlPath, service, cleanup } = makeHarness();
  try {
    await service.execute({ action: 'open', sessionId: 's1', cwd: root, input: { targets: ['index.html'] } });
    const oldUrl = service.snapshot()[0].tabs[0].panes[0].url;

    unlinkSync(htmlPath);
    service.reportNavigation(oldUrl, 404);
    await service.settled();

    const afterTab = service.snapshot()[0].tabs[0];
    assert.equal(afterTab.missing, true, 'deleted file transitions cleanly to missing: true');
    assert.equal(afterTab.problems, undefined, 'no spurious HTTP 404 problem when file is missing');
  } finally {
    cleanup();
  }
});

test('inline scripted HTML pane and kept version pane 404s auto-refresh their leases cleanly', async () => {
  const { root, htmlPath, service, revoked, cleanup } = makeHarness();
  try {
    // Inline scripted HTML pane.
    const inlineOpen = await service.execute({
      action: 'open',
      sessionId: 's1',
      cwd: root,
      input: { content: { kind: 'html', title: 'Widget', source: '<div>hi</div>' } },
    });
    const inlineTabId = inlineOpen.tabs[0].id;
    const oldInlineUrl = service.tabView('s1', inlineTabId).panes[0].url;

    service.reportNavigation(oldInlineUrl, 404);
    await service.settled();

    const newInlineUrl = service.tabView('s1', inlineTabId).panes[0].url;
    assert.notEqual(newInlineUrl, oldInlineUrl, 'inline HTML pane obtained a fresh virtual lease');
    assert.ok(revoked.includes(oldInlineUrl), 'expired inline virtual lease was revoked');
    assert.equal(service.tabView('s1', inlineTabId).problems, undefined);

    // Kept version pane of a file tab.
    const fileOpen = await service.execute({
      action: 'open',
      sessionId: 's1',
      cwd: root,
      input: { targets: ['index.html'] },
    });
    const fileTabId = fileOpen.tabs[0].id;
    writeFileSync(htmlPath, '<h1>v2</h1>', 'utf8');
    await service.execute({ action: 'open', sessionId: 's1', cwd: root, input: { targets: ['index.html'] } });
    await service.command({ action: 'version', sessionId: 's1', tabId: fileTabId, version: 1, compare: false });
    const oldVersionUrl = service.tabView('s1', fileTabId).panes[0].url;

    service.reportLoadFailure(oldVersionUrl, 'ERR_CONNECTION_REFUSED');
    await service.settled();

    const newVersionUrl = service.tabView('s1', fileTabId).panes[0].url;
    assert.notEqual(newVersionUrl, oldVersionUrl, 'kept version pane refreshed its lease on load failure');
    assert.equal(service.tabView('s1', fileTabId).problems, undefined);
  } finally {
    cleanup();
  }
});

test('missing subpage / nested iframe 404 after 200 entry load never loops and records the 404 problem', async () => {
  const { root, service, getPrepareCalls, cleanup } = makeHarness();
  try {
    await service.execute({ action: 'open', sessionId: 's1', cwd: root, input: { targets: ['index.html'] } });
    const initialUrl = service.snapshot()[0].tabs[0].panes[0].url;
    const preparesAfterOpen = getPrepareCalls();

    // Entry page loads 200, then a broken sub-link / nested iframe hits 404 across multiple rounds.
    for (let round = 0; round < 3; round += 1) {
      const currentUrl = service.snapshot()[0].tabs[0].panes[0].url;
      const missingUrl = new URL('missing.html', currentUrl).href;
      assert.notEqual(missingUrl, currentUrl);
      service.reportNavigation(currentUrl, 200);
      service.reportNavigation(missingUrl, 404);
      await service.settled();
      assert.equal(getPrepareCalls(), preparesAfterOpen, `round ${round + 1}: missing subpage must not refresh lease`);
      const tab = service.snapshot()[0].tabs[0];
      assert.equal(tab.panes[0].url, initialUrl);
      assert.equal(tab.problems?.length, 1);
      assert.match(tab.problems[0].message, /HTTP 404/);
    }

    // Hours later, the entry page itself hits 404 because the lease truly expired: recovery still works.
    service.reportNavigation(initialUrl, 404);
    await service.settled();
    const refreshedUrl = service.snapshot()[0].tabs[0].panes[0].url;
    assert.notEqual(refreshedUrl, initialUrl, 'expired entry page recovers even after earlier 200');
    assert.equal(getPrepareCalls(), preparesAfterOpen + 1);
    assert.equal(service.snapshot()[0].tabs[0].problems, undefined);

    // After recovery, the refreshed entry loads 200 and a broken nested iframe hits 404: still no refresh loop.
    const preparesAfterRecovery = getPrepareCalls();
    for (let round = 0; round < 3; round += 1) {
      const missingUrl = new URL('missing.html', refreshedUrl).href;
      assert.notEqual(missingUrl, refreshedUrl);
      service.reportNavigation(refreshedUrl, 200);
      service.reportNavigation(missingUrl, 404);
      await service.settled();
      assert.equal(getPrepareCalls(), preparesAfterRecovery, `post-recovery round ${round + 1}: must not loop`);
      const tab = service.snapshot()[0].tabs[0];
      assert.equal(tab.panes[0].url, refreshedUrl);
      assert.equal(tab.problems?.length, 1);
      assert.match(tab.problems[0].message, /HTTP 404/);
    }
  } finally {
    cleanup();
  }
});

test('expired-lease 404 recovery during an active turn hold updates hold.shown immediately', async () => {
  const { root, service, events, cleanup } = makeHarness();
  try {
    await service.execute({ action: 'open', sessionId: 's1', cwd: root, input: { targets: ['index.html'] } });
    const oldUrl = service.snapshot()[0].tabs[0].panes[0].url;

    await service.setTurnActive('s1', true);
    const eventsBefore = events.length;

    service.reportNavigation(oldUrl, 404);
    await service.settled();

    const snapTab = service.snapshot()[0].tabs[0];
    assert.notEqual(snapTab.panes[0].url, oldUrl, 'snapshot() during active turn hold emits the refreshed lease URL');
    assert.equal(snapTab.problems, undefined);
    const published = events.slice(eventsBefore);
    assert.ok(published.length > 0, 'recovery published updated held state');
    assert.equal(published.at(-1).held, true);
    assert.equal(published.at(-1).state.tabs[0].panes[0].url, snapTab.panes[0].url);
  } finally {
    cleanup();
  }
});

test('kept version pane still recovers its expired lease when the live file is missing', async () => {
  const { root, htmlPath, service, cleanup } = makeHarness();
  try {
    const opened = await service.execute({
      action: 'open',
      sessionId: 's1',
      cwd: root,
      input: { targets: ['index.html'] },
    });
    const tabId = opened.tabs[0].id;
    writeFileSync(htmlPath, '<h1>v2</h1>', 'utf8');
    await service.execute({ action: 'open', sessionId: 's1', cwd: root, input: { targets: ['index.html'] } });

    // Delete the live file so tab.missing becomes true.
    const liveUrl = service.tabView('s1', tabId).panes[0].url;
    unlinkSync(htmlPath);
    service.reportNavigation(liveUrl, 404);
    await service.settled();
    assert.equal(service.tabView('s1', tabId).missing, true);

    // Switch to kept version 1 while live is still missing, then expire version 1's lease.
    await service.command({ action: 'version', sessionId: 's1', tabId, version: 1, compare: false });
    const oldVersionUrl = service.tabView('s1', tabId).panes[0].url;
    assert.ok(oldVersionUrl);

    service.reportNavigation(oldVersionUrl, 404);
    await service.settled();

    const afterTab = service.tabView('s1', tabId);
    assert.notEqual(afterTab.panes[0].url, oldVersionUrl, 'kept version lease recovered despite missing live file');
    assert.equal(afterTab.problems, undefined);
  } finally {
    cleanup();
  }
});
