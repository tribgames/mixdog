import assert from 'node:assert/strict';
import test from 'node:test';
import { adapterWorld } from './phone-adapter-world.mjs';
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

test('the phone sends the owner claim, the release and the heartbeat as flagged resizes, and delivers size-owner events', async () => {
  const { api, frames, setSection, settle } = await adapterWorld();
  assert.equal(api.remoteTermSizeOwner, true, 'the core serves the claim model');
  const resizes = () => frames.filter((f) => f.method === 'terminal/resize').map((f) => f.params);
  const flush = async () => {
    await settle();
    await settle();
  };

  sendSizeOwnerHeartbeat(api, 't', 50, 20);
  sendSizeOwnerRelease(api, 't');
  api.termResize('t', 120, 40);
  await flush();
  // No Node output to record: Node sent the relay call `termResize [id, cols, rows, phoneOwner]` (remote-methods.ts:1163) and the claim, the
  // release and the heartbeat were its 4th argument; these are the core protocol's frames for them (the spec table), which Node never had.
  assert.deepEqual(resizes(), [
    { tabId: 't', cols: 50, rows: 20, claim: true },
    { tabId: 't', cols: 0, rows: 0, claim: true },
    { tabId: 't', cols: 120, rows: 40 },
  ]);

  // Events come from the held terminalTabs section, once the page reads the terminal lane; `own` is per connection (the ensure names it).
  const received = [];
  const unsubscribe = api.subscribeTermSizeOwner((event) => received.push(event));
  const unlane = api.subscribeTermData(() => undefined);
  await api.termEnsure('t', null, null);
  const tab = (sizeOwner) => [{ id: 't', running: true, ...(sizeOwner ? { sizeOwner } : {}) }];
  await setSection('terminalTabs', tab({ cols: 50, rows: 20, owner: 'other' }));
  await setSection('terminalTabs', tab(null));
  await setSection('terminalTabs', tab({ cols: 40, rows: 30, owner: 'me' }));
  // The events Node emitted for these claims are recorded whole (phone-terminal golden.json, trace.claims.sizeOwner, replayed against the real
  // core); this feeds the adapter sections by hand to pin the per-connection own rule, whose input (the held section) Node never had.
  assert.deepEqual(received, [
    { id: 't', cols: 50, rows: 20, own: false },
    { id: 't', cols: 0, rows: 0, own: false },
    { id: 't', cols: 40, rows: 30, own: true },
  ]);
  unsubscribe();
  await setSection('terminalTabs', tab({ cols: 1, rows: 1, owner: 'other' }));
  assert.equal(received.length, 3);
  unlane();
});