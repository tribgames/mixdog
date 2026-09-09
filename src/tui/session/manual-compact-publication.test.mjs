import assert from 'node:assert/strict';
import test from 'node:test';
import { createSessionApiA } from './session-api.mjs';
import { createFrameBatchedStorePublisher } from './frame-batched-store.mjs';

for (const outcome of ['success', 'no-change', 'error-result', 'throw']) {
  test(`manual compact publishes its settled state before ${outcome} reaches the caller`, async () => {
    let draft = {
      sessionId: 'compact-publication',
      busy: false,
      commandBusy: false,
      commandStatus: null,
      items: [],
      stats: {},
    };
    let published = draft;
    const listeners = new Set();
    // Hold the display-frame clock. An RPC completion must not depend on
    // another frame or a later user interaction publishing its final state.
    const publisher = createFrameBatchedStorePublisher({
      getState: () => draft,
      publishState: (snapshot) => { published = snapshot; },
      listeners,
      scheduleFrame: () => 1,
      cancelFrame: () => {},
    });
    const set = (patch) => {
      draft = { ...draft, ...patch };
      publisher.emit();
    };
    const result = outcome === 'success'
      ? { changed: true, beforeTokens: 1_000, afterTokens: 100 }
      : outcome === 'no-change'
        ? { changed: false, reason: 'nothing to compact' }
        : { changed: false, error: 'memory unavailable' };
    let resolveCompact;
    let rejectCompact;
    let signalStarted;
    const started = new Promise((resolve) => { signalStarted = resolve; });
    let sequence = 0;
    const api = createSessionApiA({
      runtime: {
        compact: () => {
          signalStarted();
          return new Promise((resolve, reject) => {
            resolveCompact = resolve;
            rejectCompact = reject;
          });
        },
      },
      nextId: () => ++sequence,
      flags: {},
      pending: [],
      listeners,
      getState: () => draft,
      getPublishedState: () => published,
      set,
      flushEmitImmediate: publisher.flushImmediate,
      pushItem: (item) => set({ items: [...draft.items, item] }),
      replaceItems: (items) => items,
      routeState: () => ({}),
      syncContextStats: () => {},
    });
    try {
      const operation = api.compact();
      await started;
      publisher.flush();
      assert.equal(api.getState().commandBusy, true);
      if (outcome === 'throw') {
        const rejected = assert.rejects(operation, /compact rejected/);
        rejectCompact(new Error('compact rejected'));
        await rejected;
      } else {
        resolveCompact(result);
        assert.equal(await operation, result);
      }
      assert.equal(api.getState().commandBusy, false);
      assert.equal(api.getState().commandStatus, null);
      if (outcome !== 'throw') {
        assert.equal(api.getState().items.at(-1).label,
          outcome === 'success' ? 'Compact complete'
            : outcome === 'no-change' ? 'Compact checked' : 'Compact failed');
      }
    } finally {
      publisher.dispose();
    }
  });
}
