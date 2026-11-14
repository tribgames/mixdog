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
