// A shown turn review re-reads after an authenticated remote reconnect: the
// relay does not replay review-changed pushes sent while the leg was down.
import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><body></body>');
for (const key of ['window', 'document', 'Event']) {
  Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true, writable: true });
}
dom.window.mixdogDesktop = {};
const { subscribeTurnReviewRereads } = await import('./use-turn-review-reads.ts');
const { installRemoteSync } = await import('./remote-shim-sync.ts');

const setVisibility = (state) => Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });

test('a reconnect re-reads a visible review; a hidden one waits for its visibility event', (t) => {
  let rereads = 0;
  const stop = subscribeTurnReviewRereads(() => (rereads += 1));
  t.after(() => setVisibility('visible'));
  window.dispatchEvent(new Event('mixdog:remote-reconnected'));
  assert.equal(rereads, 1);
  setVisibility('hidden');
  window.dispatchEvent(new Event('mixdog:remote-reconnected'));
  assert.equal(rereads, 1);
  stop();
  setVisibility('visible');
  window.dispatchEvent(new Event('mixdog:remote-reconnected'));
  assert.equal(rereads, 1, 'unsubscribed');
});

test('on a view-synchronizing host the review re-reads once the reconnect sync is ready, not before', async () => {
  let answer;
  const ctx = {
    restoredVisibleSessionIds: [],
    lastVisibleSessionIds: [],
    carriedResumeToken: null,
    viewResumeToken: null,
    deltaEpoch: 0,
    rosterCache: { claim: async () => null },
    viewBaselines: { begin: () => ({ offer: null, finish() {} }) },
    invoke: () => new Promise((resolve) => (answer = resolve)),
    publishLanes() {},
    fire() {},
    retireConnection() {},
  };
  installRemoteSync(ctx);
  let rereads = 0;
  const stop = subscribeTurnReviewRereads(() => (rereads += 1));
  try {
    // The socket path's reconnect on a view-sync peer (remote-shim-socket.ts).
    ctx.pendingReconnectNotification = true;
    ctx.viewSync.open();
    await new Promise((done) => setImmediate(done));
    assert.ok(answer, 'the sync is asked');
    assert.equal(rereads, 0, 'not before the view sync completes');
    answer({});
    await new Promise((done) => setImmediate(done));
    assert.equal(rereads, 1);
  } finally {
    stop();
    ctx.viewSync.close();
  }
});
