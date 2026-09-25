import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';

import { createSessionService } from './session-service.mjs';
import { applySessionStatePatch } from './session-state-patch.mjs';

const TAIL = { transcriptItemLimit: 32, transcriptByteBudget: 1_000_000 };
const item = (id, text = `row ${id}`) => ({ id, kind: 'assistant', text });
const ids = (items) => items.map((row) => row.id);

function liveRuntime(initialItems, sessionId) {
  let state = { sessionId, items: initialItems, queued: [] };
  let listener = () => {};
  return {
    runtime: {
      isWireSafe: true,
      getState: () => state,
      subscribe(next) {
        listener = next;
        return () => {};
      },
      dispose: async () => {},
    },
    append(...rows) {
      state = { ...state, items: [...state.items, ...rows] };
      listener();
    },
  };
}

function liveService(live, overrides = {}) {
  const frames = [];
  const service = createSessionService({
    createSessionRuntime: async () => live.runtime,
    onFrame: (frame) => frames.push(frame),
    publishIntervalMs: 0,
    idleEvictMs: 60_000,
    evictSweepMs: 60_000,
    ...overrides,
  });
  return { service, frames };
}

test('a paging view receives a bounded tail, live patches against it, and older items on demand', async () => {
  const id = 'sess_tail_live';
  const live = liveRuntime(
    Array.from({ length: 100 }, (_, index) => item(`i${index}`)),
    id
  );
  const { service, frames } = liveService(live);
  const viewer = { clientToken: 'viewer' };
  try {
    await service.createSession({ sessionId: id });
    const first = await service.subscribeSession({ sessionId: id, ...TAIL }, viewer);
    assert.deepEqual(ids(first.full.items), Array.from({ length: 32 }, (_, index) => `i${68 + index}`));
    assert.equal(first.full.transcriptHasOlder, true);
    let baseline = first.full;
    let revision = first.revision;

    // A live append travels as a suffix patch against the tail-only baseline.
    frames.length = 0;
    live.append(item('i100'));
    await delay(10);
    const appended = frames.at(-1);
    assert.equal(appended.baseRevision, revision);
    assert.deepEqual(appended.patch.itemsAppend, { from: 32, values: [item('i100')] });
    baseline = applySessionStatePatch(baseline, appended.patch);
    revision = appended.revision;
    assert.equal(baseline.items.length, 33);

    // Scrolling up grows the window through the daemon; order and ids hold.
    const older = await service.readSession({ sessionId: id, baseRevision: revision, transcriptItemLimit: 64 });
    baseline = older.patch ? applySessionStatePatch(baseline, older.patch) : older.full;
    revision = older.revision;
    assert.deepEqual(ids(baseline.items), Array.from({ length: 64 }, (_, index) => `i${37 + index}`));
    assert.equal(baseline.transcriptHasOlder, true);

    // Live work arriving after the page still patches the grown baseline.
    frames.length = 0;
    live.append(item('i101'));
    await delay(10);
    const afterPage = frames.at(-1);
    assert.equal(afterPage.baseRevision, revision);
    assert.deepEqual(afterPage.patch.itemsAppend, { from: 64, values: [item('i101')] });
    baseline = applySessionStatePatch(baseline, afterPage.patch);
    assert.deepEqual(ids(baseline.items), Array.from({ length: 65 }, (_, index) => `i${37 + index}`));
    assert.equal(new Set(ids(baseline.items)).size, baseline.items.length, 'no duplicates');

    // Paging to the start reports that nothing older exists.
    const all = await service.readSession({ sessionId: id, transcriptItemLimit: 512 });
    assert.equal(all.full.items.length, 102);
    assert.equal(all.full.transcriptHasOlder, false);
  } finally {
    await service.stop('test complete');
  }
});

