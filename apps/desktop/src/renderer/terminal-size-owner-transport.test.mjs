import assert from 'node:assert/strict';
import test from 'node:test';
import { createRemoteApi } from './remote-shim-api.ts';
import { publishedCeilings, withShim } from './remote-shim-test-harness.mjs';
import {
  applyEnsuredSizeOwner,
  applySizeOwner,
  sendSizeOwnerHeartbeat,
  sendSizeOwnerRelease,
} from './terminal-size-owner.ts';

function fakeView(followSize = null) {
  const view = {
    followSize,
    resized: [],
    refits: 0,
    term: { resize: (cols, rows) => view.resized.push([cols, rows]) },
    refit: () => {
      view.refits += 1;
    },
  };
  return view;
}

test('an attach/ensure result without sizeOwner resets a stale follower and refits', () => {
  const stale = fakeView({ cols: 50, rows: 20 });
  applyEnsuredSizeOwner(stale, undefined);
  assert.equal(stale.followSize, null);
  assert.equal(stale.refits, 1);

  const idle = fakeView();
  applyEnsuredSizeOwner(idle, undefined);
  assert.equal(idle.refits, 0, 'a view that was not following has nothing to refit');

  const following = fakeView();
  applyEnsuredSizeOwner(following, { cols: 50, rows: 20, own: false });
  assert.deepEqual(following.followSize, { cols: 50, rows: 20 });
  assert.deepEqual(following.resized, [[50, 20]]);

  const owner = fakeView({ cols: 50, rows: 20 });
  applySizeOwner(owner, { cols: 50, rows: 20, own: true });
  assert.equal(owner.followSize, null);
  assert.equal(owner.refits, 1);
});

test('a phone whose followed phone released while disconnected reclaims its own size on reconnect', () => {
  const sent = [];
  const api = { remoteTermSizeOwner: true, termResize: (...args) => sent.push(args) };
  const view = fakeView({ cols: 50, rows: 20 });
  // Same guard as the pane's emitResize: a followed grid is never sent back.
  const emitResize = (cols, rows) => {
    if (!view.followSize) api.termResize('t', cols, rows, true);
  };
  emitResize(40, 30);
  assert.deepEqual(sent, [], 'a stale follow suppresses the claim');
  applyEnsuredSizeOwner(view, undefined);
  assert.equal(view.followSize, null);
  assert.equal(view.refits, 1);
  emitResize(40, 30);
  assert.deepEqual(sent, [['t', 40, 30, true]], 'the fresh claim goes out');

  const live = fakeView();
  applyEnsuredSizeOwner(live, { cols: 50, rows: 20, own: false });
  assert.deepEqual(live.followSize, { cols: 50, rows: 20 }, 'a live claim by another phone is still followed');
});

test('a host without termSizeOwner never gets the 0x0 release or owner heartbeats', async () => {
  await withShim({}, async ({ ctx, dial }) => {
    const api = createRemoteApi(ctx);
    const legacy = await dial({ ready: publishedCeilings(4096, 4096) });
    const redial = (flags) => {
      ctx.connectionReady = false;
      ctx.socket = null;
      ctx.openPromise = null;
      return dial({ ...flags, ready: publishedCeilings(4096, 4096) });
    };
    assert.equal(api.remoteTermSizeOwner, false);
    sendSizeOwnerHeartbeat(api, 't', 50, 20);
    sendSizeOwnerRelease(api, 't');
    api.termResize('t', 80, 24, false);
    assert.deepEqual((await legacy.nextPayload()).params, ['t', 80, 24, false], 'only the plain fit went out');

    const current = await redial({ termSizeOwner: true });
    assert.equal(api.remoteTermSizeOwner, true);
    sendSizeOwnerHeartbeat(api, 't', 50, 20);
    assert.equal((await current.nextPayload()).method, 'setRemoteLanes', 'the lane re-registration of the new leg');
    assert.deepEqual((await current.nextPayload()).params, ['t', 50, 20, true]);
    sendSizeOwnerRelease(api, 't');
    assert.deepEqual((await current.nextPayload()).params, ['t', 0, 0, true]);
  });
});

test('the remote shim sends the owner flag on resize and delivers size-owner events', async () => {
  await withShim({}, async ({ ctx, dial }) => {
    const api = createRemoteApi(ctx);
    const leg = await dial({ ready: publishedCeilings(4096, 4096) });
    api.termResize('t', 50, 20, true);
    assert.deepEqual((await leg.nextPayload()).params, ['t', 50, 20, true]);
    api.termResize('t', 120, 40);
    assert.deepEqual((await leg.nextPayload()).params, ['t', 120, 40, false]);

    const received = [];
    const unsubscribe = api.subscribeTermSizeOwner((event) => received.push(event));
    await leg.deliver({ event: 'termSizeOwner', payload: { id: 't', cols: 50, rows: 20, own: false } });
    await leg.deliver({ event: 'termSizeOwner', payload: { id: 't', cols: 0, rows: 0, own: false } });
    await leg.deliver({ event: 'termSizeOwner', payload: { id: 't', cols: 40, rows: 30, own: true } });
    assert.deepEqual(received, [
      { id: 't', cols: 50, rows: 20, own: false },
      { id: 't', cols: 0, rows: 0, own: false },
      { id: 't', cols: 40, rows: 30, own: true },
    ]);
    unsubscribe();
    await leg.deliver({ event: 'termSizeOwner', payload: { id: 't', cols: 1, rows: 1, own: false } });
    assert.equal(received.length, 3);
  });
});
