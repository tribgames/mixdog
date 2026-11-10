import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { installTestDom } from './test-support/test-dom.mjs';
import { useStudioMediaJobs } from './studio-media-state.ts';

const job = (index, extra = {}) => ({
  id: `job-${index}`,
  status: 'running',
  kind: 'image',
  lane: 'lane',
  model: 'model',
  progress: 0,
  assetId: null,
  error: null,
  ...extra,
});

/**
 * The core as the window sees it: the keyed `mediaJobs` section the core pushes, one entry per job id (the
 * shape `StatePublisher` publishes it in: `(section, key)` with a revision, removed with `entry: null`).
 */
function mediaCore({ snapshotFails = false, snapshotFailsLate = false, refuse = [], transportFails = [] } = {}) {
  // A snapshot read that is still in flight while the pushes arrive, and fails afterwards.
  let failLate = () => undefined;
  const lateGate = snapshotFailsLate ? new Promise((_, reject) => void (failLate = () => reject(new Error('core unreachable')))) : null;
  const listeners = new Set();
  const held = new Map();
  let revision = 0;
  const push = (changes) => {
    for (const listener of [...listeners]) listener({ kind: 'sections', changes });
  };
  return {
    failSnapshot: () => failLate(),
    sections: {
      core: async () => false,
      snapshot: async () => {
        if (snapshotFails) throw new Error('core unreachable');
        if (lateGate) await lateGate;
        return { status: 'ready', entries: [...held.values()] };
      },
      subscribe: (next) => (listeners.add(next), () => void listeners.delete(next)),
      call: async (method, params) => {
        // Main answers `absent` for a feed the core does not hold and rejects when the request itself failed.
        if (method === 'feed/subscribe' && transportFails.includes(params.feedId)) throw new Error('core unreachable');
        return { absent: method === 'feed/subscribe' && refuse.includes(params.feedId) };
      },
    },
    set: (...jobs) =>
      push(
        jobs.map((value) => {
          const entry = { section: 'mediaJobs', key: value.id, revision: ++revision, value };
          held.set(value.id, entry);
          return { section: 'mediaJobs', key: value.id, entry };
        })
      ),
    remove: (id) => {
      held.delete(id);
      push([{ section: 'mediaJobs', key: id, entry: null }]);
    },
  };
}

async function mountJobs(context, { refreshAssetKind = async () => {}, snapshotFails = false, snapshotFailsLate = false, refuse = [], transportFails = [] } = {}) {
  const { restore } = installTestDom(null, { html: '<!doctype html><main></main>' });
  const core = mediaCore({ snapshotFails, snapshotFailsLate, refuse, transportFails });
  const errors = [];
  const refreshed = [];
  const written = new Map();
  const referenceStore = { read: async (key) => written.get(key), write: async (key, value) => void written.set(key, value) };
  const state = { current: null };
  // The panel hands the hook stable callbacks and a stable `api`/`assets`; a fresh one per render would re-arm it.
  const api = { sections: core.sections };
  const assets = [];
  const stableRefresh = async (kind) => {
    refreshed.push(kind);
    return refreshAssetKind(kind);
  };
  const setError = (error) => errors.push(error);
  function Harness() {
    state.current = useStudioMediaJobs({ active: true, api, assets, referenceStore, refreshAssetKind: stableRefresh, setError });
    return null;
  }
  const root = createRoot(document.querySelector('main'));
  context.after(async () => {
    await act(async () => root.unmount());
    restore();
  });
  await act(async () => root.render(React.createElement(Harness)));
  // The pushes land on the event loop, so a step waits for the macrotask the store's delivery takes.
  const drain = () => act(async () => new Promise((resolve) => setImmediate(resolve)));
  return { core, errors, refreshed, state, drain, written };
}

test('Studio follows every running job from the core push, however many, with no read of its own', async (context) => {
  const { core, state, drain, errors, refreshed } = await mountJobs(context);
  const jobs = Array.from({ length: 35 }, (_, index) => job(index));
  await act(async () => state.current.setJobs(jobs));
  await drain();
  core.set(...jobs.map((entry) => ({ ...entry, progress: 1 })));
  await drain();
  assert.deepEqual(state.current.jobs.map(({ progress }) => progress), jobs.map(() => 1));
  core.set(...jobs.map((entry) => ({ ...entry, progress: 2 })));
  await drain();
  assert.deepEqual(state.current.jobs.map(({ progress }) => progress), jobs.map(() => 2));
  assert.deepEqual(errors, []);
  assert.deepEqual(refreshed, [], 'running jobs refresh no asset list');
});

