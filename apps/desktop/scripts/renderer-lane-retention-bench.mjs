// Closed, oversized lanes must not keep an initial tiny byte estimate forever.
// node --import tsx scripts/renderer-lane-retention-bench.mjs
import { createSessionLaneStore } from '../src/renderer/session-lane-store.ts';
const store = createSessionLaneStore({
  maxEntries: 64, maxBytes: 64 * 1024,
  decorator: { decorate: (snapshot) => snapshot, clear() {} },
});
for (let index = 0; index < 50; index += 1) {
  const sessionId = `retention-${index}`;
  const close = store.subscribe(sessionId, () => {});
  store.apply({ sessionId, snapshot: { sessionId, items: [] }, frameSource: 'live' });
  store.apply({
    sessionId,
    snapshot: { sessionId, items: [{ id: 1, text: 'x'.repeat(128 * 1024) }] },
    frameSource: 'live',
  });
  close();
}
console.log(JSON.stringify({ closedSessions: 50, ...store.stats() }));
store.clear();
