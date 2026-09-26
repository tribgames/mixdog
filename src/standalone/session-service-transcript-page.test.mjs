import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';

import { createSessionService } from './session-service.mjs';
import { applySessionStatePatch, diffSessionState, transcriptItemsDigest } from './session-state-patch.mjs';

const TAIL = { transcriptItemLimit: 32, transcriptByteBudget: 1_000_000 };
const item = (id, text = `row ${id}`) => ({ id, kind: 'assistant', text });
const ids = (items) => items.map((row) => row.id);
const page = (held) => ({ transcriptItemLimit: held + 64, transcriptByteBudget: 1_000_000, transcriptPageBase: held });
const heldOf = (items) => ({ firstId: items[0].id, count: items.length, digest: transcriptItemsDigest(items) });

function coldService(history) {
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
        model: 'm',
        queued: [],
      };
    },
    idleEvictMs: 60_000,
    evictSweepMs: 60_000,
  });
}

test('a prepend-capable stored page read answers with only the rows above the held ones', async () => {
  const history = Array.from({ length: 200 }, (_, index) => item(`c${index}`));
  const service = coldService(history);
  const viewer = { clientToken: 'desktop' };
  const id = 'sess_page_cold';
  try {
    const tail = await service.subscribeSession({ sessionId: id, ...TAIL, transcriptPrepend: true }, viewer);
    const held = tail.full.items;
    const answer = await service.readSession(
      { sessionId: id, ...page(32), transcriptPrepend: true, transcriptHeld: heldOf(held) },
      viewer
    );
    assert.equal(Object.hasOwn(answer, 'full'), false, 'the held rows are not sent again');
    assert.equal(answer.page.firstHeldId, held[0].id);
    assert.equal(answer.page.heldCount, 32);
    assert.deepEqual(ids(answer.page.items), ids(history.slice(-96, -32)));
    assert.equal(answer.page.state.transcriptHasOlder, true);
    assert.equal(answer.page.state.model, 'm');
    assert.equal(Object.hasOwn(answer.page.state, 'items'), false);
    assert.ok(answer.revision > tail.revision);
    assert.equal(typeof answer.projectionStamp, 'string');

    // The held rows differ from the daemon's (content, first row, count):
    // the whole window is answered instead.
    const changed = held.map((row, index) => (index === 31 ? { ...row, text: 'settled differently' } : row));
    for (const transcriptHeld of [
      heldOf(changed),
      { ...heldOf(held), firstId: 'c0' },
      { ...heldOf(held), count: 31 },
    ]) {
      const full = await service.readSession(
        { sessionId: id, ...page(32), transcriptPrepend: true, transcriptHeld },
        viewer
      );
      assert.equal(Object.hasOwn(full, 'page'), false);
      assert.deepEqual(ids(full.full.items), ids(history.slice(-96)));
    }

    // An old client (no flag) reads the full window exactly as before.
    const legacy = await service.readSession({ sessionId: id, ...page(32), transcriptHeld: heldOf(held) }, viewer);
    assert.equal(Object.hasOwn(legacy, 'page'), false);
    assert.deepEqual(ids(legacy.full.items), ids(history.slice(-96)));
  } finally {
    await service.stop('test complete');
  }
});

function liveRuntime(initialItems, sessionId) {
  let state = { sessionId, items: initialItems, queued: [] };
  return {
    isWireSafe: true,
    getState: () => state,
    subscribe: () => () => {},
    dispose: async () => {},
  };
}

test('a live page reaches prepend-capable views as the revealed rows; other views keep the full patch', async () => {
  const id = 'sess_page_live';
  const runtime = liveRuntime(
    Array.from({ length: 200 }, (_, index) => item(`l${index}`)),
    id
  );
  const frames = [];
  const service = createSessionService({
    createSessionRuntime: async () => runtime,
    onFrame: (frame, targets) => frames.push({ frame, targets: [...(targets || [])] }),
    publishIntervalMs: 0,
    idleEvictMs: 60_000,
    evictSweepMs: 60_000,
  });
  const desktop = { clientToken: 'desktop' };
  const terminal = { clientToken: 'terminal' };
  try {
    await service.createSession({ sessionId: id });
    const tail = await service.subscribeSession({ sessionId: id, ...TAIL, transcriptPrepend: true }, desktop);
    await service.subscribeSession({ sessionId: id, ...TAIL }, terminal);
    await delay(5);
    frames.length = 0;
    const answer = await service.readSession(
      { sessionId: id, ...page(32), baseRevision: tail.revision, transcriptPrepend: true },
      desktop
    );
    // The caller's reply: only the 64 revealed rows.
    assert.deepEqual(ids(answer.patch.itemsPrepend.values), ids(runtime.getState().items.slice(-96, -32)));
    assert.equal(answer.patch.itemsAppend, null);
    const grown = applySessionStatePatch(tail.full, answer.patch);
    assert.deepEqual(ids(grown.items), ids(runtime.getState().items.slice(-96)));

    const toDesktop = frames.find(({ targets }) => targets.includes('desktop'));
    const toTerminal = frames.find(({ targets }) => targets.includes('terminal'));
    assert.deepEqual(toDesktop.targets, ['desktop']);
    assert.equal(toDesktop.frame.patch.itemsPrepend.values.length, 64);
    // A view that never announced it receives the ordinary suffix patch.
    assert.deepEqual(toTerminal.targets, ['terminal']);
    assert.equal(Object.hasOwn(toTerminal.frame.patch, 'itemsPrepend'), false);
    assert.equal(toTerminal.frame.patch.itemsAppend.from, 0);
    assert.equal(toTerminal.frame.patch.itemsAppend.values.length, 96);
  } finally {
    await service.stop('test complete');
  }
});

test('prepend deltas round-trip and stay off unless asked for', () => {
  const held = [item('r0'), item('r1'), item('r2')];
  const previous = { sessionId: 's', items: held, model: 'a' };
  const next = { sessionId: 's', items: [item('h0'), item('h1'), held[0], held[1], item('r2b')], model: 'b' };
  const plain = diffSessionState(previous, next);
  assert.equal(Object.hasOwn(plain, 'itemsPrepend'), false);
  assert.equal(plain.itemsAppend.from, 0);
  const prepended = diffSessionState(previous, next, { prepend: true });
  assert.deepEqual(ids(prepended.itemsPrepend.values), ['h0', 'h1']);
  assert.deepEqual(prepended.itemsAppend, { from: 2, values: [next.items[4]] });
  const applied = applySessionStatePatch(previous, prepended);
  assert.deepEqual(applied, next);
  assert.equal(applied.items[2], held[0], 'held rows keep their identity');
});
