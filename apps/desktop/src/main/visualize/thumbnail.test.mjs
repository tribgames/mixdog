import assert from 'node:assert/strict';
import fs, { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import fsp from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { settledBodyImage } from './host.ts';
import { createVisualizeService } from './service.ts';

function workspace() {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-visualize-thumb-'));
  const cwd = join(root, 'project');
  mkdirSync(join(cwd, 'site'), { recursive: true });
  writeFileSync(join(cwd, 'site', 'index.html'), '<h1>hi</h1>');
  writeFileSync(join(cwd, 'chart.png'), 'png');
  writeFileSync(join(cwd, 'paper.pdf'), 'pdf');
  return { root, cwd, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function fakeDeps(overrides = {}) {
  const events = [];
  const hostEvents = [];
  const deps = {
    windowAvailable: () => true,
    browserAvailable: () => true,
    preparePane: async (target) => `fake://${target.kind}/${target.label}`,
    publish: (event) => events.push(event),
    publishHost: (event) => hostEvents.push(event),
    watch: () => () => {},
    annotate: async () => [],
    capture: async () => Buffer.from('PNGDATA'),
    delay: async () => {},
    reloadDebounceMs: 5,
    ...overrides,
  };
  return { deps, events, hostEvents };
}

/** Thumbnail jobs the test resolves by hand. */
function heldThumbnails() {
  const jobs = [];
  return {
    jobs,
    thumbnail(_sessionId, tab, _targets, signal) {
      return new Promise((resolve) => jobs.push({ tab: tab.id, revision: tab.revision, signal, resolve }));
    },
  };
}

async function until(check) {
  const deadline = Date.now() + 3000;
  while (!check() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 2));
  assert.ok(check(), 'condition never held');
}

const dataUrl = (text) => `data:image/png;base64,${Buffer.from(text).toString('base64')}`;

test('a reload aborts the in-flight thumbnail job; its stale picture is never published', async () => {
  const { cwd, cleanup } = workspace();
  const held = heldThumbnails();
  const { deps, events } = fakeDeps({ thumbnail: held.thumbnail });
  const service = createVisualizeService(deps);
  try {
    await service.execute({ sessionId: 's1', cwd, action: 'open', input: { targets: ['site/index.html'] } });
    await until(() => held.jobs.length === 1);
    const [stale] = held.jobs;
    assert.equal(stale.signal.aborted, false);
    // A reload while the first picture is still being taken.
    await service.command({ sessionId: 's1', tabId: 'v1', action: 'network', allow: false });
    await until(() => held.jobs.length === 2);
    assert.equal(stale.signal.aborted, true, 'the old job is told to stop while it runs');
    assert.equal(held.jobs[1].signal.aborted, false);
    assert.ok(held.jobs[1].revision > stale.revision);
    stale.resolve(Buffer.from('PNG-OLD'));
    held.jobs[1].resolve(Buffer.from('PNG-NEW'));
    await service.settled();
    assert.equal(events.at(-1).state.tabs[0].thumbnail, dataUrl('PNG-NEW'));
    assert.equal(
      events.some((event) => event.state?.tabs[0]?.thumbnail === dataUrl('PNG-OLD')),
      false
    );
    // Closing the tab aborts its running job too.
    await service.command({ sessionId: 's1', tabId: 'v1', action: 'network', allow: true });
    await until(() => held.jobs.length === 3);
    await service.command({ sessionId: 's1', tabId: 'v1', action: 'close' });
    assert.equal(held.jobs[2].signal.aborted, true);
    held.jobs[2].resolve(Buffer.from('PNG-LATE'));
    await service.settled();
  } finally {
    service.dispose();
    cleanup();
  }
});

test('repeated activation never starts a second thumbnail job or a no-op publish', async () => {
  const { cwd, cleanup } = workspace();
  const held = heldThumbnails();
  const { deps, events } = fakeDeps({ thumbnail: held.thumbnail });
  const service = createVisualizeService(deps);
  const activate = (tabId) => service.command({ sessionId: 's1', tabId, action: 'activate' });
  try {
    await service.execute({ sessionId: 's1', cwd, action: 'open', input: { targets: ['chart.png'] } });
    await service.execute({ sessionId: 's1', cwd, action: 'open', input: { targets: ['paper.pdf'] } });
    await until(() => held.jobs.length === 2);
    // v1's picture is still being taken: switching to it (again and again)
    // starts nothing new.
    await activate('v1');
    await activate('v2');
    await activate('v1');
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(
      held.jobs.map((job) => job.tab),
      ['v1', 'v2']
    );
    // Activating the tab already shown publishes nothing.
    const published = events.length;
    await activate('v1');
    await activate('v1');
    assert.equal(events.length, published);
    assert.equal(held.jobs.length, 2);

    held.jobs[0].resolve(Buffer.from('PNG-v1'));
    held.jobs[1].resolve(Buffer.from('PNG-v2'));
    await service.settled();
    const tabs = events.at(-1).state.tabs;
    assert.deepEqual(
      tabs.map((tab) => tab.thumbnail),
      [dataUrl('PNG-v1'), dataUrl('PNG-v2')]
    );

    // A new picture identical to the current one is not published again.
    await service.command({ sessionId: 's1', tabId: 'v2', action: 'network', allow: false });
    await until(() => held.jobs.length === 3);
    const afterReload = events.length;
    held.jobs[2].resolve(Buffer.from('PNG-v2'));
    await service.settled();
    assert.equal(events.length, afterReload);
  } finally {
    service.dispose();
    cleanup();
  }
});

test('publishing never resolves paths synchronously; remote targets use the cwd resolved at prepare time', async () => {
  const { root, cwd, cleanup } = workspace();
  // A linked working directory: remote targets are relative to its real path.
  const linked = join(root, 'linked');
  symlinkSync(cwd, linked, 'junction');
  const { deps, hostEvents } = fakeDeps();
  const service = createVisualizeService(deps);
  const original = { sync: fs.realpathSync, native: fs.realpathSync.native };
  let fromService = 0;
  const counted = (impl) =>
    function (...args) {
      if (/visualize[\\/]service\.ts/.test(new Error().stack ?? '')) fromService += 1;
      return impl.apply(this, args);
    };
  fs.realpathSync = counted(original.sync);
  fs.realpathSync.native = counted(original.native);
  syncBuiltinESMExports();
  try {
    await service.execute({ sessionId: 's1', cwd: linked, action: 'open', input: { targets: ['site/index.html'] } });
    await service.execute({
      sessionId: 's1',
      cwd: linked,
      action: 'open',
      input: { content: { kind: 'svg', source: '<svg/>' } },
    });
    await service.command({ sessionId: 's1', tabId: 'v1', action: 'activate' });
    await service.command({ sessionId: 's1', tabId: 'v1', action: 'network', allow: false });
    service.hostSnapshot();
    const hostTab = hostEvents.at(-1).state.tabs.find((tab) => tab.id === 'v1');
    assert.equal(hostTab.panes[0].remoteTarget, 'site/index.html');
    assert.equal(service.snapshot()[0].tabs[0].panes[0].file, 'site/index.html');
    await service.command({ sessionId: 's1', tabId: 'v1', action: 'close' });
    assert.equal(fromService, 0);
  } finally {
    fs.realpathSync = original.sync;
    syncBuiltinESMExports();
    service.dispose();
    cleanup();
  }
});

test('a reload resolved against an older cwd never overwrites the cwd a reopen committed meanwhile', async () => {
  const { root, cwd, cleanup } = workspace();
  const { deps, hostEvents } = fakeDeps();
  const service = createVisualizeService(deps);
  const original = fsp.realpath;
  const held = [];
  let holding = false;
  // Hold the reload's own cwd resolution until the reopen has committed.
  fsp.realpath = function (path, ...rest) {
    if (holding && String(path) === cwd && /realCwdOf/.test(new Error().stack ?? '')) {
      return new Promise((resolve, reject) =>
        held.push(() => original.call(this, path, ...rest).then(resolve, reject))
      );
    }
    return original.call(this, path, ...rest);
  };
  syncBuiltinESMExports();
  try {
    await service.execute({ sessionId: 's1', cwd, action: 'open', input: { targets: ['site/index.html'] } });
    holding = true;
    const reloading = service.command({ sessionId: 's1', tabId: 'v1', action: 'network', allow: false });
    await until(() => held.length === 1);
    holding = false;
    // The same file reopened from the parent folder: same tab, new cwd.
    await service.execute({
      sessionId: 's1',
      cwd: root,
      action: 'open',
      input: { targets: ['project/site/index.html'] },
    });
    held.shift()();
    await reloading;
    await service.settled();
    service.hostSnapshot();
    const hostTab = hostEvents.at(-1).state.tabs.find((tab) => tab.id === 'v1');
    assert.equal(hostTab.panes[0].remoteTarget, 'project/site/index.html');
    assert.equal(service.snapshot()[0].tabs[0].panes[0].file, 'project/site/index.html');
  } finally {
    fsp.realpath = original;
    syncBuiltinESMExports();
    service.dispose();
    cleanup();
  }
});

test('a delayed open never commits over a later reload, and never lets an older reload through after it', async () => {
  const { cwd, cleanup } = workspace();
  const held = [];
  let holding = false;
  let changed = () => {};
  const { deps, events } = fakeDeps({
    reloadDebounceMs: 0,
    watch: (_path, onChange) => {
      changed = onChange;
      return () => {};
    },
    // Each load's pane names the load it came from; held ones wait for release.
    preparePane: (target) =>
      holding
        ? new Promise((resolve) => held.push((name) => resolve(`fake://${name}`)))
        : Promise.resolve('fake://load-1'),
  });
  const service = createVisualizeService(deps);
  const shownUrl = () => events.at(-1).state.tabs.find((tab) => tab.id === 'v1').panes[0].url;
  try {
    await service.execute({ sessionId: 's1', cwd, action: 'open', input: { targets: ['site/index.html'] } });
    holding = true;
    // Started in order: open (2), reload (3), reload (4).
    const opening = service.execute({ sessionId: 's1', cwd, action: 'open', input: { targets: ['site/index.html'] } });
    await until(() => held.length === 1);
    changed();
    await until(() => held.length === 2);
    changed();
    await until(() => held.length === 3);
    held[2]('load-4');
    await until(() => shownUrl() === 'fake://load-4');
    held[0]('open-2');
    await opening;
    assert.equal(shownUrl(), 'fake://load-4', 'the older open is dropped');
    held[1]('reload-3');
    await service.settled();
    assert.equal(shownUrl(), 'fake://load-4', 'the older reload stays dropped after the open');
  } finally {
    service.dispose();
    cleanup();
  }
});

test('a dropped open leaves the session cwd of the newer open, so a closed tab reopens from history', async () => {
  const { root, cwd, cleanup } = workspace();
  const held = [];
  let holding = false;
  const { deps, events } = fakeDeps({
    preparePane: (target) =>
      holding ? new Promise((resolve) => held.push(() => resolve('fake://held'))) : Promise.resolve('fake://pane'),
  });
  const service = createVisualizeService(deps);
  try {
    await service.execute({ sessionId: 's1', cwd, action: 'open', input: { targets: ['site/index.html'] } });
    holding = true;
    // From the parent folder, delayed: it finishes after the child-cwd open below.
    const parentOpen = service.execute({
      sessionId: 's1',
      cwd: root,
      action: 'open',
      input: { targets: ['project/site/index.html'] },
    });
    await until(() => held.length === 1);
    holding = false;
    await service.execute({ sessionId: 's1', cwd, action: 'open', input: { targets: ['site/index.html'] } });
    held[0]();
    await parentOpen;
    const [entry] = events.at(-1).state.history;
    await service.command({ sessionId: 's1', tabId: 'v1', action: 'close' });
    assert.deepEqual(events.at(-1).state.tabs, []);
    await service.command({ sessionId: 's1', action: 'history', entry: entry.id });
    const [tab] = events.at(-1).state.tabs;
    assert.equal(tab.panes[0].file, 'site/index.html');
  } finally {
    service.dispose();
    cleanup();
  }
});

test('a reload stops the old picture when it invalidates the revision, before its snapshot I/O', async () => {
  const { root, cwd, cleanup } = workspace();
  const held = heldThumbnails();
  const { deps, events } = fakeDeps({
    thumbnail: held.thumbnail,
    versions: { directory: join(root, 'app-data', 'versions') },
  });
  const service = createVisualizeService(deps);
  const original = fsp.readFile;
  let armed = false;
  let release = null;
  // Hold the version snapshot's read of the page file.
  fsp.readFile = function (path, ...rest) {
    if (armed && /index\.html$/.test(String(path))) {
      armed = false;
      return new Promise((resolve, reject) => {
        release = () => original.call(this, path, ...rest).then(resolve, reject);
      });
    }
    return original.call(this, path, ...rest);
  };
  syncBuiltinESMExports();
  try {
    await service.execute({ sessionId: 's1', cwd, action: 'open', input: { targets: ['site/index.html'] } });
    await until(() => held.jobs.length === 1);
    const [stale] = held.jobs;
    const published = events.length;
    armed = true;
    const reloading = service.command({ sessionId: 's1', tabId: 'v1', action: 'network', allow: false });
    await until(() => release !== null);
    assert.equal(stale.signal.aborted, true, 'the old capture stops before the snapshot is written');
    assert.equal(events.length, published, 'the reload has not published yet');
    release();
    await reloading;
    stale.resolve(Buffer.from('PNG-OLD'));
    await until(() => held.jobs.length === 2);
    held.jobs[1].resolve(Buffer.from('PNG-NEW'));
    await service.settled();
    assert.equal(events.at(-1).state.tabs[0].thumbnail, dataUrl('PNG-NEW'));
  } finally {
    fsp.readFile = original;
    syncBuiltinESMExports();
    service.dispose();
    cleanup();
  }
});

/** A window whose tab body is on screen; every capture is a fresh frame of
 *  `frames()` (an animation when they all differ). */
function captureWindow(frames, onCapture = () => {}) {
  const log = { captures: 0, fullBitmaps: 0, sampledWidths: [] };
  const window = {
    isDestroyed: () => false,
    webContents: {
      executeJavaScript: async () => ({ x: 0, y: 0, width: 800, height: 600 }),
      getZoomFactor: () => 1,
      mainFrame: { framesInSubtree: [] },
      async capturePage() {
        log.captures += 1;
        const frame = frames(log.captures);
        onCapture(log.captures);
        return {
          frame,
          isEmpty: () => false,
          getSize: () => ({ width: 800, height: 600 }),
          toBitmap: () => {
            log.fullBitmaps += 1;
            return Buffer.alloc(800 * 600 * 4, frame);
          },
          resize: ({ width }) => {
            log.sampledWidths.push(width);
            return { toBitmap: () => Buffer.alloc(width * 4, frame) };
          },
        };
      },
    },
  };
  return { window, log };
}

const imageTab = { id: 'v1', label: 'x', revision: 0, panes: [{ kind: 'image', label: 'x', target: 'x', url: '' }] };
const noWait = async () => {};

test('an animated page costs a few downscaled comparisons and still yields a real capture', async () => {
  const { window, log } = captureWindow((n) => n);
  const image = await settledBodyImage(window, 's1', imageTab, new AbortController().signal, noWait);
  assert.ok(log.captures >= 2 && log.captures <= 4, `captures: ${log.captures}`);
  assert.equal(image.frame, log.captures, 'the last real capture is the picture');
  assert.equal(log.fullBitmaps, 0, 'no full-resolution bitmap is compared');
  assert.ok(log.sampledWidths.every((width) => width < 800));

  // A page that holds still settles on the second capture.
  const still = captureWindow(() => 7);
  const settled = await settledBodyImage(still.window, 's1', imageTab, new AbortController().signal, noWait);
  assert.equal(still.log.captures, 2);
  assert.equal(settled.frame, 7);
});

test('an aborted thumbnail job stops between capture rounds', async () => {
  const controller = new AbortController();
  // The job is superseded while its second capture is taken.
  const { window, log } = captureWindow(
    (n) => n,
    (n) => n === 2 && controller.abort()
  );
  const waits = [];
  const image = await settledBodyImage(window, 's1', imageTab, controller.signal, async (ms, signal) => {
    waits.push(signal.aborted);
  });
  assert.equal(image, null);
  assert.equal(log.captures, 2, 'no capture after the abort');
  assert.deepEqual(waits, [false], 'no further round is waited for');

  // The default wait ends as soon as the job is aborted.
  const slow = new AbortController();
  const started = Date.now();
  const pending = settledBodyImage(captureWindow((n) => n).window, 's1', imageTab, slow.signal);
  await new Promise((resolve) => setTimeout(resolve, 20));
  slow.abort();
  assert.equal(await pending, null);
  assert.ok(Date.now() - started < 300, 'the quiet interval is cut short');
});
