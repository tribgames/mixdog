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
const LIVE_PIPE_ID = `${PIPE_ID}_live`;
const livePipePath = process.platform === 'win32'
  ? `\\\\.\\pipe\\mixdog-live-${LIVE_PIPE_ID}`
  : join(tmpdir(), `mixdog-live-${LIVE_PIPE_ID}.sock`);
const SWITCH_PIPE_ID = `${PIPE_ID}_switch`;
const switchPipePath = process.platform === 'win32'
  ? `\\\\.\\pipe\\mixdog-live-${SWITCH_PIPE_ID}`
  : join(tmpdir(), `mixdog-live-${SWITCH_PIPE_ID}.sock`);

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
  const store = {
    items: [{ id: 'disk-only', kind: 'user', text: 'persisted last user message' }],
    streamingTail: null,
    spinner: null,
  };
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
    const initialSync = viewerShare.waitForViewerSync(PIPE_ID, 1_000);
    await waitFor(() => {
      viewerShare.ensure();
      return viewerShare.viewerConnected();
    }, 'viewer connect');
    // Initial full frame mirrors the owner transcript.
    assert.equal(await initialSync, true);
    await waitFor(() => viewer.store.items.length === 1
      && viewer.store.items[0].id === 'a1', 'initial full frame');
    assert.equal(viewer.store.items.some((item) => item.id === 'disk-only'), false,
      'the initial sync barrier must replace the incomplete persisted transcript');

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

test('live-share mirrors owner live state and forwards viewer aborts', async () => {
  const listeners = new Set();
  let ownerState = {
    items: [],
    streamingTail: null,
    spinner: null,
    busy: true,
    commandBusy: false,
    queued: [{ id: 'q1', text: 'queued follow-up', content: [{ type: 'image', data: 'x' }] }],
    activeToolSummary: '2:100:1:200',
    agentWorkers: [{ tag: 'worker', status: 'running', startedAt: 10 }],
    agentJobs: [],
    clientHostPid: 4242,
    displayContextWindow: 200000,
    compactBoundaryTokens: 180000,
    autoCompactTokenLimit: 160000,
    stats: { currentContextTokens: 50000, currentContextSource: 'last_api_request', costUsd: 1.25 },
  };
  let ownerAborts = 0;
  const owner = createLiveShare({
    ownerSessionId: () => LIVE_PIPE_ID,
    viewerSessionId: () => '',
    socketPathFor: () => livePipePath,
    getPublishedState: () => ownerState,
    listeners,
    onRemoteSubmit: () => {},
    onRemoteAbort: () => { ownerAborts += 1; },
    onOwnerClosed: () => {},
    viewerApply: null,
  });
  const publish = (next) => {
    ownerState = next;
    for (const listener of listeners) listener();
  };

  const viewer = createViewerStore();
  viewer.store.stats = { inputTokens: 7 };
  const viewerShare = createLiveShare({
    ownerSessionId: () => '',
    viewerSessionId: () => LIVE_PIPE_ID,
    socketPathFor: () => livePipePath,
    getPublishedState: () => ({ items: [], streamingTail: null, spinner: null }),
    listeners: new Set(),
    onRemoteSubmit: () => {},
    onOwnerClosed: () => {},
    viewerApply: viewer.apply,
  });

  try {
    owner.ensure();
    await waitFor(() => {
      viewerShare.ensure();
      return viewerShare.viewerConnected();
    }, 'viewer connect');
    // Initial full frame carries the live-state mirror.
    await waitFor(() => viewer.store.busy === true, 'mirrored busy');
    assert.equal(viewer.store.activeToolSummary, '2:100:1:200');
    assert.equal(viewer.store.agentWorkers.length, 1);
    assert.equal(viewer.store.ownerClientHostPid, 4242);
    assert.equal(viewer.store.displayContextWindow, 200000);
    // Queue entries are projected to display fields only (no content parts).
    assert.deepEqual(viewer.store.queued, [{ id: 'q1', text: 'queued follow-up' }]);
    // Context stats merge over local accumulator fields instead of replacing.
    assert.equal(viewer.store.stats.currentContextTokens, 50000);
    assert.equal(viewer.store.stats.costUsd, 1.25);
    assert.equal(viewer.store.stats.inputTokens, 7);

    // A live-state change rides the delta protocol.
    publish({ ...ownerState, busy: false, queued: [], activeToolSummary: null });
    await waitFor(() => viewer.store.busy === false && viewer.store.queued.length === 0
      && viewer.store.activeToolSummary === null, 'mirrored live delta');

    // Viewer stop forwards the interrupt to the owner process.
    assert.equal(viewerShare.sendAbort(), true);
    await waitFor(() => ownerAborts === 1, 'forwarded abort');

    // Owner shutdown clears the mirrored activity so nothing freezes on.
    publish({ ...ownerState, busy: true, agentWorkers: [{ tag: 'w2', status: 'running' }] });
    await waitFor(() => viewer.store.busy === true, 'busy re-mirrored');
    owner.dispose();
    await waitFor(() => viewer.store.busy === false && viewer.store.agentWorkers.length === 0,
      'mirrored live state cleared on owner close');
  } finally {
    owner.dispose();
    viewerShare.dispose();
  }
});

test('switching the viewer session clears mirrored owner activity', async () => {
  // Regression: stopClient() tears the pipe down itself (session switch), so
  // the socket close handler sees clientUp=false and skipped the mirror
  // clear — the owner's busy/spinner leaked into the next resumed session as
  // a frozen working indicator.
  const listeners = new Set();
  const ownerState = {
    items: [],
    streamingTail: null,
    spinner: { active: true, mode: 'responding' },
    busy: true,
    commandBusy: false,
    queued: [{ id: 'q1', text: 'queued' }],
    activeToolSummary: '1:5:0:0',
    agentWorkers: [{ tag: 'w1', status: 'running' }],
    agentJobs: [],
    clientHostPid: 777,
  };
  const owner = createLiveShare({
    ownerSessionId: () => SWITCH_PIPE_ID,
    viewerSessionId: () => '',
    socketPathFor: () => switchPipePath,
    getPublishedState: () => ownerState,
    listeners,
    onRemoteSubmit: () => {},
    onOwnerClosed: () => {},
    viewerApply: null,
  });

  const viewer = createViewerStore();
  let viewerTarget = SWITCH_PIPE_ID;
  const viewerShare = createLiveShare({
    ownerSessionId: () => '',
    viewerSessionId: () => viewerTarget,
    socketPathFor: () => switchPipePath,
    getPublishedState: () => ({ items: [], streamingTail: null, spinner: null }),
    listeners: new Set(),
    onRemoteSubmit: () => {},
    onOwnerClosed: () => {},
    viewerApply: viewer.apply,
  });

  try {
    owner.ensure();
    await waitFor(() => {
      viewerShare.ensure();
      return viewerShare.viewerConnected();
    }, 'viewer connect');
    await waitFor(() => viewer.store.busy === true
      && viewer.store.spinner?.active === true, 'mirrored busy + spinner');

    // The user selects a different session: ensure() reconciles the viewer
    // leg away from this pipe and MUST drop the mirrored activity with it.
    viewerTarget = '';
    viewerShare.ensure();
    await waitFor(() => viewer.store.busy === false
      && viewer.store.spinner === null
      && viewer.store.queued.length === 0
      && viewer.store.agentWorkers.length === 0
      && viewer.store.activeToolSummary === null
      && viewer.store.ownerClientHostPid === 0,
    'mirrored activity cleared on session switch');
  } finally {
    owner.dispose();
    viewerShare.dispose();
  }
});