test('the byte budget cuts the tail below its item limit but never below sixteen items', async () => {
  const id = 'sess_tail_budget';
  const heavy = 'x'.repeat(100_000);
  const live = liveRuntime(
    Array.from({ length: 40 }, (_, index) => item(`h${index}`, heavy)),
    id
  );
  const { service } = liveService(live);
  try {
    await service.createSession({ sessionId: id });
    const first = await service.subscribeSession({ sessionId: id, ...TAIL }, { clientToken: 'viewer' });
    assert.equal(first.full.items.length, 16);
    assert.equal(first.full.transcriptHasOlder, true);
    assert.ok(Buffer.byteLength(JSON.stringify(first.full)) < 2_000_000);

    const light = liveRuntime(
      Array.from({ length: 40 }, (_, index) => item(`l${index}`, 'y'.repeat(20_000))),
      'sess_tail_light'
    );
    const { service: lightService } = liveService(light);
    try {
      await lightService.createSession({ sessionId: 'sess_tail_light' });
      const tail = await lightService.subscribeSession(
        { sessionId: 'sess_tail_light', ...TAIL },
        { clientToken: 'viewer' }
      );
      // 20 KB rows: the budget admits all 32 the limit allows.
      assert.equal(tail.full.items.length, 32);
      assert.ok(Buffer.byteLength(JSON.stringify(tail.full.items)) <= 1_000_000);
    } finally {
      await lightService.stop('test complete');
    }
  } finally {
    await service.stop('test complete');
  }
});

test('a view that requests no window keeps the whole transcript (old clients)', async () => {
  const id = 'sess_tail_legacy';
  const live = liveRuntime(
    Array.from({ length: 100 }, (_, index) => item(`i${index}`)),
    id
  );
  const { service, frames } = liveService(live);
  try {
    await service.createSession({ sessionId: id });
    const legacy = await service.subscribeSession({ sessionId: id }, { clientToken: 'old-client' });
    assert.equal(legacy.full.items.length, 100);
    assert.equal('transcriptHasOlder' in legacy.full, false);
    // A paging view joining later cannot shrink what the old client holds.
    const paging = await service.subscribeSession({ sessionId: id, ...TAIL }, { clientToken: 'new-client' });
    assert.equal(paging.full.items.length, 100);
    frames.length = 0;
    live.append(item('i100'));
    await delay(10);
    assert.deepEqual(frames.at(-1).patch.itemsAppend, { from: 100, values: [item('i100')] });
  } finally {
    await service.stop('test complete');
  }
});

test('a resumed runtime pages older durable history in front of its restored items', async () => {
  const id = 'sess_tail_resumed';
  const restoredId = (index) => `hist_${id}_${index}_1`;
  // The runtime restored messages 80..99; the store holds 0..99.
  const live = liveRuntime(
    Array.from({ length: 20 }, (_, index) => item(restoredId(80 + index))),
    id
  );
  const storedReads = [];
  const forgotten = [];
  const { service } = liveService(live, {
    readStoredSession: async (sessionId, options) => {
      storedReads.push(options.transcriptItemLimit);
      const history = Array.from({ length: 100 }, (_, index) => item(restoredId(index)));
      const limit = options.transcriptItemLimit;
      return { sessionId, items: history.slice(-limit), transcriptHasOlder: history.length > limit, queued: [] };
    },
    forgetStoredSession: (sessionId) => forgotten.push(sessionId),
  });
  try {
    await service.createSession({ sessionId: id });
    const first = await service.subscribeSession({ sessionId: id, ...TAIL }, { clientToken: 'viewer' });
    assert.equal(first.full.items.length, 20);
    assert.equal(first.full.transcriptHasOlder, true, 'restored from message 80: older history exists');
    const releasedBefore = forgotten.length;
    const page = await service.readSession({ sessionId: id, transcriptItemLimit: 52 });
    await delay(0);
    assert.deepEqual(
      ids(page.full.items),
      Array.from({ length: 52 }, (_, index) => restoredId(48 + index))
    );
    assert.equal(page.full.transcriptHasOlder, true);
    assert.deepEqual(storedReads, [72]);
    assert.deepEqual(
      forgotten.slice(releasedBefore),
      [id],
      'the live session keeps no cold projection from its history read'
    );
    const rest = await service.readSession({ sessionId: id, transcriptItemLimit: 500 });
    assert.equal(rest.full.items.length, 100);
    assert.equal(rest.full.transcriptHasOlder, false);
  } finally {
    await service.stop('test complete');
  }
});

