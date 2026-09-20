import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLiveShare, forwardViewerSubmit, liveSharePipePath } from './live-share.mjs';

const SESSION_ID = `lstest-${process.pid}-${Date.now()}`;

function socketPathFor(id) {
  return liveSharePipePath(id, join(tmpdir(), `mixdog-live-share-test-${id}`));
}

async function until(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return predicate();
}

function fakeViewerStore() {
  const state = { items: [], streamingTail: null, spinner: null, stats: { costUsd: 1, localOnly: 7 } };
  return {
    state,
    getState: () => state,
    set: (patch) => Object.assign(state, patch),
    replaceItems: (items) => {
      state.items = items.slice();
    },
    appendItems: (items) => {
      state.items = [...state.items, ...items];
    },
    patchItem: (id, item) => {
      state.items = state.items.map((it) => (it.id === id ? { ...it, ...item } : it));
    },
    updateStreamingTail: (id, tail, _extra, opts) => {
      state.streamingTail = opts?.resetText ? { ...tail } : { ...(state.streamingTail || {}), ...tail, id };
    },
    clearStreamingTail: () => {
      state.streamingTail = null;
    },
  };
}

function createPair() {
  const ownerState = {
    items: [{ id: 'a', text: 'hello' }],
    streamingTail: null,
    spinner: null,
    busy: false,
    queued: [],
    stats: { costUsd: 2, turns: 1 },
  };
  const listeners = new Set();
  const received = { submits: [], aborts: 0, ownerClosed: [] };
  let refuseNext = false;
  const owner = createLiveShare({
    ownerSessionId: () => SESSION_ID,
    viewerSessionId: () => '',
    socketPathFor,
    getPublishedState: () => ownerState,
    listeners,
    onRemoteSubmit: (prompt, options) => {
      received.submits.push({ prompt, options });
      if (refuseNext) {
        refuseNext = false;
        return false;
      }
      return true;
    },
    onRemoteAbort: () => {
      received.aborts += 1;
    },
  });
  const store = fakeViewerStore();
  const viewer = createLiveShare({
    ownerSessionId: () => '',
    viewerSessionId: () => SESSION_ID,
    socketPathFor,
    getPublishedState: () => ({}),
    listeners: new Set(),
    onRemoteSubmit: () => false,
    onOwnerClosed: (id, clean) => received.ownerClosed.push({ id, clean }),
    viewerApply: store,
  });
  const publish = () => {
    for (const listener of listeners) listener();
  };
  return {
    owner,
    viewer,
    ownerState,
    store,
    received,
    publish,
    refuseNextSubmit: () => {
      refuseNext = true;
    },
  };
}

test('live share mirrors owner items, tail suffixes, live state and relays viewer submit/abort', async () => {
  const pair = createPair();
  const { owner, viewer, ownerState, store, received, publish } = pair;
  try {
    owner.ensure();
    viewer.ensure();
    assert.equal(await viewer.waitForViewerSync(SESSION_ID, 3000), true);
    assert.equal(viewer.viewerConnected(), true);
    assert.deepEqual(store.state.items, [{ id: 'a', text: 'hello' }]);
    assert.equal(store.state.busy, false);
    assert.equal(store.state.stats.costUsd, 2);
    assert.equal(store.state.stats.localOnly, 7, 'unmirrored stats keep local values');

    ownerState.items = [...ownerState.items, { id: 'b', text: 'world' }];
    ownerState.streamingTail = { id: 't1', text: 'Hel' };
    ownerState.busy = true;
    ownerState.queued = [{ id: 'q1', displayText: 'later', content: [{ type: 'image' }] }];
    publish();
    assert.equal(await until(() => store.state.items.length === 2 && store.state.busy === true), true);
    assert.equal(store.state.streamingTail.text, 'Hel');
    assert.deepEqual(store.state.queued, [{ id: 'q1', text: 'later' }]);

    ownerState.streamingTail = { id: 't1', text: 'Hello', reasoning: true };
    publish();
    assert.equal(await until(() => store.state.streamingTail?.text === 'Hello'), true);
    assert.equal(store.state.streamingTail.reasoning, true, 'tail meta travels with the suffix');

    ownerState.items = ownerState.items.map((item) => (item.id === 'a' ? { ...item, text: 'patched' } : item));
    ownerState.streamingTail = null;
    ownerState.spinner = { label: 'thinking' };
    publish();
    assert.equal(
      await until(() => store.state.items[0]?.text === 'patched' && store.state.streamingTail === null),
      true
    );
    assert.deepEqual(store.state.spinner, { label: 'thinking' });

    let undelivered = 0;
    assert.equal(
      viewer.sendSubmit('hi there', {
        id: 'sub-1',
        submittedAt: 1234,
        displayText: 'hi there',
        options: { foo: 1 },
        onUndelivered: () => {
          undelivered += 1;
        },
      }),
      true
    );
    assert.equal(await until(() => received.submits.length === 1), true);
    assert.deepEqual(received.submits[0], { prompt: 'hi there', options: { foo: 1, id: 'sub-1', submittedAt: 1234 } });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(undelivered, 0, 'an acknowledged submit never falls back');

    pair.refuseNextSubmit();
    let refused = 0;
    viewer.sendSubmit('refused', {
      onUndelivered: () => {
        refused += 1;
      },
    });
    assert.equal(await until(() => refused === 1), true, 'a refused submit reports undelivered');

    assert.equal(viewer.sendAbort(), true);
    assert.equal(await until(() => received.aborts === 1), true);

    owner.dispose();
    assert.equal(await until(() => received.ownerClosed.length === 1), true);
    assert.deepEqual(received.ownerClosed[0], { id: SESSION_ID, clean: true });
    assert.equal(store.state.busy, false, 'mirrored activity clears when the owner goes away');
    assert.equal(store.state.spinner, null);
    assert.equal(viewer.viewerConnected(), false);
    assert.equal(viewer.sendSubmit('late'), false);
  } finally {
    owner.dispose();
    viewer.dispose();
  }
});

test('forwardViewerSubmit takes the pipe when it accepts, otherwise spools with the same id', () => {
  const spooled = [];
  const sent = [];
  const accepting = {
    ensure: () => {},
    sendSubmit: (content, meta) => {
      sent.push({ content, meta });
      return true;
    },
  };
  assert.equal(
    forwardViewerSubmit({ text: 'go', options: { id: 'keep-me' }, share: accepting, spool: (id) => spooled.push(id) }),
    true
  );
  assert.equal(sent[0].meta.id, 'keep-me');
  assert.deepEqual(spooled, []);

  const refusing = { ensure: () => {}, sendSubmit: () => false };
  assert.equal(
    forwardViewerSubmit({
      text: 'go',
      share: refusing,
      pid: 42,
      spool: (id) => {
        spooled.push(id);
        return true;
      },
    }),
    true
  );
  assert.match(spooled[0], /^view-submit-42-\d+$/);
  assert.equal(forwardViewerSubmit({ text: '   ', share: refusing, spool: () => true }), false);
});