test('a job the core reports done lands its asset, and a refresh that fails is surfaced with the jobs left as they were', async (context) => {
  let failing = true;
  const { core, state, drain, errors, refreshed } = await mountJobs(context, {
    refreshAssetKind: async () => {
      if (failing) throw new Error('asset list unavailable');
    },
  });
  await act(async () => state.current.setJobs([job(0), job(1)]));
  await drain();
  core.set(job(0, { status: 'done', progress: 100, assetId: 'asset-0' }));
  await drain();
  assert.deepEqual(errors, ['asset list unavailable']);
  assert.deepEqual(refreshed, ['image']);
  assert.deepEqual(state.current.jobs.map(({ status }) => status), ['running', 'running'], 'nothing is applied from a failed read');
  failing = false;
  core.set(job(0, { status: 'done', progress: 100, assetId: 'asset-0' }), job(1, { progress: 40 }));
  await drain();
  assert.deepEqual(state.current.jobs.map(({ status, progress }) => [status, progress]), [['done', 100], ['running', 40]]);
});

// Node read a job every 1.5 s: the first null read keeps it running with its progress, the second marks it lost.
const tick = (ms) => act(async () => void context_timers.tick(ms));
let context_timers;
const withTimers = (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  context_timers = context.mock.timers;
};

test('a job the core does not hold keeps running with its progress through the first null read and is lost on the second, 1.5 s later', async (context) => {
  withTimers(context);
  const { core, state, drain } = await mountJobs(context, { refuse: ['media:job-1'] });
  await act(async () => state.current.setJobs([job(0), job(1, { progress: 7 })]));
  await drain();
  assert.deepEqual(state.current.jobs.map(({ status, progress }) => [status, progress]), [['running', 0], ['running', 7]], 'the first null read');
  await tick(1_499);
  await drain();
  assert.equal(state.current.jobs[1].status, 'running', 'not before the second read');
  await tick(1);
  await drain();
  const [watched, silent] = state.current.jobs;
  assert.equal(watched.status, 'running', 'a job whose entry has not arrived yet is not lost');
  assert.equal(silent.status, 'failed');
  assert.match(silent.error, /Lost track of this run/);
  core.set(job(0, { progress: 10 }));
  await drain();
  assert.equal(state.current.jobs[0].progress, 10);
});

test('a job the core announced and then removed without a result is lost on the second read; an entry in between resets the count', async (context) => {
  withTimers(context);
  const { core, state, drain } = await mountJobs(context);
  await act(async () => state.current.setJobs([job(0)]));
  await drain();
  core.set(job(0, { progress: 10 }));
  await drain();
  core.remove('job-0');
  await drain();
  assert.deepEqual(state.current.jobs.map(({ status, progress }) => [status, progress]), [['running', 10]], 'the first null read');
  core.set(job(0, { progress: 20 }));
  await drain();
  await tick(1_500);
  await drain();
  assert.deepEqual(state.current.jobs.map(({ status, progress }) => [status, progress]), [['running', 20]], 'an entry resets the count');
  core.remove('job-0');
  await drain();
  await tick(1_499);
  await drain();
  assert.equal(state.current.jobs[0].status, 'running');
  await tick(1);
  await drain();
  assert.equal(state.current.jobs[0].status, 'failed', 'the second null read in a row');
});

test('a job removed, restored and removed again is lost 1.5 s after its latest removal, not 1.5 s after the first', async (context) => {
  withTimers(context);
  const { core, state, drain } = await mountJobs(context);
  await act(async () => state.current.setJobs([job(0)]));
  await drain();
  core.set(job(0, { progress: 10 }));
  await drain();
  core.remove('job-0');
  await drain();
  await tick(500);
  core.set(job(0, { progress: 20 }));
  await drain();
  await tick(500);
  core.remove('job-0');
  await drain();
  await tick(500);
  await drain();
  assert.deepEqual(state.current.jobs.map(({ status, progress }) => [status, progress]), [['running', 20]], '1500 ms after the first removal is only 500 ms after the latest');
  await tick(999);
  await drain();
  assert.equal(state.current.jobs[0].status, 'running', 'not before 1.5 s after the latest removal');
  await tick(1);
  await drain();
  assert.equal(state.current.jobs[0].status, 'failed');
});