test('a cold paging view reads a bounded stored tail and grows it on demand', async () => {
  const id = 'sess_tail_cold';
  const history = Array.from({ length: 100 }, (_, index) => item(`c${index}`, 'z'.repeat(index >= 90 ? 200_000 : 10)));
  const reads = [];
  const service = createSessionService({
    createSessionRuntime: async () => {
      throw new Error('cold views never materialize');
    },
    sessionExists: async () => true,
    readStoredSession: async (sessionId, options) => {
      reads.push(options.transcriptItemLimit);
      const limit = options.transcriptItemLimit;
      return {
        sessionId,
        projectionStamp: `stamp:${limit}`,
        items: history.slice(-limit),
        transcriptHasOlder: history.length > limit,
        queued: [],
      };
    },
    idleEvictMs: 60_000,
    evictSweepMs: 60_000,
  });
  try {
    const tail = await service.subscribeSession({ sessionId: id, ...TAIL }, { clientToken: 'viewer' });
    // Ten 200 KB rows exceed the 1 MB budget; the floor keeps sixteen.
    assert.deepEqual(ids(tail.full.items), Array.from({ length: 16 }, (_, index) => `c${84 + index}`));
    assert.equal(tail.full.transcriptHasOlder, true);
    const page = await service.readSession({ sessionId: id, transcriptItemLimit: 80 });
    assert.deepEqual(ids(page.full.items), Array.from({ length: 80 }, (_, index) => `c${20 + index}`));
    assert.equal(page.full.transcriptHasOlder, true);
    // An old client names no window and keeps the 512-item resume page.
    const legacy = await service.readSession({ sessionId: id, open: {} });
    assert.equal(legacy.full.items.length, 100);
    assert.deepEqual(reads, [32, 80, 512]);
  } finally {
    await service.stop('test complete');
  }
});

test('cold projections are released when the session goes live or its last view leaves', async () => {
  const forgotten = [];
  const coldId = 'sess_cold_release';
  const liveId = 'sess_live_release';
  const live = liveRuntime([item('only')], liveId);
  const service = createSessionService({
    createSessionRuntime: async () => live.runtime,
    sessionExists: async () => true,
    readStoredSession: async (sessionId) => ({ sessionId, items: [item('stored')], queued: [] }),
    forgetStoredSession: (sessionId) => forgotten.push(sessionId),
    idleEvictMs: 60_000,
    evictSweepMs: 60_000,
  });
  try {
    const first = { clientToken: 'first' };
    const second = { clientToken: 'second' };
    await service.subscribeSession({ sessionId: coldId, ...TAIL }, first);
    await service.subscribeSession({ sessionId: coldId, ...TAIL }, second);
    await service.unsubscribeSession({ sessionId: coldId }, first);
    await delay(0);
    assert.deepEqual(forgotten, [], 'another cold view still reads it');
    await service.unsubscribeSession({ sessionId: coldId }, second);
    await delay(0);
    assert.deepEqual(forgotten, [coldId]);

    await service.createSession({ sessionId: liveId });
    await delay(0);
    assert.deepEqual(forgotten, [coldId, liveId]);
  } finally {
    await service.stop('test complete');
  }
});

test('a watched session that publishes after the sweep stopped is released after the retention delay', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 1_000 });
  const id = 'sess_sweep_restart';
  const live = liveRuntime([item('a')], id);
  const { service } = liveService(live, { evictSweepMs: 1_000 });
  try {
    await service.createSession({ sessionId: id }, { clientToken: 'viewer' });
    assert.equal(service.status.projected, 1);
    // Idle past the projection budget: released, then the sweep stops.
    t.mock.timers.tick(92_000);
    assert.equal(service.status.projected, 0);
    t.mock.timers.tick(1_000);
    assert.equal(service.status.evictionSweepActive, false);

    live.append(item('b'));
    t.mock.timers.tick(1);
    assert.equal(service.status.projected, 1, 'the publish rebuilt the projection');
    assert.equal(service.status.evictionSweepActive, true, 'and restarted the sweep');
    t.mock.timers.tick(92_000);
    assert.equal(service.status.projected, 0, 'the rebuilt projection is reclaimed');
  } finally {
    t.mock.timers.reset();
    await service.stop('test complete');
  }
});
