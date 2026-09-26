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

test('the byte budget cuts the tail below its item limit but never below eight items', async () => {
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
    // Nine 100 KB rows fit the 1 MB budget; the tenth would pass it.
    assert.equal(first.full.items.length, 9);
    assert.equal(first.full.transcriptHasOlder, true);
    assert.ok(Buffer.byteLength(JSON.stringify(first.full.items)) <= 1_000_000);

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
    // Ten 200 KB rows exceed the 1 MB budget; the floor keeps eight.
    assert.deepEqual(ids(tail.full.items), Array.from({ length: 8 }, (_, index) => `c${92 + index}`));
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

const PAGE_BYTES = 1_000_000;
const page = (held, extra = {}) => ({
  transcriptItemLimit: held + 64,
  transcriptByteBudget: PAGE_BYTES,
  transcriptPageBase: held,
  ...extra,
});
const bytesOf = (rows) => rows.reduce((sum, row) => sum + Buffer.byteLength(JSON.stringify(row)), 0);

function coldHistoryService(history) {
  return createSessionService({
    createSessionRuntime: async () => {
      throw new Error('cold views never materialize');
    },
    sessionExists: async () => true,
    readStoredSession: async (sessionId, options) => {
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
}

test('a cold older-history page reveals up to 64 rows within its byte budget, keeping every held row', async () => {
  // Oldest 40 rows are 150 KB, the newest 100 are 1 KB.
  const history = Array.from({ length: 140 }, (_, index) => item(`p${index}`, 'z'.repeat(index < 40 ? 150_000 : 1_000)));
  const service = coldHistoryService(history);
  const viewer = { clientToken: 'viewer' };
  try {
    const tail = await service.subscribeSession({ sessionId: 'sess_page_cold', ...TAIL }, viewer);
    assert.deepEqual(ids(tail.full.items), ids(history.slice(-32)));
    // Small rows: the whole 64-item page fits the budget.
    const first = await service.readSession({ sessionId: 'sess_page_cold', ...page(32) }, viewer);
    assert.deepEqual(ids(first.full.items), ids(history.slice(-96)));
    assert.equal(first.full.transcriptHasOlder, true);
    // Four 1 KB rows, then 150 KB rows until the next would pass 1 MB: ten.
    const second = await service.readSession({ sessionId: 'sess_page_cold', ...page(96) }, viewer);
    assert.deepEqual(ids(second.full.items), ids(history.slice(-106)));
    assert.ok(bytesOf(second.full.items.slice(0, 10)) <= PAGE_BYTES);
    assert.equal(second.full.transcriptHasOlder, true);
    // Six 150 KB rows fill the budget, but a page never reveals fewer than eight.
    const third = await service.readSession({ sessionId: 'sess_page_cold', ...page(106) }, viewer);
    assert.deepEqual(ids(third.full.items), ids(history.slice(-114)));
    // The held rows are never budgeted away, however large the window is.
    assert.ok(bytesOf(third.full.items) > PAGE_BYTES);
  } finally {
    await service.stop('test complete');
  }
});

test('pages of huge rows still progress by eight and report the start of history', async () => {
  const huge = 'h'.repeat(1_200_000);
  const history = Array.from({ length: 30 }, (_, index) => item(`g${index}`, huge));
  const service = coldHistoryService(history);
  const viewer = { clientToken: 'viewer' };
  try {
    const tail = await service.subscribeSession({ sessionId: 'sess_page_huge', ...TAIL }, viewer);
    assert.equal(tail.full.items.length, 8);
    let held = 8;
    const counts = [];
    let hasOlder = true;
    while (hasOlder) {
      const next = await service.readSession({ sessionId: 'sess_page_huge', ...page(held) }, viewer);
      held = next.full.items.length;
      hasOlder = next.full.transcriptHasOlder;
      counts.push(held);
    }
    assert.deepEqual(counts, [16, 24, 30]);
    assert.equal(hasOlder, false);
  } finally {
    await service.stop('test complete');
  }
});

test('a live older-history page is byte-budgeted, and so is durable history above a resumed runtime', async () => {
  const id = 'sess_page_live';
  const live = liveRuntime(
    Array.from({ length: 100 }, (_, index) => item(`l${index}`, 'y'.repeat(index < 50 ? 300_000 : 500))),
    id
  );
  const { service } = liveService(live);
  const viewer = { clientToken: 'viewer' };
  try {
    await service.createSession({ sessionId: id });
    const tail = await service.subscribeSession({ sessionId: id, ...TAIL }, viewer);
    assert.equal(tail.full.items.length, 32);
    // 18 small rows, then three 300 KB rows fit; a fourth would pass 1 MB.
    const grown = await service.readSession({ sessionId: id, baseRevision: tail.revision, ...page(32) }, viewer);
    const items = grown.patch ? applySessionStatePatch(tail.full, grown.patch).items : grown.full.items;
    assert.deepEqual(ids(items), Array.from({ length: 53 }, (_, index) => `l${47 + index}`));
  } finally {
    await service.stop('test complete');
  }

  const resumedId = 'sess_page_resumed';
  const restoredId = (index) => `hist_${resumedId}_${index}_1`;
  const resumed = liveRuntime(
    Array.from({ length: 20 }, (_, index) => item(restoredId(80 + index))),
    resumedId
  );
  const { service: resumedService } = liveService(resumed, {
    readStoredSession: async (sessionId, options) => {
      const history = Array.from({ length: 100 }, (_, index) => item(restoredId(index), 'x'.repeat(100_000)));
      const limit = options.transcriptItemLimit;
      return { sessionId, items: history.slice(-limit), transcriptHasOlder: history.length > limit, queued: [] };
    },
  });
  try {
    await resumedService.createSession({ sessionId: resumedId });
    await resumedService.subscribeSession({ sessionId: resumedId, ...TAIL }, viewer);
    const paged = await resumedService.readSession({ sessionId: resumedId, ...page(20) }, viewer);
    // Nine 100 KB durable rows fit the page budget above the 20 restored ones.
    assert.deepEqual(
      ids(paged.full.items),
      Array.from({ length: 29 }, (_, index) => restoredId(71 + index))
    );
    assert.equal(paged.full.transcriptHasOlder, true);
  } finally {
    await resumedService.stop('test complete');
  }
});

// A cold pane's window must survive the session going live. Adopted without
// one, the first frame carried the runtime's whole restored transcript (a
// profiled 9.16 MB frame; 8-20 MB on the largest real sessions).
function adoptionService() {
  const history = Array.from({ length: 300 }, (_, index) => item(`a${index}`, 'w'.repeat(60_000)));
  const frames = [];
  let externalPublish = () => {};
  const runtimes = [];
  const service = createSessionService({
    sessionExists: async () => true,
    readStoredSession: async (sessionId, options) => {
      const limit = options.transcriptItemLimit;
      return { sessionId, projectionStamp: `s${limit}`, items: history.slice(-limit), transcriptHasOlder: true, queued: [] };
    },
    createSessionRuntime: async () => {
      let state = { sessionId: '', items: [], queued: [] };
      let listener = () => {};
      const runtime = {
        isWireSafe: true,
        getState: () => state,
        subscribe(next) {
          listener = next;
          return () => {};
        },
        append(row) {
          state = { ...state, items: [...state.items, row] };
          listener();
        },
        async resume(sessionId, options) {
          state = { sessionId, items: history.slice(-(options?.transcriptItemLimit ?? 512)), queued: [] };
          return true;
        },
        getAutoClear: async () => false,
        dispose: async () => {},
      };
      runtimes.push(runtime);
      return runtime;
    },
    subscribeExternalSessionStates: (publish) => {
      externalPublish = publish;
      return () => {};
    },
    onFrame: (frame, targets) => {
      if (frame.type === 'session-state') frames.push({ frame, targets: [...(targets || [])] });
    },
    publishIntervalMs: 0,
    idleEvictMs: 60_000,
    evictSweepMs: 60_000,
  });
  return { service, frames, history, runtimes, external: (update) => externalPublish(update) };
}
const OPEN = { open: { resumeOptions: { transcriptItemLimit: 512 } } };
const frameBytes = (frame) => Buffer.byteLength(JSON.stringify(frame));

test('a cold tail view keeps its byte-budgeted window when the session is loaded live', async () => {
  const { service, frames, history } = adoptionService();
  const id = 'sess_adopt_load';
  try {
    await service.subscribeSession({ sessionId: id, ...TAIL, ...OPEN }, { clientToken: 'desktop' });
    // A submit/configure on the cold session loads its runtime (512 items).
    await service.readSession({ sessionId: id, action: 'getAutoClear', ...OPEN });
    await delay(5);
    const first = frames.find(({ targets }) => targets.includes('desktop'))?.frame;
    assert.ok(first?.full, 'the adopted view receives a full first frame');
    // 16 rows of ~60 KB fit the 1 MB budget; never the 512-row restore (~31 MB).
    assert.deepEqual(ids(first.full.items), ids(history.slice(-16)));
    assert.equal(first.full.transcriptHasOlder, true);
    assert.ok(frameBytes(first) < 1_100_000, `first frame ${frameBytes(first)} bytes`);
  } finally {
    await service.stop('test complete');
  }
});

test('an old whole-transcript cold view still receives the whole restored transcript when adopted', async () => {
  const { service, frames, runtimes } = adoptionService();
  const id = 'sess_adopt_legacy';
  try {
    await service.subscribeSession({ sessionId: id, ...OPEN }, { clientToken: 'old-phone' });
    await service.readSession({ sessionId: id, action: 'getAutoClear', ...OPEN });
    runtimes.at(-1).append(item('live-row'));
    await delay(5);
    const first = frames.find(({ targets }) => targets.includes('old-phone'))?.frame;
    assert.equal(first.full.items.length, 301, 'the whole resume page, unchanged');
    assert.equal('transcriptHasOlder' in first.full, false);
  } finally {
    await service.stop('test complete');
  }
});

test('an external worker view and the runtime that later owns it serve the cold view its window', async () => {
  const { service, frames, history, external } = adoptionService();
  const id = 'sess_adopt_worker';
  try {
    await service.subscribeSession({ sessionId: id, ...TAIL, ...OPEN }, { clientToken: 'desktop' });
    // The Lead's runtime starts publishing its worker's whole transcript.
    external({ sessionId: id, snapshot: { sessionId: id, items: history, queued: [] } });
    const bound = frames.at(-1).frame;
    assert.deepEqual(ids(bound.full.items), ids(history.slice(-16)));
    assert.ok(frameBytes(bound) < 1_100_000);

    // A daemon runtime then materializes the address and takes over the view.
    frames.length = 0;
    await service.readSession({ sessionId: id, action: 'getAutoClear', ...OPEN });
    await delay(5);
    const owned = frames.find(({ targets }) => targets.includes('desktop'))?.frame;
    assert.ok(owned, 'the owner publishes to the adopted view');
    assert.ok(frameBytes(owned) < 1_100_000, `owner frame ${frameBytes(owned)} bytes`);
  } finally {
    await service.stop('test complete');
  }
});

test('a tail window grown by appends goes out whole only within its byte budget', async () => {
  const id = 'sess_sticky_growth';
  const live = liveRuntime(
    Array.from({ length: 4 }, (_, index) => item(`s${index}`)),
    id
  );
  const frames = [];
  const service = createSessionService({
    createSessionRuntime: async () => live.runtime,
    onFrame: (frame, targets) => frames.push({ frame, targets: [...(targets || [])] }),
    publishIntervalMs: 0,
    idleEvictMs: 60_000,
    evictSweepMs: 60_000,
  });
  try {
    await service.createSession({ sessionId: id });
    // A pane attached while the worker had four rows: its window starts at 0.
    const first = await service.subscribeSession({ sessionId: id, ...TAIL }, { clientToken: 'desktop' });
    assert.equal(first.full.items.length, 4);
    // Thirty 40 KB rows land as small suffix patches (1.2 MB of window).
    for (let index = 0; index < 30; index += 1) {
      live.append(item(`g${index}`, 'g'.repeat(40_000)));
      await delay(1);
    }
    const appended = frames.filter(({ targets }) => targets.includes('desktop'));
    assert.ok(appended.every(({ frame }) => frame.patch?.itemsAppend?.values.length <= 1));
    const revision = appended.at(-1).frame.revision;

    // A second view joins with no baseline: a fresh tail within 1 MB, not
    // the 34 rows the first view accumulated.
    frames.length = 0;
    const joined = await service.subscribeSession({ sessionId: id, ...TAIL }, { clientToken: 'phone' });
    assert.deepEqual(
      ids(joined.full.items),
      Array.from({ length: 24 }, (_, index) => `g${6 + index}`)
    );
    assert.ok(Buffer.byteLength(JSON.stringify(joined.full.items)) <= 1_000_000);
    assert.equal(joined.full.transcriptHasOlder, true);
    // The view already attached follows the cut in one bounded patch.
    const cut = frames.find(({ targets }) => targets.includes('desktop')).frame;
    assert.equal(cut.baseRevision, revision);
    assert.equal(cut.patch.itemsAppend.from, 0);
    assert.deepEqual(ids(cut.patch.itemsAppend.values), ids(joined.full.items));

    // Later rows are ordinary suffix patches again, for both views.
    frames.length = 0;
    live.append(item('after'));
    await delay(5);
    assert.deepEqual(frames.at(-1).frame.patch.itemsAppend, { from: 24, values: [item('after')] });

    // A resync read (stale baseline) is budgeted too.
    const resync = await service.readSession({ sessionId: id, ...TAIL, baseRevision: 1 });
    assert.ok(Buffer.byteLength(JSON.stringify(resync.full.items)) <= 1_000_000);

    // Rows too large for the budget: the cut keeps the eight-row minimum.
    for (let index = 0; index < 12; index += 1) live.append(item(`h${index}`, 'h'.repeat(300_000)));
    await delay(5);
    const huge = await service.subscribeSession({ sessionId: id, ...TAIL }, { clientToken: 'tablet' });
    assert.deepEqual(
      ids(huge.full.items),
      Array.from({ length: 8 }, (_, index) => `h${4 + index}`)
    );
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