test('a status read that fails after the updates arrived is surfaced and keeps the progress already received', async (context) => {
  const failed = await mountJobs(context, { snapshotFailsLate: true });
  await act(async () => failed.state.current.setJobs([job(0)]));
  await failed.drain();
  failed.core.set(job(0, { progress: 40 }));
  await failed.drain();
  failed.core.set(job(0, { progress: 55 }));
  await failed.drain();
  assert.deepEqual(failed.errors, []);
  assert.deepEqual(failed.state.current.jobs.map(({ status, progress }) => [status, progress]), [['running', 55]]);
  failed.core.failSnapshot();
  await failed.drain();
  assert.deepEqual(failed.errors, ['core unreachable']);
  assert.deepEqual(failed.state.current.jobs.map(({ status, progress }) => [status, progress]), [['running', 55]]);
});
test('a feed request that fails in transport is a status error and leaves the job running; an absent feed is a lost job', async (context) => {
  withTimers(context);
  const { state, drain, errors } = await mountJobs(context, { transportFails: ['media:job-0'], refuse: ['media:job-1'] });
  await act(async () => state.current.setJobs([job(0), job(1)]));
  await drain();
  await tick(1_500);
  await drain();
  // The lost job changes the running set, so the surviving job's feed is asked for again and fails again.
  assert.ok(errors.length > 0 && errors.every((error) => error === 'core unreachable'));
  assert.deepEqual(state.current.jobs.map(({ status }) => status), ['running', 'failed']);
});
/**
 * The same window, wired as production wires it: a real protocol connection and window IPC in main over a client
 * standing in for the core's socket, and the renderer's `sections` source reading main through that IPC. The client
 * answers `feed/subscribe` as the core does, with the response and then the feed's snapshot; the test pushes the
 * feed's later notifications.
 */
