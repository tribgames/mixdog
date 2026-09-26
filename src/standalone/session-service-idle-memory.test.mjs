import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';

import { createSessionService } from './session-service.mjs';

const TAIL = { transcriptItemLimit: 32, transcriptByteBudget: 1_000_000 };
const item = (id) => ({ id, kind: 'assistant', text: `row ${id} `.repeat(20) });

test('a vanished viewing client releases the wire projection; the runtime stays and the next view is identical', async () => {
  const id = 'sess_idle_memory';
  let state = { sessionId: id, items: Array.from({ length: 60 }, (_, index) => item(`i${index}`)), queued: [] };
  let listener = () => {};
  const runtime = {
    getState: () => state,
    subscribe(next) {
      listener = next;
      return () => {};
    },
    dispose: async () => {},
  };
  const service = createSessionService({
    createSessionRuntime: async () => runtime,
    publishIntervalMs: 0,
    idleEvictMs: 600_000,
    evictSweepMs: 600_000,
  });
  try {
    await service.createSession({ sessionId: id });
    const first = await service.subscribeSession({ sessionId: id, ...TAIL }, { clientToken: 'desktop' });
    assert.equal(service.status.projected, 1);

    // The desktop's transport dies: no unsubscribe arrives.
    service.releaseClient('desktop');
    assert.equal(service.status.projected, 0, 'nobody reads the projection of an unwatched session');
    assert.equal(service.status.live, 1, 'the runtime itself is kept for the next turn');
    assert.equal(service.status.retained, 1);

    // It comes back: the same window, rebuilt on demand.
    const again = await service.subscribeSession({ sessionId: id, ...TAIL }, { clientToken: 'desktop' });
    assert.deepEqual(again.full.items, first.full.items);
    assert.equal(again.full.transcriptHasOlder, first.full.transcriptHasOlder);

    // And the next turn's rows keep flowing as patches.
    state = { ...state, items: [...state.items, item('next')] };
    listener();
    await delay(5);
    assert.equal(service.status.projected, 1);
  } finally {
    await service.stop('test complete');
  }
});
