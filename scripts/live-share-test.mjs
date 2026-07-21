// Integration test for src/tui/engine/live-share.mjs: a real owner pipe
// server and viewer client exchange full/delta/tail frames and submits over
// the platform transport (named pipe / unix socket).
import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLiveShare } from '../src/tui/engine/live-share.mjs';

const PIPE_ID = `livetest_${process.pid}_${Date.now()}`;
const pipePath = process.platform === 'win32'
  ? `\\\\.\\pipe\\mixdog-live-${PIPE_ID}`
  : join(tmpdir(), `mixdog-live-${PIPE_ID}.sock`);

function waitFor(check, label, timeoutMs = 4000) {
  return new Promise((resolvePromise, rejectPromise) => {
    const startedAt = Date.now();
    const tick = () => {
      let result = false;
      try { result = check(); } catch { result = false; }
      if (result) return resolvePromise(result);
      if (Date.now() - startedAt > timeoutMs) {
        return rejectPromise(new Error(`timeout waiting for ${label}`));
      }
      setTimeout(tick, 20);
    };
    tick();
  });
}

function createViewerStore() {
  const store = { items: [], streamingTail: null, spinner: null };
  return {
    store,
    apply: {
      getState: () => store,
      set: (patch) => Object.assign(store, patch),
      replaceItems: (items) => { store.items = [...items]; },
      patchItem: (id, patch) => {
        const index = store.items.findIndex((item) => item?.id === id);
        if (index < 0) return false;
        store.items[index] = { ...store.items[index], ...patch };
        return true;
      },
      appendItems: (items) => { store.items = [...store.items, ...items]; },
      updateStreamingTail: (id, patch) => {
        const current = store.streamingTail?.id === id ? store.streamingTail : { id, text: '' };
        store.streamingTail = { ...current, ...patch, id };
      },
      clearStreamingTail: () => { store.streamingTail = null; },
    },
  };
}

test('live-share mirrors owner deltas and routes viewer submits', async () => {
  const listeners = new Set();
  let ownerState = {
    items: [{ id: 'a1', kind: 'assistant', text: 'hello' }],
    streamingTail: null,
    spinner: null,
  };
  const receivedSubmits = [];
  const owner = createLiveShare({
    ownerSessionId: () => PIPE_ID,
    viewerSessionId: () => '',
    socketPathFor: () => pipePath,
    getPublishedState: () => ownerState,
    listeners,
    onRemoteSubmit: (text) => receivedSubmits.push(text),
    onOwnerClosed: () => {},
    viewerApply: null,
  });
  const publish = (next) => {
    ownerState = next;
    for (const listener of listeners) listener();
  };

  const viewer = createViewerStore();
  let ownerClosedCount = 0;
  const viewerShare = createLiveShare({
    ownerSessionId: () => '',
    viewerSessionId: () => PIPE_ID,
    socketPathFor: () => pipePath,
    getPublishedState: () => ({ items: [], streamingTail: null, spinner: null }),
    listeners: new Set(),
    onRemoteSubmit: () => {},
    onOwnerClosed: () => { ownerClosedCount += 1; },
    viewerApply: viewer.apply,
  });

  try {
    owner.ensure();
    await waitFor(() => {
      viewerShare.ensure();
      return viewerShare.viewerConnected();
    }, 'viewer connect');
    // Initial full frame mirrors the owner transcript.
    await waitFor(() => viewer.store.items.length === 1
      && viewer.store.items[0].id === 'a1', 'initial full frame');

    // Appended item + streaming tail start.
    publish({
      ...ownerState,
      items: [...ownerState.items, { id: 'u1', kind: 'user', text: 'hi from owner side' }],
      streamingTail: { kind: 'assistant', id: 't1', text: 'stream', streaming: true },
      spinner: { active: true, mode: 'responding' },
    });
    await waitFor(() => viewer.store.items.length === 2
      && viewer.store.streamingTail?.text === 'stream'
      && viewer.store.spinner?.active === true, 'append + tail frame');

    // Append-only tail growth rides the suffix protocol.
    publish({
      ...ownerState,
      streamingTail: { kind: 'assistant', id: 't1', text: 'streaming more', streaming: true },
    });
    await waitFor(() => viewer.store.streamingTail?.text === 'streaming more', 'tail suffix frame');

    // Patched item (owner edited an existing row) arrives as a change.
    publish({
      ...ownerState,
      items: [{ ...ownerState.items[0], text: 'hello edited' }, ownerState.items[1]],
      streamingTail: null,
    });
    await waitFor(() => viewer.store.items[0].text === 'hello edited'
      && viewer.store.streamingTail === null, 'patch + tail clear frame');

    // Viewer submit reaches the owner queue.
    assert.equal(viewerShare.sendSubmit('typed on viewer'), true);
    await waitFor(() => receivedSubmits.length === 1, 'viewer submit');
    assert.equal(receivedSubmits[0], 'typed on viewer');

    // Owner shutdown notifies the viewer promotion path.
    owner.dispose();
    await waitFor(() => ownerClosedCount === 1, 'owner close notification');
  } finally {
    owner.dispose();
    viewerShare.dispose();
  }
});