async function throughMain(context, { refuseFeeds = [], failFeeds = [] } = {}) {
  const { createProtocolConnection } = await import('../main/protocol/connection.ts');
  const { registerProtocolWindowIpc } = await import('../main/protocol/window-ipc.ts');
  const { SECTIONS_IPC } = await import('../shared/contract-sections.ts');
  const listeners = new Set();
  const subscribed = [];
  const unsubscribed = [];
  const feeds = new Map();
  const jobs = new Map();
  const stamp = (feedId) => {
    const feed = feeds.get(feedId) ?? { epoch: 'e1', seq: 0 };
    feeds.set(feedId, feed);
    feed.seq += 1;
    return { id: feedId, epoch: feed.epoch, seq: feed.seq };
  };
  let revision = 0;
  const update = (value) => ({ section: 'mediaJobs', key: value.id, revision: ++revision, value });
  const storeListeners = new Set();
  // `appFeed`: the app subscription's stamp, none here (`subscribeApp` attaches nothing).
  const store = {
    section: () => undefined,
    sections: () => [],
    appFeed: () => undefined,
    subscribe: (listener) => (storeListeners.add(listener), () => storeListeners.delete(listener)),
  };
  const client = {
    store,
    status: { state: 'ready' },
    subscribeApp: async () => {},
    notify: () => {},
    respond: () => {},
    close: async () => {},
    on: (listener) => (listeners.add(listener), () => listeners.delete(listener)),
    call: async (method, params) => {
      if (method === 'feed/unsubscribe') {
        unsubscribed.push(params.feedId);
        return {};
      }
      assert.equal(method, 'feed/subscribe');
      subscribed.push(params.feedId);
      // The core refuses a feed it does not hold with `invalidParams` (server.rs, FeedSubscribe).
      if (refuseFeeds.includes(params.feedId)) {
        throw Object.assign(new Error('invalidParams'), { detail: { kind: 'rpc', data: { reason: 'invalidParams', path: 'feedId' } } });
      }
      if (failFeeds.includes(params.feedId)) throw Object.assign(new Error('socket closed'), { detail: { kind: 'connectionLost' } });
      const id = params.feedId.slice('media:'.length);
      // The snapshot follows the response.
      queueMicrotask(() =>
        emit({
          method: 'feed/snapshot',
          feed: stamp(params.feedId),
          params: { feedId: params.feedId, state: { sections: jobs.has(id) ? [update(jobs.get(id))] : [] } },
        })
      );
      return {};
    },
  };
  const emit = (notification) => listeners.forEach((listener) => listener({ type: 'notification', notification }));
  const connection = createProtocolConnection({ open: async () => client, defer: (flush) => flush() });
  await connection.start();
  // A window of the connection: its own IPC handlers and the pushes main sends it.
  const openWindow = () => {
    const handlers = new Map();
    const pushes = new Set();
    const dispose = registerProtocolWindowIpc({
      connection,
      handle: (channel, handler) => handlers.set(channel, handler),
      send: (channel, value) => (channel === SECTIONS_IPC.push && pushes.forEach((listener) => listener(value)), true),
      removeHandler: (channel) => handlers.delete(channel),
    });
    context.after(() => dispose());
    return {
      core: async () => true,
      snapshot: async () => handlers.get(SECTIONS_IPC.snapshot)({}),
      subscribe: (listener) => (pushes.add(listener), () => pushes.delete(listener)),
      call: async (method, params) => handlers.get(SECTIONS_IPC.call)({}, method, params),
    };
  };
  const sections = openWindow();
  return {
    sections,
    openWindow,
    refuseFeeds,
    failFeeds,
    // The link drops and comes back: the core restores the app subscription and its snapshot follows the status.
    reconnect: async ({ beforeAppSnapshot = async () => {} } = {}) => {
      listeners.forEach((listener) => listener({ type: 'status', status: { state: 'reconnecting' } }));
      listeners.forEach((listener) => listener({ type: 'status', status: { state: 'ready' } }));
      await new Promise((resolve) => setImmediate(resolve));
      await beforeAppSnapshot();
      storeListeners.forEach((listener) => listener({ type: 'appSnapshot' }));
    },
    subscribed,
    unsubscribed,
    // What the core already holds for a job when the window subscribes, and a later push on its feed.
    hold: (value) => jobs.set(value.id, value),
    push: (value) => {
      jobs.set(value.id, value);
      emit({ method: 'media/job/updated', feed: stamp(`media:${value.id}`), params: update(value) });
    },
    drop: (id) => emit({ method: 'media/job/updated', feed: stamp(`media:${id}`), params: { section: 'mediaJobs', key: id, revision: ++revision, removed: true } }),
  };
}

/** The studio hook mounted over one window's `sections`. */
let mountedDoms = 0;
let restoreDom = null;
async function mountOver(context, sections, errors = []) {
  // Windows mounted by one test share the one document; the last to unmount restores it.
  if (mountedDoms++ === 0) restoreDom = installTestDom(null, { html: '<!doctype html><main></main>' }).restore;
  const state = { current: null };
  const api = { sections };
  const assets = [];
  const refresh = async () => [];
  const setError = (error) => errors.push(error);
  function Harness() {
    state.current = useStudioMediaJobs({ active: true, api, assets, refreshAssetKind: refresh, setError });
    return null;
  }
  const container = document.createElement('div');
  document.querySelector('main').append(container);
  const root = createRoot(container);
  context.after(async () => {
    await act(async () => root.unmount());
    if (--mountedDoms === 0) restoreDom();
  });
  await act(async () => root.render(React.createElement(Harness)));
  const drain = () => act(async () => new Promise((resolve) => setImmediate(resolve)));
  return { state, drain, errors };
}

test('a second window watching a job the first already holds is given its current state; the job is not announced to it again', async (context) => {
  const main = await throughMain(context);
  main.hold(job(0, { progress: 5 }));
  const first = await mountOver(context, main.sections);
  await act(async () => first.state.current.setJobs([job(0)]));
  await first.drain();
  await first.drain();
  main.push(job(0, { progress: 60 }));
  await first.drain();
  assert.equal(first.state.current.jobs[0].progress, 60);
  const second = await mountOver(context, main.openWindow());
  await act(async () => second.state.current.setJobs([job(0)]));
  await second.drain();
  await second.drain();
  assert.equal(second.state.current.jobs[0].progress, 60, 'the second window sees the value the first one already has');
  assert.deepEqual(main.subscribed, ['media:job-0'], 'the core was asked for the feed once');
});

