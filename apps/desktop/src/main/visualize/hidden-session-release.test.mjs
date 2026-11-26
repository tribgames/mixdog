import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createVisualizeParkStore, parkDirectoryFor, stripParkedHistory } from './park-store.ts';
import { createVisualizeService } from './service.ts';
import {
  findClosedRequestedHistory,
  findFileTab,
  findVerifyRequestedTab,
  markFileTabMissing,
  targetIdentityKey,
} from './tab-state.ts';

test('hidden session releases file watchers, inline sources and thumbnails, then restores from disk when shown', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-vis-park-'));
  const filePath = join(root, 'page.html');
  writeFileSync(filePath, '<h1>v1</h1>', 'utf8');
  const versionsDir = join(root, 'versions');

  const activeWatchers = new Map();
  let watcherSeq = 0;
  const events = [];
  let leaseSeq = 0;
  const pngBytes = Buffer.from('PNG-THUMB-DATA');
  const expectedDataUrl = `data:image/png;base64,${pngBytes.toString('base64')}`;

  const service = createVisualizeService({
    windowAvailable: () => true,
    browserAvailable: () => false,
    recentShownLimit: 0,
    versions: { directory: versionsDir },
    preparePane: async (target) => `http://127.0.0.1:4100/lease-${++leaseSeq}/${target.label}`,
    prepareInlinePage: async () => `http://127.0.0.1:4100/lease-${++leaseSeq}/inline.html`,
    publish: (event) => events.push(event),
    watch(path, onChange) {
      const id = ++watcherSeq;
      activeWatchers.set(id, { path, onChange });
      return () => {
        activeWatchers.delete(id);
      };
    },
    annotate: async () => [],
    capture: async () => pngBytes,
    onScreen: async () => 'visible',
    thumbnail: async () => pngBytes,
    thumbnailOffscreen: async () => pngBytes,
    delay: async () => {},
  });

  try {
    await service.setShownSessions(['s1']);
    service.setTurnActive('s1', true);

    const fileOpen = await service.execute({
      action: 'open',
      sessionId: 's1',
      cwd: root,
      input: { targets: ['page.html'] },
    });
    const fileTabId = fileOpen.tabs[0].id;
    const inlineOpen = await service.execute({
      action: 'open',
      sessionId: 's1',
      cwd: root,
      input: { content: { kind: 'mermaid', title: 'Flow', source: 'graph TD; A-->B;' } },
    });
    const inlineTabId = inlineOpen.tabs.find((t) => t.kind === 'inline').id;
    // Open a second version of the inline tab so inlineHistory has 2 entries.
    await service.execute({
      action: 'open',
      sessionId: 's1',
      cwd: root,
      input: { content: { kind: 'mermaid', title: 'Flow', source: 'graph TD; A-->C;' } },
    });
    service.setTurnActive('s1', false);
    await service.settled();
    assert.equal(activeWatchers.size, 1, 'open file tab holds an fs.watch while shown');
    assert.equal(service.snapshot().length, 1);

    // Hide s1: switch to another session.
    await service.setShownSessions(['s2']);
    await service.settled();

    assert.equal(activeWatchers.size, 0, 'hidden session keeps no file watchers');
    assert.equal(service.tabView('s1', fileTabId), null);
    assert.equal(service.tabView('s1', inlineTabId), null);
    // Parked session remains listed in snapshot/hostSnapshot with deferred inline & no thumbnails/urls.
    const parkedSnap = service.snapshot().find((entry) => entry.sessionId === 's1');
    assert.ok(parkedSnap, 'parked session stays visible in snapshot for renderer reload');
    assert.equal(parkedSnap.tabs.length, 2);
    const parkedInline = parkedSnap.tabs.find((tab) => tab.id === inlineTabId);
    assert.equal(parkedInline?.thumbnail, undefined);
    assert.equal(parkedInline?.panes[0]?.url, '');
    assert.equal(parkedInline?.panes[0]?.inline?.source, '');
    assert.equal(parkedInline?.panes[0]?.inline?.deferred, true);
    const parkedHost = service.hostSnapshot().find((entry) => entry.sessionId === 's1');
    assert.ok(parkedHost, 'parked session stays visible in hostSnapshot for paired phones');
    assert.equal(parkedHost.tabs.length, 2);
    assert.equal(parkedHost.tabs.find((tab) => tab.id === inlineTabId)?.panes[0]?.inline?.deferred, true);

    // Thumbnail command can still read from disk without rehydrating the session.
    const thumb = await service.command({
      action: 'thumbnail',
      sessionId: 's1',
      tabId: fileTabId,
      version: 1,
    });
    assert.equal(thumb.thumbnail, expectedDataUrl);
    assert.equal(activeWatchers.size, 0, 'thumbnail read on hidden session does not re-arm watchers');
    assert.equal(service.tabView('s1', fileTabId), null, 'thumbnail read leaves hidden session parked');

    // Show s1 again: tabs, inline source, history and watcher return from disk.
    await service.setShownSessions(['s1']);
    await service.settled();

    assert.equal(activeWatchers.size, 1, 'showing session again re-arms its file watcher');
    const restored = service.snapshot().find((entry) => entry.sessionId === 's1');
    assert.ok(restored, 'restored session appears in snapshot');
    assert.equal(restored.tabs.length, 2);
    const restoredInline = restored.tabs.find((tab) => tab.id === inlineTabId);
    assert.equal(restoredInline?.panes[0]?.inline?.source, 'graph TD; A-->C;');
    assert.equal(restoredInline?.versions?.length, 2);

    // Closing all tabs and hiding releases watchers while keeping history in snapshot; releasing the session drops it completely.
    await service.execute({ action: 'close', sessionId: 's1', cwd: root, input: {} });
    await service.setShownSessions([]);
    assert.equal(activeWatchers.size, 0);
    assert.equal(service.snapshot()[0]?.tabs.length, 0);
    await service.releaseSession('s1');
    assert.deepEqual(service.snapshot(), []);
  } finally {
    service.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test('rehydrating a parked file tab preserves selected past version and compare targets inside version.dir', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-vis-park-ver-'));
  const filePath = join(root, 'page.html');
  writeFileSync(filePath, '<h1>v1</h1>', 'utf8');
  const versionsDir = join(root, 'versions');
  const preparedTargets = [];
  let leaseSeq = 0;

  const service = createVisualizeService({
    windowAvailable: () => true,
    browserAvailable: () => false,
    recentShownLimit: 0,
    versions: { directory: versionsDir },
    preparePane: async (target) => {
      preparedTargets.push({ path: target.path, root: target.root, label: target.label });
      return `http://127.0.0.1:4100/lease-${++leaseSeq}/${target.label}`;
    },
    prepareInlinePage: async () => `http://127.0.0.1:4100/lease-${++leaseSeq}/inline.html`,
    publish: () => {},
    watch: () => () => {},
    annotate: async () => [],
    capture: async () => Buffer.from('PNG'),
    onScreen: async () => 'visible',
    thumbnail: async () => Buffer.from('PNG'),
    thumbnailOffscreen: async () => Buffer.from('PNG'),
    delay: async () => {},
  });

  try {
    await service.setShownSessions(['s1']);
    const first = await service.execute({
      action: 'open',
      sessionId: 's1',
      cwd: root,
      input: { targets: ['page.html'] },
    });
    const tabId = first.tabs[0].id;
    writeFileSync(filePath, '<h1>v2</h1>', 'utf8');
    await service.execute({
      action: 'open',
      sessionId: 's1',
      cwd: root,
      input: { targets: ['page.html'] },
    });
    await service.command({ action: 'version', sessionId: 's1', tabId, version: 1, compare: true });
    await service.settled();

    // Park on window hide, then rehydrate.
    await service.setShownSessions([]);
    await service.settled();
    preparedTargets.length = 0;

    await service.setShownSessions(['s1']);
    await service.settled();

    const restored = service.snapshot().find((entry) => entry.sessionId === 's1');
    const restoredTab = restored?.tabs.find((tab) => tab.id === tabId);
    assert.equal(restoredTab?.version, 1, 'selected past version is preserved after park/rehydrate');
    assert.equal(restoredTab?.compare, true, 'compare view is preserved after park/rehydrate');
    const pastTarget = preparedTargets.find((entry) => entry.root.startsWith(versionsDir));
    assert.ok(pastTarget, 'past version pane was prepared from version.dir instead of mangled host root');
    assert.ok(pastTarget.path.startsWith(pastTarget.root));
  } finally {
    service.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test('MRU keeps recent switches warm, revokes inline virtual leases on park/replace/close, and respects remoteViewing', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-vis-mru-'));
  const filePath = join(root, 'a.html');
  writeFileSync(filePath, '<p>a</p>', 'utf8');
  const versionsDir = join(root, 'versions');
  const revoked = [];
  const activeWatchers = new Map();
  let watcherSeq = 0;
  let leaseSeq = 0;

  const service = createVisualizeService({
    windowAvailable: () => true,
    browserAvailable: () => false,
    recentShownLimit: 2,
    remoteViewing: async (sessionId) => sessionId === 's-remote',
    revokeInlinePage: (url) => revoked.push(url),
    versions: { directory: versionsDir },
    preparePane: async (target) => `http://127.0.0.1:4100/lease-${++leaseSeq}/${target.label}`,
    prepareInlinePage: async () => `http://127.0.0.1:4100/virtual-${++leaseSeq}/index.html`,
    publish: () => {},
    watch: (path) => {
      const id = ++watcherSeq;
      activeWatchers.set(id, path);
      return () => activeWatchers.delete(id);
    },
    annotate: async () => [],
    capture: async () => Buffer.from('PNG'),
    onScreen: async () => 'visible',
    thumbnail: async () => Buffer.from('PNG'),
    thumbnailOffscreen: async () => Buffer.from('PNG'),
    delay: async () => {},
  });

  try {
    await service.setShownSessions(['s1']);
    await service.execute({ action: 'open', sessionId: 's1', cwd: root, input: { targets: ['a.html'] } });
    const inline1 = await service.execute({
      action: 'open',
      sessionId: 's1',
      cwd: root,
      input: { content: { kind: 'chart', title: 'Chart', source: '{"series":[]}' } },
    });
    const chartTabId = inline1.tabs.find((t) => t.label === 'Chart')?.id;
    assert.ok(chartTabId);
    const firstInlineUrl = service.tabView('s1', chartTabId)?.panes[0]?.url;
    assert.ok(firstInlineUrl);

    // Updating the inline tab revokes the replaced virtual lease.
    await service.execute({
      action: 'open',
      sessionId: 's1',
      cwd: root,
      input: { content: { kind: 'chart', title: 'Chart', source: '{"series":[{"type":"bar"}]}' } },
    });
    assert.ok(revoked.includes(firstInlineUrl), 'replaced inline virtual lease is revoked');
    const secondInlineUrl = service.tabView('s1', chartTabId)?.panes[0]?.url;

    // Quick A -> B -> A switch stays inside MRU (limit 2): s1 is NOT parked.
    await service.setShownSessions(['s2']);
    await service.settled();
    assert.equal(activeWatchers.size, 1, 's1 stays warm inside recentShown MRU');
    assert.equal(revoked.includes(secondInlineUrl), false);

    // Switching to s3 evicts s1 from MRU (limit 2 -> s2, s3) and parks s1, revoking its virtual lease.
    await service.setShownSessions(['s3']);
    await service.settled();
    assert.equal(activeWatchers.size, 0, 'evicted MRU session parks and drops file watcher');
    assert.ok(revoked.includes(secondInlineUrl), 'parking revokes inline virtual lease');

    // A session viewed on a paired phone stays unparked even when the desktop window hides.
    await service.setShownSessions(['s-remote']);
    await service.execute({ action: 'open', sessionId: 's-remote', cwd: root, input: { targets: ['a.html'] } });
    assert.equal(activeWatchers.size, 1);
    await service.setShownSessions([]);
    await service.settled();
    assert.equal(activeWatchers.size, 1, 'remoteViewing session stays unparked when desktop window hides');
  } finally {
    service.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test('version store drops in-memory thumbnail after writing <dir>.png and reads it from disk', async () => {
  const { createVisualizeVersionStore } = await import('./versions.ts');
  const root = mkdtempSync(join(tmpdir(), 'mixdog-vis-ver-thumb-'));
  const filePath = join(root, 'pic.png');
  writeFileSync(filePath, 'PNG-BYTES');
  const store = createVisualizeVersionStore({ directory: join(root, 'versions') });
  try {
    await store.snapshot('s1', 'v1', [{ kind: 'image', path: filePath, root }]);
    const pic = `data:image/png;base64,${Buffer.from('CARD-1').toString('base64')}`;
    assert.equal(store.keepThumbnail('s1', 'v1', 1, pic), true);
    await store.settled();
    assert.equal(store.get('s1', 'v1', 1)?.thumbnail, undefined, 'thumbnail cleared from heap once written');
    assert.equal(await store.readThumbnail('s1', 'v1', 1), pic, 'thumbnail read back from disk');
  } finally {
    await store.dropSession('s1');
    rmSync(root, { recursive: true, force: true });
  }
});

test('failed park save preserves live tabs and watchers instead of dropping them', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-vis-park-fail-'));
  const filePath = join(root, 'page.html');
  writeFileSync(filePath, '<h1>live</h1>', 'utf8');
  const versionsDir = join(root, 'versions');

  const activeWatchers = new Map();
  let watcherSeq = 0;
  let leaseSeq = 0;
  const service = createVisualizeService({
    windowAvailable: () => true,
    browserAvailable: () => false,
    recentShownLimit: 0,
    versions: { directory: versionsDir },
    preparePane: async (target) => `http://127.0.0.1:4100/lease-${++leaseSeq}/${target.label}`,
    publish: () => {},
    watch(path) {
      const id = ++watcherSeq;
      activeWatchers.set(id, path);
      return () => activeWatchers.delete(id);
    },
    annotate: async () => [],
    capture: async () => Buffer.from('PNG'),
    onScreen: async () => 'visible',
    delay: async () => {},
  });

  try {
    await service.setShownSessions(['s1']);
    const opened = await service.execute({
      action: 'open',
      sessionId: 's1',
      cwd: root,
      input: { targets: ['page.html'] },
    });
    const tabId = opened.tabs[0].id;
    assert.equal(activeWatchers.size, 1);

    // Place a regular file at the sibling park directory so parkStore.save fails.
    writeFileSync(parkDirectoryFor(versionsDir), 'blocker', 'utf8');

    await service.setShownSessions(['s2']);
    await service.settled();

    assert.equal(activeWatchers.size, 1, 'failed park save keeps live watcher intact');
    assert.ok(service.tabView('s1', tabId), 'failed park save never destroys live tab');
  } finally {
    service.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test('concurrent wake during parkNow preserves live tabs and removes unused parked file', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-vis-park-wake-'));
  const filePath = join(root, 'page.html');
  writeFileSync(filePath, '<h1>live</h1>', 'utf8');
  const versionsDir = join(root, 'versions');
  const activeWatchers = new Map();
  let watcherSeq = 0;
  let leaseSeq = 0;

  const service = createVisualizeService({
    windowAvailable: () => true,
    browserAvailable: () => false,
    recentShownLimit: 0,
    versions: { directory: versionsDir },
    preparePane: async (target) => `http://127.0.0.1:4100/lease-${++leaseSeq}/${target.label}`,
    publish: () => {},
    watch(path) {
      const id = ++watcherSeq;
      activeWatchers.set(id, path);
      return () => activeWatchers.delete(id);
    },
    annotate: async () => [],
    capture: async () => Buffer.from('PNG'),
    onScreen: async () => 'visible',
    delay: async () => {},
  });

  try {
    await service.setShownSessions(['s1']);
    const opened = await service.execute({
      action: 'open',
      sessionId: 's1',
      cwd: root,
      input: { targets: ['page.html'] },
    });
    const tabId = opened.tabs[0].id;

    // Trigger parkNow (enters async parkStore.save), then immediately wake s1 before save completes.
    const parking = service.setShownSessions(['s2']);
    const waking = service.setShownSessions(['s1']);
    await Promise.all([parking, waking]);
    await service.settled();

    assert.equal(activeWatchers.size, 1, 'woken session keeps its live watcher');
    assert.ok(service.tabView('s1', tabId), 'woken session keeps its live tab');
    const parkedDir = parkDirectoryFor(versionsDir);
    const leftover = existsSync(parkedDir) ? readdirSync(parkedDir).filter((name) => name.endsWith('.json')) : [];
    assert.deepEqual(leftover, [], 'unused parked file from aborted park is cleaned up');
  } finally {
    service.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test('releaseSession and dispose mid-hydration do not resurrect sessions or leak watchers and inline leases', async () => {
  for (const mode of ['release', 'dispose']) {
    const root = mkdtempSync(join(tmpdir(), `mixdog-vis-hydrate-${mode}-`));
    const filePath = join(root, 'page.html');
    writeFileSync(filePath, '<h1>live</h1>', 'utf8');
    const versionsDir = join(root, 'versions');
    const activeWatchers = new Map();
    const revoked = [];
    let watcherSeq = 0;
    let leaseSeq = 0;
    let holdHydrate = false;
    let releaseHydrate;
    let inlineStarted;
    const inlineWaiting = new Promise((resolve) => (inlineStarted = resolve));

    const service = createVisualizeService({
      windowAvailable: () => true,
      browserAvailable: () => false,
      recentShownLimit: 0,
      versions: { directory: versionsDir },
      preparePane: async (target) => `http://127.0.0.1:4100/lease-${++leaseSeq}/${target.label}`,
      prepareInlinePage: async () => {
        const url = `http://127.0.0.1:4100/virtual-${++leaseSeq}/index.html`;
        if (holdHydrate) {
          inlineStarted();
          await new Promise((resolve) => (releaseHydrate = resolve));
        }
        return url;
      },
      revokeInlinePage: (url) => revoked.push(url),
      publish: () => {},
      watch(path) {
        const id = ++watcherSeq;
        activeWatchers.set(id, path);
        return () => activeWatchers.delete(id);
      },
      annotate: async () => [],
      capture: async () => Buffer.from('PNG'),
      onScreen: async () => 'visible',
      delay: async () => {},
    });

    try {
      await service.setShownSessions(['s1']);
      await service.execute({ action: 'open', sessionId: 's1', cwd: root, input: { targets: ['page.html'] } });
      await service.execute({
        action: 'open',
        sessionId: 's1',
        cwd: root,
        input: { content: { kind: 'html', title: 'Inline', source: '<p>x</p>' } },
      });
      await service.setShownSessions([]);
      await service.settled();
      assert.equal(activeWatchers.size, 0);
      revoked.length = 0;

      // Start hydration and suspend mid-flight while prepareInlinePage is awaiting.
      holdHydrate = true;
      const hydrating = service.setShownSessions(['s1']);
      await inlineWaiting;

      let finishing = Promise.resolve();
      if (mode === 'release') finishing = service.releaseSession('s1');
      else service.dispose();

      releaseHydrate();
      await Promise.all([hydrating, finishing]);
      await service.settled();

      assert.equal(service.snapshot().length, 0, `${mode} mid-hydration never resurrects the session`);
      assert.equal(activeWatchers.size, 0, `${mode} mid-hydration leaks zero file watchers`);
      assert.equal(revoked.length, 1, `${mode} mid-hydration revokes newly created inline lease`);
    } finally {
      service.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test('park store clears stale crash files on startup and removes parked JSON files on dispose', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-vis-park-clean-'));
  const parkedDir = join(root, 'parked');
  mkdirSync(parkedDir, { recursive: true });
  const staleFile = join(parkedDir, 'stale-from-crash.json');
  writeFileSync(staleFile, '{"stale":true}', 'utf8');

  const store = createVisualizeParkStore(parkedDir);
  try {
    await store.settled();
    assert.equal(existsSync(staleFile), false, 'stale parked JSON file from prior crash is cleared on startup');

    await store.save('s1', { active: null, counter: 1, history: [], tabs: [] });
    const created = readdirSync(parkedDir).filter((name) => name.endsWith('.json'));
    assert.equal(created.length, 1, 'saved session wrote one parked JSON file');

    store.dispose();
    await store.settled();
    assert.deepEqual(
      readdirSync(parkedDir).filter((name) => name.endsWith('.json')),
      [],
      'dispose removes parked JSON files even in a persistent directory'
    );
  } finally {
    store.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test('fast commands mutating live state while parkStore.save is in flight are not overwritten on rehydration', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-vis-park-mutate-'));
  const fileA = join(root, 'a.html');
  const fileB = join(root, 'b.html');
  writeFileSync(fileA, '<h1>A</h1>', 'utf8');
  writeFileSync(fileB, '<h1>B</h1>', 'utf8');
  const versionsDir = join(root, 'versions');
  const innerStore = createVisualizeParkStore(join(versionsDir, 'parked'));

  let holdFirstSave = true;
  let firstSaveStarted;
  const firstSaveWaiting = new Promise((resolve) => (firstSaveStarted = resolve));
  let releaseFirstSave;
  const parkStore = {
    ...innerStore,
    async save(sessionId, data) {
      if (holdFirstSave) {
        holdFirstSave = false;
        firstSaveStarted();
        await new Promise((resolve) => (releaseFirstSave = resolve));
      }
      return innerStore.save(sessionId, data);
    },
  };

  let leaseSeq = 0;
  let mutationsApplied;
  const bothMutationsDone = new Promise((resolve) => (mutationsApplied = resolve));
  let tabA;
  let tabB;
  const service = createVisualizeService({
    windowAvailable: () => true,
    browserAvailable: () => false,
    recentShownLimit: 0,
    versions: { directory: versionsDir },
    parkStore,
    preparePane: async (target) => `http://127.0.0.1:4100/lease-${++leaseSeq}/${target.label}`,
    publish: (event) => {
      if (
        tabA &&
        tabB &&
        event.sessionId === 's1' &&
        event.state.tabs.length === 1 &&
        event.state.tabs[0].id === tabA &&
        event.state.tabs[0].networkAllowed === undefined
      ) {
        mutationsApplied();
      }
    },
    watch: () => () => {},
    annotate: async () => [],
    capture: async () => Buffer.from('PNG'),
    onScreen: async () => 'visible',
    delay: async () => {},
  });

  try {
    await service.setShownSessions(['s1']);
    const openA = await service.execute({
      action: 'open',
      sessionId: 's1',
      cwd: root,
      input: { targets: ['a.html'] },
    });
    const openB = await service.execute({
      action: 'open',
      sessionId: 's1',
      cwd: root,
      input: { targets: ['b.html'] },
    });
    tabA = openA.tabs[0].id;
    tabB = openB.tabs[0].id;
    assert.equal(service.tabView('s1', tabA)?.networkAllowed, true);

    // Start parking s1 and suspend while parkStore.save is writing the pre-mutation snapshot.
    const parking = service.setShownSessions(['s2']);
    await firstSaveWaiting;

    // Mutate state in place while the first park save is still in flight: close tabB and disable network on tabA.
    const closeCmd = service.command({ action: 'close', sessionId: 's1', tabId: tabB });
    const networkCmd = service.command({ action: 'network', sessionId: 's1', tabId: tabA, allow: false });
    await bothMutationsDone;
    // Let both withSessionOp finally blocks drop activeOps back to 0 before the first save resolves.
    await Promise.resolve();

    // Release the stale first save so parking finishes cleanly.
    releaseFirstSave();
    await Promise.all([parking, closeCmd, networkCmd]);
    await service.settled();

    // Session should now be parked with the post-mutation state; rehydrate and verify.
    await service.setShownSessions(['s1']);
    await service.settled();

    const restored = service.snapshot().find((entry) => entry.sessionId === 's1');
    assert.ok(restored, 'session rehydrates cleanly');
    assert.deepEqual(
      restored.tabs.map((tab) => tab.id),
      [tabA],
      'closed tabB is never resurrected by stale park snapshot'
    );
    assert.equal(
      restored.tabs[0].networkAllowed,
      undefined,
      'networkAllowed=false mutation is preserved across park and rehydrate'
    );
  } finally {
    service.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test('hydrating a kept-version inline tab claims the live lease so Back to live keeps enforcing disabled network', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-vis-hydrate-lease-'));
  const versionsDir = join(root, 'versions');
  let leaseSeq = 0;

  const service = createVisualizeService({
    windowAvailable: () => true,
    browserAvailable: () => false,
    recentShownLimit: 0,
    versions: { directory: versionsDir },
    preparePane: async (target) => `http://127.0.0.1:4100/lease-${++leaseSeq}/${target.label}`,
    prepareInlinePage: async () => `http://127.0.0.1:4100/virtual-${++leaseSeq}/index.html`,
    publish: () => {},
    watch: () => () => {},
    annotate: async () => [],
    capture: async () => Buffer.from('PNG'),
    onScreen: async () => 'visible',
    delay: async () => {},
  });

  try {
    await service.setShownSessions(['s1']);
    const first = await service.execute({
      action: 'open',
      sessionId: 's1',
      cwd: root,
      input: { content: { kind: 'html', title: 'App', source: '<p>v1</p>' } },
    });
    const tabId = first.tabs[0].id;
    await service.execute({
      action: 'open',
      sessionId: 's1',
      cwd: root,
      input: { content: { kind: 'html', title: 'App', source: '<p>v2</p>' } },
    });
    await service.command({ action: 'network', sessionId: 's1', tabId, allow: false });
    await service.command({ action: 'version', sessionId: 's1', tabId, version: 1, compare: false });

    // Park while viewing kept version 1 (compare off), then rehydrate.
    await service.setShownSessions([]);
    await service.settled();
    await service.setShownSessions(['s1']);
    await service.settled();

    const keptUrl = service.tabView('s1', tabId)?.panes[0]?.url;
    assert.ok(keptUrl);
    assert.equal(
      service.guardRequest([keptUrl], { url: 'https://evil.example/data', resourceType: 'xhr' }),
      true,
      'kept version lease blocks external network after hydrate'
    );

    // Click "Back to live" and verify the live inline HTML lease is claimed and blocks external network.
    await service.command({ action: 'version', sessionId: 's1', tabId, version: null, compare: false });
    const liveUrl = service.tabView('s1', tabId)?.panes[0]?.url;
    assert.ok(liveUrl && liveUrl !== keptUrl);
    assert.equal(
      service.guardRequest([liveUrl], { url: 'https://evil.example/data', resourceType: 'xhr' }),
      true,
      'live inline lease prepared during hydrate enforces disabled network after Back to live'
    );
  } finally {
    service.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test('lease-guard retains minimal policy metadata instead of TabState and syncs network policy updates', async () => {
  const { createLeaseGuard } = await import('./lease-guard.ts');
  const blocked = [];
  const guard = createLeaseGuard((lease, kind, message) => blocked.push({ lease, kind, message }));

  const url = 'http://127.0.0.1:4100/lease-abc/index.html';
  const claimAndDrop = () => {
    const tab = { id: 'v1', allowNetwork: false, inline: { kind: 'html', source: 'x'.repeat(1024) } };
    const ref = new WeakRef(tab);
    guard.claimLeases('s1', tab, [{ kind: 'html', label: 'index.html', target: 'index.html', url }]);

    assert.equal(guard.guardRequest([url], { url: 'https://outside.test/a', resourceType: 'fetch' }), true);
    assert.equal(blocked.length, 1);

    tab.allowNetwork = true;
    guard.updatePolicy('s1', tab);
    assert.equal(guard.guardRequest([url], { url: 'https://outside.test/b', resourceType: 'fetch' }), false);

    tab.allowNetwork = false;
    guard.updatePolicy('s1', tab);
    return ref;
  };
  const ref = claimAndDrop();
  // Last policy remains enforced even after TabState reference is dropped.
  assert.equal(guard.guardRequest([url], { url: 'https://outside.test/c', resourceType: 'fetch' }), true);
  assert.equal(blocked.length, 2);
  if (typeof globalThis.gc === 'function') {
    await new Promise((resolve) => setImmediate(resolve));
    globalThis.gc();
    assert.equal(ref.deref(), undefined, 'TabState is eligible for GC once unreferenced');
  }
});

test('pre-park leases enforce network restrictions toggled off after park and rehydrate', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-vis-prepark-policy-'));
  writeFileSync(join(root, 'page.html'), '<h1>page</h1>', 'utf8');
  const versionsDir = join(root, 'versions');
  let leaseSeq = 0;

  const service = createVisualizeService({
    windowAvailable: () => true,
    browserAvailable: () => false,
    recentShownLimit: 0,
    versions: { directory: versionsDir },
    preparePane: async (target) => `http://127.0.0.1:4100/lease-${++leaseSeq}/${target.label}`,
    publish: () => {},
    watch: () => () => {},
    annotate: async () => [],
    capture: async () => Buffer.from('PNG'),
    onScreen: async () => 'visible',
    delay: async () => {},
  });

  try {
    await service.setShownSessions(['s1']);
    const opened = await service.execute({
      action: 'open',
      sessionId: 's1',
      cwd: root,
      input: { targets: ['page.html'] },
    });
    const tabId = opened.tabs[0].id;
    const preParkUrl = service.tabView('s1', tabId)?.panes[0]?.url;
    assert.ok(preParkUrl);
    assert.equal(service.guardRequest([preParkUrl], { url: 'https://outside.test/a', resourceType: 'fetch' }), false);

    // Park and rehydrate so a fresh TabState object is created for the same (s1, tabId).
    await service.setShownSessions([]);
    await service.settled();
    await service.setShownSessions(['s1']);
    await service.settled();

    const postHydrateUrl = service.tabView('s1', tabId)?.panes[0]?.url;
    assert.ok(postHydrateUrl && postHydrateUrl !== preParkUrl);

    // Disable network on the rehydrated tab: BOTH pre-park and post-hydrate leases must now block network.
    await service.command({ action: 'network', sessionId: 's1', tabId, allow: false });
    assert.equal(
      service.guardRequest([postHydrateUrl], { url: 'https://outside.test/b', resourceType: 'fetch' }),
      true,
      'post-hydrate lease enforces allowNetwork=false'
    );
    assert.equal(
      service.guardRequest([preParkUrl], { url: 'https://outside.test/c', resourceType: 'fetch' }),
      true,
      'pre-park lease enforces allowNetwork=false toggled after rehydration'
    );
  } finally {
    service.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test('turn starting while session is parked preserves previous tabs in snapshots and after mid-turn hydration', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-vis-park-turn-'));
  writeFileSync(join(root, 'a.html'), '<h1>A</h1>', 'utf8');
  writeFileSync(join(root, 'b.html'), '<h1>B</h1>', 'utf8');
  const versionsDir = join(root, 'versions');
  const events = [];
  let leaseSeq = 0;

  const service = createVisualizeService({
    windowAvailable: () => true,
    browserAvailable: () => false,
    recentShownLimit: 0,
    versions: { directory: versionsDir },
    preparePane: async (target) => `http://127.0.0.1:4100/lease-${++leaseSeq}/${target.label}`,
    publish: (event) => events.push(event),
    watch: () => () => {},
    annotate: async () => [],
    capture: async () => Buffer.from('PNG'),
    onScreen: async () => 'visible',
    delay: async () => {},
  });

  try {
    await service.setShownSessions(['s1']);
    const first = await service.execute({
      action: 'open',
      sessionId: 's1',
      cwd: root,
      input: { targets: ['a.html'] },
    });
    const tabA = first.tabs[0].id;

    // Park s1 while idle.
    await service.setShownSessions(['s2']);
    await service.settled();
    assert.equal(service.tabView('s1', tabA), null);

    // Start a turn while s1 is parked: snapshots must keep s1's previous tab visible and marked held.
    await service.setTurnActive('s1', true);
    const parkedHeldSnap = service.snapshot().find((entry) => entry.sessionId === 's1');
    assert.ok(parkedHeldSnap, 'parked session with active turn stays in snapshot()');
    assert.equal(parkedHeldSnap.held, true);
    assert.deepEqual(
      parkedHeldSnap.tabs.map((t) => t.id),
      [tabA],
      'previous tab stays visible while turn runs on parked session'
    );
    const parkedHeldHost = service.hostSnapshot().find((entry) => entry.sessionId === 's1');
    assert.equal(parkedHeldHost?.held, true);
    assert.deepEqual(
      parkedHeldHost?.tabs.map((t) => t.id),
      [tabA]
    );

    // Switch back to s1 mid-turn: hydration refreshes hold.shown with live URLs for previous tabs.
    events.length = 0;
    await service.setShownSessions(['s1']);
    await service.settled();
    const hydratedHeldSnap = service.snapshot().find((entry) => entry.sessionId === 's1');
    assert.equal(hydratedHeldSnap?.held, true);
    assert.deepEqual(
      hydratedHeldSnap?.tabs.map((t) => t.id),
      [tabA]
    );
    assert.ok(hydratedHeldSnap?.tabs[0]?.panes[0]?.url, 'hydrated mid-turn tab has a live URL');
    assert.equal(events.at(-1)?.held, true);
    assert.ok(events.at(-1)?.state.tabs[0]?.panes[0]?.url);

    // Agent opens b.html during the same turn: stays held behind a.html until turn end.
    await service.execute({ action: 'open', sessionId: 's1', cwd: root, input: { targets: ['b.html'] } });
    assert.deepEqual(
      service
        .snapshot()
        .find((entry) => entry.sessionId === 's1')
        ?.tabs.map((t) => t.id),
      [tabA]
    );

    await service.setTurnActive('s1', false);
    const afterEnd = service.snapshot().find((entry) => entry.sessionId === 's1');
    assert.equal(afterEnd?.held, undefined);
    assert.equal(afterEnd?.tabs.length, 2);
  } finally {
    service.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test('hiding window while parked session hydration is pending aborts hydration without leaking watchers or leases', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-vis-hide-mid-hydrate-'));
  writeFileSync(join(root, 'page.html'), '<h1>live</h1>', 'utf8');
  const versionsDir = join(root, 'versions');
  const activeWatchers = new Map();
  const revoked = [];
  let watcherSeq = 0;
  let leaseSeq = 0;
  let holdHydrate = false;
  let hydrateBlocked;
  const hydrateWaiting = new Promise((resolve) => (hydrateBlocked = resolve));
  let releaseHydrate;

  const service = createVisualizeService({
    windowAvailable: () => true,
    browserAvailable: () => false,
    recentShownLimit: 0,
    versions: { directory: versionsDir },
    preparePane: async (target) => `http://127.0.0.1:4100/lease-${++leaseSeq}/${target.label}`,
    prepareInlinePage: async () => {
      const url = `http://127.0.0.1:4100/virtual-${++leaseSeq}/index.html`;
      if (holdHydrate) {
        holdHydrate = false;
        hydrateBlocked();
        await new Promise((resolve) => (releaseHydrate = resolve));
      }
      return url;
    },
    revokeInlinePage: (url) => revoked.push(url),
    publish: () => {},
    watch(path) {
      const id = ++watcherSeq;
      activeWatchers.set(id, path);
      return () => activeWatchers.delete(id);
    },
    annotate: async () => [],
    capture: async () => Buffer.from('PNG'),
    onScreen: async () => 'visible',
    delay: async () => {},
  });

  try {
    await service.setShownSessions(['s1']);
    const fileOpen = await service.execute({
      action: 'open',
      sessionId: 's1',
      cwd: root,
      input: { targets: ['page.html'] },
    });
    await service.execute({
      action: 'open',
      sessionId: 's1',
      cwd: root,
      input: { content: { kind: 'html', title: 'Inline', source: '<p>x</p>' } },
    });
    const fileTabId = fileOpen.tabs[0].id;

    // Park s1.
    await service.setShownSessions([]);
    await service.settled();
    assert.equal(activeWatchers.size, 0);
    revoked.length = 0;

    // Begin hydrating s1, then hide the window before pane prep resolves.
    holdHydrate = true;
    const showing = service.setShownSessions(['s1']);
    await hydrateWaiting;
    const hiding = service.setShownSessions([]);
    releaseHydrate();
    await Promise.all([showing, hiding]);
    await service.settled();

    assert.equal(activeWatchers.size, 0, 'aborted hydration arms zero file watchers');
    assert.equal(service.tabView('s1', fileTabId), null, 'session stays parked after hide during pending hydration');
    assert.equal(revoked.length, 1, 'prepared inline virtual lease is revoked when hydration aborts on hide');
    assert.equal(service.snapshot().find((entry) => entry.sessionId === 's1')?.tabs.length, 2);

    // A later show still hydrates cleanly from the preserved parked snapshot.
    await service.setShownSessions(['s1']);
    await service.settled();
    assert.equal(activeWatchers.size, 1);
    assert.ok(service.tabView('s1', fileTabId));
  } finally {
    service.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test('hydrating a tab whose parent directory disappeared while parked recovers when directory and file return', async () => {
  const { watchFile } = await import('./host-file-watch.ts');
  const root = mkdtempSync(join(tmpdir(), 'mixdog-vis-missing-dir-'));
  const subDir = join(root, 'sub');
  mkdirSync(subDir, { recursive: true });
  const filePath = join(subDir, 'page.html');
  writeFileSync(filePath, '<h1>v1</h1>', 'utf8');
  const versionsDir = join(root, 'versions');
  let leaseSeq = 0;

  const service = createVisualizeService({
    windowAvailable: () => true,
    browserAvailable: () => false,
    recentShownLimit: 0,
    versions: { directory: versionsDir },
    preparePane: async (target) => {
      if (!existsSync(target.path)) {
        const error = new Error(`ENOENT: ${target.path}`);
        error.code = 'ENOENT';
        throw error;
      }
      return `http://127.0.0.1:4100/lease-${++leaseSeq}/${target.label}`;
    },
    publish: () => {},
    watch: watchFile,
    annotate: async () => [],
    capture: async () => Buffer.from('PNG'),
    onScreen: async () => 'visible',
    delay: async () => {},
    reloadDebounceMs: 25,
  });

  try {
    await service.setShownSessions(['s1']);
    const opened = await service.execute({
      action: 'open',
      sessionId: 's1',
      cwd: root,
      input: { targets: ['sub/page.html'] },
    });
    const tabId = opened.tabs[0].id;

    // Park s1, then remove the entire parent directory while parked.
    await service.setShownSessions([]);
    await service.settled();
    rmSync(subDir, { recursive: true, force: true });

    // Hydrate while directory is absent: tab shows missing placeholder and arms retry recovery.
    await service.setShownSessions(['s1']);
    await service.settled();
    assert.equal(service.tabView('s1', tabId)?.missing, true);
    assert.equal(service.tabView('s1', tabId)?.panes[0]?.url, '');

    // Recreate directory and file; the armed missing-file retry must recover the tab automatically.
    mkdirSync(subDir, { recursive: true });
    writeFileSync(filePath, '<h1>recovered</h1>', 'utf8');

    const deadline = Date.now() + 2000;
    while (Date.now() < deadline && service.tabView('s1', tabId)?.missing) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    await service.settled();

    const recovered = service.tabView('s1', tabId);
    assert.equal(recovered?.missing, undefined, 'tab recovered from missing state once directory and file returned');
    assert.ok(recovered?.panes[0]?.url, 'recovered tab received a fresh lease URL');
  } finally {
    service.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test('releaseSession during operation-driven hydration aborts pending operation without resurrecting session', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-vis-op-release-'));
  writeFileSync(join(root, 'a.html'), '<h1>A</h1>', 'utf8');
  writeFileSync(join(root, 'b.html'), '<h1>B</h1>', 'utf8');
  const versionsDir = join(root, 'versions');
  const activeWatchers = new Map();
  let watcherSeq = 0;
  let leaseSeq = 0;
  let holdHydrate = false;
  let hydrateStarted;
  const hydrateWaiting = new Promise((resolve) => (hydrateStarted = resolve));
  let releaseHydrate;

  const service = createVisualizeService({
    windowAvailable: () => true,
    browserAvailable: () => false,
    recentShownLimit: 0,
    versions: { directory: versionsDir },
    preparePane: async (target) => {
      if (holdHydrate) {
        holdHydrate = false;
        hydrateStarted();
        await new Promise((resolve) => (releaseHydrate = resolve));
      }
      return `http://127.0.0.1:4100/lease-${++leaseSeq}/${target.label}`;
    },
    publish: () => {},
    watch(path) {
      const id = ++watcherSeq;
      activeWatchers.set(id, path);
      return () => activeWatchers.delete(id);
    },
    annotate: async () => [],
    capture: async () => Buffer.from('PNG'),
    onScreen: async () => 'visible',
    delay: async () => {},
  });

  try {
    await service.setShownSessions(['s1']);
    await service.execute({ action: 'open', sessionId: 's1', cwd: root, input: { targets: ['a.html'] } });
    await service.setShownSessions([]);
    await service.settled();
    assert.equal(activeWatchers.size, 0);

    // Start an operation on parked s1 that suspends during hydration, then delete s1 mid-hydration.
    holdHydrate = true;
    const pendingOp = service.execute({ action: 'open', sessionId: 's1', cwd: root, input: { targets: ['b.html'] } });
    await hydrateWaiting;

    const releasing = service.releaseSession('s1');
    releaseHydrate();

    await assert.rejects(pendingOp, /released/);
    await releasing;
    await service.settled();

    assert.deepEqual(service.snapshot(), [], 'deleted session is never resurrected by pending operation');
    assert.equal(activeWatchers.size, 0, 'deleted session arms zero file watchers');
  } finally {
    service.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test('hydration re-resolves original symlink targets and detects missing symlink even when old target remains', async (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mixdog-vis-hydrate-symlink-')));
  const dirV1 = join(root, 'dir-v1');
  const dirV2 = join(root, 'dir-v2');
  mkdirSync(dirV1, { recursive: true });
  mkdirSync(dirV2, { recursive: true });
  const v1 = join(dirV1, 'page.html');
  const v2 = join(dirV2, 'page.html');
  const linkDir = join(root, 'current');
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  writeFileSync(v1, '<h1>v1</h1>', 'utf8');
  writeFileSync(v2, '<h1>v2</h1>', 'utf8');
  try {
    symlinkSync(dirV1, linkDir, linkType);
  } catch {
    rmSync(root, { recursive: true, force: true });
    t.skip('directory symlinks unavailable');
    return;
  }

  const versionsDir = join(root, 'versions');
  const preparedPaths = [];
  const watchedPaths = [];
  let leaseSeq = 0;

  const service = createVisualizeService({
    windowAvailable: () => true,
    browserAvailable: () => false,
    recentShownLimit: 0,
    versions: { directory: versionsDir },
    preparePane: async (target) => {
      preparedPaths.push(target.path);
      return `http://127.0.0.1:4100/lease-${++leaseSeq}/${target.label}`;
    },
    publish: () => {},
    watch(path) {
      watchedPaths.push(path);
      return () => {};
    },
    annotate: async () => [],
    capture: async () => Buffer.from('PNG'),
    onScreen: async () => 'visible',
    delay: async () => {},
    reloadDebounceMs: 25,
  });

  try {
    await service.setShownSessions(['s1']);
    const opened = await service.execute({
      action: 'open',
      sessionId: 's1',
      cwd: root,
      input: { targets: ['current/page.html'] },
    });
    const tabId = opened.tabs[0].id;
    assert.equal(preparedPaths.at(-1), v1);

    // Park s1 and retarget symlink from dir-v1 -> dir-v2 while parked.
    await service.setShownSessions([]);
    await service.settled();
    unlinkSync(linkDir);
    symlinkSync(dirV2, linkDir, linkType);
    preparedPaths.length = 0;
    watchedPaths.length = 0;

    // Hydrate: must re-resolve current/page.html to dir-v2/page.html and watch v2.
    await service.setShownSessions(['s1']);
    await service.settled();
    assert.equal(preparedPaths.at(-1), v2, 'hydration prepares the new symlink target dir-v2/page.html');
    assert.equal(watchedPaths.at(-1), v2, 'hydration watches the new symlink target dir-v2/page.html');

    // Park again and delete the symlink while dir-v2/page.html still exists on disk.
    await service.setShownSessions([]);
    await service.settled();
    unlinkSync(linkDir);
    preparedPaths.length = 0;

    await service.setShownSessions(['s1']);
    await service.settled();
    assert.equal(preparedPaths.length, 0, 'deleted symlink is not prepared from stale resolved path');
    assert.equal(service.tabView('s1', tabId)?.missing, true, 'deleted symlink hydrates as missing');

    // Recreate symlink -> dir-v1; armed missing-file retry recovers automatically.
    symlinkSync(dirV1, linkDir, linkType);
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline && service.tabView('s1', tabId)?.missing) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    await service.settled();
    assert.equal(service.tabView('s1', tabId)?.missing, undefined);
    assert.equal(preparedPaths.at(-1), v1, 'recreated symlink recovers to its new target');
  } finally {
    service.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test('non-HTML tab churn does not evict tracked HTML policy boxes across park, hydrate, and updatePolicy', async () => {
  const { createLeaseGuard } = await import('./lease-guard.ts');
  const guard = createLeaseGuard(() => {});

  const preParkUrl = 'http://127.0.0.1:4100/lease-prepark/index.html';
  const preParkTab = { id: 'v1', allowNetwork: true };
  guard.claimLeases('s1', preParkTab, [{ kind: 'html', label: 'index.html', target: 'index.html', url: preParkUrl }]);
  assert.equal(guard.guardRequest([preParkUrl], { url: 'https://outside.test/a', resourceType: 'fetch' }), false);

  // Churn more than MAX_TRACKED_LEASES (4096) distinct non-HTML tabs across sessions.
  for (let i = 0; i < 4200; i += 1) {
    guard.claimLeases(`non-html-${i}`, { id: `t${i}`, allowNetwork: true }, [
      { kind: 'image', label: 'pic.png', target: 'pic.png', url: `http://127.0.0.1:4100/img-${i}/pic.png` },
      { kind: 'inline', label: 'Chart', target: 'Chart', url: '' },
    ]);
  }

  // Simulate park + hydrate with a fresh TabState object and a fresh lease for the same (s1, v1).
  const postHydrateUrl = 'http://127.0.0.1:4100/lease-posthydrate/index.html';
  const hydratedTab = { id: 'v1', allowNetwork: true };
  guard.claimLeases('s1', hydratedTab, [
    { kind: 'html', label: 'index.html', target: 'index.html', url: postHydrateUrl },
  ]);

  // Toggle network off on the hydrated tab: both post-hydrate and retained pre-park leases must block.
  hydratedTab.allowNetwork = false;
  guard.updatePolicy('s1', hydratedTab);
  assert.equal(
    guard.guardRequest([postHydrateUrl], { url: 'https://outside.test/b', resourceType: 'fetch' }),
    true,
    'post-hydrate lease enforces allowNetwork=false'
  );
  assert.equal(
    guard.guardRequest([preParkUrl], { url: 'https://outside.test/c', resourceType: 'fetch' }),
    true,
    'retained pre-park lease still receives updatePolicy after heavy non-HTML tab churn'
  );
});

test('releaseSession during await recordVersion aborts open without recreating or publishing deleted session', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-vis-release-record-ver-'));
  writeFileSync(join(root, 'page.html'), '<h1>hello</h1>', 'utf8');
  const versionsDir = join(root, 'versions');
  const activeWatchers = new Map();
  const events = [];
  let watcherSeq = 0;
  let leaseSeq = 0;
  let releasePromise = null;

  const service = createVisualizeService({
    windowAvailable: () => true,
    browserAvailable: () => false,
    recentShownLimit: 0,
    versions: { directory: versionsDir },
    preparePane: async (target) => `http://127.0.0.1:4100/lease-${++leaseSeq}/${target.label}`,
    publish: (event) => events.push(event),
    watch(path) {
      const id = ++watcherSeq;
      activeWatchers.set(id, path);
      if (!releasePromise) {
        // watchTab runs immediately before await recordVersion; release s1 on the next microtask while recordVersion awaits.
        queueMicrotask(() => {
          releasePromise = service.releaseSession('s1');
        });
      }
      return () => activeWatchers.delete(id);
    },
    annotate: async () => [],
    capture: async () => Buffer.from('PNG'),
    onScreen: async () => 'visible',
    delay: async () => {},
  });

  try {
    await service.setShownSessions(['s1']);
    await assert.rejects(
      service.execute({ action: 'open', sessionId: 's1', cwd: root, input: { targets: ['page.html'] } }),
      /released/
    );
    assert.ok(releasePromise, 'releaseSession was triggered while recordVersion was in flight');
    await releasePromise;
    await service.settled();

    assert.deepEqual(service.snapshot(), [], 'deleted session is not recreated by finishOpen after recordVersion');
    assert.deepEqual(
      events.filter((event) => event.sessionId === 's1'),
      [],
      'deleted tab is never published after releaseSession during recordVersion'
    );
    assert.equal(activeWatchers.size, 0, 'watcher created before recordVersion is cleaned up');
  } finally {
    service.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test('missing symlink tab after hydration drops stale target paths and refuses source and read commands', async (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mixdog-vis-missing-symlink-read-')));
  const dirV1 = join(root, 'dir-v1');
  mkdirSync(dirV1, { recursive: true });
  const v1 = join(dirV1, 'page.html');
  const linkDir = join(root, 'current');
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  writeFileSync(v1, '<h1>old-secret-v1</h1>', 'utf8');
  try {
    symlinkSync(dirV1, linkDir, linkType);
  } catch {
    rmSync(root, { recursive: true, force: true });
    t.skip('directory symlinks unavailable');
    return;
  }

  const versionsDir = join(root, 'versions');
  let leaseSeq = 0;
  const service = createVisualizeService({
    windowAvailable: () => true,
    browserAvailable: () => false,
    recentShownLimit: 0,
    versions: { directory: versionsDir },
    preparePane: async (target) => `http://127.0.0.1:4100/lease-${++leaseSeq}/${target.label}`,
    publish: () => {},
    watch: () => () => {},
    annotate: async () => [],
    capture: async () => Buffer.from('PNG'),
    inspect: async () => [{ pane: 'page.html', result: { ok: true } }],
    act: async () => [{ step: 'click', ok: true }],
    onScreen: async () => 'visible',
    delay: async () => {},
    reloadDebounceMs: 60_000,
  });

  try {
    await service.setShownSessions(['s1']);
    const opened = await service.execute({
      action: 'open',
      sessionId: 's1',
      cwd: root,
      input: { targets: ['current/page.html'] },
    });
    const tabId = opened.tabs[0].id;
    assert.equal((await service.paneText('s1', tabId, 0)).text, '<h1>old-secret-v1</h1>');

    // Park s1 and delete the symlink while dir-v1/page.html still exists on disk.
    await service.setShownSessions([]);
    await service.settled();
    unlinkSync(linkDir);

    await service.setShownSessions(['s1']);
    await service.settled();

    assert.equal(service.tabView('s1', tabId)?.missing, true);
    const hostPane = service.hostSnapshot().find((entry) => entry.sessionId === 's1')?.tabs[0]?.panes[0];
    assert.equal(hostPane?.path, '', 'missing hydrated tab retains no stale canonical path');

    await assert.rejects(service.paneText('s1', tabId, 0), /missing/);
    await assert.rejects(
      service.execute({ action: 'check', sessionId: 's1', cwd: root, input: { tab: tabId } }),
      /missing/
    );
    await assert.rejects(
      service.execute({ action: 'inspect', sessionId: 's1', cwd: root, input: { tab: tabId } }),
      /missing/
    );
    await assert.rejects(
      service.execute({
        action: 'act',
        sessionId: 's1',
        cwd: root,
        input: { tab: tabId, steps: [{ do: 'click', selector: 'h1' }] },
      }),
      /missing/
    );
    await assert.rejects(
      service.execute({ action: 'capture', sessionId: 's1', cwd: root, input: { tab: tabId, output: 'out.png' } }),
      /missing/
    );
    await assert.rejects(
      service.execute({ action: 'annotate', sessionId: 's1', cwd: root, input: { tab: tabId, clear: true } }),
      /missing/
    );
  } finally {
    service.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test('retargeted symlink recomputes hydrated tab key so reopening updates existing tab and version history', async (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mixdog-vis-retarget-key-')));
  const dirV1 = join(root, 'dir-v1');
  const dirV2 = join(root, 'dir-v2');
  mkdirSync(dirV1, { recursive: true });
  mkdirSync(dirV2, { recursive: true });
  const v1 = join(dirV1, 'page.html');
  const v2 = join(dirV2, 'page.html');
  const linkDir = join(root, 'current');
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  writeFileSync(v1, '<h1>v1</h1>', 'utf8');
  writeFileSync(v2, '<h1>v2</h1>', 'utf8');
  try {
    symlinkSync(dirV1, linkDir, linkType);
  } catch {
    rmSync(root, { recursive: true, force: true });
    t.skip('directory symlinks unavailable');
    return;
  }

  const versionsDir = join(root, 'versions');
  let leaseSeq = 0;
  const service = createVisualizeService({
    windowAvailable: () => true,
    browserAvailable: () => false,
    recentShownLimit: 0,
    versions: { directory: versionsDir },
    preparePane: async (target) => `http://127.0.0.1:4100/lease-${++leaseSeq}/${target.label}`,
    publish: () => {},
    watch: () => () => {},
    annotate: async () => [],
    capture: async () => Buffer.from('PNG'),
    onScreen: async () => 'visible',
    delay: async () => {},
  });

  try {
    await service.setShownSessions(['s1']);
    const first = await service.execute({
      action: 'open',
      sessionId: 's1',
      cwd: root,
      input: { targets: ['current/page.html'] },
    });
    const tabId = first.tabs[0].id;
    assert.equal(service.tabView('s1', tabId)?.versions?.length, 1);

    // Park s1, retarget symlink from dir-v1 -> dir-v2, and hydrate.
    await service.setShownSessions([]);
    await service.settled();
    unlinkSync(linkDir);
    symlinkSync(dirV2, linkDir, linkType);
    await service.setShownSessions(['s1']);
    await service.settled();

    // Reopening the retargeted path must reuse the hydrated tab and append to its version history.
    const reopened = await service.execute({
      action: 'open',
      sessionId: 's1',
      cwd: root,
      input: { targets: ['current/page.html'] },
    });
    assert.equal(reopened.tabs[0].id, tabId, 'reopening retargeted symlink reuses hydrated tab instead of duplicating');
    const snap = service.snapshot().find((entry) => entry.sessionId === 's1');
    assert.equal(snap?.tabs.length, 1, 'no duplicate tab created for retargeted symlink');
    assert.equal(service.tabView('s1', tabId)?.versions?.length, 2, 'version history preserved across retargeted open');
  } finally {
    service.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test('setShownSessions queued behind non-publishing paneText hydration publishes restored pane URLs', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-vis-overlap-hydrate-'));
  writeFileSync(join(root, 'page.html'), '<h1>restored</h1>', 'utf8');
  const versionsDir = join(root, 'versions');
  const events = [];
  let leaseSeq = 0;
  let holdPrepare = false;
  let prepareStarted;
  const prepareWaiting = new Promise((resolve) => (prepareStarted = resolve));
  let releasePrepare;

  const service = createVisualizeService({
    windowAvailable: () => true,
    browserAvailable: () => false,
    recentShownLimit: 0,
    versions: { directory: versionsDir },
    preparePane: async (target) => {
      if (holdPrepare) {
        holdPrepare = false;
        prepareStarted();
        await new Promise((resolve) => (releasePrepare = resolve));
      }
      return `http://127.0.0.1:4100/lease-${++leaseSeq}/${target.label}`;
    },
    publish: (event) => events.push(event),
    watch: () => () => {},
    annotate: async () => [],
    capture: async () => Buffer.from('PNG'),
    onScreen: async () => 'visible',
    delay: async () => {},
  });

  try {
    await service.setShownSessions(['s1']);
    const opened = await service.execute({
      action: 'open',
      sessionId: 's1',
      cwd: root,
      input: { targets: ['page.html'] },
    });
    const tabId = opened.tabs[0].id;

    // Park s1 while hidden.
    await service.setShownSessions([]);
    await service.settled();
    events.length = 0;

    // Start operation-driven hydration (paneText uses publishAfter: false) and overlap setShownSessions(['s1']).
    holdPrepare = true;
    const textPromise = service.paneText('s1', tabId, 0);
    await prepareWaiting;

    const showPromise = service.setShownSessions(['s1']);
    releasePrepare();

    const [textResult] = await Promise.all([textPromise, showPromise]);
    await service.settled();

    assert.equal(textResult.text, '<h1>restored</h1>');
    const published = events.filter((event) => event.sessionId === 's1');
    assert.ok(published.length > 0, 'overlapping setShownSessions publishes restored state once hydration finishes');
    const publishedUrl = published.at(-1)?.state?.tabs?.[0]?.panes?.[0]?.url;
    assert.ok(publishedUrl, 'published restored snapshot carries a live pane URL');
    assert.equal(publishedUrl, service.tabView('s1', tabId)?.panes[0]?.url);
  } finally {
    service.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test('reopening a restored file before missing retry fires clears tab.missing so paneText succeeds', async (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mixdog-vis-reopen-missing-')));
  const dirV1 = join(root, 'dir-v1');
  mkdirSync(dirV1, { recursive: true });
  const v1 = join(dirV1, 'page.html');
  const linkDir = join(root, 'current');
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  writeFileSync(v1, '<h1>restored-before-retry</h1>', 'utf8');
  try {
    symlinkSync(dirV1, linkDir, linkType);
  } catch {
    rmSync(root, { recursive: true, force: true });
    t.skip('directory symlinks unavailable');
    return;
  }

  const versionsDir = join(root, 'versions');
  let leaseSeq = 0;
  const service = createVisualizeService({
    windowAvailable: () => true,
    browserAvailable: () => false,
    recentShownLimit: 0,
    versions: { directory: versionsDir },
    preparePane: async (target) => `http://127.0.0.1:4100/lease-${++leaseSeq}/${target.label}`,
    publish: () => {},
    watch: () => () => {},
    annotate: async () => [],
    capture: async () => Buffer.from('PNG'),
    onScreen: async () => 'visible',
    delay: async () => {},
    reloadDebounceMs: 60_000,
  });

  try {
    await service.setShownSessions(['s1']);
    const opened = await service.execute({
      action: 'open',
      sessionId: 's1',
      cwd: root,
      input: { targets: ['current/page.html'] },
    });
    const tabId = opened.tabs[0].id;

    // Park, remove symlink, and hydrate as missing with a long retry timer.
    await service.setShownSessions([]);
    await service.settled();
    unlinkSync(linkDir);
    await service.setShownSessions(['s1']);
    await service.settled();
    assert.equal(service.tabView('s1', tabId)?.missing, true);
    await assert.rejects(service.paneText('s1', tabId, 0), /missing/);

    // Restore symlink and reopen before the 60s retry fires.
    symlinkSync(dirV1, linkDir, linkType);
    const reopened = await service.execute({
      action: 'open',
      sessionId: 's1',
      cwd: root,
      input: { targets: ['current/page.html'] },
    });
    assert.equal(reopened.tabs[0].id, tabId);
    assert.equal(service.tabView('s1', tabId)?.missing, undefined, 'reopen clears missing state');
    assert.equal((await service.paneText('s1', tabId, 0)).text, '<h1>restored-before-retry</h1>');
  } finally {
    service.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test('compare mode with missing live symlink refuses capture, annotate, inspect, check, and live paneText', async (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mixdog-vis-compare-missing-')));
  const dirV1 = join(root, 'dir-v1');
  mkdirSync(dirV1, { recursive: true });
  const v1 = join(dirV1, 'page.html');
  const linkDir = join(root, 'current');
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  writeFileSync(v1, '<h1>v1</h1>', 'utf8');
  try {
    symlinkSync(dirV1, linkDir, linkType);
  } catch {
    rmSync(root, { recursive: true, force: true });
    t.skip('directory symlinks unavailable');
    return;
  }

  const versionsDir = join(root, 'versions');
  let leaseSeq = 0;
  let annotateCalls = 0;
  let captureCalls = 0;
  const service = createVisualizeService({
    windowAvailable: () => true,
    browserAvailable: () => false,
    recentShownLimit: 0,
    versions: { directory: versionsDir },
    preparePane: async (target) => `http://127.0.0.1:4100/lease-${++leaseSeq}/${target.label}`,
    publish: () => {},
    watch: () => () => {},
    annotate: async () => {
      annotateCalls += 1;
      return [];
    },
    capture: async () => {
      captureCalls += 1;
      return Buffer.from('PNG');
    },
    inspect: async () => [{ pane: 'page.html', result: { ok: true } }],
    onScreen: async () => 'visible',
    delay: async () => {},
    reloadDebounceMs: 60_000,
  });

  try {
    await service.setShownSessions(['s1']);
    const first = await service.execute({
      action: 'open',
      sessionId: 's1',
      cwd: root,
      input: { targets: ['current/page.html'] },
    });
    const tabId = first.tabs[0].id;
    writeFileSync(v1, '<h1>v2</h1>', 'utf8');
    await service.execute({ action: 'open', sessionId: 's1', cwd: root, input: { targets: ['current/page.html'] } });
    await service.command({ action: 'version', sessionId: 's1', tabId, version: 1, compare: true });
    await service.settled();

    // Park while comparing v1 beside live, delete symlink, and rehydrate.
    await service.setShownSessions([]);
    await service.settled();
    unlinkSync(linkDir);
    await service.setShownSessions(['s1']);
    await service.settled();

    const restored = service.tabView('s1', tabId);
    assert.equal(restored?.version, 1);
    assert.equal(restored?.compare, true);

    await assert.rejects(
      service.execute({ action: 'annotate', sessionId: 's1', cwd: root, input: { tab: tabId, clear: true } }),
      /missing/
    );
    await assert.rejects(
      service.execute({ action: 'capture', sessionId: 's1', cwd: root, input: { tab: tabId, output: 'out.png' } }),
      /missing/
    );
    await assert.rejects(
      service.execute({ action: 'inspect', sessionId: 's1', cwd: root, input: { tab: tabId } }),
      /missing/
    );
    await assert.rejects(
      service.execute({ action: 'check', sessionId: 's1', cwd: root, input: { tab: tabId } }),
      /missing/
    );
    assert.equal(annotateCalls, 0, 'annotate backend is never invoked when compare includes missing live pane');
    assert.equal(captureCalls, 0, 'capture backend is never invoked when compare includes missing live pane');

    // Kept version pane (index 0) remains readable, while missing live pane (index 1) is refused.
    assert.equal((await service.paneText('s1', tabId, 0)).text, '<h1>v1</h1>');
    await assert.rejects(service.paneText('s1', tabId, 1), /missing/);
  } finally {
    service.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test('missing symlink restored to a new destination via retry rekeys tab and history for subsequent reopen', async (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mixdog-vis-retry-retarget-')));
  const dirV1 = join(root, 'dir-v1');
  const dirV2 = join(root, 'dir-v2');
  mkdirSync(dirV1, { recursive: true });
  mkdirSync(dirV2, { recursive: true });
  const v1 = join(dirV1, 'page.html');
  const v2 = join(dirV2, 'page.html');
  const linkDir = join(root, 'current');
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  writeFileSync(v1, '<h1>v1</h1>', 'utf8');
  writeFileSync(v2, '<h1>v2</h1>', 'utf8');
  try {
    symlinkSync(dirV1, linkDir, linkType);
  } catch {
    rmSync(root, { recursive: true, force: true });
    t.skip('directory symlinks unavailable');
    return;
  }

  const versionsDir = join(root, 'versions');
  let leaseSeq = 0;
  const service = createVisualizeService({
    windowAvailable: () => true,
    browserAvailable: () => false,
    recentShownLimit: 0,
    versions: { directory: versionsDir },
    preparePane: async (target) => `http://127.0.0.1:4100/lease-${++leaseSeq}/${target.label}`,
    publish: () => {},
    watch: () => () => {},
    annotate: async () => [],
    capture: async () => Buffer.from('PNG'),
    onScreen: async () => 'visible',
    delay: async () => {},
    reloadDebounceMs: 25,
  });

  try {
    await service.setShownSessions(['s1']);
    const first = await service.execute({
      action: 'open',
      sessionId: 's1',
      cwd: root,
      input: { targets: ['current/page.html'] },
    });
    const tabId = first.tabs[0].id;
    assert.equal(service.tabView('s1', tabId)?.versions?.length, 1);

    // Park, delete symlink, and hydrate as missing.
    await service.setShownSessions([]);
    await service.settled();
    unlinkSync(linkDir);
    await service.setShownSessions(['s1']);
    await service.settled();
    assert.equal(service.tabView('s1', tabId)?.missing, true);

    // Restore symlink pointing to a new destination (dir-v2) and wait for missing-file retry recovery.
    symlinkSync(dirV2, linkDir, linkType);
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline && service.tabView('s1', tabId)?.missing) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    await service.settled();
    assert.equal(service.tabView('s1', tabId)?.missing, undefined);
    assert.equal(service.tabView('s1', tabId)?.versions?.length, 2, 'retry recovery recorded v2 on recovered tab');

    const historyAfterRetry = service.snapshot().find((entry) => entry.sessionId === 's1')?.history ?? [];
    assert.equal(historyAfterRetry.length, 1, 'history keeps one entry after retry retarget');
    assert.equal(historyAfterRetry[0].open, true, 'history entry stays open after retry retarget');

    // Reopening the new canonical path or symlink must reuse the recovered tab and continue its version history.
    writeFileSync(v2, '<h1>v3</h1>', 'utf8');
    const reopened = await service.execute({
      action: 'open',
      sessionId: 's1',
      cwd: root,
      input: { targets: ['dir-v2/page.html'] },
    });
    assert.equal(reopened.tabs[0].id, tabId, 'reopening recovered destination reuses existing tab');
    const snap = service.snapshot().find((entry) => entry.sessionId === 's1');
    assert.equal(snap?.tabs.length, 1);
    assert.equal(service.tabView('s1', tabId)?.versions?.length, 3);
    assert.equal(snap?.history?.length, 1, 'reopen after retry retarget creates no duplicate history entry');
    assert.equal(snap?.history?.[0]?.open, true);
  } finally {
    service.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test('symlink retargeting onto another open file keeps distinct tab identities, version histories, and synced All visuals', async (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mixdog-vis-retarget-collision-')));
  const dirA = join(root, 'dir-a');
  const dirB = join(root, 'dir-b');
  mkdirSync(dirA, { recursive: true });
  mkdirSync(dirB, { recursive: true });
  const fileA = join(dirA, 'page.html');
  const fileB = join(dirB, 'page.html');
  const linkDir = join(root, 'current');
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  writeFileSync(fileA, '<h1>A1</h1>', 'utf8');
  writeFileSync(fileB, '<h1>B1</h1>', 'utf8');
  try {
    symlinkSync(dirA, linkDir, linkType);
  } catch {
    rmSync(root, { recursive: true, force: true });
    t.skip('directory symlinks unavailable');
    return;
  }

  const versionsDir = join(root, 'versions');
  let leaseSeq = 0;
  const service = createVisualizeService({
    windowAvailable: () => true,
    browserAvailable: () => false,
    recentShownLimit: 0,
    versions: { directory: versionsDir },
    preparePane: async (target) => `http://127.0.0.1:4100/lease-${++leaseSeq}/${target.label}`,
    publish: () => {},
    watch: () => () => {},
    annotate: async () => [],
    capture: async () => Buffer.from('PNG'),
    onScreen: async () => 'visible',
    delay: async () => {},
  });

  try {
    await service.setShownSessions(['s1']);
    const openB = await service.execute({
      action: 'open',
      sessionId: 's1',
      cwd: root,
      input: { targets: ['dir-b/page.html'] },
    });
    const tabB = openB.tabs[0].id;
    const openLink = await service.execute({
      action: 'open',
      sessionId: 's1',
      cwd: root,
      input: { targets: ['current/page.html'] },
    });
    const tabLink = openLink.tabs[0].id;
    assert.notEqual(tabB, tabLink);

    // Park both tabs, retarget symlink from dir-a -> dir-b, then hydrate.
    await service.setShownSessions([]);
    await service.settled();
    unlinkSync(linkDir);
    symlinkSync(dirB, linkDir, linkType);
    await service.setShownSessions(['s1']);
    await service.settled();

    const afterHydrate = service.snapshot().find((entry) => entry.sessionId === 's1');
    assert.equal(afterHydrate?.tabs.length, 2);
    assert.equal(afterHydrate?.history?.length, 2, 'All visuals keeps both distinct entries after retarget collision');
    assert.ok(
      afterHydrate?.history?.every((item) => item.open),
      'both open tabs stay marked open in All visuals after retarget collision'
    );

    // Reopening the symlink must continue Tab 2's version history (A1 -> B1) without clobbering Tab 1.
    const reopenLink = await service.execute({
      action: 'open',
      sessionId: 's1',
      cwd: root,
      input: { targets: ['current/page.html'] },
    });
    assert.equal(reopenLink.tabs[0].id, tabLink, 'reopening retargeted symlink updates Tab 2, not Tab 1');
    assert.equal(service.tabView('s1', tabLink)?.versions?.length, 2, 'Tab 2 continues its version history');
    assert.equal(service.tabView('s1', tabB)?.versions?.length, 1, 'Tab 1 is untouched by symlink reopen');

    // Reopening dir-b/page.html updates Tab 1 without clobbering Tab 2.
    writeFileSync(fileB, '<h1>B2</h1>', 'utf8');
    const reopenB = await service.execute({
      action: 'open',
      sessionId: 's1',
      cwd: root,
      input: { targets: ['dir-b/page.html'] },
    });
    assert.equal(reopenB.tabs[0].id, tabB, 'reopening File B updates Tab 1');
    assert.equal(service.tabView('s1', tabB)?.versions?.length, 2, 'Tab 1 continues its own version history');
    assert.equal(service.tabView('s1', tabLink)?.versions?.length, 2, 'Tab 2 is untouched by File B reopen');

    const finalSnap = service.snapshot().find((entry) => entry.sessionId === 's1');
    assert.equal(finalSnap?.tabs.length, 2);
    assert.equal(finalSnap?.history?.length, 2, 'All visuals has zero duplicate history entries after both reopens');
    assert.ok(
      finalSnap?.history?.every((item) => item.open),
      'All visuals keeps both tabs marked open'
    );
  } finally {
    service.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test('All visuals history stays synced and open with no duplicates across symlink retarget hydration and reopen', async (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mixdog-vis-retarget-history-')));
  const dirV1 = join(root, 'dir-v1');
  const dirV2 = join(root, 'dir-v2');
  mkdirSync(dirV1, { recursive: true });
  mkdirSync(dirV2, { recursive: true });
  const v1 = join(dirV1, 'page.html');
  const v2 = join(dirV2, 'page.html');
  const linkDir = join(root, 'current');
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  writeFileSync(v1, '<h1>v1</h1>', 'utf8');
  writeFileSync(v2, '<h1>v2</h1>', 'utf8');
  try {
    symlinkSync(dirV1, linkDir, linkType);
  } catch {
    rmSync(root, { recursive: true, force: true });
    t.skip('directory symlinks unavailable');
    return;
  }

  const versionsDir = join(root, 'versions');
  let leaseSeq = 0;
  const service = createVisualizeService({
    windowAvailable: () => true,
    browserAvailable: () => false,
    recentShownLimit: 0,
    versions: { directory: versionsDir },
    preparePane: async (target) => `http://127.0.0.1:4100/lease-${++leaseSeq}/${target.label}`,
    publish: () => {},
    watch: () => () => {},
    annotate: async () => [],
    capture: async () => Buffer.from('PNG'),
    onScreen: async () => 'visible',
    delay: async () => {},
  });

  try {
    await service.setShownSessions(['s1']);
    const opened = await service.execute({
      action: 'open',
      sessionId: 's1',
      cwd: root,
      input: { targets: ['current/page.html'] },
    });
    const tabId = opened.tabs[0].id;

    // Park, retarget symlink -> dir-v2, and hydrate.
    await service.setShownSessions([]);
    await service.settled();
    unlinkSync(linkDir);
    symlinkSync(dirV2, linkDir, linkType);
    await service.setShownSessions(['s1']);
    await service.settled();

    const hydratedHistory = service.snapshot().find((entry) => entry.sessionId === 's1')?.history ?? [];
    assert.equal(hydratedHistory.length, 1, 'hydration migrates history entry in place');
    assert.equal(hydratedHistory[0].open, true, 'still-open retargeted tab stays marked open in All visuals');

    // Reopen the retargeted path: All visuals must still have 1 open entry with 2 versions.
    const reopened = await service.execute({
      action: 'open',
      sessionId: 's1',
      cwd: root,
      input: { targets: ['current/page.html'] },
    });
    assert.equal(reopened.tabs[0].id, tabId);
    const afterReopenHistory = service.snapshot().find((entry) => entry.sessionId === 's1')?.history ?? [];
    assert.equal(afterReopenHistory.length, 1, 'reopening retargeted symlink adds no duplicate history entry');
    assert.equal(afterReopenHistory[0].open, true);
    assert.equal(afterReopenHistory[0].versions, 2);
  } finally {
    service.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test('reopening retargeted symlink after closing File B preserves File B in All visuals history', async (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mixdog-vis-retarget-closed-history-')));
  const dirA = join(root, 'dir-a');
  const dirB = join(root, 'dir-b');
  mkdirSync(dirA, { recursive: true });
  mkdirSync(dirB, { recursive: true });
  const fileA = join(dirA, 'page.html');
  const fileB = join(dirB, 'page.html');
  const linkDir = join(root, 'current');
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  writeFileSync(fileA, '<h1>A</h1>', 'utf8');
  writeFileSync(fileB, '<h1>B</h1>', 'utf8');
  try {
    symlinkSync(dirA, linkDir, linkType);
  } catch {
    rmSync(root, { recursive: true, force: true });
    t.skip('directory symlinks unavailable');
    return;
  }

  const versionsDir = join(root, 'versions');
  let leaseSeq = 0;
  const service = createVisualizeService({
    windowAvailable: () => true,
    browserAvailable: () => false,
    recentShownLimit: 0,
    versions: { directory: versionsDir },
    preparePane: async (target) => `http://127.0.0.1:4100/lease-${++leaseSeq}/${target.label}`,
    publish: () => {},
    watch: () => () => {},
    annotate: async () => [],
    capture: async () => Buffer.from('PNG'),
    onScreen: async () => 'visible',
    delay: async () => {},
  });

  try {
    await service.setShownSessions(['s1']);
    const openB = await service.execute({
      action: 'open',
      sessionId: 's1',
      cwd: root,
      input: { targets: ['dir-b/page.html'], label: 'File B' },
    });
    const tabB = openB.tabs[0].id;
    const openLink = await service.execute({
      action: 'open',
      sessionId: 's1',
      cwd: root,
      input: { targets: ['current/page.html'], label: 'Symlink' },
    });
    const tabLink = openLink.tabs[0].id;

    // Park both tabs, retarget symlink -> dir-b, hydrate, then close File B.
    await service.setShownSessions([]);
    await service.settled();
    unlinkSync(linkDir);
    symlinkSync(dirB, linkDir, linkType);
    await service.setShownSessions(['s1']);
    await service.settled();

    await service.command({ action: 'close', sessionId: 's1', tabId: tabB });
    const historyAfterClose = service.snapshot().find((entry) => entry.sessionId === 's1')?.history ?? [];
    assert.equal(historyAfterClose.length, 2);
    assert.equal(historyAfterClose.find((item) => item.label === 'File B')?.open, false);
    assert.equal(historyAfterClose.find((item) => item.label === 'Symlink')?.open, true);

    // Reopen the retargeted symlink: must NOT migrate onto File B's closed history key or erase File B.
    const reopenedLink = await service.execute({
      action: 'open',
      sessionId: 's1',
      cwd: root,
      input: { targets: ['current/page.html'] },
    });
    assert.equal(reopenedLink.tabs[0].id, tabLink);

    const historyAfterReopen = service.snapshot().find((entry) => entry.sessionId === 's1')?.history ?? [];
    assert.equal(historyAfterReopen.length, 2, 'File B stays in All visuals alongside the retargeted symlink');
    assert.equal(historyAfterReopen.find((item) => item.label === 'File B')?.open, false);
    assert.equal(historyAfterReopen.find((item) => item.label === 'Symlink')?.open, true);
  } finally {
    service.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test('opening old destination A does not take over a missing symlink tab before retry recovers it to B', async (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mixdog-vis-missing-takeover-')));
  const dirA = join(root, 'dir-a');
  const dirB = join(root, 'dir-b');
  mkdirSync(dirA, { recursive: true });
  mkdirSync(dirB, { recursive: true });
  const fileA = join(dirA, 'page.html');
  const fileB = join(dirB, 'page.html');
  const linkDir = join(root, 'current');
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  writeFileSync(fileA, '<h1>A</h1>', 'utf8');
  writeFileSync(fileB, '<h1>B</h1>', 'utf8');
  try {
    symlinkSync(dirA, linkDir, linkType);
  } catch {
    rmSync(root, { recursive: true, force: true });
    t.skip('directory symlinks unavailable');
    return;
  }

  const versionsDir = join(root, 'versions');
  let leaseSeq = 0;
  const service = createVisualizeService({
    windowAvailable: () => true,
    browserAvailable: () => false,
    recentShownLimit: 0,
    versions: { directory: versionsDir },
    preparePane: async (target) => `http://127.0.0.1:4100/lease-${++leaseSeq}/${target.label}`,
    publish: () => {},
    watch: () => () => {},
    annotate: async () => [],
    capture: async () => Buffer.from('PNG'),
    onScreen: async () => 'visible',
    delay: async () => {},
    reloadDebounceMs: 25,
  });

  try {
    await service.setShownSessions(['s1']);
    const openedLink = await service.execute({
      action: 'open',
      sessionId: 's1',
      cwd: root,
      input: { targets: ['current/page.html'], label: 'Link' },
    });
    const linkTabId = openedLink.tabs[0].id;

    // Park, remove symlink while dir-a/page.html still exists, and hydrate as missing.
    await service.setShownSessions([]);
    await service.settled();
    unlinkSync(linkDir);
    await service.setShownSessions(['s1']);
    await service.settled();
    assert.equal(service.tabView('s1', linkTabId)?.missing, true);

    // Open old destination dir-a/page.html before retry: must create its own tab without taking over linkTabId.
    const openedA = await service.execute({
      action: 'open',
      sessionId: 's1',
      cwd: root,
      input: { targets: ['dir-a/page.html'], label: 'Dest A' },
    });
    const tabAId = openedA.tabs[0].id;
    assert.notEqual(
      tabAId,
      linkTabId,
      'opening old destination A creates a separate tab instead of hijacking missing link'
    );
    assert.equal(service.tabView('s1', linkTabId)?.missing, true, 'missing link tab stays intact');
    assert.equal((await service.paneText('s1', tabAId, 0)).text, '<h1>A</h1>');
    await assert.rejects(service.paneText('s1', linkTabId, 0), /missing/);

    // Recreate symlink -> dir-b; retry recovers linkTabId with its version history (A -> B).
    symlinkSync(dirB, linkDir, linkType);
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline && service.tabView('s1', linkTabId)?.missing) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    await service.settled();

    assert.equal(service.tabView('s1', linkTabId)?.missing, undefined);
    assert.equal((await service.paneText('s1', linkTabId, 0)).text, '<h1>B</h1>');
    assert.equal(
      service.tabView('s1', linkTabId)?.versions?.length,
      2,
      'link tab kept its version history across recovery'
    );
    assert.equal(service.snapshot().find((entry) => entry.sessionId === 's1')?.tabs.length, 2);
  } finally {
    service.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test('held compare-mode paneText refuses missing live pane after lease refresh detects deleted symlink', async (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mixdog-vis-held-compare-missing-')));
  const dirA = join(root, 'dir-a');
  mkdirSync(dirA, { recursive: true });
  const fileA = join(dirA, 'page.html');
  const linkDir = join(root, 'current');
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  writeFileSync(fileA, '<h1>v1</h1>', 'utf8');
  try {
    symlinkSync(dirA, linkDir, linkType);
  } catch {
    rmSync(root, { recursive: true, force: true });
    t.skip('directory symlinks unavailable');
    return;
  }

  const versionsDir = join(root, 'versions');
  let leaseSeq = 0;
  const service = createVisualizeService({
    windowAvailable: () => true,
    browserAvailable: () => false,
    recentShownLimit: 0,
    versions: { directory: versionsDir },
    preparePane: async (target) => `http://127.0.0.1:4100/lease-${++leaseSeq}/${target.label}`,
    publish: () => {},
    watch: () => () => {},
    annotate: async () => [],
    capture: async () => Buffer.from('PNG'),
    onScreen: async () => 'visible',
    delay: async () => {},
    reloadDebounceMs: 60_000,
  });

  try {
    await service.setShownSessions(['s1']);
    const first = await service.execute({
      action: 'open',
      sessionId: 's1',
      cwd: root,
      input: { targets: ['current/page.html'] },
    });
    const tabId = first.tabs[0].id;
    writeFileSync(fileA, '<h1>v2-live</h1>', 'utf8');
    await service.execute({ action: 'open', sessionId: 's1', cwd: root, input: { targets: ['current/page.html'] } });
    await service.command({ action: 'version', sessionId: 's1', tabId, version: 1, compare: true });

    const compareView = service.tabView('s1', tabId);
    const liveUrl = compareView?.panes[1]?.url;
    assert.ok(liveUrl, 'compare mode live pane has a lease URL');

    // Start a turn hold, delete the symlink while dir-a/page.html still exists, and expire the live lease.
    await service.setTurnActive('s1', true);
    unlinkSync(linkDir);
    service.reportNavigation(liveUrl, 404);
    await service.settled();

    // Kept version pane (index 0) stays readable; missing live pane (index 1) must refuse instead of reading old target.
    assert.equal((await service.paneText('s1', tabId, 0)).text, '<h1>v1</h1>');
    await assert.rejects(service.paneText('s1', tabId, 1), /missing/);
  } finally {
    service.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test('reopening a closed retargeted symlink after closing File B preserves File B history with zero duplicates', async (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mixdog-vis-both-closed-reopen-')));
  const dirA = join(root, 'dir-a');
  const dirB = join(root, 'dir-b');
  mkdirSync(dirA, { recursive: true });
  mkdirSync(dirB, { recursive: true });
  const fileA = join(dirA, 'page.html');
  const fileB = join(dirB, 'page.html');
  const linkDir = join(root, 'current');
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  writeFileSync(fileA, '<h1>A</h1>', 'utf8');
  writeFileSync(fileB, '<h1>B</h1>', 'utf8');
  try {
    symlinkSync(dirA, linkDir, linkType);
  } catch {
    rmSync(root, { recursive: true, force: true });
    t.skip('directory symlinks unavailable');
    return;
  }

  const versionsDir = join(root, 'versions');
  let leaseSeq = 0;
  const service = createVisualizeService({
    windowAvailable: () => true,
    browserAvailable: () => false,
    recentShownLimit: 0,
    versions: { directory: versionsDir },
    preparePane: async (target) => `http://127.0.0.1:4100/lease-${++leaseSeq}/${target.label}`,
    publish: () => {},
    watch: () => () => {},
    annotate: async () => [],
    capture: async () => Buffer.from('PNG'),
    onScreen: async () => 'visible',
    delay: async () => {},
  });

  try {
    await service.setShownSessions(['s1']);
    const openB = await service.execute({
      action: 'open',
      sessionId: 's1',
      cwd: root,
      input: { targets: ['dir-b/page.html'], label: 'File B' },
    });
    const tabB = openB.tabs[0].id;
    const openLink = await service.execute({
      action: 'open',
      sessionId: 's1',
      cwd: root,
      input: { targets: ['current/page.html'], label: 'Symlink' },
    });
    const tabLink = openLink.tabs[0].id;

    // Park both tabs, retarget symlink -> dir-b, hydrate, then close BOTH File B and Symlink.
    await service.setShownSessions([]);
    await service.settled();
    unlinkSync(linkDir);
    symlinkSync(dirB, linkDir, linkType);
    await service.setShownSessions(['s1']);
    await service.settled();

    await service.command({ action: 'close', sessionId: 's1', tabId: tabB });
    await service.command({ action: 'close', sessionId: 's1', tabId: tabLink });

    const bothClosed = service.snapshot().find((entry) => entry.sessionId === 's1');
    assert.equal(bothClosed?.tabs.length, 0);
    assert.equal(bothClosed?.history?.length, 2);
    const linkEntry = bothClosed?.history?.find((item) => item.label === 'Symlink');
    assert.ok(linkEntry && linkEntry.open === false);
    assert.equal(bothClosed?.history?.find((item) => item.label === 'File B')?.open, false);

    // Reopen the closed symlink from All visuals: File B stays closed in history and Symlink flips open with no duplicate.
    await service.command({ action: 'history', sessionId: 's1', entry: linkEntry.id });

    const afterReopen = service.snapshot().find((entry) => entry.sessionId === 's1');
    assert.equal(afterReopen?.tabs.length, 1);
    assert.equal(afterReopen?.history?.length, 2, 'zero duplicate history entries after reopening closed symlink');
    assert.equal(
      afterReopen?.history?.find((item) => item.label === 'File B')?.open,
      false,
      'File B remains preserved in All visuals'
    );
    assert.equal(
      afterReopen?.history?.find((item) => item.label === 'Symlink')?.open,
      true,
      'reopened Symlink history entry flips back to open'
    );
  } finally {
    service.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test('older in-flight reload does not undo a newer missing-file decision from lease refresh', async (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mixdog-vis-stale-reload-missing-')));
  const dirA = join(root, 'dir-a');
  mkdirSync(dirA, { recursive: true });
  const fileA = join(dirA, 'page.html');
  const linkDir = join(root, 'current');
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  writeFileSync(fileA, '<h1>A</h1>', 'utf8');
  try {
    symlinkSync(dirA, linkDir, linkType);
  } catch {
    rmSync(root, { recursive: true, force: true });
    t.skip('directory symlinks unavailable');
    return;
  }

  const versionsDir = join(root, 'versions');
  const watchers = new Map();
  let leaseSeq = 0;
  let holdReloadPrepare = false;
  let reloadPrepareStarted;
  const reloadPrepareWaiting = new Promise((resolve) => (reloadPrepareStarted = resolve));
  let releaseReloadPrepare;

  const service = createVisualizeService({
    windowAvailable: () => true,
    browserAvailable: () => false,
    recentShownLimit: 0,
    versions: { directory: versionsDir },
    preparePane: async (target) => {
      if (holdReloadPrepare) {
        holdReloadPrepare = false;
        reloadPrepareStarted();
        await new Promise((resolve) => (releaseReloadPrepare = resolve));
      }
      return `http://127.0.0.1:4100/lease-${++leaseSeq}/${target.label}`;
    },
    publish: () => {},
    watch(path, onChange) {
      watchers.set(path, onChange);
      return () => watchers.delete(path);
    },
    annotate: async () => [],
    capture: async () => Buffer.from('PNG'),
    onScreen: async () => 'visible',
    delay: async () => {},
    reloadDebounceMs: 10,
  });

  try {
    await service.setShownSessions(['s1']);
    const opened = await service.execute({
      action: 'open',
      sessionId: 's1',
      cwd: root,
      input: { targets: ['current/page.html'] },
    });
    const tabId = opened.tabs[0].id;
    const oldUrl = service.tabView('s1', tabId)?.panes[0]?.url;
    assert.ok(oldUrl);

    // Trigger a watch reload and pause it after resolveTargetWithin, inside preparePane.
    holdReloadPrepare = true;
    const triggerWatch = [...watchers.values()][0];
    assert.ok(triggerWatch);
    triggerWatch();
    let keepAlive;
    try {
      await Promise.race([
        reloadPrepareWaiting,
        new Promise((_, reject) => {
          keepAlive = setTimeout(() => reject(new Error('reload preparePane did not start in time')), 2000);
        }),
      ]);
    } finally {
      clearTimeout(keepAlive);
    }

    // Delete the symlink while the older reload is suspended, then trigger a newer lease refresh (404).
    unlinkSync(linkDir);
    service.reportNavigation(oldUrl, 404);
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline && !service.tabView('s1', tabId)?.missing) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(service.tabView('s1', tabId)?.missing, true, 'newer lease refresh marked tab missing');

    // Release the older reload's preparePane: it must be rejected as superseded and must not undo missing state.
    releaseReloadPrepare();
    await service.settled();

    assert.equal(service.tabView('s1', tabId)?.missing, true, 'older reload never overwrites newer missing decision');
    await assert.rejects(service.paneText('s1', tabId, 0), /missing/);
  } finally {
    service.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test('distinct canonical files A.html and a.html never collide in findFileTab or resolveFileTabKey', async () => {
  const { fileTargetsKey, findFileTab, resolveFileTabKey } = await import('./tab-state.ts');
  const cwd = process.platform === 'win32' ? 'C:\\case-sensitive-dir' : '/case-sensitive-dir';
  const targetUpper = {
    kind: 'html',
    target: 'A.html',
    path: join(cwd, 'A.html'),
    label: 'A.html',
    root: cwd,
  };
  const targetLower = {
    kind: 'html',
    target: 'a.html',
    path: join(cwd, 'a.html'),
    label: 'a.html',
    root: cwd,
  };
  const tabUpper = {
    id: 'v1',
    label: 'A.html',
    key: fileTargetsKey([targetUpper]),
    cwd,
    revision: 0,
    targets: [targetUpper],
    panes: [],
    unwatch: [],
    lifetime: new AbortController(),
    reloadTimer: null,
    problems: [],
    problemSeq: 0,
  };

  assert.equal(
    findFileTab([tabUpper], cwd, [targetLower]),
    undefined,
    'opening a.html with distinct canonical path does not match A.html tab'
  );
  const state = {
    tabs: [tabUpper],
    history: [
      {
        id: 'h1',
        key: tabUpper.key,
        label: 'A.html',
        remoteLabel: 'A.html',
        kind: 'html',
        targets: ['A.html'],
        at: 1,
        versions: 1,
      },
    ],
  };
  const lowerKey = resolveFileTabKey(state, cwd, [targetLower]);
  assert.equal(lowerKey, fileTargetsKey([targetLower]), 'a.html receives its own distinct canonical key');
  assert.notEqual(lowerKey, tabUpper.key);

  // When both requests resolve to the SAME canonical file (case-insensitive Windows FS), findFileTab still reuses it.
  if (process.platform === 'win32') {
    const sameCanonicalLower = { ...targetLower, path: targetUpper.path };
    assert.equal(
      findFileTab([tabUpper], cwd, [sameCanonicalLower]),
      tabUpper,
      'same canonical file under different casing on Windows still matches existing tab'
    );
  }
});

test('closing dir1/report.html then opening report.html from dir2 keeps both in All visuals history', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mixdog-vis-same-rel-cwd-')));
  const dir1 = join(root, 'dir1');
  const dir2 = join(root, 'dir2');
  mkdirSync(dir1, { recursive: true });
  mkdirSync(dir2, { recursive: true });
  writeFileSync(join(dir1, 'report.html'), '<h1>Report 1</h1>', 'utf8');
  writeFileSync(join(dir2, 'report.html'), '<h1>Report 2</h1>', 'utf8');
  const versionsDir = join(root, 'versions');
  let leaseSeq = 0;

  const service = createVisualizeService({
    windowAvailable: () => true,
    browserAvailable: () => false,
    recentShownLimit: 0,
    versions: { directory: versionsDir },
    preparePane: async (target) => `http://127.0.0.1:4100/lease-${++leaseSeq}/${target.label}`,
    publish: () => {},
    watch: () => () => {},
    annotate: async () => [],
    capture: async () => Buffer.from('PNG'),
    onScreen: async () => 'visible',
    delay: async () => {},
  });

  try {
    await service.setShownSessions(['s1']);
    const open1 = await service.execute({
      action: 'open',
      sessionId: 's1',
      cwd: dir1,
      input: { targets: ['report.html'], label: 'Report 1' },
    });
    const tab1 = open1.tabs[0].id;
    await service.command({ action: 'close', sessionId: 's1', tabId: tab1 });

    // Open a different relative report.html from dir2: must NOT collide with closed dir1/report.html.
    const open2 = await service.execute({
      action: 'open',
      sessionId: 's1',
      cwd: dir2,
      input: { targets: ['report.html'], label: 'Report 2' },
    });
    const tab2 = open2.tabs[0].id;
    assert.equal((await service.paneText('s1', tab2, 0)).text, '<h1>Report 2</h1>');

    const history = service.snapshot().find((entry) => entry.sessionId === 's1')?.history ?? [];
    assert.equal(history.length, 2, 'both dir1/report.html and dir2/report.html remain in All visuals');
    const entry1 = history.find((item) => item.label === 'Report 1');
    const entry2 = history.find((item) => item.label === 'Report 2');
    assert.equal(entry1?.open, false);
    assert.equal(entry2?.open, true);

    // Reopening Report 1 from All visuals uses its stored cwd (dir1), not the session's last cwd (dir2).
    await service.command({ action: 'history', sessionId: 's1', entry: entry1.id });
    const afterReopen = service.snapshot().find((entry) => entry.sessionId === 's1');
    assert.equal(afterReopen?.tabs.length, 2);
    const reopenedTab1 = afterReopen?.tabs.find((tab) => tab.label === 'Report 1');
    assert.ok(reopenedTab1);
    assert.equal((await service.paneText('s1', reopenedTab1.id, 0)).text, '<h1>Report 1</h1>');
  } finally {
    service.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test('reopening closed retargeted symlink via All visuals while File B stays open preserves File B tab', async (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mixdog-vis-closed-link-open-b-')));
  const dirA = join(root, 'dir-a');
  const dirB = join(root, 'dir-b');
  mkdirSync(dirA, { recursive: true });
  mkdirSync(dirB, { recursive: true });
  writeFileSync(join(dirA, 'page.html'), '<h1>A</h1>', 'utf8');
  writeFileSync(join(dirB, 'page.html'), '<h1>B</h1>', 'utf8');
  const linkDir = join(root, 'current');
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  try {
    symlinkSync(dirA, linkDir, linkType);
  } catch {
    rmSync(root, { recursive: true, force: true });
    t.skip('directory symlinks unavailable');
    return;
  }

  const versionsDir = join(root, 'versions');
  let leaseSeq = 0;
  const service = createVisualizeService({
    windowAvailable: () => true,
    browserAvailable: () => false,
    recentShownLimit: 0,
    versions: { directory: versionsDir },
    preparePane: async (target) => `http://127.0.0.1:4100/lease-${++leaseSeq}/${target.label}`,
    publish: () => {},
    watch: () => () => {},
    annotate: async () => [],
    capture: async () => Buffer.from('PNG'),
    onScreen: async () => 'visible',
    delay: async () => {},
  });

  try {
    await service.setShownSessions(['s1']);
    const openB = await service.execute({
      action: 'open',
      sessionId: 's1',
      cwd: root,
      input: { targets: ['dir-b/page.html'], label: 'File B' },
    });
    const tabB = openB.tabs[0].id;
    const openLink = await service.execute({
      action: 'open',
      sessionId: 's1',
      cwd: root,
      input: { targets: ['current/page.html'], label: 'Symlink' },
    });
    const tabLink = openLink.tabs[0].id;

    // Close ONLY the symlink tab while File B remains open, then retarget symlink -> dir-b.
    await service.command({ action: 'close', sessionId: 's1', tabId: tabLink });
    unlinkSync(linkDir);
    symlinkSync(dirB, linkDir, linkType);

    const beforeReopen = service.snapshot().find((entry) => entry.sessionId === 's1');
    const linkEntry = beforeReopen?.history?.find((item) => item.label === 'Symlink');
    assert.ok(linkEntry && linkEntry.open === false);

    // Reopen Symlink from All visuals: must NOT overwrite File B's open tab.
    await service.command({ action: 'history', sessionId: 's1', entry: linkEntry.id });

    const afterReopen = service.snapshot().find((entry) => entry.sessionId === 's1');
    assert.equal(afterReopen?.tabs.length, 2, 'reopened symlink gets its own tab alongside File B');
    const liveB = afterReopen?.tabs.find((tab) => tab.id === tabB);
    const liveLink = afterReopen?.tabs.find((tab) => tab.id !== tabB);
    assert.equal(liveB?.label, 'File B', 'File B tab and label are preserved untouched');
    assert.equal(liveLink?.label, 'Symlink', 'reopened symlink opens cleanly with its own tab and label');
    assert.equal(afterReopen?.history?.length, 2, 'zero duplicate history entries');
    assert.ok(
      afterReopen?.history?.every((item) => item.open),
      'both File B and Symlink are marked open'
    );
  } finally {
    service.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test('missing A.html tab never captures distinct a.html in findFileTab', async () => {
  const { findFileTab, targetIdentityKey } = await import('./tab-state.ts');
  const cwd = process.platform === 'win32' ? 'C:\\case-sensitive-dir' : '/case-sensitive-dir';
  const missingUpper = {
    kind: 'html',
    target: 'A.html',
    path: '',
    label: 'A.html',
    root: cwd,
  };
  const liveLower = {
    kind: 'html',
    target: 'a.html',
    path: join(cwd, 'a.html'),
    label: 'a.html',
    root: cwd,
  };
  const tabMissingUpper = {
    id: 'v1',
    label: 'A.html',
    key: targetIdentityKey(cwd, [missingUpper]),
    cwd,
    revision: 0,
    targets: [missingUpper],
    panes: [],
    unwatch: [],
    lifetime: new AbortController(),
    reloadTimer: null,
    missing: true,
    problems: [],
    problemSeq: 0,
  };

  assert.equal(
    findFileTab([tabMissingUpper], cwd, [liveLower]),
    undefined,
    'missing A.html tab does not capture distinct a.html'
  );
  // Exact-case reopen of A.html still finds the missing A.html tab.
  const restoredUpper = { ...missingUpper, path: join(cwd, 'A.html') };
  assert.equal(
    findFileTab([tabMissingUpper], cwd, [restoredUpper]),
    tabMissingUpper,
    'exact-case reopen still recovers missing A.html tab'
  );
});

test('reopening closed symlink Current/page.html as current/page.html reuses history without colliding distinct case files', async () => {
  const { fileTargetsKey, findClosedRequestedHistory, resolveFileTabKey, targetIdentityKey } = await import(
    './tab-state.ts'
  );
  const cwd = process.platform === 'win32' ? 'C:\\repo' : '/repo';
  const fileBPath = join(cwd, 'dir-b', 'page.html');
  const upperLink = { kind: 'html', target: 'Current/page.html', path: fileBPath, label: 'page.html', root: cwd };
  const lowerLink = { kind: 'html', target: 'current/page.html', path: fileBPath, label: 'page.html', root: cwd };
  const fileBKey = fileTargetsKey([{ path: fileBPath }]);
  const upperLinkKey = targetIdentityKey(cwd, [upperLink]);

  const state = {
    tabs: [
      {
        id: 'v1',
        label: 'File B',
        key: fileBKey,
        cwd,
        revision: 0,
        targets: [{ kind: 'html', target: 'dir-b/page.html', path: fileBPath, label: 'page.html', root: cwd }],
        panes: [],
        unwatch: [],
        lifetime: new AbortController(),
        reloadTimer: null,
        problems: [],
        problemSeq: 0,
      },
    ],
    history: [
      {
        id: 'h-link',
        key: upperLinkKey,
        label: 'Symlink',
        remoteLabel: 'Symlink',
        kind: 'html',
        targets: ['Current/page.html'],
        cwd,
        canonicalKey: fileBKey,
        at: 2,
        versions: 1,
      },
      {
        id: 'h-b',
        key: fileBKey,
        label: 'File B',
        remoteLabel: 'File B',
        kind: 'html',
        targets: ['dir-b/page.html'],
        cwd,
        canonicalKey: fileBKey,
        at: 1,
        versions: 1,
      },
    ],
  };

  if (process.platform === 'win32') {
    const matched = findClosedRequestedHistory(state, cwd, [lowerLink], fileBKey);
    assert.equal(matched?.key, upperLinkKey, 'Windows case-folded closed symlink matches via canonicalKey');
    const resolvedKey = resolveFileTabKey(state, cwd, [lowerLink], { syncHistory: true });
    assert.equal(resolvedKey, targetIdentityKey(cwd, [lowerLink]));
    assert.equal(state.history.length, 2, 'migrated closed symlink history without duplicating');
    assert.equal(
      state.history.some((entry) => entry.key === fileBKey),
      true,
      'File B history stays intact'
    );
    assert.equal(
      state.history.some((entry) => entry.key === resolvedKey),
      true
    );
  }

  // Distinct canonical files A.html and a.html in closed history stay separate even on Windows.
  const upperFile = { kind: 'html', target: 'A.html', path: join(cwd, 'A.html'), label: 'A.html', root: cwd };
  const lowerFile = { kind: 'html', target: 'a.html', path: join(cwd, 'a.html'), label: 'a.html', root: cwd };
  const upperFileKey = fileTargetsKey([upperFile]);
  const lowerFileKey = fileTargetsKey([lowerFile]);
  const caseState = {
    tabs: [],
    history: [
      {
        id: 'h-upper',
        key: upperFileKey,
        label: 'A.html',
        remoteLabel: 'A.html',
        kind: 'html',
        targets: ['A.html'],
        cwd,
        canonicalKey: upperFileKey,
        at: 1,
        versions: 1,
      },
    ],
  };
  assert.equal(
    findClosedRequestedHistory(caseState, cwd, [lowerFile], lowerFileKey),
    undefined,
    'distinct canonical a.html does not match closed A.html history'
  );
  assert.equal(resolveFileTabKey(caseState, cwd, [lowerFile], { syncHistory: true }), lowerFileKey);
  assert.equal(caseState.history[0].key, upperFileKey, 'closed A.html history is untouched');
});

test('held turn user reopen of symlink closed and retargeted during turn selects pre-turn picture', async (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mixdog-vis-held-retarget-reopen-')));
  const dirA = join(root, 'dir-a');
  const dirB = join(root, 'dir-b');
  mkdirSync(dirA, { recursive: true });
  mkdirSync(dirB, { recursive: true });
  writeFileSync(join(dirA, 'page.html'), '<h1>A</h1>', 'utf8');
  writeFileSync(join(dirB, 'page.html'), '<h1>B</h1>', 'utf8');
  const linkDir = join(root, 'current');
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  try {
    symlinkSync(dirA, linkDir, linkType);
  } catch {
    rmSync(root, { recursive: true, force: true });
    t.skip('directory symlinks unavailable');
    return;
  }

  const versionsDir = join(root, 'versions');
  const events = [];
  let leaseSeq = 0;
  const service = createVisualizeService({
    windowAvailable: () => true,
    browserAvailable: () => false,
    recentShownLimit: 0,
    versions: { directory: versionsDir },
    preparePane: async (target) => `http://127.0.0.1:4100/lease-${++leaseSeq}/${target.label}`,
    publish: (event) => events.push(event),
    watch: () => () => {},
    annotate: async () => [],
    capture: async () => Buffer.from('PNG'),
    onScreen: async () => 'visible',
    delay: async () => {},
  });

  try {
    await service.setShownSessions(['s1']);
    const openLink = await service.execute({
      action: 'open',
      sessionId: 's1',
      cwd: root,
      input: { targets: ['current/page.html'], label: 'Symlink' },
    });
    const linkTabId = openLink.tabs[0].id;
    const openOther = await service.execute({
      action: 'open',
      sessionId: 's1',
      cwd: root,
      input: { targets: ['dir-b/page.html'], label: 'Other' },
    });
    const otherTabId = openOther.tabs[0].id;
    assert.equal(service.snapshot()[0].active, otherTabId);

    // Start a turn hold, then during the turn close the symlink tab and retarget current -> dir-b.
    await service.setTurnActive('s1', true);
    await service.execute({ action: 'close', sessionId: 's1', cwd: root, input: { tab: linkTabId } });
    unlinkSync(linkDir);
    symlinkSync(dirB, linkDir, linkType);

    // User clicks reopen on the symlink card during the turn: must select pre-turn picture linkTabId, not open a new tab.
    events.length = 0;
    await service.command({
      action: 'reopen',
      sessionId: 's1',
      tabId: linkTabId,
      targets: ['current/page.html'],
      label: 'Symlink',
    });

    const snapDuringHold = service.snapshot().find((entry) => entry.sessionId === 's1');
    assert.equal(snapDuringHold?.held, true);
    assert.equal(
      snapDuringHold?.active,
      linkTabId,
      'user reopen selected pre-turn picture instead of opening a new tab'
    );
    assert.equal(snapDuringHold?.tabs.length, 2, 'no extra tab added to held shown state');
    assert.equal(events.at(-1)?.tab, linkTabId);

    // After the turn ends, the closed symlink tab stays closed (only Other remains).
    await service.setTurnActive('s1', false);
    const snapAfterTurn = service.snapshot().find((entry) => entry.sessionId === 's1');
    assert.deepEqual(
      snapAfterTurn?.tabs.map((tab) => tab.id),
      [otherTabId],
      'user reopen of pre-turn picture did not recreate a live tab'
    );
  } finally {
    service.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test('verify open followed by visible open of closed retargeted symlink promotes cleanly with zero duplicate history', async (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mixdog-vis-verify-promote-link-')));
  const dirA = join(root, 'dir-a');
  const dirB = join(root, 'dir-b');
  mkdirSync(dirA, { recursive: true });
  mkdirSync(dirB, { recursive: true });
  writeFileSync(join(dirA, 'page.html'), '<h1>A</h1>', 'utf8');
  writeFileSync(join(dirB, 'page.html'), '<h1>B</h1>', 'utf8');
  const linkDir = join(root, 'current');
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  try {
    symlinkSync(dirA, linkDir, linkType);
  } catch {
    rmSync(root, { recursive: true, force: true });
    t.skip('directory symlinks unavailable');
    return;
  }

  const versionsDir = join(root, 'versions');
  let leaseSeq = 0;
  const service = createVisualizeService({
    windowAvailable: () => true,
    browserAvailable: () => false,
    recentShownLimit: 0,
    versions: { directory: versionsDir },
    preparePane: async (target) => `http://127.0.0.1:4100/lease-${++leaseSeq}/${target.label}`,
    publish: () => {},
    watch: () => () => {},
    annotate: async () => [],
    capture: async () => Buffer.from('PNG'),
    inspectOffscreen: async () => ({ result: { findingCount: 0 }, problems: [] }),
    onScreen: async () => 'visible',
    delay: async () => {},
  });

  try {
    await service.setShownSessions(['s1']);
    // Case A: File B not in history; close symlink, retarget -> B, verify open, then visible open.
    const open1 = await service.execute({
      action: 'open',
      sessionId: 's1',
      cwd: root,
      input: { targets: ['current/page.html'], label: 'Symlink' },
    });
    await service.command({ action: 'close', sessionId: 's1', tabId: open1.tabs[0].id });
    unlinkSync(linkDir);
    symlinkSync(dirB, linkDir, linkType);

    await service.execute({
      action: 'open',
      sessionId: 's1',
      cwd: root,
      input: { targets: ['current/page.html'], verify: true },
    });
    const historyAfterVerify = service.snapshot().find((entry) => entry.sessionId === 's1')?.history ?? [];
    assert.equal(historyAfterVerify.length, 1);
    assert.equal(historyAfterVerify[0].open, false, 'verify open leaves closed history untouched');

    await service.execute({
      action: 'open',
      sessionId: 's1',
      cwd: root,
      input: { targets: ['current/page.html'], label: 'Symlink' },
    });
    const afterPromoteA = service.snapshot().find((entry) => entry.sessionId === 's1');
    assert.equal(afterPromoteA?.tabs.length, 1);
    assert.equal(
      afterPromoteA?.history?.length,
      1,
      'promoting verify tab reconciles closed symlink history with zero duplicates'
    );
    assert.equal(afterPromoteA?.history?.[0]?.open, true);

    // Case B: File B is ALSO open; close symlink, retarget -> A then -> B, verify open, then visible open.
    await service.execute({
      action: 'open',
      sessionId: 's1',
      cwd: root,
      input: { targets: ['dir-b/page.html'], label: 'File B' },
    });
    // Reset in a fresh session s2 to test File B open alongside closed retargeted symlink -> verify -> visible.
    await service.setShownSessions(['s2']);
    unlinkSync(linkDir);
    symlinkSync(dirA, linkDir, linkType);
    const openB2 = await service.execute({
      action: 'open',
      sessionId: 's2',
      cwd: root,
      input: { targets: ['dir-b/page.html'], label: 'File B' },
    });
    const openLink2 = await service.execute({
      action: 'open',
      sessionId: 's2',
      cwd: root,
      input: { targets: ['current/page.html'], label: 'Symlink' },
    });
    await service.command({ action: 'close', sessionId: 's2', tabId: openLink2.tabs[0].id });
    unlinkSync(linkDir);
    symlinkSync(dirB, linkDir, linkType);

    await service.execute({
      action: 'open',
      sessionId: 's2',
      cwd: root,
      input: { targets: ['current/page.html'], verify: true },
    });
    const promotedB = await service.execute({
      action: 'open',
      sessionId: 's2',
      cwd: root,
      input: { targets: ['current/page.html'], label: 'Symlink' },
    });
    assert.notEqual(promotedB.tabs[0].id, openB2.tabs[0].id, 'promoted symlink does not collide with open File B');
    const afterPromoteB = service.snapshot().find((entry) => entry.sessionId === 's2');
    assert.equal(afterPromoteB?.tabs.length, 2);
    assert.equal(afterPromoteB?.history?.length, 2, 'zero duplicate history entries when File B is also open');
    assert.ok(afterPromoteB?.history?.every((item) => item.open));
  } finally {
    service.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test('held card reopen selects the pre-turn tab by tabId even after the turn switches session cwd', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mixdog-vis-held-card-cwd-')));
  const dir1 = join(root, 'dir1');
  const dir2 = join(root, 'dir2');
  mkdirSync(dir1, { recursive: true });
  mkdirSync(dir2, { recursive: true });
  writeFileSync(join(dir1, 'report.html'), '<h1>Dir 1</h1>', 'utf8');
  writeFileSync(join(dir1, 'other.html'), '<h1>Other</h1>', 'utf8');
  writeFileSync(join(dir2, 'report.html'), '<h1>Dir 2</h1>', 'utf8');

  const events = [];
  let leaseSeq = 0;
  const service = createVisualizeService({
    windowAvailable: () => true,
    browserAvailable: () => false,
    recentShownLimit: 0,
    versions: { directory: join(root, 'versions') },
    preparePane: async (target) => `http://127.0.0.1:4100/lease-${++leaseSeq}/${target.label}`,
    publish: (event) => events.push(structuredClone(event)),
    watch: () => () => {},
    annotate: async () => [],
    capture: async () => Buffer.from('PNG'),
    inspectOffscreen: async () => ({ result: { findingCount: 0 }, problems: [] }),
    onScreen: async () => 'visible',
    delay: async () => {},
  });

  try {
    // Case A: pre-turn tab becomes a 'past' picture (closed by turn) and turn opens dir2/report.html.
    await service.setShownSessions(['s1']);
    const r1 = await service.execute({
      action: 'open',
      sessionId: 's1',
      cwd: dir1,
      input: { targets: ['report.html'], label: 'Dir 1 Report' },
    });
    const other = await service.execute({
      action: 'open',
      sessionId: 's1',
      cwd: dir1,
      input: { targets: ['other.html'], label: 'Other' },
    });
    const r1Id = r1.tabs[0].id;
    const otherId = other.tabs[0].id;

    await service.setTurnActive('s1', true);
    await service.execute({ action: 'close', sessionId: 's1', cwd: dir1, input: { tab: r1Id } });
    const r2 = await service.execute({
      action: 'open',
      sessionId: 's1',
      cwd: dir2,
      input: { targets: ['report.html'], label: 'Dir 2 Report' },
    });
    const r2Id = r2.tabs[0].id;
    events.length = 0;

    await service.command({
      action: 'reopen',
      sessionId: 's1',
      tabId: r1Id,
      targets: ['report.html'],
      label: 'Dir 1 Report',
    });

    const heldPastSnap = service.snapshot().find((entry) => entry.sessionId === 's1');
    assert.equal(heldPastSnap?.active, r1Id, 'selects pre-turn dir1/report.html picture instead of dir2/report.html');
    assert.deepEqual(
      heldPastSnap?.tabs.map((tab) => tab.id),
      [r1Id, otherId],
      'does not pull turn tab dir2/report.html into held view'
    );
    assert.equal(events.at(-1)?.tab, r1Id);

    await service.setTurnActive('s1', false);
    const afterPastTurn = service.snapshot().find((entry) => entry.sessionId === 's1');
    assert.deepEqual(
      afterPastTurn?.tabs.map((tab) => tab.id),
      [otherId, r2Id]
    );

    // Case B: pre-turn tab stays 'live' while turn opens dir2/report.html (updating sessionCwds to dir2).
    await service.setShownSessions(['s2']);
    const liveR1 = await service.execute({
      action: 'open',
      sessionId: 's2',
      cwd: dir1,
      input: { targets: ['report.html'], label: 'Dir 1 Report' },
    });
    const liveOther = await service.execute({
      action: 'open',
      sessionId: 's2',
      cwd: dir1,
      input: { targets: ['other.html'], label: 'Other' },
    });
    const liveR1Id = liveR1.tabs[0].id;
    const liveOtherId = liveOther.tabs[0].id;

    await service.setTurnActive('s2', true);
    await service.execute({
      action: 'open',
      sessionId: 's2',
      cwd: dir2,
      input: { targets: ['report.html'], label: 'Dir 2 Report' },
    });

    await service.command({
      action: 'reopen',
      sessionId: 's2',
      tabId: liveR1Id,
      targets: ['report.html'],
      label: 'Dir 1 Report',
    });
    const heldLiveSnap = service.snapshot().find((entry) => entry.sessionId === 's2');
    assert.equal(heldLiveSnap?.active, liveR1Id, 'live card reopen resolves against pre-turn tab cwd');
    assert.deepEqual(
      heldLiveSnap?.tabs.map((tab) => tab.id),
      [liveR1Id, liveOtherId]
    );
    assert.equal((await service.paneText('s2', liveR1Id, 0)).text, '<h1>Dir 1</h1>');
  } finally {
    service.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test('exact closed history owner beats a Windows case-folded open tab or newer folded closed entry', () => {
  const cwd = process.platform === 'win32' ? 'C:\\project' : '/project';
  const canonicalB = join(cwd, 'dir-b', 'page.html');
  const makeTarget = (rel) => ({
    kind: 'html',
    target: rel,
    path: canonicalB,
    root: cwd,
    label: 'page.html',
  });
  const upperFiles = [makeTarget('Link/page.html')];
  const lowerFiles = [makeTarget('link/page.html')];
  const upperTab = {
    id: 'v1',
    label: 'Upper',
    key: canonicalB,
    cwd,
    revision: 1,
    targets: upperFiles,
    panes: [],
    unwatch: [],
    lifetime: new AbortController(),
    reloadTimer: null,
    problems: [],
    problemSeq: 0,
  };
  const lowerClosedKey = targetIdentityKey(cwd, lowerFiles);
  const upperClosedEntry = {
    id: 'upper-id',
    key: canonicalB,
    canonicalKey: canonicalB,
    label: 'Upper',
    remoteLabel: 'Upper',
    kind: 'html',
    targets: ['Link/page.html'],
    cwd,
    at: 2,
    versions: 1,
  };
  const lowerClosedEntry = {
    id: 'lower-id',
    key: lowerClosedKey,
    canonicalKey: canonicalB,
    label: 'Lower',
    remoteLabel: 'Lower',
    kind: 'html',
    targets: ['link/page.html'],
    cwd,
    at: 1,
    versions: 1,
  };

  // Open Link/page.html must not swallow a reopen of closed exact owner link/page.html.
  const matchedOpen = findFileTab([upperTab], cwd, lowerFiles, canonicalB, [upperClosedEntry, lowerClosedEntry]);
  assert.equal(matchedOpen, undefined, 'exact closed history owner blocks folded open-tab match');
  const matchedClosedWhileUpperOpen = findClosedRequestedHistory(
    { tabs: [upperTab], history: [upperClosedEntry, lowerClosedEntry] },
    cwd,
    lowerFiles,
    canonicalB
  );
  assert.equal(matchedClosedWhileUpperOpen?.key, lowerClosedKey);

  // When both are closed and newer Link/page.html appears first in history, exact link/page.html still wins.
  const matchedClosedBothClosed = findClosedRequestedHistory(
    { tabs: [], history: [upperClosedEntry, lowerClosedEntry] },
    cwd,
    lowerFiles,
    canonicalB
  );
  assert.equal(matchedClosedBothClosed?.key, lowerClosedKey, 'older exact closed entry beats newer folded entry');
});

test('hidden verify tab during a hold does not defeat selecting the pre-turn picture on user reopen', async (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mixdog-vis-verify-held-picture-')));
  const dirA = join(root, 'dir-a');
  const dirB = join(root, 'dir-b');
  mkdirSync(dirA, { recursive: true });
  mkdirSync(dirB, { recursive: true });
  writeFileSync(join(dirA, 'page.html'), '<h1>A</h1>', 'utf8');
  writeFileSync(join(dirB, 'page.html'), '<h1>B</h1>', 'utf8');
  writeFileSync(join(root, 'other.html'), '<h1>Other</h1>', 'utf8');
  const linkDir = join(root, 'current');
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  try {
    symlinkSync(dirA, linkDir, linkType);
  } catch {
    rmSync(root, { recursive: true, force: true });
    t.skip('directory symlinks unavailable');
    return;
  }

  let leaseSeq = 0;
  const service = createVisualizeService({
    windowAvailable: () => true,
    browserAvailable: () => false,
    recentShownLimit: 0,
    versions: { directory: join(root, 'versions') },
    preparePane: async (target) => `http://127.0.0.1:4100/lease-${++leaseSeq}/${target.label}`,
    publish: () => {},
    watch: () => () => {},
    annotate: async () => [],
    capture: async () => Buffer.from('PNG'),
    inspectOffscreen: async () => ({ result: { findingCount: 0 }, problems: [] }),
    onScreen: async () => 'visible',
    delay: async () => {},
  });

  try {
    await service.setShownSessions(['s1']);
    const bTab = await service.execute({
      action: 'open',
      sessionId: 's1',
      cwd: root,
      input: { targets: ['dir-b/page.html'], label: 'File B' },
    });
    const linkTab = await service.execute({
      action: 'open',
      sessionId: 's1',
      cwd: root,
      input: { targets: ['current/page.html'], label: 'Symlink' },
    });
    const otherTab = await service.execute({
      action: 'open',
      sessionId: 's1',
      cwd: root,
      input: { targets: ['other.html'], label: 'Other' },
    });
    const bId = bTab.tabs[0].id;
    const linkId = linkTab.tabs[0].id;
    const otherId = otherTab.tabs[0].id;

    await service.setTurnActive('s1', true);
    await service.execute({ action: 'close', sessionId: 's1', cwd: root, input: { tab: linkId } });
    unlinkSync(linkDir);
    symlinkSync(dirB, linkDir, linkType);
    // Verify-open creates a hidden verify tab with a collision-safe target key distinct from linkId's pre-turn key.
    await service.execute({
      action: 'open',
      sessionId: 's1',
      cwd: root,
      input: { targets: ['current/page.html'], verify: true },
    });

    // User reopen without tabId (e.g. turn preview or card) must still pick linkId's pre-turn picture, not promote verify.
    await service.command({
      action: 'reopen',
      sessionId: 's1',
      tabId: '',
      targets: ['current/page.html'],
      label: 'Symlink',
    });

    const snapDuringHold = service.snapshot().find((entry) => entry.sessionId === 's1');
    assert.equal(snapDuringHold?.active, linkId, 'selects pre-turn symlink picture instead of promoting verify tab');
    assert.deepEqual(
      snapDuringHold?.tabs.map((tab) => tab.id),
      [bId, linkId, otherId],
      'verify tab is not added to held shown tabs'
    );

    await service.setTurnActive('s1', false);
    const snapAfterTurn = service.snapshot().find((entry) => entry.sessionId === 's1');
    assert.deepEqual(
      snapAfterTurn?.tabs.map((tab) => tab.id),
      [bId, otherId],
      'verify tab stayed verify-only and closed at turn end'
    );
  } finally {
    service.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test('held All visuals entry still selects the frozen pre-turn picture after live history rekeys mid-turn', async (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mixdog-vis-held-history-rekey-')));
  const dirA = join(root, 'dir-a');
  const dirB = join(root, 'dir-b');
  mkdirSync(dirA, { recursive: true });
  mkdirSync(dirB, { recursive: true });
  writeFileSync(join(dirA, 'page.html'), '<h1>A</h1>', 'utf8');
  writeFileSync(join(dirB, 'page.html'), '<h1>B</h1>', 'utf8');
  writeFileSync(join(root, 'other.html'), '<h1>Other</h1>', 'utf8');
  const linkDir = join(root, 'current');
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  try {
    symlinkSync(dirA, linkDir, linkType);
  } catch {
    rmSync(root, { recursive: true, force: true });
    t.skip('directory symlinks unavailable');
    return;
  }

  let leaseSeq = 0;
  const service = createVisualizeService({
    windowAvailable: () => true,
    browserAvailable: () => false,
    recentShownLimit: 0,
    versions: { directory: join(root, 'versions') },
    preparePane: async (target) => `http://127.0.0.1:4100/lease-${++leaseSeq}/${target.label}`,
    publish: () => {},
    watch: () => () => {},
    annotate: async () => [],
    capture: async () => Buffer.from('PNG'),
    inspectOffscreen: async () => ({ result: { findingCount: 0 }, problems: [] }),
    onScreen: async () => 'visible',
    delay: async () => {},
  });

  try {
    await service.setShownSessions(['s1']);
    const linkTab = await service.execute({
      action: 'open',
      sessionId: 's1',
      cwd: root,
      input: { targets: ['current/page.html'], label: 'Symlink' },
    });
    const otherTab = await service.execute({
      action: 'open',
      sessionId: 's1',
      cwd: root,
      input: { targets: ['other.html'], label: 'Other' },
    });
    const linkId = linkTab.tabs[0].id;
    const otherId = otherTab.tabs[0].id;
    const preTurnEntryId = service
      .snapshot()
      .find((entry) => entry.sessionId === 's1')
      ?.history?.find((item) => item.label === 'Symlink')?.id;
    assert.ok(preTurnEntryId);

    await service.setTurnActive('s1', true);
    // Retarget symlink and reopen during the turn: live state.history rekeys the entry to a new id.
    unlinkSync(linkDir);
    symlinkSync(dirB, linkDir, linkType);
    await service.execute({
      action: 'open',
      sessionId: 's1',
      cwd: root,
      input: { targets: ['current/page.html'], label: 'Symlink' },
    });

    // Clicking the frozen pre-turn All visuals row must select the frozen pre-turn picture, not throw.
    await service.command({
      action: 'history',
      sessionId: 's1',
      tabId: '',
      entry: preTurnEntryId,
    });
    const heldSnap = service.snapshot().find((entry) => entry.sessionId === 's1');
    assert.equal(heldSnap?.active, linkId, 'frozen history entry selects pre-turn picture');
    assert.deepEqual(
      heldSnap?.tabs.map((tab) => tab.id),
      [linkId, otherId]
    );
  } finally {
    service.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test('case-only reopen recovers a missing tab on Windows without duplicating (including across park/hydrate)', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mixdog-vis-missing-case-')));
  const upperPath = join(root, 'A.html');
  writeFileSync(upperPath, '<h1>A</h1>', 'utf8');

  // Unit check: markFileTabMissing preserves lastCanonicalKey and findFileTab matches case-only reopen on win32.
  const tab = {
    id: 'v1',
    label: 'A.html',
    key: upperPath,
    cwd: root,
    revision: 1,
    targets: [{ kind: 'html', target: 'A.html', path: upperPath, root, label: 'A.html' }],
    panes: [],
    unwatch: [],
    lifetime: new AbortController(),
    reloadTimer: null,
    problems: [],
    problemSeq: 0,
  };
  const sessionState = { tabs: [tab], active: 'v1', counter: 1, history: [] };
  markFileTabMissing(sessionState, tab);
  assert.equal(tab.missing, true);
  assert.equal(tab.targets[0].path, '');
  assert.equal(tab.lastCanonicalKey, upperPath);
  if (process.platform === 'win32') {
    const recovered = findFileTab(
      sessionState.tabs,
      root,
      [{ kind: 'html', target: 'a.html', path: upperPath, root, label: 'a.html' }],
      upperPath,
      sessionState.history
    );
    assert.equal(recovered?.id, 'v1', 'folded lookup matches recovering missing tab via lastCanonicalKey');
  }

  // End-to-end check on case-insensitive Windows filesystem (including park while missing -> hydrate -> case-only reopen).
  if (process.platform === 'win32' && existsSync(join(root, 'a.html'))) {
    let leaseSeq = 0;
    const service = createVisualizeService({
      windowAvailable: () => true,
      browserAvailable: () => false,
      recentShownLimit: 0,
      versions: { directory: join(root, 'versions') },
      preparePane: async (target) => `http://127.0.0.1:4100/lease-${++leaseSeq}/${target.label}`,
      publish: () => {},
      watch: () => () => {},
      annotate: async () => [],
      capture: async () => Buffer.from('PNG'),
      inspectOffscreen: async () => ({ result: { findingCount: 0 }, problems: [] }),
      onScreen: async () => 'visible',
      delay: async () => {},
    });
    try {
      await service.setShownSessions(['s1']);
      const opened = await service.execute({
        action: 'open',
        sessionId: 's1',
        cwd: root,
        input: { targets: ['A.html'] },
      });
      const tabId = opened.tabs[0].id;

      // Park while A.html exists, remove A.html while parked, hydrate (marking it missing with preserved lastCanonicalKey).
      await service.setShownSessions([]);
      unlinkSync(upperPath);
      await service.setShownSessions(['s1']);
      const snapMissing = service.snapshot().find((entry) => entry.sessionId === 's1');
      assert.equal(snapMissing?.tabs.length, 1);
      assert.equal(snapMissing?.tabs[0].missing, true);

      // Restore A.html before retry fires and reopen using lowercase 'a.html'.
      writeFileSync(upperPath, '<h1>A restored</h1>', 'utf8');
      const reopened = await service.execute({
        action: 'open',
        sessionId: 's1',
        cwd: root,
        input: { targets: ['a.html'] },
      });
      assert.equal(reopened.tabs[0].id, tabId, 'reuses the recovering missing tab instead of duplicating');
      const snapRecovered = service.snapshot().find((entry) => entry.sessionId === 's1');
      assert.equal(snapRecovered?.tabs.length, 1);
      assert.equal(snapRecovered?.tabs[0].missing, undefined);
      assert.equal((await service.paneText('s1', tabId, 0)).text, '<h1>A restored</h1>');
    } finally {
      service.dispose();
    }
  }
  rmSync(root, { recursive: true, force: true });
});

test('clicking a closed All visuals row promotes an invisible verify tab instead of selecting it hidden', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mixdog-vis-history-promote-verify-')));
  writeFileSync(join(root, 'a.html'), '<h1>A</h1>', 'utf8');

  let leaseSeq = 0;
  const service = createVisualizeService({
    windowAvailable: () => true,
    browserAvailable: () => false,
    recentShownLimit: 0,
    versions: { directory: join(root, 'versions') },
    preparePane: async (target) => `http://127.0.0.1:4100/lease-${++leaseSeq}/${target.label}`,
    publish: () => {},
    watch: () => () => {},
    annotate: async () => [],
    capture: async () => Buffer.from('PNG'),
    inspectOffscreen: async () => ({ result: { findingCount: 0 }, problems: [] }),
    onScreen: async () => 'visible',
    delay: async () => {},
  });

  try {
    await service.setShownSessions(['s1']);
    const opened = await service.execute({
      action: 'open',
      sessionId: 's1',
      cwd: root,
      input: { targets: ['a.html'], label: 'Page A' },
    });
    await service.command({ action: 'close', sessionId: 's1', tabId: opened.tabs[0].id });

    const entryId = service
      .snapshot()
      .find((entry) => entry.sessionId === 's1')
      ?.history?.find((item) => item.label === 'Page A')?.id;
    assert.ok(entryId);

    // Open the same file as an invisible verify tab.
    await service.execute({
      action: 'open',
      sessionId: 's1',
      cwd: root,
      input: { targets: ['a.html'], verify: true },
    });
    const beforeClick = service.snapshot().find((entry) => entry.sessionId === 's1');
    assert.equal(beforeClick?.tabs.length, 0, 'verify tab is hidden');
    assert.equal(beforeClick?.history?.[0]?.open, false);

    // Clicking the closed All visuals row must promote the verify tab into a visible active tab.
    await service.command({ action: 'history', sessionId: 's1', tabId: '', entry: entryId });
    const afterClick = service.snapshot().find((entry) => entry.sessionId === 's1');
    assert.equal(afterClick?.tabs.length, 1, 'verify tab promoted to visible');
    assert.equal(afterClick?.active, afterClick?.tabs[0]?.id);
    assert.equal(afterClick?.history?.length, 1);
    assert.equal(afterClick?.history?.[0]?.open, true);
  } finally {
    service.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test('hidden verify tab does not mask an exact closed symlink history entry when retargeted onto open file B', async (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mixdog-vis-verify-masks-closed-')));
  const dirA = join(root, 'dir-a');
  const dirB = join(root, 'dir-b');
  mkdirSync(dirA, { recursive: true });
  mkdirSync(dirB, { recursive: true });
  writeFileSync(join(dirA, 'page.html'), '<h1>A</h1>', 'utf8');
  writeFileSync(join(dirB, 'page.html'), '<h1>B</h1>', 'utf8');
  const linkDir = join(root, 'link-s');
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  try {
    symlinkSync(dirA, linkDir, linkType);
  } catch {
    rmSync(root, { recursive: true, force: true });
    t.skip('directory symlinks unavailable');
    return;
  }

  let leaseSeq = 0;
  const service = createVisualizeService({
    windowAvailable: () => true,
    browserAvailable: () => false,
    recentShownLimit: 0,
    versions: { directory: join(root, 'versions') },
    preparePane: async (target) => `http://127.0.0.1:4100/lease-${++leaseSeq}/${target.label}`,
    publish: () => {},
    watch: () => () => {},
    annotate: async () => [],
    capture: async () => Buffer.from('PNG'),
    inspectOffscreen: async () => ({ result: { findingCount: 0 }, problems: [] }),
    onScreen: async () => 'visible',
    delay: async () => {},
  });

  try {
    await service.setShownSessions(['s1']);
    const bOpen = await service.execute({
      action: 'open',
      sessionId: 's1',
      cwd: root,
      input: { targets: ['dir-b/page.html'], label: 'File B' },
    });
    const sOpen = await service.execute({
      action: 'open',
      sessionId: 's1',
      cwd: root,
      input: { targets: ['link-s/page.html'], label: 'Symlink S' },
    });
    const bId = bOpen.tabs[0].id;
    const sId = sOpen.tabs[0].id;
    await service.command({ action: 'close', sessionId: 's1', tabId: sId });
    const sEntryId = service
      .snapshot()
      .find((entry) => entry.sessionId === 's1')
      ?.history?.find((item) => item.label === 'Symlink S')?.id;
    assert.ok(sEntryId);

    // Hidden verify tab for A directly takes canonical key A without owning S's closed history entry.
    await service.execute({
      action: 'open',
      sessionId: 's1',
      cwd: root,
      input: { targets: ['dir-a/page.html'], verify: true },
    });
    unlinkSync(linkDir);
    symlinkSync(dirB, linkDir, linkType);

    // Clicking S's closed history row must open a distinct tab for S and leave visible File B untouched.
    await service.command({ action: 'history', sessionId: 's1', tabId: '', entry: sEntryId });
    const snap = service.snapshot().find((entry) => entry.sessionId === 's1');
    assert.equal(snap?.tabs.length, 2, 'reopening S creates its own tab instead of reusing visible File B');
    const bTab = snap?.tabs.find((tab) => tab.id === bId);
    const sTab = snap?.tabs.find((tab) => tab.id !== bId);
    assert.equal(bTab?.label, 'File B', 'visible File B tab is preserved');
    assert.equal(sTab?.label, 'Symlink S');
    assert.equal(snap?.history?.length, 2, 'zero duplicate history rows');
    assert.deepEqual(snap?.history?.map((item) => [item.label, item.open]).sort(), [
      ['File B', true],
      ['Symlink S', true],
    ]);
  } finally {
    service.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test('recycled live key during a hold does not hijack an unrelated pre-turn frozen picture', async (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mixdog-vis-recycled-held-key-')));
  const dirA = join(root, 'dir-a');
  const dirC = join(root, 'dir-c');
  const dirD = join(root, 'dir-d');
  for (const [dir, html] of [
    [dirA, '<h1>A</h1>'],
    [dirC, '<h1>C</h1>'],
    [dirD, '<h1>D</h1>'],
  ]) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'page.html'), html, 'utf8');
  }
  const linkS = join(root, 'link-s');
  const linkT = join(root, 'link-t');
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  try {
    symlinkSync(dirA, linkS, linkType);
    symlinkSync(dirC, linkT, linkType);
  } catch {
    rmSync(root, { recursive: true, force: true });
    t.skip('directory symlinks unavailable');
    return;
  }

  let leaseSeq = 0;
  const service = createVisualizeService({
    windowAvailable: () => true,
    browserAvailable: () => false,
    recentShownLimit: 0,
    versions: { directory: join(root, 'versions') },
    preparePane: async (target) => `http://127.0.0.1:4100/lease-${++leaseSeq}/${target.label}`,
    publish: () => {},
    watch: () => () => {},
    annotate: async () => [],
    capture: async () => Buffer.from('PNG'),
    inspectOffscreen: async () => ({ result: { findingCount: 0 }, problems: [] }),
    onScreen: async () => 'visible',
    delay: async () => {},
  });

  try {
    await service.setShownSessions(['s1']);
    const sOpen = await service.execute({
      action: 'open',
      sessionId: 's1',
      cwd: root,
      input: { targets: ['link-s/page.html'], label: 'Symlink S' },
    });
    const tOpen = await service.execute({
      action: 'open',
      sessionId: 's1',
      cwd: root,
      input: { targets: ['link-t/page.html'], label: 'Symlink T' },
    });
    const sId = sOpen.tabs[0].id;
    await service.command({ action: 'close', sessionId: 's1', tabId: tOpen.tabs[0].id });

    const preTurnHistory = service.snapshot().find((entry) => entry.sessionId === 's1')?.history ?? [];
    const sEntryId = preTurnHistory.find((item) => item.label === 'Symlink S')?.id;
    const tEntryId = preTurnHistory.find((item) => item.label === 'Symlink T')?.id;
    assert.ok(sEntryId && tEntryId);

    // Start a hold with S->A open and T->C closed.
    await service.setTurnActive('s1', true);
    // During the turn: S retargets to D (vacating live key A), then T retargets to A and opens (recycling live key A).
    unlinkSync(linkS);
    symlinkSync(dirD, linkS, linkType);
    await service.execute({
      action: 'open',
      sessionId: 's1',
      cwd: root,
      input: { targets: ['link-s/page.html'], label: 'Symlink S' },
    });
    unlinkSync(linkT);
    symlinkSync(dirA, linkT, linkType);
    const tTurnOpen = await service.execute({
      action: 'open',
      sessionId: 's1',
      cwd: root,
      input: { targets: ['link-t/page.html'], label: 'Symlink T' },
    });
    const tTurnId = tTurnOpen.tabs[0].id;

    // Clicking T's frozen history row must show the turn's T tab (turnWork), NOT select pre-turn S!
    await service.command({ action: 'history', sessionId: 's1', tabId: '', entry: tEntryId });
    const heldAfterT = service.snapshot().find((entry) => entry.sessionId === 's1');
    assert.equal(heldAfterT?.active, tTurnId, 'clicking frozen T shows turn tab T instead of pre-turn S');
    assert.deepEqual(
      heldAfterT?.tabs.map((tab) => [tab.id, tab.turnWork]),
      [
        [sId, undefined],
        [tTurnId, true],
      ],
      'pre-turn S picture stays intact alongside turn-work T tab'
    );

    // Clicking S's frozen history row still selects pre-turn S.
    await service.command({ action: 'history', sessionId: 's1', tabId: '', entry: sEntryId });
    const heldAfterS = service.snapshot().find((entry) => entry.sessionId === 's1');
    assert.equal(heldAfterS?.active, sId, 'clicking frozen S still selects pre-turn S picture');
  } finally {
    service.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test('hydrating a parked held session preserves frozen history IDs even when a file goes missing while parked', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mixdog-vis-parked-hold-missing-')));
  const pageA = join(root, 'a.html');
  writeFileSync(pageA, '<h1>A</h1>', 'utf8');
  writeFileSync(join(root, 'other.html'), '<h1>Other</h1>', 'utf8');

  let leaseSeq = 0;
  const service = createVisualizeService({
    windowAvailable: () => true,
    browserAvailable: () => false,
    recentShownLimit: 0,
    versions: { directory: join(root, 'versions') },
    preparePane: async (target) => `http://127.0.0.1:4100/lease-${++leaseSeq}/${target.label}`,
    publish: () => {},
    watch: () => () => {},
    annotate: async () => [],
    capture: async () => Buffer.from('PNG'),
    inspectOffscreen: async () => ({ result: { findingCount: 0 }, problems: [] }),
    onScreen: async () => 'visible',
    delay: async () => {},
  });

  try {
    await service.setShownSessions(['s1']);
    const aOpen = await service.execute({
      action: 'open',
      sessionId: 's1',
      cwd: root,
      input: { targets: ['a.html'], label: 'Page A' },
    });
    const otherOpen = await service.execute({
      action: 'open',
      sessionId: 's1',
      cwd: root,
      input: { targets: ['other.html'], label: 'Other' },
    });
    const aId = aOpen.tabs[0].id;
    const otherId = otherOpen.tabs[0].id;

    // Park the session and start a turn hold while parked.
    await service.setShownSessions([]);
    await service.settled();
    await service.setTurnActive('s1', true);
    const advertisedEntryId = service
      .snapshot()
      .find((entry) => entry.sessionId === 's1')
      ?.history?.find((item) => item.label === 'Page A')?.id;
    assert.ok(advertisedEntryId, 'parked held snapshot advertises pre-park history id');

    // Remove a.html while still parked, then click the advertised history row (which hydrates first).
    unlinkSync(pageA);
    await service.command({ action: 'history', sessionId: 's1', tabId: '', entry: advertisedEntryId });

    const snapDuringHold = service.snapshot().find((entry) => entry.sessionId === 's1');
    assert.equal(snapDuringHold?.held, true);
    assert.equal(snapDuringHold?.active, aId, 'frozen history click selects pre-park tab without throwing');
    assert.deepEqual(
      snapDuringHold?.tabs.map((tab) => tab.id),
      [aId, otherId]
    );
    assert.ok(
      snapDuringHold?.history?.some((item) => item.id === advertisedEntryId),
      'frozen history id stays advertised until the hold ends'
    );
  } finally {
    service.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test('missing tab recovery matches case-changed restored filename on Windows without duplicating', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mixdog-vis-missing-case-recreate-')));
  const upperPath = join(root, 'A.html');
  const lowerPath = join(root, 'a.html');

  // Unit check: missing tab whose lastCanonicalKey ended in A.html matches restored canonical path ending in a.html.
  const tab = {
    id: 'v1',
    label: 'A.html',
    key: upperPath,
    cwd: root,
    revision: 1,
    targets: [{ kind: 'html', target: 'A.html', path: upperPath, root, label: 'A.html' }],
    panes: [],
    unwatch: [],
    lifetime: new AbortController(),
    reloadTimer: null,
    problems: [],
    problemSeq: 0,
  };
  const sessionState = { tabs: [tab], active: 'v1', counter: 1, history: [] };
  markFileTabMissing(sessionState, tab);
  assert.equal(tab.lastCanonicalKey, upperPath);
  if (process.platform === 'win32') {
    const recovered = findFileTab(
      sessionState.tabs,
      root,
      [{ kind: 'html', target: 'a.html', path: lowerPath, root, label: 'a.html' }],
      lowerPath,
      sessionState.history
    );
    assert.equal(recovered?.id, 'v1', 'folded missing-tab recovery compares lastCanonicalKey case-insensitively');
  }

  // End-to-end on case-insensitive Windows filesystem: delete A.html, recreate as lowercase a.html, reopen a.html.
  writeFileSync(upperPath, '<h1>Upper</h1>', 'utf8');
  if (process.platform === 'win32' && existsSync(lowerPath)) {
    let leaseSeq = 0;
    const service = createVisualizeService({
      windowAvailable: () => true,
      browserAvailable: () => false,
      recentShownLimit: 0,
      versions: { directory: join(root, 'versions') },
      preparePane: async (target) => `http://127.0.0.1:4100/lease-${++leaseSeq}/${target.label}`,
      publish: () => {},
      watch: () => () => {},
      annotate: async () => [],
      capture: async () => Buffer.from('PNG'),
      inspectOffscreen: async () => ({ result: { findingCount: 0 }, problems: [] }),
      onScreen: async () => 'visible',
      delay: async () => {},
    });
    try {
      await service.setShownSessions(['s1']);
      const opened = await service.execute({
        action: 'open',
        sessionId: 's1',
        cwd: root,
        input: { targets: ['A.html'] },
      });
      const tabId = opened.tabs[0].id;

      await service.setShownSessions([]);
      unlinkSync(upperPath);
      await service.setShownSessions(['s1']);
      assert.equal(service.snapshot().find((entry) => entry.sessionId === 's1')?.tabs[0]?.missing, true);

      // Recreate with lowercase filename on disk so realpath resolves to .../a.html instead of .../A.html.
      writeFileSync(lowerPath, '<h1>Lower restored</h1>', 'utf8');
      const reopened = await service.execute({
        action: 'open',
        sessionId: 's1',
        cwd: root,
        input: { targets: ['a.html'] },
      });
      assert.equal(reopened.tabs[0].id, tabId, 'reuses recovering missing tab when restored filename changes case');
      const snap = service.snapshot().find((entry) => entry.sessionId === 's1');
      assert.equal(snap?.tabs.length, 1);
      assert.equal(snap?.tabs[0]?.missing, undefined);
      assert.equal((await service.paneText('s1', tabId, 0)).text, '<h1>Lower restored</h1>');
    } finally {
      service.dispose();
    }
  }
  rmSync(root, { recursive: true, force: true });
});

test('canonical fallback reuses a live symlink tab with a collision-safe key after file B closes', async (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mixdog-vis-canonical-collision-key-')));
  const dirA = join(root, 'dir-a');
  const dirB = join(root, 'dir-b');
  mkdirSync(dirA, { recursive: true });
  mkdirSync(dirB, { recursive: true });
  writeFileSync(join(dirA, 'page.html'), '<h1>A</h1>', 'utf8');
  writeFileSync(join(dirB, 'page.html'), '<h1>B</h1>', 'utf8');
  const linkS = join(root, 'link-s');
  const linkAlias = join(root, 'link-alias');
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  try {
    symlinkSync(dirA, linkS, linkType);
    symlinkSync(dirB, linkAlias, linkType);
  } catch {
    rmSync(root, { recursive: true, force: true });
    t.skip('directory symlinks unavailable');
    return;
  }

  let leaseSeq = 0;
  const service = createVisualizeService({
    windowAvailable: () => true,
    browserAvailable: () => false,
    recentShownLimit: 0,
    versions: { directory: join(root, 'versions') },
    preparePane: async (target) => `http://127.0.0.1:4100/lease-${++leaseSeq}/${target.label}`,
    publish: () => {},
    watch: () => () => {},
    annotate: async () => [],
    capture: async () => Buffer.from('PNG'),
    inspectOffscreen: async () => ({ result: { findingCount: 0 }, problems: [] }),
    onScreen: async () => 'visible',
    delay: async () => {},
  });

  try {
    await service.setShownSessions(['s1']);
    const bOpen = await service.execute({
      action: 'open',
      sessionId: 's1',
      cwd: root,
      input: { targets: ['dir-b/page.html'], label: 'File B' },
    });
    const sOpen = await service.execute({
      action: 'open',
      sessionId: 's1',
      cwd: root,
      input: { targets: ['link-s/page.html'], label: 'Symlink S' },
    });
    const bId = bOpen.tabs[0].id;
    const sId = sOpen.tabs[0].id;

    // Park, retarget S -> B, hydrate so S keeps a collision-safe requested-path key, then close B.
    await service.setShownSessions([]);
    unlinkSync(linkS);
    symlinkSync(dirB, linkS, linkType);
    await service.setShownSessions(['s1']);
    await service.command({ action: 'close', sessionId: 's1', tabId: bId });

    // Opening a brand-new alias to B must reuse live S instead of creating a duplicate tab for B.
    const aliasOpen = await service.execute({
      action: 'open',
      sessionId: 's1',
      cwd: root,
      input: { targets: ['link-alias/page.html'], label: 'Alias B' },
    });
    assert.equal(aliasOpen.tabs[0].id, sId, 'canonical fallback reuses live collision-safe symlink tab');
    const snap = service.snapshot().find((entry) => entry.sessionId === 's1');
    assert.equal(snap?.tabs.length, 1, 'no duplicate open tab created');
    assert.ok(
      snap?.history?.some((item) => item.label === 'File B' && item.open === false),
      'closed File B history entry survives'
    );
  } finally {
    service.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test('parking strips inline history sources from memory and restores them from parkStore on hydration', async () => {
  const bigSource = `<svg>${'x'.repeat(200_000)}</svg>`;
  const stripped = stripParkedHistory([
    {
      id: 'in-1',
      key: 'inline:Big',
      label: 'Big',
      remoteLabel: 'Big',
      kind: 'svg',
      targets: [],
      content: { kind: 'svg', title: 'Big', source: bigSource },
      at: 1,
      versions: 1,
    },
  ]);
  assert.equal(stripped[0].content?.source, '', 'stripParkedHistory drops inline source bytes');
  assert.equal(stripped[0].content?.deferred, true, 'stripParkedHistory marks inline history deferred');
  assert.equal(stripped[0].content?.title, 'Big');

  // End-to-end: prove a closed inline history entry clicked under a parked hold loads its source from parkStore.
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mixdog-vis-parked-inline-history-')));
  const backing = createVisualizeParkStore(join(root, 'parked'));
  const diskMarker = '<svg>restored-from-disk-store</svg>';
  let loadCalls = 0;
  const parkStore = {
    save: (sessionId, data) => backing.save(sessionId, data),
    load: async (sessionId) => {
      loadCalls += 1;
      const loaded = await backing.load(sessionId);
      if (loaded) {
        for (const entry of loaded.history) {
          if (entry.content?.title === 'Big') entry.content = { ...entry.content, source: diskMarker };
        }
      }
      return loaded;
    },
    remove: (sessionId) => backing.remove(sessionId),
    dispose: () => backing.dispose(),
    settled: () => backing.settled(),
  };

  let leaseSeq = 0;
  const service = createVisualizeService({
    windowAvailable: () => true,
    browserAvailable: () => false,
    recentShownLimit: 0,
    parkStore,
    versions: { directory: join(root, 'versions') },
    preparePane: async (target) => `http://127.0.0.1:4100/lease-${++leaseSeq}/${target.label}`,
    prepareInlinePage: async () => `http://127.0.0.1:4100/lease-${++leaseSeq}/inline.html`,
    publish: () => {},
    watch: () => () => {},
    annotate: async () => [],
    capture: async () => Buffer.from('PNG'),
    inspectOffscreen: async () => ({ result: { findingCount: 0 }, problems: [] }),
    onScreen: async () => 'visible',
    delay: async () => {},
  });

  try {
    await service.setShownSessions(['s1']);
    const opened = await service.execute({
      action: 'open',
      sessionId: 's1',
      cwd: root,
      input: { content: { kind: 'svg', title: 'Big', source: bigSource } },
    });
    await service.command({ action: 'close', sessionId: 's1', tabId: opened.tabs[0].id });

    // Park s1 while idle, then start a turn hold while parked.
    await service.setShownSessions([]);
    await service.settled();
    await service.setTurnActive('s1', true);
    const entryId = service
      .snapshot()
      .find((entry) => entry.sessionId === 's1')
      ?.history?.find((item) => item.label === 'Big')?.id;
    assert.ok(entryId);

    // Click the closed inline history row during the parked hold: hydrates full source from disk store.
    await service.command({ action: 'history', sessionId: 's1', tabId: '', entry: entryId });
    assert.ok(loadCalls > 0, 'hydration loaded full inline history from parkStore');
    const reopenedTab = service.snapshot().find((entry) => entry.sessionId === 's1')?.tabs[0];
    assert.equal(
      reopenedTab?.panes[0]?.inline?.source,
      diskMarker,
      'inline source was hydrated from parkStore on disk rather than retained in parkedSessions memory'
    );
  } finally {
    service.dispose();
    await parkStore.settled();
    rmSync(root, { recursive: true, force: true });
  }
});

test('clicking frozen T during a hold does not select unrelated pre-turn picture S when both links retarget to D', async (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mixdog-vis-held-unrelated-past-')));
  const dirA = join(root, 'dir-a');
  const dirC = join(root, 'dir-c');
  const dirD = join(root, 'dir-d');
  for (const [dir, html] of [
    [dirA, '<h1>A</h1>'],
    [dirC, '<h1>C</h1>'],
    [dirD, '<h1>D</h1>'],
  ]) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'page.html'), html, 'utf8');
  }
  const linkS = join(root, 'link-s');
  const linkT = join(root, 'link-t');
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  try {
    symlinkSync(dirA, linkS, linkType);
    symlinkSync(dirC, linkT, linkType);
  } catch {
    rmSync(root, { recursive: true, force: true });
    t.skip('directory symlinks unavailable');
    return;
  }

  let leaseSeq = 0;
  const service = createVisualizeService({
    windowAvailable: () => true,
    browserAvailable: () => false,
    recentShownLimit: 0,
    versions: { directory: join(root, 'versions') },
    preparePane: async (target) => `http://127.0.0.1:4100/lease-${++leaseSeq}/${target.label}`,
    publish: () => {},
    watch: () => () => {},
    annotate: async () => [],
    capture: async () => Buffer.from('PNG'),
    inspectOffscreen: async () => ({ result: { findingCount: 0 }, problems: [] }),
    onScreen: async () => 'visible',
    delay: async () => {},
  });

  try {
    await service.setShownSessions(['s1']);
    const sOpen = await service.execute({
      action: 'open',
      sessionId: 's1',
      cwd: root,
      input: { targets: ['link-s/page.html'], label: 'Symlink S' },
    });
    const tOpen = await service.execute({
      action: 'open',
      sessionId: 's1',
      cwd: root,
      input: { targets: ['link-t/page.html'], label: 'Symlink T' },
    });
    const sId = sOpen.tabs[0].id;
    await service.command({ action: 'close', sessionId: 's1', tabId: tOpen.tabs[0].id });
    const tEntryId = service
      .snapshot()
      .find((entry) => entry.sessionId === 's1')
      ?.history?.find((item) => item.label === 'Symlink T')?.id;
    assert.ok(tEntryId);

    // Hold starts with S -> A open and T -> C closed.
    await service.setTurnActive('s1', true);
    // Open C directly (replacing T's live history entry), retarget both S and T -> D, and reopen S.
    await service.execute({
      action: 'open',
      sessionId: 's1',
      cwd: root,
      input: { targets: ['dir-c/page.html'], label: 'File C' },
    });
    unlinkSync(linkS);
    unlinkSync(linkT);
    symlinkSync(dirD, linkS, linkType);
    symlinkSync(dirD, linkT, linkType);
    await service.execute({
      action: 'open',
      sessionId: 's1',
      cwd: root,
      input: { targets: ['link-s/page.html'], label: 'Symlink S' },
    });

    // Clicking frozen T must open T -> D cleanly rather than selecting S's pre-turn picture of A.
    await service.command({ action: 'history', sessionId: 's1', tabId: '', entry: tEntryId });
    const snapDuringHold = service.snapshot().find((entry) => entry.sessionId === 's1');
    assert.equal(snapDuringHold?.held, true);
    assert.notEqual(snapDuringHold?.active, sId, 'does not select unrelated pre-turn S picture');
    assert.equal(snapDuringHold?.tabs.length, 2, 'keeps pre-turn S picture alongside newly opened T -> D');
    const activeTab = snapDuringHold?.tabs.find((tab) => tab.id === snapDuringHold.active);
    assert.equal(activeTab?.label, 'Symlink T');
    assert.equal((await service.paneText('s1', activeTab.id, 0)).text, '<h1>D</h1>');
    assert.equal((await service.paneText('s1', sId, 0)).text, '<h1>A</h1>', 'pre-turn S picture remains A');
  } finally {
    service.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test('held file history click does not short-circuit on recycled key from a newly joined direct tab', async (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mixdog-vis-held-history-recycled-key-')));
  const dirC = join(root, 'dir-c');
  const dirD = join(root, 'dir-d');
  mkdirSync(dirC, { recursive: true });
  mkdirSync(dirD, { recursive: true });
  writeFileSync(join(dirC, 'page.html'), '<h1>C</h1>', 'utf8');
  writeFileSync(join(dirD, 'page.html'), '<h1>D</h1>', 'utf8');
  const linkT = join(root, 'link-t');
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  try {
    symlinkSync(dirC, linkT, linkType);
  } catch {
    rmSync(root, { recursive: true, force: true });
    t.skip('directory symlinks unavailable');
    return;
  }

  let leaseSeq = 0;
  const service = createVisualizeService({
    windowAvailable: () => true,
    browserAvailable: () => false,
    recentShownLimit: 0,
    versions: { directory: join(root, 'versions') },
    preparePane: async (target) => `http://127.0.0.1:4100/lease-${++leaseSeq}/${target.label}`,
    publish: () => {},
    watch: () => () => {},
    annotate: async () => [],
    capture: async () => Buffer.from('PNG'),
    inspectOffscreen: async () => ({ result: { findingCount: 0 }, problems: [] }),
    onScreen: async () => 'visible',
    delay: async () => {},
  });

  try {
    await service.setShownSessions(['s1']);
    const tOpen = await service.execute({
      action: 'open',
      sessionId: 's1',
      cwd: root,
      input: { targets: ['link-t/page.html'], label: 'Symlink T' },
    });
    await service.command({ action: 'close', sessionId: 's1', tabId: tOpen.tabs[0].id });
    const tEntryId = service
      .snapshot()
      .find((entry) => entry.sessionId === 's1')
      ?.history?.find((item) => item.label === 'Symlink T')?.id;
    assert.ok(tEntryId);

    // Start a hold with T -> C closed.
    await service.setTurnActive('s1', true);
    // User reopens C directly from a chat card (joining hold.shown without turnWork, recycling key C).
    await service.command({
      action: 'reopen',
      sessionId: 's1',
      tabId: '',
      targets: ['dir-c/page.html'],
      label: 'File C',
    });
    const cId = service.snapshot().find((entry) => entry.sessionId === 's1')?.active;
    assert.ok(cId);

    // Retarget T -> D, then click frozen T in All visuals.
    unlinkSync(linkT);
    symlinkSync(dirD, linkT, linkType);
    await service.command({ action: 'history', sessionId: 's1', tabId: '', entry: tEntryId });

    const snap = service.snapshot().find((entry) => entry.sessionId === 's1');
    assert.equal(snap?.held, true);
    assert.equal(snap?.tabs.length, 2, 'opens T -> D instead of short-circuiting to C');
    assert.notEqual(snap?.active, cId);
    const tTab = snap?.tabs.find((tab) => tab.id === snap.active);
    assert.equal(tTab?.label, 'Symlink T');
    assert.equal((await service.paneText('s1', tTab.id, 0)).text, '<h1>D</h1>');
    assert.equal((await service.paneText('s1', cId, 0)).text, '<h1>C</h1>');
  } finally {
    service.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test('clicking closed T during a hold promotes its hidden verify tab instead of selecting turn-preview B', async (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mixdog-vis-held-promote-verify-over-turn-')));
  const dirA = join(root, 'dir-a');
  const dirB = join(root, 'dir-b');
  mkdirSync(dirA, { recursive: true });
  mkdirSync(dirB, { recursive: true });
  writeFileSync(join(dirA, 'page.html'), '<h1>A</h1>', 'utf8');
  writeFileSync(join(dirB, 'page.html'), '<h1>B</h1>', 'utf8');
  const linkT = join(root, 'link-t');
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  try {
    symlinkSync(dirA, linkT, linkType);
  } catch {
    rmSync(root, { recursive: true, force: true });
    t.skip('directory symlinks unavailable');
    return;
  }

  let leaseSeq = 0;
  const service = createVisualizeService({
    windowAvailable: () => true,
    browserAvailable: () => false,
    recentShownLimit: 0,
    versions: { directory: join(root, 'versions') },
    preparePane: async (target) => `http://127.0.0.1:4100/lease-${++leaseSeq}/${target.label}`,
    publish: () => {},
    watch: () => () => {},
    annotate: async () => [],
    capture: async () => Buffer.from('PNG'),
    inspectOffscreen: async () => ({ result: { findingCount: 0 }, problems: [] }),
    onScreen: async () => 'visible',
    delay: async () => {},
  });

  try {
    await service.setShownSessions(['s1']);
    const tOpen = await service.execute({
      action: 'open',
      sessionId: 's1',
      cwd: root,
      input: { targets: ['link-t/page.html'], label: 'Symlink T' },
    });
    await service.command({ action: 'close', sessionId: 's1', tabId: tOpen.tabs[0].id });
    const tEntryId = service
      .snapshot()
      .find((entry) => entry.sessionId === 's1')
      ?.history?.find((item) => item.label === 'Symlink T')?.id;
    assert.ok(tEntryId);

    // Start a hold with T -> A closed.
    await service.setTurnActive('s1', true);
    // Agent opens B, user views B's turn preview, then T is retargeted to B and verify-opened.
    const bOpen = await service.execute({
      action: 'open',
      sessionId: 's1',
      cwd: root,
      input: { targets: ['dir-b/page.html'], label: 'File B' },
    });
    const bId = bOpen.tabs[0].id;
    await service.command({
      action: 'reopen',
      sessionId: 's1',
      tabId: '',
      targets: ['dir-b/page.html'],
      label: 'File B',
    });
    assert.equal(service.snapshot().find((entry) => entry.sessionId === 's1')?.active, bId);

    unlinkSync(linkT);
    symlinkSync(dirB, linkT, linkType);
    await service.execute({
      action: 'open',
      sessionId: 's1',
      cwd: root,
      input: { targets: ['link-t/page.html'], verify: true },
    });

    // Clicking T's history row must promote T's hidden verify tab instead of selecting B's preview.
    await service.command({ action: 'history', sessionId: 's1', tabId: '', entry: tEntryId });
    const snapDuringHold = service.snapshot().find((entry) => entry.sessionId === 's1');
    assert.equal(snapDuringHold?.held, true);
    assert.notEqual(snapDuringHold?.active, bId, 'promotes T instead of selecting turn-preview B');
    assert.equal(snapDuringHold?.tabs.length, 2, 'promoted T appears alongside turn-preview B');
    const promotedT = snapDuringHold?.tabs.find((tab) => tab.id === snapDuringHold.active);
    assert.equal(promotedT?.label, 'Symlink T');
    assert.equal(promotedT?.turnWork, undefined);

    // After the turn ends, both B and promoted T remain open with zero duplicate history rows.
    await service.setTurnActive('s1', false);
    const snapAfterTurn = service.snapshot().find((entry) => entry.sessionId === 's1');
    assert.equal(snapAfterTurn?.tabs.length, 2);
    assert.equal(snapAfterTurn?.history?.length, 2);
    assert.ok(snapAfterTurn?.history?.every((item) => item.open));
  } finally {
    service.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test('newly joined tab with recycled key does not mask frozen closed history row or select stale past picture', async (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mixdog-vis-recycled-mask-past-')));
  const dirA = join(root, 'dir-a');
  const dirC = join(root, 'dir-c');
  mkdirSync(dirA, { recursive: true });
  mkdirSync(dirC, { recursive: true });
  writeFileSync(join(dirA, 'page.html'), '<h1>A</h1>', 'utf8');
  writeFileSync(join(dirC, 'page.html'), '<h1>C</h1>', 'utf8');
  const linkS = join(root, 'link-s');
  const linkT = join(root, 'link-t');
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  try {
    symlinkSync(dirA, linkS, linkType);
    symlinkSync(dirC, linkT, linkType);
  } catch {
    rmSync(root, { recursive: true, force: true });
    t.skip('directory symlinks unavailable');
    return;
  }

  let leaseSeq = 0;
  const service = createVisualizeService({
    windowAvailable: () => true,
    browserAvailable: () => false,
    recentShownLimit: 0,
    versions: { directory: join(root, 'versions') },
    preparePane: async (target) => `http://127.0.0.1:4100/lease-${++leaseSeq}/${target.label}`,
    publish: () => {},
    watch: () => () => {},
    annotate: async () => [],
    capture: async () => Buffer.from('PNG'),
    inspectOffscreen: async () => ({ result: { findingCount: 0 }, problems: [] }),
    onScreen: async () => 'visible',
    delay: async () => {},
  });

  try {
    await service.setShownSessions(['s1']);
    const sOpen = await service.execute({
      action: 'open',
      sessionId: 's1',
      cwd: root,
      input: { targets: ['link-s/page.html'], label: 'Symlink S' },
    });
    const tOpen = await service.execute({
      action: 'open',
      sessionId: 's1',
      cwd: root,
      input: { targets: ['link-t/page.html'], label: 'Symlink T' },
    });
    const sId = sOpen.tabs[0].id;
    await service.command({ action: 'close', sessionId: 's1', tabId: tOpen.tabs[0].id });
    const tEntryId = service
      .snapshot()
      .find((entry) => entry.sessionId === 's1')
      ?.history?.find((item) => item.label === 'Symlink T')?.id;
    assert.ok(tEntryId);

    // Start a hold with S -> A open and T -> C closed.
    await service.setTurnActive('s1', true);
    // Reopen C directly from a card so C joins hold.shown without turnWork, recycling key C.
    await service.command({
      action: 'reopen',
      sessionId: 's1',
      tabId: '',
      targets: ['dir-c/page.html'],
      label: 'File C',
    });
    const cId = service.snapshot().find((entry) => entry.sessionId === 's1')?.active;
    assert.ok(cId);

    // Change S during the turn so its pre-turn picture of A in hold.shown is now 'past'.
    await service.execute({
      action: 'open',
      sessionId: 's1',
      cwd: root,
      input: { targets: ['link-s/page.html'], label: 'Symlink S updated' },
    });

    // Retarget T -> A and click frozen T in All visuals.
    unlinkSync(linkT);
    symlinkSync(dirA, linkT, linkType);
    await service.command({ action: 'history', sessionId: 's1', tabId: '', entry: tEntryId });

    const snapDuringHold = service.snapshot().find((entry) => entry.sessionId === 's1');
    assert.equal(snapDuringHold?.held, true);
    assert.notEqual(snapDuringHold?.active, sId, 'does not select stale past picture of S');
    assert.notEqual(snapDuringHold?.active, cId, 'does not select newly joined C tab');
    assert.equal(snapDuringHold?.tabs.length, 3, 'opens T -> A alongside S picture and joined C');
    const tTab = snapDuringHold?.tabs.find((tab) => tab.id === snapDuringHold.active);
    assert.equal(tTab?.label, 'Symlink T');
    assert.equal((await service.paneText('s1', tTab.id, 0)).text, '<h1>A</h1>');
  } finally {
    service.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test('transient park-store disk read failure preserves parked session and retries on next show', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mixdog-vis-park-transient-read-')));
  const parkDir = join(root, 'parked');
  const directStore = createVisualizeParkStore(parkDir);
  try {
    await directStore.save('s-dir', {
      active: 'v1',
      counter: 1,
      cwd: root,
      history: [],
      tabs: [],
    });
    await directStore.save('s-bad-json', {
      active: null,
      counter: 0,
      cwd: root,
      history: [],
      tabs: [],
    });
    const [fileA, fileB] = readdirSync(parkDir).sort();
    // Corrupt one file and replace the other with a directory so readFile throws non-ENOENT (EISDIR).
    const firstPath = join(parkDir, fileA);
    const secondPath = join(parkDir, fileB);
    const firstContent = JSON.parse(await (await import('node:fs/promises')).readFile(firstPath, 'utf8'));
    const dirTarget = firstContent.active === 'v1' ? firstPath : secondPath;
    const corruptTarget = dirTarget === firstPath ? secondPath : firstPath;
    unlinkSync(dirTarget);
    mkdirSync(dirTarget);
    writeFileSync(corruptTarget, '{not-json', 'utf8');

    assert.equal(await directStore.load('s-missing'), null, 'ENOENT returns null');
    assert.equal(await directStore.load('s-bad-json'), null, 'corrupt JSON returns null');
    await assert.rejects(
      () => directStore.load('s-dir'),
      (error) => error?.code !== 'ENOENT',
      'non-ENOENT filesystem error rejects instead of returning null'
    );
  } finally {
    directStore.dispose();
    await directStore.settled();
  }

  // End-to-end service test with simulated transient EBUSY failures on parkStore.load.
  writeFileSync(join(root, 'page.html'), '<h1>Persisted</h1>', 'utf8');
  const backing = createVisualizeParkStore(join(root, 'service-parked'));
  let remainingFailures = 0;
  const parkStore = {
    save: (sessionId, data) => backing.save(sessionId, data),
    load: async (sessionId) => {
      if (remainingFailures > 0) {
        remainingFailures -= 1;
        const error = Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
        throw error;
      }
      return backing.load(sessionId);
    },
    remove: (sessionId) => backing.remove(sessionId),
    dispose: () => backing.dispose(),
    settled: () => backing.settled(),
  };

  let leaseSeq = 0;
  const service = createVisualizeService({
    windowAvailable: () => true,
    browserAvailable: () => false,
    recentShownLimit: 0,
    parkStore,
    versions: { directory: join(root, 'versions') },
    preparePane: async (target) => `http://127.0.0.1:4100/lease-${++leaseSeq}/${target.label}`,
    publish: () => {},
    watch: () => () => {},
    annotate: async () => [],
    capture: async () => Buffer.from('PNG'),
    inspectOffscreen: async () => ({ result: { findingCount: 0 }, problems: [] }),
    onScreen: async () => 'visible',
    delay: async () => {},
  });

  try {
    await service.setShownSessions(['s1']);
    const opened = await service.execute({
      action: 'open',
      sessionId: 's1',
      cwd: root,
      input: { targets: ['page.html'], label: 'Persisted Page' },
    });
    const tabId = opened.tabs[0].id;
    await service.setShownSessions([]);
    await service.settled();

    // First show hits transient EBUSY: parked entry must remain intact in snapshot, not dropped.
    remainingFailures = 1;
    await service.setShownSessions(['s1']);
    const snapAfterTransientShow = service.snapshot().find((entry) => entry.sessionId === 's1');
    assert.ok(snapAfterTransientShow, 'parked session survives transient load error on show');
    assert.equal(snapAfterTransientShow.tabs.length, 1);
    assert.equal(snapAfterTransientShow.tabs[0].panes[0].url, '', 'still parked awaiting retry');

    // Operation hitting transient EBUSY rejects without dropping parked state or creating a blank session.
    remainingFailures = 1;
    await assert.rejects(() => service.paneText('s1', tabId, 0), /EBUSY/);
    assert.ok(
      service.snapshot().find((entry) => entry.sessionId === 's1'),
      'parked session survives transient load error on operation'
    );

    // Next show succeeds and restores live tab URLs and history from the intact park file.
    await service.setShownSessions(['s1']);
    const restored = service.snapshot().find((entry) => entry.sessionId === 's1');
    assert.equal(restored?.tabs.length, 1);
    assert.equal(restored?.tabs[0]?.id, tabId);
    assert.ok(restored?.tabs[0]?.panes[0]?.url, 'hydrated with live lease URL on retry');
    assert.equal(restored?.history?.length, 1);
    assert.equal((await service.paneText('s1', tabId, 0)).text, '<h1>Persisted</h1>');
  } finally {
    service.dispose();
    await parkStore.settled();
    rmSync(root, { recursive: true, force: true });
  }
});

test('Windows case-folded verify tab is promoted on frozen history click without duplicating', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mixdog-vis-folded-verify-promote-')));
  const upperPath = join(root, 'A.html');
  const lowerPath = join(root, 'a.html');
  const otherPath = join(root, 'other.html');
  writeFileSync(upperPath, '<h1>A</h1>', 'utf8');
  writeFileSync(otherPath, '<h1>Other</h1>', 'utf8');

  // Unit check: findVerifyRequestedTab matches folded verify tab only when canonical target also matches.
  if (process.platform === 'win32') {
    const verifyTab = {
      id: 'v2',
      label: 'a.html',
      key: upperPath,
      cwd: root,
      verify: true,
      revision: 1,
      targets: [{ kind: 'html', target: 'a.html', path: upperPath, root, label: 'a.html' }],
      panes: [],
      unwatch: [],
      lifetime: new AbortController(),
      reloadTimer: null,
      problems: [],
      problemSeq: 0,
    };
    assert.equal(
      findVerifyRequestedTab(
        [verifyTab],
        root,
        [{ kind: 'html', target: 'A.html', path: upperPath, root, label: 'A.html' }],
        upperPath
      )?.id,
      'v2',
      'matches folded verify tab with identical canonical target'
    );
    assert.equal(
      findVerifyRequestedTab(
        [verifyTab],
        root,
        [{ kind: 'html', target: 'A.html', path: otherPath, root, label: 'A.html' }],
        otherPath
      ),
      undefined,
      'does not match when canonical target differs (symlink retarget protection)'
    );
  }

  // End-to-end on case-insensitive Windows filesystem: close A.html, start hold, verify-open a.html, click frozen A.html.
  if (process.platform === 'win32' && existsSync(lowerPath)) {
    let leaseSeq = 0;
    const service = createVisualizeService({
      windowAvailable: () => true,
      browserAvailable: () => false,
      recentShownLimit: 0,
      versions: { directory: join(root, 'versions') },
      preparePane: async (target) => `http://127.0.0.1:4100/lease-${++leaseSeq}/${target.label}`,
      publish: () => {},
      watch: () => () => {},
      annotate: async () => [],
      capture: async () => Buffer.from('PNG'),
      inspectOffscreen: async () => ({ result: { findingCount: 0 }, problems: [] }),
      onScreen: async () => 'visible',
      delay: async () => {},
    });
    try {
      await service.setShownSessions(['s1']);
      const opened = await service.execute({
        action: 'open',
        sessionId: 's1',
        cwd: root,
        input: { targets: ['A.html'], label: 'Upper A' },
      });
      assert.equal(opened.tabs[0].id, 'v1');
      await service.command({ action: 'close', sessionId: 's1', tabId: 'v1' });
      const entryId = service
        .snapshot()
        .find((entry) => entry.sessionId === 's1')
        ?.history?.find((item) => item.label === 'Upper A')?.id;
      assert.ok(entryId);

      await service.setTurnActive('s1', true);
      // Verify-open lowercase a.html creates hidden verify tab v2.
      await service.execute({
        action: 'open',
        sessionId: 's1',
        cwd: root,
        input: { targets: ['a.html'], verify: true },
      });
      assert.equal(service.snapshot().find((entry) => entry.sessionId === 's1')?.tabs.length, 0);

      // Clicking frozen A.html must promote hidden verify tab v2 directly instead of creating v3.
      await service.command({ action: 'history', sessionId: 's1', tabId: '', entry: entryId });
      const snapDuringHold = service.snapshot().find((entry) => entry.sessionId === 's1');
      assert.equal(snapDuringHold?.held, true);
      assert.equal(snapDuringHold?.tabs.length, 1);
      assert.equal(snapDuringHold?.active, 'v2', 'promoted hidden verify tab v2 directly without duplicating as v3');

      await service.setTurnActive('s1', false);
      const snapAfterTurn = service.snapshot().find((entry) => entry.sessionId === 's1');
      assert.equal(snapAfterTurn?.tabs.length, 1);
      assert.equal(snapAfterTurn?.tabs[0]?.id, 'v2');
      assert.equal(snapAfterTurn?.history?.length, 1);
      assert.equal(snapAfterTurn?.history?.[0]?.open, true);
    } finally {
      service.dispose();
    }
  }
  rmSync(root, { recursive: true, force: true });
});

test('frozen closed history row T reopens T instead of selecting agent turn preview B after C recycles key', async (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mixdog-vis-frozen-t-vs-turn-b-')));
  const dirB = join(root, 'dir-b');
  const dirC = join(root, 'dir-c');
  mkdirSync(dirB, { recursive: true });
  mkdirSync(dirC, { recursive: true });
  writeFileSync(join(dirB, 'page.html'), '<h1>B</h1>', 'utf8');
  writeFileSync(join(dirC, 'page.html'), '<h1>C</h1>', 'utf8');
  const linkT = join(root, 'link-t');
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  try {
    symlinkSync(dirC, linkT, linkType);
  } catch {
    rmSync(root, { recursive: true, force: true });
    t.skip('directory symlinks unavailable');
    return;
  }

  let leaseSeq = 0;
  const service = createVisualizeService({
    windowAvailable: () => true,
    browserAvailable: () => false,
    recentShownLimit: 0,
    versions: { directory: join(root, 'versions') },
    preparePane: async (target) => `http://127.0.0.1:4100/lease-${++leaseSeq}/${target.label}`,
    publish: () => {},
    watch: () => () => {},
    annotate: async () => [],
    capture: async () => Buffer.from('PNG'),
    inspectOffscreen: async () => ({ result: { findingCount: 0 }, problems: [] }),
    onScreen: async () => 'visible',
    delay: async () => {},
  });

  try {
    await service.setShownSessions(['s1']);
    const tOpen = await service.execute({
      action: 'open',
      sessionId: 's1',
      cwd: root,
      input: { targets: ['link-t/page.html'], label: 'Symlink T' },
    });
    await service.command({ action: 'close', sessionId: 's1', tabId: tOpen.tabs[0].id });
    const tEntryId = service
      .snapshot()
      .find((entry) => entry.sessionId === 's1')
      ?.history?.find((item) => item.label === 'Symlink T')?.id;
    assert.ok(tEntryId);

    // Start a hold, reopen C directly (recycling key C), let agent open B, retarget T -> B, click frozen T.
    await service.setTurnActive('s1', true);
    await service.command({
      action: 'reopen',
      sessionId: 's1',
      tabId: '',
      targets: ['dir-c/page.html'],
      label: 'File C',
    });
    const bOpen = await service.execute({
      action: 'open',
      sessionId: 's1',
      cwd: root,
      input: { targets: ['dir-b/page.html'], label: 'File B' },
    });
    const bId = bOpen.tabs[0].id;
    unlinkSync(linkT);
    symlinkSync(dirB, linkT, linkType);

    await service.command({ action: 'history', sessionId: 's1', tabId: '', entry: tEntryId });
    const snapDuringHold = service.snapshot().find((entry) => entry.sessionId === 's1');
    assert.equal(snapDuringHold?.held, true);
    assert.notEqual(snapDuringHold?.active, bId, 'does not hijack agent turn tab B');
    const reopenedT = snapDuringHold?.tabs.find((tab) => tab.id === snapDuringHold.active);
    assert.equal(reopenedT?.label, 'Symlink T');
    assert.equal(reopenedT?.turnWork, undefined);
    assert.equal((await service.paneText('s1', reopenedT.id, 0)).text, '<h1>B</h1>');

    await service.setTurnActive('s1', false);
    const snapAfterTurn = service.snapshot().find((entry) => entry.sessionId === 's1');
    assert.equal(snapAfterTurn?.tabs.length, 3, 'C, B, and T are all open after turn ends');
    assert.deepEqual(
      snapAfterTurn?.history?.map((item) => [item.label, item.open]).sort(),
      [
        ['File B', true],
        ['File C', true],
        ['Symlink T', true],
      ],
      'all three distinct visuals survive in history'
    );
  } finally {
    service.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test('exact hidden verify tab T -> B is promoted ahead of stale pre-turn canonical picture B', async (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mixdog-vis-verify-before-preturn-canonical-')));
  const dirB = join(root, 'dir-b');
  mkdirSync(dirB, { recursive: true });
  writeFileSync(join(dirB, 'page.html'), '<h1>B</h1>', 'utf8');
  const linkT = join(root, 'link-t');
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  try {
    symlinkSync(dirB, linkT, linkType);
  } catch {
    rmSync(root, { recursive: true, force: true });
    t.skip('directory symlinks unavailable');
    return;
  }

  let leaseSeq = 0;
  const service = createVisualizeService({
    windowAvailable: () => true,
    browserAvailable: () => false,
    recentShownLimit: 0,
    versions: { directory: join(root, 'versions') },
    preparePane: async (target) => `http://127.0.0.1:4100/lease-${++leaseSeq}/${target.label}`,
    publish: () => {},
    watch: () => () => {},
    annotate: async () => [],
    capture: async () => Buffer.from('PNG'),
    inspectOffscreen: async () => ({ result: { findingCount: 0 }, problems: [] }),
    onScreen: async () => 'visible',
    delay: async () => {},
  });

  try {
    await service.setShownSessions(['s1']);
    const bOpen = await service.execute({
      action: 'open',
      sessionId: 's1',
      cwd: root,
      input: { targets: ['dir-b/page.html'], label: 'File B' },
    });
    const bId = bOpen.tabs[0].id;
    assert.equal(bId, 'v1');

    // Start hold, close B during the turn (leaving v1 as a 'past' pre-turn picture), then verify-open T -> B (v2).
    await service.setTurnActive('s1', true);
    await service.execute({ action: 'close', sessionId: 's1', cwd: root, input: { tab: bId } });
    await service.execute({
      action: 'open',
      sessionId: 's1',
      cwd: root,
      input: { targets: ['link-t/page.html'], verify: true },
    });

    // User reopens T: must promote hidden verify tab v2 instead of selecting stale pre-turn picture v1.
    await service.command({
      action: 'reopen',
      sessionId: 's1',
      tabId: '',
      targets: ['link-t/page.html'],
      label: 'Symlink T',
    });
    const snapDuringHold = service.snapshot().find((entry) => entry.sessionId === 's1');
    assert.equal(snapDuringHold?.held, true);
    assert.equal(snapDuringHold?.active, 'v2', 'promotes exact hidden verify tab v2 instead of selecting stale v1');
    assert.equal(snapDuringHold?.tabs.length, 2);

    // After the turn ends, promoted v2 remains visible (not wiped out by closeVerify).
    await service.setTurnActive('s1', false);
    const snapAfterTurn = service.snapshot().find((entry) => entry.sessionId === 's1');
    assert.deepEqual(
      snapAfterTurn?.tabs.map((tab) => [tab.id, tab.label]),
      [['v2', 'Symlink T']]
    );
    assert.equal(snapAfterTurn?.history?.length, 2);
  } finally {
    service.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test('hydrating a parked held session after symlink retarget updates held metadata so reopening A shows A not B', async (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mixdog-vis-parked-hold-retarget-meta-')));
  const dirA = join(root, 'dir-a');
  const dirB = join(root, 'dir-b');
  mkdirSync(dirA, { recursive: true });
  mkdirSync(dirB, { recursive: true });
  writeFileSync(join(dirA, 'page.html'), '<h1>A</h1>', 'utf8');
  writeFileSync(join(dirB, 'page.html'), '<h1>B</h1>', 'utf8');
  const linkS = join(root, 'link-s');
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  try {
    symlinkSync(dirA, linkS, linkType);
  } catch {
    rmSync(root, { recursive: true, force: true });
    t.skip('directory symlinks unavailable');
    return;
  }

  let leaseSeq = 0;
  const service = createVisualizeService({
    windowAvailable: () => true,
    browserAvailable: () => false,
    recentShownLimit: 0,
    versions: { directory: join(root, 'versions') },
    preparePane: async (target) => `http://127.0.0.1:4100/lease-${++leaseSeq}/${target.label}`,
    publish: () => {},
    watch: () => () => {},
    annotate: async () => [],
    capture: async () => Buffer.from('PNG'),
    inspectOffscreen: async () => ({ result: { findingCount: 0 }, problems: [] }),
    onScreen: async () => 'visible',
    delay: async () => {},
  });

  try {
    await service.setShownSessions(['s1']);
    const sOpen = await service.execute({
      action: 'open',
      sessionId: 's1',
      cwd: root,
      input: { targets: ['link-s/page.html'], label: 'Symlink S' },
    });
    const sId = sOpen.tabs[0].id;
    const frozenSEntryId = service
      .snapshot()
      .find((entry) => entry.sessionId === 's1')
      ?.history?.find((item) => item.label === 'Symlink S')?.id;
    assert.ok(frozenSEntryId);

    // Park S -> A, retarget S -> B while parked, start a hold while parked, then hydrate.
    await service.setShownSessions([]);
    await service.settled();
    unlinkSync(linkS);
    symlinkSync(dirB, linkS, linkType);
    await service.setTurnActive('s1', true);
    await service.setShownSessions(['s1']);
    await service.settled();

    // Agent reopens S during the turn (making held S a 'past' picture displaying B).
    await service.execute({
      action: 'open',
      sessionId: 's1',
      cwd: root,
      input: { targets: ['link-s/page.html'], label: 'Symlink S' },
    });

    // User reopens direct path A: must open A cleanly and render A, never match held S displaying B!
    await service.command({
      action: 'reopen',
      sessionId: 's1',
      tabId: '',
      targets: ['dir-a/page.html'],
      label: 'File A',
    });
    const snapDuringHold = service.snapshot().find((entry) => entry.sessionId === 's1');
    assert.equal(snapDuringHold?.held, true);
    assert.notEqual(snapDuringHold?.active, sId, 'reopening direct path A does not select held S displaying B');
    assert.equal(snapDuringHold?.tabs.length, 2);
    assert.equal((await service.paneText('s1', snapDuringHold.active, 0)).text, '<h1>A</h1>');

    // Clicking the frozen pre-park history entry for S still selects held S without throwing.
    await service.command({ action: 'history', sessionId: 's1', tabId: '', entry: frozenSEntryId });
    assert.equal(service.snapshot().find((entry) => entry.sessionId === 's1')?.active, sId);
  } finally {
    service.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test('editing a file while parked records a new version on hydrate so version 1 stays immutable in normal and compare views', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mixdog-vis-parked-edit-version-')));
  const page = join(root, 'page.html');
  writeFileSync(page, '<h1>Version One</h1>', 'utf8');

  let leaseSeq = 0;
  const service = createVisualizeService({
    windowAvailable: () => true,
    browserAvailable: () => false,
    recentShownLimit: 0,
    versions: { directory: join(root, 'versions') },
    preparePane: async (target) => `http://127.0.0.1:4100/lease-${++leaseSeq}/${target.label}`,
    publish: () => {},
    watch: () => () => {},
    annotate: async () => [],
    capture: async () => Buffer.from('PNG'),
    inspectOffscreen: async () => ({ result: { findingCount: 0 }, problems: [] }),
    onScreen: async () => 'visible',
    delay: async () => {},
  });

  try {
    await service.setShownSessions(['s1']);
    const opened = await service.execute({
      action: 'open',
      sessionId: 's1',
      cwd: root,
      input: { targets: ['page.html'], label: 'Page' },
    });
    const tabId = opened.tabs[0].id;
    assert.equal(service.snapshot().find((entry) => entry.sessionId === 's1')?.tabs[0]?.versions?.length, 1);

    // Park s1 (stopping file watcher), edit page.html on disk, then hydrate s1 again.
    await service.setShownSessions([]);
    await service.settled();
    writeFileSync(page, '<h1>Version Two Edited While Parked</h1>', 'utf8');
    await service.setShownSessions(['s1']);
    await service.settled();

    const hydratedSnap = service.snapshot().find((entry) => entry.sessionId === 's1');
    assert.equal(hydratedSnap?.tabs[0]?.versions?.length, 2, 'hydrate recorded disk edit as version 2');
    assert.equal(hydratedSnap?.history?.[0]?.versions, 2, 'history version count updated on hydrate');
    assert.equal((await service.paneText('s1', tabId, 0)).text, '<h1>Version Two Edited While Parked</h1>');

    // Selecting version 1 (normal view) must display original v1 bytes, NOT the edited live bytes.
    await service.command({ action: 'version', sessionId: 's1', tabId, version: 1, compare: false });
    assert.equal((await service.paneText('s1', tabId, 0)).text, '<h1>Version One</h1>');

    // Selecting version 1 with compare must display v1 alongside the live v2 edit consistently.
    await service.command({ action: 'version', sessionId: 's1', tabId, version: 1, compare: true });
    assert.equal((await service.paneText('s1', tabId, 0)).text, '<h1>Version One</h1>');
    assert.equal((await service.paneText('s1', tabId, 1)).text, '<h1>Version Two Edited While Parked</h1>');

    // Selecting version 2 returns to the edited live bytes.
    await service.command({ action: 'version', sessionId: 's1', tabId, version: 2, compare: false });
    assert.equal((await service.paneText('s1', tabId, 0)).text, '<h1>Version Two Edited While Parked</h1>');
  } finally {
    service.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test('park-store keeps file tracked after transient remove failure so dispose cleans it up once unlocked', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mixdog-vis-park-transient-remove-')));
  const parkDir = join(root, 'parked');
  const store = createVisualizeParkStore(parkDir);
  try {
    await store.save('s1', {
      active: 'v1',
      counter: 1,
      cwd: root,
      history: [],
      tabs: [],
    });
    const [fileName] = readdirSync(parkDir);
    assert.ok(fileName);
    const jsonPath = join(parkDir, fileName);

    // Replace the file with a directory so non-recursive rm(target, { force: true }) fails with EPERM/EISDIR.
    unlinkSync(jsonPath);
    mkdirSync(jsonPath);
    await store.remove('s1');
    assert.equal(existsSync(jsonPath), true, 'simulated transient delete obstacle prevented removal');

    // Release obstacle and restore regular file at the tracked path; dispose() must still retry and remove it.
    rmSync(jsonPath, { recursive: true, force: true });
    writeFileSync(jsonPath, '{"still":"tracked"}', 'utf8');
    assert.equal(existsSync(jsonPath), true);

    store.dispose();
    await store.settled();
    assert.equal(
      existsSync(jsonPath),
      false,
      'dispose retried and removed file after earlier transient remove failure'
    );
  } finally {
    store.dispose();
    await store.settled();
    rmSync(root, { recursive: true, force: true });
  }
});

test('inline-only session parked before version-store init survives first file snapshot in another session', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mixdog-vis-park-sibling-')));
  const versionsDir = join(root, 'versions');
  const page = join(root, 'page.html');
  writeFileSync(page, '<h1>File Session</h1>', 'utf8');
  let leaseSeq = 0;

  const service = createVisualizeService({
    windowAvailable: () => true,
    browserAvailable: () => false,
    recentShownLimit: 0,
    versions: { directory: versionsDir },
    preparePane: async (target) => `http://127.0.0.1:4100/lease-${++leaseSeq}/${target.label}`,
    publish: () => {},
    watch: () => () => {},
    annotate: async () => [],
    capture: async () => Buffer.from('PNG'),
    onScreen: async () => 'visible',
    delay: async () => {},
  });

  try {
    await service.setShownSessions(['s1']);
    const inlineOpened = await service.execute({
      action: 'open',
      sessionId: 's1',
      cwd: root,
      input: {
        content: {
          kind: 'html',
          source: '<h1>Inline Parked Before Versions Init</h1>',
          title: 'Inline',
        },
      },
    });
    const inlineTabId = inlineOpened.tabs[0].id;

    // Park s1 before any file snapshot has run (versionsDir has not been initialized yet).
    await service.setShownSessions([]);
    await service.settled();
    const parkedDir = parkDirectoryFor(versionsDir);
    assert.equal(
      existsSync(parkedDir) && readdirSync(parkedDir).some((name) => name.endsWith('.json')),
      true,
      'parked inline session is stored in sibling park directory'
    );

    // Open a file in s2, triggering versions.ts first-use wipe of versionsDir.
    await service.setShownSessions(['s2']);
    await service.execute({
      action: 'open',
      sessionId: 's2',
      cwd: root,
      input: { targets: ['page.html'], label: 'File' },
    });

    // Hydrate s1: its parked JSON must survive versionsDir initialization intact.
    await service.setShownSessions(['s1']);
    await service.settled();
    const s1Snap = service.snapshot().find((entry) => entry.sessionId === 's1');
    assert.equal(s1Snap?.tabs.length, 1);
    assert.equal(s1Snap?.tabs[0]?.id, inlineTabId);
    assert.equal((await service.paneText('s1', inlineTabId, 0)).text, '<h1>Inline Parked Before Versions Init</h1>');
  } finally {
    service.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test('selected v1 stays pinned and is not evicted when hydration records v21', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mixdog-vis-hydrate-pin-v1-')));
  const versionsDir = join(root, 'versions');
  const page = join(root, 'page.html');
  writeFileSync(page, '<h1>v1</h1>', 'utf8');
  let leaseSeq = 0;

  const service = createVisualizeService({
    windowAvailable: () => true,
    browserAvailable: () => false,
    recentShownLimit: 0,
    versions: { directory: versionsDir, maxVersionsPerTab: 20 },
    preparePane: async (target) => `http://127.0.0.1:4100/lease-${++leaseSeq}/${target.label}`,
    publish: () => {},
    watch: () => () => {},
    annotate: async () => [],
    capture: async () => Buffer.from('PNG'),
    onScreen: async () => 'visible',
    delay: async () => {},
  });

  try {
    await service.setShownSessions(['s1']);
    const opened = await service.execute({
      action: 'open',
      sessionId: 's1',
      cwd: root,
      input: { targets: ['page.html'], label: 'Page' },
    });
    const tabId = opened.tabs[0].id;

    for (let n = 2; n <= 20; n += 1) {
      writeFileSync(page, `<h1>v${n}</h1>`, 'utf8');
      await service.execute({
        action: 'open',
        sessionId: 's1',
        cwd: root,
        input: { targets: ['page.html'], label: 'Page' },
      });
    }
    assert.equal(service.snapshot().find((entry) => entry.sessionId === 's1')?.tabs[0]?.versions?.length, 20);

    await service.command({ action: 'version', sessionId: 's1', tabId, version: 1, compare: false });
    assert.equal((await service.paneText('s1', tabId, 0)).text, '<h1>v1</h1>');

    // Park s1 while v1 is selected, write v21 on disk, then hydrate.
    await service.setShownSessions([]);
    await service.settled();
    writeFileSync(page, '<h1>v21</h1>', 'utf8');
    await service.setShownSessions(['s1']);
    await service.settled();

    const hydratedTab = service.snapshot().find((entry) => entry.sessionId === 's1')?.tabs[0];
    const keptNumbers = (hydratedTab?.versions ?? []).map((version) => version.n);
    assert.equal(keptNumbers.includes(1), true, 'selected v1 was preserved during v21 eviction');
    assert.equal(keptNumbers.includes(21), true, 'v21 was recorded on hydrate');
    assert.equal(keptNumbers.length, 20, 'oldest unpinned version was evicted instead of pinned v1');
    assert.equal(hydratedTab?.version, 1, 'hydrated tab remains on selected v1');
    assert.equal((await service.paneText('s1', tabId, 0)).text, '<h1>v1</h1>');

    await service.command({ action: 'version', sessionId: 's1', tabId, version: null, compare: false });
    assert.equal((await service.paneText('s1', tabId, 0)).text, '<h1>v21</h1>');
  } finally {
    service.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test('retargeted closed symlink during hold does not select stale retained turn preview', async (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mixdog-vis-retarget-turn-preview-')));
  const dirA = join(root, 'dir-a');
  const dirB = join(root, 'dir-b');
  const dirC = join(root, 'dir-c');
  mkdirSync(dirA, { recursive: true });
  mkdirSync(dirB, { recursive: true });
  mkdirSync(dirC, { recursive: true });
  writeFileSync(join(dirA, 'page.html'), '<h1>File A</h1>', 'utf8');
  writeFileSync(join(dirB, 'page.html'), '<h1>File B</h1>', 'utf8');
  writeFileSync(join(dirC, 'page.html'), '<h1>File C</h1>', 'utf8');
  const linkT = join(root, 'link-t');
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  try {
    symlinkSync(dirA, linkT, linkType);
  } catch {
    rmSync(root, { recursive: true, force: true });
    t.skip('directory symlinks unavailable');
    return;
  }

  let leaseSeq = 0;
  const service = createVisualizeService({
    windowAvailable: () => true,
    browserAvailable: () => false,
    preparePane: async (target) => `http://127.0.0.1:4100/lease-${++leaseSeq}/${target.label}`,
    publish: () => {},
    watch: () => () => {},
    annotate: async () => [],
    capture: async () => Buffer.from('PNG'),
    onScreen: async () => 'visible',
    delay: async () => {},
  });

  try {
    await service.setShownSessions(['s1']);
    const openedT = await service.execute({
      action: 'open',
      sessionId: 's1',
      cwd: root,
      input: { targets: ['link-t/page.html'], label: 'Link T' },
    });
    const tPreId = openedT.tabs[0].id;
    await service.command({ action: 'close', sessionId: 's1', tabId: tPreId });
    const frozenHistoryId = service.snapshot().find((entry) => entry.sessionId === 's1')?.history?.[0]?.id;
    assert.ok(frozenHistoryId);

    await service.setTurnActive('s1', true);

    // Retarget T -> B, agent opens T (v2) and C (v3), user views both turn previews, agent closes v2.
    unlinkSync(linkT);
    symlinkSync(dirB, linkT, linkType);
    const turnT = await service.execute({
      action: 'open',
      sessionId: 's1',
      cwd: root,
      input: { targets: ['link-t/page.html'], label: 'Link T Turn B' },
    });
    const turnTId = turnT.tabs[0].id;
    await service.command({
      action: 'reopen',
      sessionId: 's1',
      tabId: turnTId,
      targets: ['link-t/page.html'],
      label: 'Link T Turn B',
    });

    const turnC = await service.execute({
      action: 'open',
      sessionId: 's1',
      cwd: root,
      input: { targets: ['dir-c/page.html'], label: 'Direct C Turn' },
    });
    const turnCId = turnC.tabs[0].id;
    await service.command({
      action: 'reopen',
      sessionId: 's1',
      tabId: turnCId,
      targets: ['dir-c/page.html'],
      label: 'Direct C Turn',
    });
    await service.execute({
      action: 'close',
      sessionId: 's1',
      cwd: root,
      input: { tab: turnTId },
    });

    // Retarget T -> C and click the frozen T history row.
    unlinkSync(linkT);
    symlinkSync(dirC, linkT, linkType);
    await service.command({ action: 'history', sessionId: 's1', tabId: '', entry: frozenHistoryId });

    const snap = service.snapshot().find((entry) => entry.sessionId === 's1');
    assert.ok(snap?.active);
    assert.notEqual(snap.active, turnTId, 'must not select stale retained turn preview of B');
    assert.notEqual(snap.active, turnCId, 'must not hijack unrelated turn preview of C');
    assert.equal((await service.paneText('s1', snap.active, 0)).text, '<h1>File C</h1>');
  } finally {
    service.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test('replacing a parked file with an oversize file keeps v1 selectable instead of conflating too-large with unchanged', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mixdog-vis-park-oversize-')));
  const versionsDir = join(root, 'versions');
  const page = join(root, 'page.html');
  const smallV1 = '<h1>Small V1</h1>';
  const bigLive = `<h1>${'X'.repeat(128)}</h1>`;
  writeFileSync(page, smallV1, 'utf8');
  let leaseSeq = 0;

  const service = createVisualizeService({
    windowAvailable: () => true,
    browserAvailable: () => false,
    recentShownLimit: 0,
    versions: { directory: versionsDir, maxSnapshotBytes: 64 },
    preparePane: async (target) => `http://127.0.0.1:4100/lease-${++leaseSeq}/${target.label}`,
    publish: () => {},
    watch: () => () => {},
    annotate: async () => [],
    capture: async () => Buffer.from('PNG'),
    onScreen: async () => 'visible',
    delay: async () => {},
  });

  try {
    await service.setShownSessions(['s1']);
    const opened = await service.execute({
      action: 'open',
      sessionId: 's1',
      cwd: root,
      input: { targets: ['page.html'], label: 'Page' },
    });
    const tabId = opened.tabs[0].id;
    assert.equal(service.snapshot().find((entry) => entry.sessionId === 's1')?.tabs[0]?.versions?.length, 1);

    await service.setShownSessions([]);
    await service.settled();
    writeFileSync(page, bigLive, 'utf8');
    await service.setShownSessions(['s1']);
    await service.settled();

    assert.equal((await service.paneText('s1', tabId, 0)).text, bigLive);

    // Selecting v1 (normal view) must render original immutable v1 bytes, not the unkept oversize live file.
    await service.command({ action: 'version', sessionId: 's1', tabId, version: 1, compare: false });
    assert.equal((await service.paneText('s1', tabId, 0)).text, smallV1);

    // Compare mode renders original v1 beside the unkept oversize live file.
    await service.command({ action: 'version', sessionId: 's1', tabId, version: 1, compare: true });
    assert.equal((await service.paneText('s1', tabId, 0)).text, smallV1);
    assert.equal((await service.paneText('s1', tabId, 1)).text, bigLive);

    // Selecting null returns to live oversize file.
    await service.command({ action: 'version', sessionId: 's1', tabId, version: null, compare: false });
    assert.equal((await service.paneText('s1', tabId, 0)).text, bigLive);
  } finally {
    service.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test('tab dropped for escaping recorded root during hydration is purged from held state so reopening its target opens live panes', async (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mixdog-vis-hydrate-drop-hold-')));
  const projectDir = join(root, 'project');
  const dirA = join(projectDir, 'dir-a');
  const outsideDir = join(root, 'outside');
  const versionsDir = join(root, 'versions');
  mkdirSync(dirA, { recursive: true });
  mkdirSync(outsideDir, { recursive: true });
  writeFileSync(join(dirA, 'page.html'), '<h1>Inside A</h1>', 'utf8');
  writeFileSync(join(outsideDir, 'page.html'), '<h1>Outside Secret</h1>', 'utf8');
  const linkS = join(projectDir, 'link-s');
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  try {
    symlinkSync(dirA, linkS, linkType);
  } catch {
    rmSync(root, { recursive: true, force: true });
    t.skip('directory symlinks unavailable');
    return;
  }

  let leaseSeq = 0;
  const service = createVisualizeService({
    windowAvailable: () => true,
    browserAvailable: () => false,
    recentShownLimit: 0,
    versions: { directory: versionsDir },
    preparePane: async (target) => `http://127.0.0.1:4100/lease-${++leaseSeq}/${target.label}`,
    publish: () => {},
    watch: () => () => {},
    annotate: async () => [],
    capture: async () => Buffer.from('PNG'),
    onScreen: async () => 'visible',
    delay: async () => {},
  });

  try {
    await service.setShownSessions(['s1']);
    const openedA = await service.execute({
      action: 'open',
      sessionId: 's1',
      cwd: projectDir,
      input: { targets: ['dir-a/page.html'], label: 'File A' },
    });
    await service.command({ action: 'close', sessionId: 's1', tabId: openedA.tabs[0].id });
    const historyAId = service.snapshot().find((entry) => entry.sessionId === 's1')?.history?.[0]?.id;
    assert.ok(historyAId);

    const openedS = await service.execute({
      action: 'open',
      sessionId: 's1',
      cwd: projectDir,
      input: { targets: ['link-s/page.html'], label: 'Link S' },
    });
    const sTabId = openedS.tabs[0].id;

    // Park s1, retarget S outside projectDir, start a hold while parked, then hydrate.
    await service.setShownSessions([]);
    await service.settled();
    unlinkSync(linkS);
    symlinkSync(outsideDir, linkS, linkType);

    await service.setTurnActive('s1', true);
    await service.setShownSessions(['s1']);
    await service.settled();

    const heldSnap = service.snapshot().find((entry) => entry.sessionId === 's1');
    assert.equal(
      heldSnap?.tabs.some((tab) => tab.id === sTabId),
      false,
      'dropped tab S is purged from held state instead of remaining with blank URL'
    );
    assert.equal(heldSnap?.active, null);

    // Reopening A during the hold must open A cleanly with live panes instead of selecting dropped S.
    await service.command({ action: 'history', sessionId: 's1', tabId: '', entry: historyAId });
    const afterReopen = service.snapshot().find((entry) => entry.sessionId === 's1');
    assert.ok(afterReopen?.active);
    assert.notEqual(afterReopen.active, sTabId);
    const activeTab = afterReopen.tabs.find((tab) => tab.id === afterReopen.active);
    assert.ok(activeTab?.panes[0]?.url, 'reopened A has a live pane URL');
    assert.equal((await service.paneText('s1', afterReopen.active, 0)).text, '<h1>Inside A</h1>');
  } finally {
    service.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test('park-store keeps tracked path after failed overwrite save so dispose still removes it once unlocked', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mixdog-vis-park-overwrite-fail-')));
  const parkDir = join(root, 'parked');
  const store = createVisualizeParkStore(parkDir);
  try {
    await store.save('s1', {
      active: 'v1',
      counter: 1,
      cwd: root,
      history: [],
      tabs: [],
    });
    const [fileName] = readdirSync(parkDir);
    assert.ok(fileName);
    const jsonPath = join(parkDir, fileName);

    // Replace with a directory so both remove() and an overwrite save() fail while the path is already tracked.
    unlinkSync(jsonPath);
    mkdirSync(jsonPath);
    await store.remove('s1');
    await assert.rejects(() =>
      store.save('s1', {
        active: 'v1',
        counter: 2,
        cwd: root,
        history: [],
        tabs: [],
      })
    );

    // Restore a regular file at the tracked path and ensure dispose() still deletes it.
    rmSync(jsonPath, { recursive: true, force: true });
    writeFileSync(jsonPath, '{"still":"tracked-after-overwrite-error"}', 'utf8');
    assert.equal(existsSync(jsonPath), true);

    store.dispose();
    await store.settled();
    assert.equal(
      existsSync(jsonPath),
      false,
      'dispose deleted tracked file even after an earlier failed overwrite save'
    );
  } finally {
    store.dispose();
    await store.settled();
    rmSync(root, { recursive: true, force: true });
  }
});

test('cancelled hydration does not drop out-of-root tab versions before commit', async (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mixdog-vis-cancel-hydrate-drop-')));
  const projectDir = join(root, 'project');
  const dirA = join(projectDir, 'dir-a');
  const outsideDir = join(root, 'outside');
  const versionsDir = join(root, 'versions');
  mkdirSync(dirA, { recursive: true });
  mkdirSync(outsideDir, { recursive: true });
  const pageA = join(dirA, 'page.html');
  const page2 = join(projectDir, 'second.html');
  writeFileSync(pageA, '<h1>v1</h1>', 'utf8');
  writeFileSync(join(outsideDir, 'page.html'), '<h1>outside</h1>', 'utf8');
  writeFileSync(page2, '<h1>second</h1>', 'utf8');
  const linkS = join(projectDir, 'link-s');
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  try {
    symlinkSync(dirA, linkS, linkType);
  } catch {
    rmSync(root, { recursive: true, force: true });
    t.skip('directory symlinks unavailable');
    return;
  }

  let leaseSeq = 0;
  let holdSecond = false;
  let secondStarted;
  let releaseSecond;
  const secondEntered = new Promise((resolve) => (secondStarted = resolve));
  const secondGate = new Promise((resolve) => (releaseSecond = resolve));

  const service = createVisualizeService({
    windowAvailable: () => true,
    browserAvailable: () => false,
    recentShownLimit: 0,
    versions: { directory: versionsDir },
    preparePane: async (target) => {
      if (holdSecond && target.target === 'second.html') {
        secondStarted();
        await secondGate;
      }
      return `http://127.0.0.1:4100/lease-${++leaseSeq}/${target.label}`;
    },
    publish: () => {},
    watch: () => () => {},
    annotate: async () => [],
    capture: async () => Buffer.from('PNG'),
    onScreen: async () => 'visible',
    delay: async () => {},
  });

  try {
    await service.setShownSessions(['s1']);
    const tab1 = (
      await service.execute({
        action: 'open',
        sessionId: 's1',
        cwd: projectDir,
        input: { targets: ['link-s/page.html'], label: 'Link S' },
      })
    ).tabs[0].id;
    writeFileSync(pageA, '<h1>v2</h1>', 'utf8');
    await service.execute({
      action: 'open',
      sessionId: 's1',
      cwd: projectDir,
      input: { targets: ['link-s/page.html'], label: 'Link S' },
    });
    await service.command({ action: 'version', sessionId: 's1', tabId: tab1, version: 1, compare: false });
    await service.execute({
      action: 'open',
      sessionId: 's1',
      cwd: projectDir,
      input: { targets: ['second.html'], label: 'Second' },
    });

    // Park s1, point link-s outside root, begin hydration, and cancel while second tab prepares.
    await service.setShownSessions([]);
    await service.settled();
    unlinkSync(linkS);
    symlinkSync(outsideDir, linkS, linkType);

    holdSecond = true;
    const waking = service.setShownSessions(['s1']);
    await secondEntered;
    const hiding = service.setShownSessions([]);
    releaseSecond();
    await Promise.all([waking, hiding]);
    await service.settled();

    // Restore link-s back inside projectDir and wake s1: tab1's [1, 2] history and v1 bytes must survive!
    holdSecond = false;
    unlinkSync(linkS);
    symlinkSync(dirA, linkS, linkType);
    await service.setShownSessions(['s1']);
    await service.settled();

    const snap = service.snapshot().find((entry) => entry.sessionId === 's1');
    const restoredTab1 = snap?.tabs.find((tab) => tab.id === tab1);
    assert.deepEqual(
      restoredTab1?.versions?.map((version) => version.n),
      [1, 2],
      'cancelled hydration preserved tab1 version history'
    );
    assert.equal(restoredTab1?.version, 1);
    assert.equal((await service.paneText('s1', tab1, 0)).text, '<h1>v1</h1>');
  } finally {
    service.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test('reopening an open retargeted symlink during a hold refreshes onto the new target instead of serving stale panes', async (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mixdog-vis-retarget-open-hold-')));
  const dirA = join(root, 'dir-a');
  const dirB = join(root, 'dir-b');
  mkdirSync(dirA, { recursive: true });
  mkdirSync(dirB, { recursive: true });
  writeFileSync(join(dirA, 'page.html'), '<h1>File A</h1>', 'utf8');
  writeFileSync(join(dirB, 'page.html'), '<h1>File B</h1>', 'utf8');
  const linkT = join(root, 'link-t');
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  try {
    symlinkSync(dirA, linkT, linkType);
  } catch {
    rmSync(root, { recursive: true, force: true });
    t.skip('directory symlinks unavailable');
    return;
  }

  let leaseSeq = 0;
  const service = createVisualizeService({
    windowAvailable: () => true,
    browserAvailable: () => false,
    preparePane: async (target) => `http://127.0.0.1:4100/lease-${++leaseSeq}/${target.label}`,
    publish: () => {},
    watch: () => () => {},
    annotate: async () => [],
    capture: async () => Buffer.from('PNG'),
    onScreen: async () => 'visible',
    delay: async () => {},
  });

  try {
    await service.setShownSessions(['s1']);
    await service.setTurnActive('s1', true);

    const opened = await service.execute({
      action: 'open',
      sessionId: 's1',
      cwd: root,
      input: { targets: ['link-t/page.html'], label: 'Link T' },
    });
    const tabId = opened.tabs[0].id;

    // Preview the open turn symlink tab pointing to A.
    await service.command({
      action: 'reopen',
      sessionId: 's1',
      tabId,
      targets: ['link-t/page.html'],
      label: 'Link T',
    });
    assert.equal((await service.paneText('s1', tabId, 0)).text, '<h1>File A</h1>');

    // Retarget link-t -> dir-b WITHOUT closing the tab, then reopen it.
    unlinkSync(linkT);
    symlinkSync(dirB, linkT, linkType);
    await service.command({
      action: 'reopen',
      sessionId: 's1',
      tabId,
      targets: ['link-t/page.html'],
      label: 'Link T',
    });

    const hostTab = service
      .hostSnapshot()
      .find((entry) => entry.sessionId === 's1')
      ?.tabs.find((tab) => tab.id === tabId);
    assert.equal(hostTab?.panes[0]?.path, join(dirB, 'page.html'), 'host pane updated to dir-b/page.html');
    assert.equal((await service.paneText('s1', tabId, 0)).text, '<h1>File B</h1>');
  } finally {
    service.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test('turn-end thumbnail on liveUnkept does not overwrite the newest kept version thumbnail', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mixdog-vis-unkept-thumb-')));
  const versionsDir = join(root, 'versions');
  const page = join(root, 'page.html');
  writeFileSync(page, '<h1>Kept A</h1>', 'utf8');
  let leaseSeq = 0;
  let currentPng = Buffer.from('PNG-KEPT-A');
  const dataUrl = (buf) => `data:image/png;base64,${buf.toString('base64')}`;

  const service = createVisualizeService({
    windowAvailable: () => true,
    browserAvailable: () => false,
    recentShownLimit: 0,
    versions: { directory: versionsDir, maxSnapshotBytes: 64 },
    preparePane: async (target) => `http://127.0.0.1:4100/lease-${++leaseSeq}/${target.label}`,
    publish: () => {},
    watch: () => () => {},
    annotate: async () => [],
    capture: async () => currentPng,
    thumbnailOffscreen: async () => currentPng,
    onScreen: async () => 'visible',
    delay: async () => {},
  });

  try {
    await service.setShownSessions(['s1']);
    await service.setTurnActive('s1', true);
    const opened = await service.execute({
      action: 'open',
      sessionId: 's1',
      cwd: root,
      input: { targets: ['page.html'], label: 'Page' },
    });
    const tabId = opened.tabs[0].id;
    await service.setTurnActive('s1', false);
    await service.settled();

    const thumbV1Before = await service.command({ action: 'thumbnail', sessionId: 's1', tabId, version: 1 });
    assert.equal(thumbV1Before?.thumbnail, dataUrl(Buffer.from('PNG-KEPT-A')));

    // Park, replace with oversized B, hydrate, and let a turn open/end capture B's thumbnail.
    await service.setShownSessions([]);
    await service.settled();
    writeFileSync(page, `<h1>${'B'.repeat(128)}</h1>`, 'utf8');
    await service.setShownSessions(['s1']);
    await service.settled();

    currentPng = Buffer.from('PNG-OVERSIZED-B');
    await service.setTurnActive('s1', true);
    await service.execute({
      action: 'open',
      sessionId: 's1',
      cwd: root,
      input: { targets: ['page.html'], label: 'Page' },
    });
    await service.setTurnActive('s1', false);
    await service.settled();

    const tabView = service.snapshot().find((entry) => entry.sessionId === 's1')?.tabs[0];
    assert.equal(tabView?.liveUnkept, true);
    assert.equal(tabView?.thumbnail, dataUrl(Buffer.from('PNG-OVERSIZED-B')));
    assert.equal(tabView?.thumbnailVersion, 0);

    const thumbV1After = await service.command({ action: 'thumbnail', sessionId: 's1', tabId, version: 1 });
    assert.equal(
      thumbV1After?.thumbnail,
      dataUrl(Buffer.from('PNG-KEPT-A')),
      'kept v1 thumbnail remained PNG-KEPT-A instead of being overwritten by oversized B'
    );
  } finally {
    service.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test('park-store dispose racing with save mkdir or transient EBUSY on post-write rm leaves no orphaned json', async () => {
  const { mkdir: fsMkdir, rm: fsRm, writeFile: fsWriteFile } = await import('node:fs/promises');
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mixdog-vis-park-dispose-race-')));
  const emptySession = { active: null, counter: 1, cwd: root, history: [], tabs: [] };

  // Case A: dispose() fires while save() awaits mkdir -> writeFile must never run.
  const dirA = join(root, 'park-a');
  let writeCalledA = false;
  let mkdirCalls = 0;
  const storeA = createVisualizeParkStore(dirA, {
    mkdir: async (path, options) => {
      mkdirCalls += 1;
      await fsMkdir(path, options);
      if (mkdirCalls === 2) storeA.dispose();
    },
    writeFile: async (path, data, encoding) => {
      writeCalledA = true;
      return fsWriteFile(path, data, encoding);
    },
  });

  // Case B: dispose() fires while save() is inside writeFile, then post-write rm fails once with EBUSY.
  const dirB = join(root, 'park-b');
  let rmFailures = 0;
  const storeB = createVisualizeParkStore(dirB, {
    writeFile: async (path, data, encoding) => {
      storeB.dispose();
      return fsWriteFile(path, data, encoding);
    },
    rm: async (path, options) => {
      if (String(path).endsWith('.json') && rmFailures === 0) {
        rmFailures += 1;
        throw Object.assign(new Error('resource busy'), { code: 'EBUSY' });
      }
      return fsRm(path, options);
    },
  });

  try {
    await storeA.save('s1', emptySession);
    await storeA.settled();
    assert.equal(writeCalledA, false, 'disposed save aborted before writeFile');
    const filesA = existsSync(dirA) ? readdirSync(dirA).filter((name) => name.endsWith('.json')) : [];
    assert.deepEqual(filesA, [], 'no orphaned JSON written after dispose during mkdir');

    await storeB.save('s1', emptySession);
    await storeB.settled();
    assert.equal(rmFailures, 1, 'simulated one transient EBUSY on post-write rm');
    const filesB = existsSync(dirB) ? readdirSync(dirB).filter((name) => name.endsWith('.json')) : [];
    assert.deepEqual(filesB, [], 'dispose cleanup sweep removed orphaned JSON after transient EBUSY');
  } finally {
    storeA.dispose();
    storeB.dispose();
    await Promise.all([storeA.settled(), storeB.settled()]);
    rmSync(root, { recursive: true, force: true });
  }
});

test('replacing an oversized parked file with different oversized content bumps revision and invalidates stale thumbnail', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mixdog-vis-oversize-b-to-c-')));
  const versionsDir = join(root, 'versions');
  const page = join(root, 'page.html');
  writeFileSync(page, '<h1>Small V1</h1>', 'utf8');
  let leaseSeq = 0;
  const pngB = Buffer.from('PNG-OVERSIZED-B');
  const expectedThumbB = `data:image/png;base64,${pngB.toString('base64')}`;

  const service = createVisualizeService({
    windowAvailable: () => true,
    browserAvailable: () => false,
    recentShownLimit: 0,
    versions: { directory: versionsDir, maxSnapshotBytes: 64 },
    preparePane: async (target) => `http://127.0.0.1:4100/lease-${++leaseSeq}/${target.label}`,
    publish: () => {},
    watch: () => () => {},
    annotate: async () => [],
    capture: async () => pngB,
    thumbnailOffscreen: async () => pngB,
    onScreen: async () => 'visible',
    delay: async () => {},
  });

  try {
    await service.setShownSessions(['s1']);
    const opened = await service.execute({
      action: 'open',
      sessionId: 's1',
      cwd: root,
      input: { targets: ['page.html'], label: 'Page' },
    });
    const tabId = opened.tabs[0].id;

    // Park, replace with oversized B, hydrate, and capture B's thumbnail at turn end.
    await service.setShownSessions([]);
    await service.settled();
    writeFileSync(page, `<h1>${'B'.repeat(128)}</h1>`, 'utf8');
    await service.setShownSessions(['s1']);
    await service.settled();
    await service.setTurnActive('s1', true);
    await service.execute({
      action: 'open',
      sessionId: 's1',
      cwd: root,
      input: { targets: ['page.html'], label: 'Page' },
    });
    await service.setTurnActive('s1', false);
    await service.settled();

    const snapB = service.snapshot().find((entry) => entry.sessionId === 's1')?.tabs[0];
    assert.equal(snapB?.liveUnkept, true);
    assert.equal(snapB?.thumbnail, expectedThumbB);
    const revB = snapB?.revision ?? 0;

    // Park again, replace oversized B with different oversized C, then hydrate.
    await service.setShownSessions([]);
    await service.settled();
    const contentC = `<h1>${'C'.repeat(192)}</h1>`;
    writeFileSync(page, contentC, 'utf8');
    await service.setShownSessions(['s1']);
    await service.settled();

    const snapC = service.snapshot().find((entry) => entry.sessionId === 's1')?.tabs[0];
    assert.equal(snapC?.liveUnkept, true);
    assert.ok((snapC?.revision ?? 0) > revB, 'revision bumped when oversized B was replaced by oversized C');
    assert.equal(snapC?.thumbnail, undefined, 'stale thumbnail of B was invalidated on hydrate');
    assert.equal((await service.paneText('s1', tabId, 0)).text, contentC);
  } finally {
    service.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test('snapshot write error on hydrate marks liveUnkept so kept v1 still loads its immutable snapshot', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mixdog-vis-hydrate-enospc-')));
  const versionsDir = join(root, 'versions');
  const page = join(root, 'page.html');
  writeFileSync(page, '<h1>Version One</h1>', 'utf8');
  let leaseSeq = 0;

  const service = createVisualizeService({
    windowAvailable: () => true,
    browserAvailable: () => false,
    recentShownLimit: 0,
    versions: { directory: versionsDir },
    preparePane: async (target) => `http://127.0.0.1:4100/lease-${++leaseSeq}/${target.label}`,
    publish: () => {},
    watch: () => () => {},
    annotate: async () => [],
    capture: async () => Buffer.from('PNG'),
    onScreen: async () => 'visible',
    delay: async () => {},
  });

  try {
    await service.setShownSessions(['s1']);
    const opened = await service.execute({
      action: 'open',
      sessionId: 's1',
      cwd: root,
      input: { targets: ['page.html'], label: 'Page' },
    });
    const tabId = opened.tabs[0].id;

    // Park s1, edit page.html, and place a regular file blocking version 2's directory so versions.record fails.
    await service.setShownSessions([]);
    await service.settled();
    writeFileSync(page, '<h1>Version Two Unkept</h1>', 'utf8');
    const [sessionHash] = readdirSync(versionsDir);
    assert.ok(sessionHash);
    writeFileSync(join(versionsDir, sessionHash, tabId, '2'), 'block-v2-write', 'utf8');

    await service.setShownSessions(['s1']);
    await service.settled();

    const snap = service.snapshot().find((entry) => entry.sessionId === 's1')?.tabs[0];
    assert.equal(snap?.liveUnkept, true, 'failed snapshot marks liveUnkept');
    assert.equal(snap?.versions?.length, 1);
    assert.equal((await service.paneText('s1', tabId, 0)).text, '<h1>Version Two Unkept</h1>');

    // Selecting v1 normally must load immutable v1 bytes (matching Compare), not live v2 bytes.
    await service.command({ action: 'version', sessionId: 's1', tabId, version: 1, compare: false });
    assert.equal((await service.paneText('s1', tabId, 0)).text, '<h1>Version One</h1>');

    await service.command({ action: 'version', sessionId: 's1', tabId, version: 1, compare: true });
    assert.equal((await service.paneText('s1', tabId, 0)).text, '<h1>Version One</h1>');
    assert.equal((await service.paneText('s1', tabId, 1)).text, '<h1>Version Two Unkept</h1>');
  } finally {
    service.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test('waking with kept v1 selected after oversized replacement computes restoreAssets without reading oversized live pane', async () => {
  const fsp = (await import('node:fs/promises')).default;
  const { syncBuiltinESMExports } = await import('node:module');
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mixdog-vis-hydrate-no-oversize-read-')));
  const versionsDir = join(root, 'versions');
  const page = join(root, 'page.html');
  writeFileSync(page, '<h1>V1</h1>', 'utf8');
  let leaseSeq = 0;

  const service = createVisualizeService({
    windowAvailable: () => true,
    browserAvailable: () => false,
    recentShownLimit: 0,
    versions: { directory: versionsDir, maxSnapshotBytes: 64 },
    preparePane: async (target) => `http://127.0.0.1:4100/lease-${++leaseSeq}/${target.label}`,
    publish: () => {},
    watch: () => () => {},
    annotate: async () => [],
    capture: async () => Buffer.from('PNG'),
    onScreen: async () => 'visible',
    delay: async () => {},
  });

  const originalReadFile = fsp.readFile;
  const liveReads = [];
  try {
    await service.setShownSessions(['s1']);
    const opened = await service.execute({
      action: 'open',
      sessionId: 's1',
      cwd: root,
      input: { targets: ['page.html'], label: 'Page' },
    });
    const tabId = opened.tabs[0].id;
    writeFileSync(page, '<h1>V2</h1>', 'utf8');
    await service.execute({
      action: 'open',
      sessionId: 's1',
      cwd: root,
      input: { targets: ['page.html'], label: 'Page' },
    });
    await service.command({ action: 'version', sessionId: 's1', tabId, version: 1, compare: false });

    // Park with v1 selected, replace live page.html with oversized content, then hydrate while spying on readFile.
    await service.setShownSessions([]);
    await service.settled();
    writeFileSync(page, `<h1>${'Z'.repeat(512)}</h1>`, 'utf8');

    fsp.readFile = function wrappedReadFile(path, ...rest) {
      if (String(path) === page) liveReads.push(String(path));
      return originalReadFile.call(this, path, ...rest);
    };
    syncBuiltinESMExports();

    await service.setShownSessions(['s1']);
    await service.settled();

    assert.deepEqual(liveReads, [], 'hydration never reads oversized live pane into memory');
    const snap = service.snapshot().find((entry) => entry.sessionId === 's1')?.tabs[0];
    assert.equal(snap?.version, 1);
    assert.equal(snap?.liveUnkept, true);
    assert.equal(snap?.restoreAssets, undefined);
    assert.equal((await service.paneText('s1', tabId, 0)).text, '<h1>V1</h1>');
  } finally {
    fsp.readFile = originalReadFile;
    syncBuiltinESMExports();
    service.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});