test('a window that stops watching a job loses its entries from its mirror, and the feed ends when the last window leaves', async (context) => {
  const main = await throughMain(context);
  main.hold(job(0, { progress: 5 }));
  const window = main.openWindow();
  const pushed = [];
  window.subscribe((push) => pushed.push(push));
  await window.call('feed/subscribe', { feedId: 'media:job-0' });
  await new Promise((resolve) => setImmediate(resolve));
  const changes = () => pushed.flatMap((push) => push.changes ?? []);
  assert.deepEqual(changes().map(({ key, entry }) => [key, entry?.value.progress]), [['job-0', 5]]);
  await window.call('feed/unsubscribe', { feedId: 'media:job-0' });
  assert.deepEqual(changes().at(-1), { section: 'mediaJobs', key: 'job-0', entry: null }, 'the entry is removed from the window');
  assert.deepEqual(main.unsubscribed, ['media:job-0']);
});

test('main tells an absent feed from a failed request: the first resolves as absent, the second rejects', async (context) => {
  const main = await throughMain(context, { refuseFeeds: ['media:gone'], failFeeds: ['media:down'] });
  assert.deepEqual(await main.sections.call('feed/subscribe', { feedId: 'media:gone' }), { absent: true });
  await assert.rejects(main.sections.call('feed/subscribe', { feedId: 'media:down' }));
});

test('a media:<jobId> update pushed by the core reaches the studio store through main, and a feed the core refused loses its job', async (context) => {
  withTimers(context);
  const main = await throughMain(context, { refuseFeeds: ['media:job-2'] });
  main.hold(job(0, { progress: 5 }));
  const { state, drain } = await mountOver(context, main.sections, { push: (error) => assert.fail(String(error)) });
  await act(async () => state.current.setJobs([job(0), job(2)]));
  await drain();
  await drain();
  assert.deepEqual([...new Set(main.subscribed)], ['media:job-0', 'media:job-2'], 'the studio watches the feed of every running job');
  assert.equal(state.current.jobs[1].status, 'running', 'a feed the core refused is one null read');
  await tick(1_500);
  await drain();
  const [first, refused] = state.current.jobs;
  assert.equal(first.progress, 5, 'the snapshot of the feed reached the store');
  assert.equal(refused.status, 'failed', 'the second null read');
  main.push(job(0, { status: 'done', progress: 100, assetId: 'asset-0' }));
  await drain();
  assert.deepEqual(state.current.jobs.map(({ status, progress }) => [status, progress]), [['done', 100], ['failed', 0]]);
});
async function mountThroughMain(context, main) {
  const errors = [];
  const mounted = await mountOver(context, main.sections, errors);
  return { ...mounted, errors };
}

test('a feed snapshot delivered before the app replace commits is kept by the replace, and the running job is not lost', async (context) => {
  withTimers(context);
  const main = await throughMain(context);
  main.hold(job(0, { progress: 5 }));
  const { state, drain } = await mountThroughMain(context, main);
  await act(async () => state.current.setJobs([job(0)]));
  await drain();
  await drain();
  assert.equal(state.current.jobs[0].progress, 5);
  main.hold(job(0, { progress: 30 }));
  // The restored feed's snapshot lands first, the replace of the app store after it.
  await main.reconnect();
  await drain();
  await tick(1_500);
  await drain();
  assert.deepEqual(state.current.jobs.map(({ status, progress }) => [status, progress]), [['running', 30]]);
});

test('a feed that cannot be restored after a reconnect for a transport reason keeps its entries and is reported; one the core no longer holds loses them', async (context) => {
  withTimers(context);
  const main = await throughMain(context);
  main.hold(job(0, { progress: 5 }));
  main.hold(job(1, { progress: 6 }));
  const { state, drain, errors } = await mountThroughMain(context, main);
  await act(async () => state.current.setJobs([job(0), job(1)]));
  await drain();
  await drain();
  main.failFeeds.push('media:job-0');
  main.refuseFeeds.push('media:job-1');
  await main.reconnect();
  await drain();
  await drain();
  assert.deepEqual(state.current.jobs.map(({ status, progress }) => [status, progress]), [['running', 5], ['running', 6]], 'the first null read keeps the progress');
  assert.deepEqual(errors, ['socket closed']);
  await tick(1_500);
  await drain();
  assert.deepEqual(state.current.jobs.map(({ status }) => status), ['running', 'failed']);
});