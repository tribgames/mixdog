import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test, { after } from 'node:test';
import React, { act, useState } from 'react';
import { installTestDom } from './test-support/test-dom.mjs';

const { restore: restoreBootstrapDom } = installTestDom(null);
after(restoreBootstrapDom);

const [
  { useConversationPendingPrompts },
  { useConversationSubmission },
  { useConversationComposerActions },
  { pendingPromptTranscriptItems },
  { defaultSessionLaneStore },
  { followSessionStates },
  { connect, sessionReducer, sessionStateOf },
  { MockNetwork },
] = await Promise.all([
  import('./use-conversation-pending-prompts.ts'),
  import('./use-conversation-submission.ts'),
  import('./conversation-support.tsx'),
  import('./conversation-prompt-items.ts'),
  import('./session-lane-store.ts'),
  import('./remote-session-states.ts'),
  import('../../../../packages/protocol-client/src/index.ts'),
  import('../../../../packages/protocol-client/src/mock.ts'),
]);

const protocolOptions = JSON.parse(
  readFileSync(new URL('../../../../packages/protocol-client/conformance/options.json', import.meta.url), 'utf8')
);

function mountDom(t) {
  const { document, root } = installTestDom(t, {
    expose: ['HTMLElement', 'Element', 'Node', 'MouseEvent', 'Event'],
    rootId: 'root',
  });
  return { document, root };
}

async function mountPendingHarness(t, { queuedAtSubmit = true } = {}) {
  const { root } = mountDom(t);
  const view = {
    optimisticPrompts: [],
    steerItems: [],
    pendingItems: [],
    actions: null,
    setOptimisticPrompts: null,
  };
  const host = { reply: null, replies: new Map() };
  const refs = {
    acceptSnapshotContextRef: {
      current: { snapshotRevision: undefined, restoring: false, snapshotPreview: false },
    },
    armFollowOnSubmitRef: { current: () => {} },
    composerActions: {
      current: {
        invokeResult: (action) => action(),
        submit: (_content, options) =>
          new Promise((resolve) => {
            host.reply = resolve;
            if (options?.id !== undefined) host.replies.set(String(options.id), resolve);
          }),
      },
    },
    draftModeRef: { current: false },
    goalSubmission: { current: null },
    goalSubmitScopeRef: { current: 's1' },
    queuedBehindTurnAtSubmit: { current: queuedAtSubmit },
    routeSessionIdRef: { current: 's1' },
    suppressDraftSubmitPaintHandoff: { current: false },
  };
  function Harness({
    sessionKey = 's1',
    settledItems = [],
    queued = [],
    busy = false,
    compacting = false,
    hasOlder = false,
    turnId = '',
    snapshotRevision,
    snapshotPreview = false,
    restoring = false,
  }) {
    const [optimisticPrompts, setOptimisticPrompts] = useState([]);
    refs.acceptSnapshotContextRef.current = { snapshotRevision, restoring, snapshotPreview };
    const pending = useConversationPendingPrompts({
      optimisticPrompts,
      setOptimisticPrompts,
      settledItems,
      queued,
      transcriptSessionKey: sessionKey,
      promotedOwnDraft: { current: false },
      busy,
      compacting,
      hasOlder,
      turnId,
      snapshotRevision,
      snapshotPreview,
      restoring,
    });
    view.actions = useConversationComposerActions({
      ...refs,
      goalSubmission: pending.goalSubmission,
      goalSubmitScopeRef: pending.goalSubmitScopeRef,
      setOptimisticPrompts,
    });
    view.optimisticPrompts = optimisticPrompts;
    view.steerItems = pending.steerItems;
    view.pendingItems = pending.transcriptPendingPromptItems;
    view.setOptimisticPrompts = setOptimisticPrompts;
    return null;
  }
  const show = (props) => act(async () => root.render(React.createElement(Harness, props)));
  const submit = async (text, id) => {
    let sending;
    await act(async () => {
      sending = view.actions.composerSubmit(text, { id });
    });
    return { sending, id };
  };
  const accept = async ({ sending, id }, value = true) => {
    await act(async () => {
      const resolve = (id !== undefined ? host.replies.get(String(id)) : null) ?? host.reply;
      resolve(value);
      await sending;
    });
  };
  const acceptAndShow = async ({ sending, id }, value, props) => {
    await act(async () => {
      const resolve = (id !== undefined ? host.replies.get(String(id)) : null) ?? host.reply;
      resolve(value);
      await sending;
      root.render(React.createElement(Harness, props));
    });
  };
  return { view, show, submit, accept, acceptAndShow };
}

const baseRunning = [
  { kind: 'user', id: 'u1', text: 'first prompt' },
  { kind: 'assistant', id: 'a1', text: 'working...' },
];

test('queued prompt seen in queued then removed without settling (cross-device cancel) releases with no steerLocal zombie', async (t) => {
  const pane = await mountPendingHarness(t, { queuedAtSubmit: true });
  await pane.show({ settledItems: baseRunning, busy: true, queued: [] });

  const sending = await pane.submit('follow up', 'sub-cancel');
  await pane.accept(sending, true);
  assert.equal(pane.view.steerItems.length, 1);
  assert.equal(pane.view.steerItems[0].steerLocal, true);

  // Server publishes the item in session.queued.
  await pane.show({
    settledItems: baseRunning,
    busy: true,
    queued: [{ id: 'sub-cancel', displayText: 'follow up', submittedAt: 10 }],
  });
  assert.equal(pane.view.steerItems.length, 1);
  assert.equal(pane.view.steerItems[0].steerLocal, undefined);

  // Another device cancels the queued prompt while the turn is still running:
  // the single intermediate empty-queue frame holds briefly in drain (matching mid-turn dequeue before user row commit),
  // then releases cleanly once the turn appends a non-user row (or finishes idle / changes turn / restores).
  await pane.show({ settledItems: baseRunning, busy: true, queued: [] });
  assert.equal(pane.view.optimisticPrompts.length, 1);

  await pane.show({
    settledItems: [...baseRunning, { kind: 'assistant', id: 'a2', text: 'continuing without cancelled prompt' }],
    busy: true,
    queued: [],
  });
  assert.deepEqual(pane.view.optimisticPrompts, []);
  assert.deepEqual(pane.view.steerItems, []);

  // Cancelling as the turn goes idle releases immediately on that frame.
  const sendingIdle = await pane.submit('follow up idle cancel', 'sub-cancel-idle');
  await pane.accept(sendingIdle, true);
  await pane.show({
    settledItems: baseRunning,
    busy: true,
    queued: [{ id: 'sub-cancel-idle', displayText: 'follow up idle cancel', submittedAt: 20 }],
  });
  await pane.show({ settledItems: baseRunning, busy: false, queued: [] });
  assert.deepEqual(pane.view.optimisticPrompts, []);
  assert.deepEqual(pane.view.steerItems, []);
});

test('queued prompt seen in queued then dequeued and compacted/trimmed off the tail releases immediately', async (t) => {
  const pane = await mountPendingHarness(t, { queuedAtSubmit: true });
  await pane.show({ settledItems: baseRunning, busy: true, queued: [] });

  const sending = await pane.submit('trimmed follow up', 'sub-trim');
  await pane.accept(sending, true);

  await pane.show({
    settledItems: baseRunning,
    busy: true,
    queued: [{ id: 'sub-trim', displayText: 'trimmed follow up', submittedAt: 10 }],
  });

  // Mobile reconnects after compaction/trim: item left queued and is older than the new tail window.
  await pane.show({
    settledItems: [
      { kind: 'user', id: 'u50', text: 'much later' },
      { kind: 'assistant', id: 'a50', text: 'done' },
    ],
    busy: true,
    hasOlder: true,
    queued: [],
  });
  assert.deepEqual(pane.view.optimisticPrompts, []);
  assert.deepEqual(pane.view.steerItems, []);
});

test('accepted prompt never seen in queued releases on fresh authoritative trimmed tail after reconnect', async (t) => {
  const pane = await mountPendingHarness(t, { queuedAtSubmit: true });
  await pane.show({ settledItems: baseRunning, busy: true, hasOlder: false, queued: [], snapshotRevision: 1 });

  const sending = await pane.submit('sent before background', 'sub-bg-trim');
  await pane.accept(sending, true);

  // Still on the pre-accept snapshot: must stay visible as steerLocal until a post-accept snapshot arrives.
  assert.equal(pane.view.optimisticPrompts.length, 1);
  assert.equal(pane.view.steerItems.length, 1);
  assert.equal(pane.view.steerItems[0].steerLocal, true);

  // Reconnect lands with a newer trimmed tail (even while another turn is busy and without snapshotRevision change).
  await pane.show({
    settledItems: [
      { kind: 'user', id: 'u90', text: 'later turn' },
      { kind: 'assistant', id: 'a90', text: 'later reply' },
    ],
    busy: true,
    hasOlder: true,
    queued: [],
    snapshotRevision: 1,
  });
  assert.deepEqual(pane.view.optimisticPrompts, []);
  assert.deepEqual(pane.view.steerItems, []);
});

test('accepted queued prompt never seen in queued releases when session becomes idle with empty queued after accept', async (t) => {
  const pane = await mountPendingHarness(t, { queuedAtSubmit: true });
  await pane.show({ settledItems: baseRunning, busy: true, queued: [] });

  const sending = await pane.submit('sent before idle', 'sub-bg-idle');
  await pane.accept(sending, true);
  assert.equal(pane.view.steerItems.length, 1);

  // Reconnect snapshot: running turn finished and queue is empty (cancelled or compacted away).
  await pane.show({
    settledItems: [...baseRunning, { kind: 'turndone', id: 'd1' }],
    busy: false,
    queued: [],
  });
  assert.deepEqual(pane.view.optimisticPrompts, []);
  assert.deepEqual(pane.view.steerItems, []);
});

test('accepted prompt never seen in queued releases when authoritative snapshotRevision advances after accept', async (t) => {
  const pane = await mountPendingHarness(t, { queuedAtSubmit: true });
  await pane.show({ settledItems: baseRunning, busy: true, queued: [], snapshotRevision: 1 });

  const sending = await pane.submit('cancelled during disconnect', 'sub-rev');
  await pane.accept(sending, true);
  assert.equal(pane.view.steerItems.length, 1);

  // Same turn still running, same settled items, but fresh authoritative reconnect snapshot (rev 2) has empty queue.
  await pane.show({ settledItems: baseRunning, busy: true, queued: [], snapshotRevision: 2 });
  assert.deepEqual(pane.view.optimisticPrompts, []);
  assert.deepEqual(pane.view.steerItems, []);
});

test('accepted queued prompt never seen in queued releases when a different turnId is active with empty queued', async (t) => {
  const pane = await mountPendingHarness(t, { queuedAtSubmit: true });
  await pane.show({ settledItems: baseRunning, busy: true, queued: [], turnId: 'turn-1' });

  const sending = await pane.submit('missed during turn-1', 'sub-turn');
  await pane.accept(sending, true);
  assert.equal(pane.view.steerItems.length, 1);

  await pane.show({ settledItems: baseRunning, busy: true, queued: [], turnId: 'turn-2' });
  assert.deepEqual(pane.view.optimisticPrompts, []);
  assert.deepEqual(pane.view.steerItems, []);
});

test('in-flight submit (accepted: false) and accepted: true on pre-accept revision are NOT dropped prematurely', async (t) => {
  const pane = await mountPendingHarness(t, { queuedAtSubmit: true });
  await pane.show({ settledItems: baseRunning, busy: true, hasOlder: false, queued: [], snapshotRevision: 1 });

  const sending = await pane.submit('still in flight', 'sub-inflight');
  assert.equal(pane.view.optimisticPrompts[0].accepted, false);

  // Even if state progresses while RPC is still in flight (accepted: false), keep the bubble.
  await pane.show({
    settledItems: [{ kind: 'user', id: 'u20', text: 'newer' }],
    busy: false,
    hasOlder: true,
    queued: [],
    snapshotRevision: 2,
  });
  assert.equal(pane.view.optimisticPrompts.length, 1);
  assert.equal(pane.view.steerItems.length, 1);

  // RPC resolves accepted: true while still viewing snapshotRevision 2: baseline is captured on rev 2, NOT dropped!
  await pane.accept(sending, true);
  assert.equal(pane.view.optimisticPrompts.length, 1);
  assert.equal(pane.view.optimisticPrompts[0].accepted, true);
  assert.equal(pane.view.steerItems.length, 1);

  // Re-render on the exact same pre-accept snapshot revision 2: still NOT dropped.
  await pane.show({
    settledItems: [{ kind: 'user', id: 'u20', text: 'newer' }],
    busy: false,
    hasOlder: true,
    queued: [],
    snapshotRevision: 2,
  });
  assert.equal(pane.view.optimisticPrompts.length, 1);

  // Next revision arrives with the durable row -> settles cleanly.
  await pane.show({
    settledItems: [
      { kind: 'user', id: 'u20', text: 'newer' },
      { kind: 'user', id: 'sub-inflight', text: 'still in flight' },
    ],
    busy: true,
    hasOlder: true,
    queued: [],
    snapshotRevision: 3,
  });
  assert.deepEqual(pane.view.optimisticPrompts, []);
  assert.deepEqual(pane.view.steerItems, []);
});

test('accepted queued prompt is NOT dropped while running turn appends rows on a non-trimmed window or during restoreOwed/preview', async (t) => {
  const pane = await mountPendingHarness(t, { queuedAtSubmit: true });
  await pane.show({
    settledItems: baseRunning,
    busy: true,
    hasOlder: false,
    queued: [],
    turnId: 'turn-1',
    snapshotRevision: 1,
  });

  const sending = await pane.submit('waiting for queue echo', 'sub-wait');
  await pane.accept(sending, true);

  // Running turn appends another row on the same turn while queue echo has not arrived yet.
  const grown = [...baseRunning, { kind: 'assistant', id: 'a2', text: 'still working' }];
  await pane.show({
    settledItems: grown,
    busy: true,
    hasOlder: false,
    queued: [],
    turnId: 'turn-1',
    snapshotRevision: 1,
  });
  assert.equal(pane.view.optimisticPrompts.length, 1);
  assert.equal(pane.view.steerItems.length, 1);

  // Provisional preview or in-progress restore does not drop the prompt before the live snapshot arrives.
  await pane.show({
    settledItems: [],
    busy: false,
    hasOlder: true,
    queued: [],
    turnId: '',
    snapshotRevision: 2,
    restoring: true,
  });
  assert.equal(pane.view.optimisticPrompts.length, 1);

  await pane.show({
    settledItems: [],
    busy: false,
    hasOlder: true,
    queued: [],
    turnId: '',
    snapshotRevision: 2,
    snapshotPreview: true,
  });
  assert.equal(pane.view.optimisticPrompts.length, 1);
});

test('failed steer (steer: "failed") is NEVER dropped so user keeps "Send again"', async (t) => {
  const pane = await mountPendingHarness(t, { queuedAtSubmit: true });
  await pane.show({ settledItems: baseRunning, busy: true, queued: [], snapshotRevision: 1 });

  const sending = await pane.submit('retry me', 'sub-failed');
  await pane.accept(sending, false);
  assert.equal(pane.view.optimisticPrompts.length, 1);
  assert.equal(pane.view.optimisticPrompts[0].steer, 'failed');

  // Even across idle transition, trimmed tail, and snapshotRevision advance, failed steer stays.
  await pane.show({
    settledItems: [{ kind: 'user', id: 'u99', text: 'unrelated' }],
    busy: false,
    hasOlder: true,
    queued: [],
    snapshotRevision: 5,
  });
  assert.equal(pane.view.optimisticPrompts.length, 1);
  assert.equal(pane.view.steerItems.length, 1);
  assert.equal(pane.view.steerItems[0].steer, 'failed');
});

test('useConversationSubmission releases accepted queued prompt once session lane restoreOwed completes', async (t) => {
  const { root } = mountDom(t);
  const sessionId = 's-restore-test';
  defaultSessionLaneStore.clear();
  t.after(() => defaultSessionLaneStore.clear());

  let hostResolve = null;
  let latestSubmission = null;

  function Pane({ snapshot }) {
    latestSubmission = useConversationSubmission(
      {
        snapshot,
        routeSnapshot: snapshot,
        sessionAddress: null,
        selectedSessionId: sessionId,
        submit: () =>
          new Promise((resolve) => {
            hostResolve = resolve;
          }),
        invokeResult: (action) => action(),
        applySnapshot: () => {},
        onNewTask: () => {},
        onResumeSession: () => {},
        onOpenSessions: () => {},
        onOpenProjects: () => {},
        onOpenSettings: () => {},
        onOpenCommandSurface: () => {},
        onClearToNewTask: () => {},
        onInheritSession: async () => false,
      },
      {
        draftMode: false,
        settledItems: snapshot.items ?? [],
        transcriptSessionKey: sessionId,
        promotedOwnDraft: { current: false },
        routeSessionIdRef: { current: sessionId },
        armFollow: () => {},
        resetTranscriptToLive: () => {},
        suppressDraftSubmitPaintHandoff: { current: false },
      }
    );
    return null;
  }

  const initialSnapshot = {
    sessionId,
    items: baseRunning,
    busy: true,
    queued: [],
  };
  defaultSessionLaneStore.apply({
    sessionId,
    frameSource: 'live',
    snapshot: initialSnapshot,
    streamPosition: { epoch: 'e1', seq: 10, order: 1 },
  });

  await act(async () => root.render(React.createElement(Pane, { snapshot: initialSnapshot })));

  let sending;
  await act(async () => {
    sending = latestSubmission.actions.composerSubmit('reconnect check', { id: 'sub-lane-restore' });
  });
  await act(async () => {
    hostResolve(true);
    await sending;
  });
  assert.equal(latestSubmission.steerItems.length, 1);
  assert.equal(latestSubmission.steerItems[0].steerLocal, true);

  const flushLane = async (update) => {
    await act(async () => {
      defaultSessionLaneStore.apply(update);
      await new Promise((resolve) => setTimeout(resolve, 25));
    });
  };

  // Reconnect begins: lane marks restoreOwed: true -> prompt stays until restore finishes.
  await flushLane({
    sessionId,
    frameSource: 'replay',
    snapshot: { ...initialSnapshot, restoreOwed: true },
    streamPosition: { epoch: 'e1', seq: 10, order: 1 },
  });
  assert.equal(latestSubmission.steerItems.length, 1);

  // Restore completes with authoritative live snapshot (restoreOwed cleared, prompt absent from queued & items).
  const restoredSnapshot = {
    sessionId,
    items: baseRunning,
    busy: true,
    queued: [],
  };
  await flushLane({
    sessionId,
    frameSource: 'live',
    snapshot: restoredSnapshot,
    streamPosition: { epoch: 'e1', seq: 25, order: 1 },
  });
  await act(async () => root.render(React.createElement(Pane, { snapshot: restoredSnapshot })));
  assert.deepEqual(latestSubmission.steerItems, []);
});

test('probe 1: phone follower authoritative snapshot and replay restores release zombie without restoreOwed or epoch change', async (t) => {
  const { root } = mountDom(t);
  const threadId = 't-phone-zombie';
  defaultSessionLaneStore.clear();
  t.after(() => defaultSessionLaneStore.clear());

  const row = (id) => ({
    id,
    preview: '',
    title: 'Phone test',
    updatedAt: 1,
    messageCount: 1,
    cwd: '/w',
    classification: {},
    projectPath: null,
  });
  const baseWireItems = [{ id: 'u1', type: 'userMessage', content: [{ type: 'text', text: 'first prompt' }] }];
  const net = new MockNetwork();
  let conn = null;
  let resumeCount = 0;
  let resumeMode = 'snapshot';
  const serve = (request, activeConn) => {
    if (request.method === 'thread/resume') {
      resumeCount += 1;
      if (resumeMode === 'snapshot') {
        // Same epoch, same busy turn, same transcriptGeneration (0), overlapping tail, NO restoreOwed.
        const seq = resumeCount === 1 ? 1 : 20;
        activeConn.serverSend({
          id: request.id,
          result: {
            thread: row(threadId),
            subscription: { id: `sub-${resumeCount}`, mode: 'snapshot', epoch: 'e1', startSeq: seq },
          },
        });
        activeConn.serverSend({
          method: 'thread/snapshot',
          params: {
            thread: row(threadId),
            items: baseWireItems,
            state: { title: 'Phone test', runtime: { busy: true, turnId: 'turn-1' }, queued: [] },
            hasOlder: false,
          },
          feed: { id: threadId, epoch: 'e1', seq },
        });
        return;
      }
      // Replay mode on the exact same epoch and same fold origin: enqueue + cancel folded inside the replay.
      // `liveSeq: 24` sets the replay boundary at seq 23 (`liveSeq - 1`), emitting `replayComplete: true` on seq 23.
      activeConn.serverSend({
        id: request.id,
        result: {
          thread: row(threadId),
          subscription: { id: `sub-${resumeCount}`, mode: 'replay', epoch: 'e1', startSeq: 21, liveSeq: 24 },
        },
      });
      activeConn.serverSend({
        method: 'thread/queue/changed',
        params: {
          threadId,
          queued: [{ id: 'q-replay', clientSubmissionId: 'sub-phone-replay', text: 'replay cancel', enqueuedAt: 10 }],
        },
        feed: { id: threadId, epoch: 'e1', seq: 21 },
      });
      activeConn.serverSend({
        method: 'thread/queue/changed',
        params: { threadId, queued: [] },
        feed: { id: threadId, epoch: 'e1', seq: 22 },
      });
      activeConn.serverSend({
        method: 'thread/frame',
        params: { threadId, structureChanged: false },
        feed: { id: threadId, epoch: 'e1', seq: 23 },
      });
      return;
    }
    if (request.id !== undefined) activeConn.serverSend({ id: request.id, result: {} });
  };
  const acceptNext = async () => {
    const nextConn = await net.accept();
    const init = JSON.parse(await nextConn.nextSent());
    nextConn.serverSend({ id: init.id, result: { ...protocolOptions.initializeResult, serverInstanceId: 's1' } });
    await nextConn.nextSent();
    void (async () => {
      for (;;) {
        let raw;
        try {
          raw = await nextConn.nextSent();
        } catch {
          return;
        }
        serve(JSON.parse(raw), nextConn);
      }
    })();
    return nextConn;
  };
  const connecting = connect({
    target: { id: 'local' },
    connector: net,
    clientInfo: protocolOptions.clientInfo,
    capabilities: protocolOptions.capabilities,
    threadReducer: sessionReducer,
    clock: { sleep: () => Promise.resolve() },
    random: () => 0,
  });
  conn = await acceptNext();
  const client = await connecting;
  t.after(() => client.close());

  const updates = [];
  const follower = followSessionStates(client, {
    publish: (update) => {
      updates.push(update);
      defaultSessionLaneStore.apply(update);
    },
    decorate: (state) => state,
    stateOf: (id) => sessionStateOf(client, id),
  });
  t.after(() => follower.stop());

  let hostResolve = null;
  let latestSubmission = null;
  function Pane({ snapshot }) {
    latestSubmission = useConversationSubmission(
      {
        snapshot,
        routeSnapshot: snapshot,
        sessionAddress: null,
        selectedSessionId: threadId,
        submit: () =>
          new Promise((resolve) => {
            hostResolve = resolve;
          }),
        invokeResult: (action) => action(),
        applySnapshot: () => {},
        onNewTask: () => {},
        onResumeSession: () => {},
        onOpenSessions: () => {},
        onOpenProjects: () => {},
        onOpenSettings: () => {},
        onOpenCommandSurface: () => {},
        onClearToNewTask: () => {},
        onInheritSession: async () => false,
      },
      {
        draftMode: false,
        settledItems: snapshot.items ?? [],
        transcriptSessionKey: threadId,
        promotedOwnDraft: { current: false },
        routeSessionIdRef: { current: threadId },
        armFollow: () => {},
        resetTranscriptToLive: () => {},
        suppressDraftSubmitPaintHandoff: { current: false },
      }
    );
    return null;
  }

  const waitForUpdates = async (count) => {
    await act(async () => {
      for (let i = 0; i < 100 && updates.length < count; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    });
    assert.ok(updates.length >= count, `expected at least ${count} updates, got ${updates.length}`);
  };

  await act(async () => {
    await client.resumeThread(threadId, { lastItems: 40 });
  });
  await waitForUpdates(1);
  const snap1 = updates.at(-1).snapshot;
  assert.equal(typeof snap1.snapshotRevision, 'number');
  await act(async () => root.render(React.createElement(Pane, { snapshot: snap1 })));

  // Submit & accept a steer; queue echo is never observed.
  let sending;
  await act(async () => {
    sending = latestSubmission.actions.composerSubmit('cancelled on PC', { id: 'sub-phone-snap' });
  });
  await act(async () => {
    hostResolve(true);
    await sending;
  });
  assert.equal(latestSubmission.steerItems.length, 1);
  assert.equal(latestSubmission.steerItems[0].steerLocal, true);

  // Ordinary incremental frame on the same fold origin must NOT drop the accepted prompt.
  await act(async () => {
    conn.serverSend({
      method: 'thread/frame',
      params: { threadId, structureChanged: false },
      feed: { id: threadId, epoch: 'e1', seq: 2 },
    });
  });
  await waitForUpdates(2);
  const snapIncremental = updates.at(-1).snapshot;
  assert.equal(snapIncremental.snapshotRevision, snap1.snapshotRevision);
  await act(async () => root.render(React.createElement(Pane, { snapshot: snapIncremental })));
  assert.equal(latestSubmission.steerItems.length, 1, 'normal streaming frame does not drop accepted prompt');

  // Reconnect delivers fresh authoritative thread/snapshot on same epoch, same busy turn, same transcriptGeneration (0), no restoreOwed.
  const countBeforeSnapReconnect = updates.length;
  await act(async () => {
    conn.serverClose(1006);
    conn = await acceptNext();
  });
  await waitForUpdates(countBeforeSnapReconnect + 1);
  const snap2 = updates.at(-1).snapshot;
  assert.ok(snap2.snapshotRevision > snap1.snapshotRevision, 'fresh snapshot advances snapshotRevision');
  assert.equal(snap2.restoreOwed, undefined);
  assert.equal(snap2.transcriptGeneration, 0);
  await act(async () => root.render(React.createElement(Pane, { snapshot: snap2 })));
  assert.deepEqual(latestSubmission.steerItems, [], 'fresh authoritative snapshot releases zombie');

  // Now verify reconnect via replay mode (same fold origin, same epoch, enqueue + cancel folded inside replay).
  let sendingReplay;
  await act(async () => {
    sendingReplay = latestSubmission.actions.composerSubmit('replay cancel', { id: 'sub-phone-replay' });
  });
  await act(async () => {
    hostResolve(true);
    await sendingReplay;
  });
  assert.equal(latestSubmission.steerItems.length, 1);

  resumeMode = 'replay';
  const countBeforeReplayReconnect = updates.length;
  await act(async () => {
    conn.serverClose(1006);
    conn = await acceptNext();
  });
  await waitForUpdates(countBeforeReplayReconnect + 1);
  const snap3 = updates.at(-1).snapshot;
  assert.ok(snap3.snapshotRevision > snap2.snapshotRevision, 'replayComplete advances snapshotRevision');
  await act(async () => root.render(React.createElement(Pane, { snapshot: snap3 })));
  assert.deepEqual(latestSubmission.steerItems, [], 'post-replay authoritative sync releases zombie');
});

test('probe 2: accepting during restore releases cleanly when restore finishes idle with prompt absent', async (t) => {
  const pane = await mountPendingHarness(t, { queuedAtSubmit: true });
  await pane.show({ settledItems: baseRunning, busy: true, queued: [], restoring: true });

  // Submit starts and becomes accepted: true WHILE restoring is still true.
  const sending = await pane.submit('accepted during restore', 'sub-during-restore');
  await pane.accept(sending, true);
  assert.equal(pane.view.optimisticPrompts.length, 1);
  assert.equal(pane.view.optimisticPrompts[0].accepted, true);
  assert.equal(pane.view.steerItems.length, 1);

  // Restore finishes idle with prompt absent (no snapshotRevision bump needed): must release immediately!
  await pane.show({ settledItems: baseRunning, busy: false, queued: [], restoring: false });
  assert.deepEqual(pane.view.optimisticPrompts, []);
  assert.deepEqual(pane.view.steerItems, []);
});

test('probe 2b: accepting during restore keeps prompt when post-restore snapshot contains it in queued', async (t) => {
  const pane = await mountPendingHarness(t, { queuedAtSubmit: true });
  await pane.show({ settledItems: baseRunning, busy: true, queued: [], restoring: true });

  const sending = await pane.submit('still queued after restore', 'sub-restore-queued');
  await pane.accept(sending, true);
  assert.equal(pane.view.optimisticPrompts.length, 1);

  await pane.show({
    settledItems: baseRunning,
    busy: true,
    queued: [{ id: 'sub-restore-queued', displayText: 'still queued after restore', submittedAt: 10 }],
    restoring: false,
  });
  assert.equal(pane.view.optimisticPrompts.length, 1);
  assert.equal(pane.view.steerItems.length, 1);
  assert.equal(pane.view.steerItems[0].steerLocal, undefined);
});

test('probe 3a: in-flight submit (accepted: false) seen in queued then dequeued is NOT dropped before RPC reply resolves', async (t) => {
  const pane = await mountPendingHarness(t, { queuedAtSubmit: true });
  await pane.show({ settledItems: baseRunning, busy: true, queued: [] });

  const sending = await pane.submit('in flight', 'sub-inflight-dequeue');
  assert.equal(pane.view.optimisticPrompts[0].accepted, false);

  // Queue echoes the item before the submit RPC reply arrives, then dequeues it.
  await pane.show({
    settledItems: baseRunning,
    busy: true,
    queued: [{ id: 'sub-inflight-dequeue', displayText: 'in flight', submittedAt: 10 }],
  });
  await pane.show({ settledItems: baseRunning, busy: true, queued: [] });
  assert.equal(pane.view.optimisticPrompts.length, 1, 'in-flight card stays until its RPC reply resolves');
  assert.equal(pane.view.optimisticPrompts[0].accepted, false);

  // Once the RPC resolves accepted: true on the same live busy turn, the prompt enters draining (not dropped prematurely mid-drain)
  // and releases cleanly as soon as the turn progresses past user-row insertion or finishes idle.
  await pane.accept(sending, true);
  assert.equal(pane.view.optimisticPrompts.length, 1);

  await pane.show({
    settledItems: [...baseRunning, { kind: 'assistant', id: 'a2', text: 'reply without queued prompt' }],
    busy: true,
    queued: [],
  });
  assert.deepEqual(pane.view.optimisticPrompts, []);
  assert.deepEqual(pane.view.steerItems, []);
});

test('probe 3b: prompt dequeued before idle auto-clear compaction stays visible during compaction, then settles or releases', async (t) => {
  const pane = await mountPendingHarness(t, { queuedAtSubmit: true });
  await pane.show({ settledItems: baseRunning, busy: true, compacting: false, queued: [] });

  const sending = await pane.submit('after auto clear', 'sub-compact');
  await pane.accept(sending, true);
  await pane.show({
    settledItems: baseRunning,
    busy: true,
    compacting: false,
    queued: [{ id: 'sub-compact', displayText: 'after auto clear', submittedAt: 10 }],
  });

  // Turn ends, core dequeues the prompt on its own and runs idle auto-clear compaction (commandBusy/compacting: true).
  const ended = [...baseRunning, { kind: 'turndone', id: 'd1' }];
  await pane.show({ settledItems: ended, busy: false, compacting: true, queued: [] });
  assert.equal(pane.view.optimisticPrompts.length, 1, 'bubble stays visible while compaction runs');
  assert.equal(pane.view.steerItems.length, 1);

  // Compaction finishes and the prompt starts its turn with its durable row: settles seamlessly.
  await pane.show({
    settledItems: [...ended, { kind: 'user', id: 'sub-compact', text: 'after auto clear', fromQueue: true }],
    busy: true,
    compacting: false,
    queued: [],
  });
  assert.deepEqual(pane.view.optimisticPrompts, []);
  assert.deepEqual(pane.view.steerItems, []);

  // Second case: compaction ends idle without ever starting the prompt (refused/cancelled):
  // stays held across the brief post-compaction with_facts idle frame, then releases cleanly once a non-user row / turn / restore lands.
  const sending2 = await pane.submit('aborted in compact', 'sub-compact-abort');
  await pane.accept(sending2, true);
  await pane.show({
    settledItems: ended,
    busy: true,
    compacting: false,
    queued: [{ id: 'sub-compact-abort', displayText: 'aborted in compact', submittedAt: 20 }],
    snapshotRevision: 1,
  });
  await pane.show({ settledItems: ended, busy: false, compacting: true, queued: [], snapshotRevision: 1 });
  assert.equal(pane.view.optimisticPrompts.length, 1, 'held during compaction');
  await pane.show({ settledItems: ended, busy: false, compacting: false, queued: [], snapshotRevision: 1 });
  assert.equal(pane.view.optimisticPrompts.length, 1, 'held during post-compaction with_facts window');
  await pane.show({
    settledItems: [...ended, { kind: 'notice', id: 'n-abort', text: 'Compaction aborted' }],
    busy: false,
    compacting: false,
    queued: [],
    snapshotRevision: 1,
  });
  assert.deepEqual(pane.view.optimisticPrompts, [], 'released once non-user row lands after compaction');
  assert.deepEqual(pane.view.steerItems, []);
});

test('probe 3c: two-prompt drain holds second bubble while first settles, and releases if second never lands', async (t) => {
  const pane = await mountPendingHarness(t, { queuedAtSubmit: true });
  await pane.show({ settledItems: baseRunning, busy: true, queued: [] });

  const sending = await pane.submit('second in drain', 'sub-drain-2');
  await pane.accept(sending, true);
  await pane.show({
    settledItems: baseRunning,
    busy: true,
    queued: [
      { id: 'sub-drain-1', displayText: 'first in drain', submittedAt: 5 },
      { id: 'sub-drain-2', displayText: 'second in drain', submittedAt: 6 },
    ],
  });

  // Both leave queued together; first durable row lands first.
  const withFirst = [...baseRunning, { kind: 'user', id: 'sub-drain-1', text: 'first in drain', steered: true }];
  await pane.show({ settledItems: withFirst, busy: true, queued: [] });
  assert.equal(pane.view.optimisticPrompts.length, 1, 'second stays while cohort drains');

  // If the turn moves on to an assistant reply without the second row ever landing, release cleanly (no zombie).
  await pane.show({
    settledItems: [...withFirst, { kind: 'assistant', id: 'a2', text: 'reply without second' }],
    busy: true,
    queued: [],
  });
  assert.deepEqual(pane.view.optimisticPrompts, []);
  assert.deepEqual(pane.view.steerItems, []);
});

test('probe 4: failed steer (lost submit reply) releases when matching durable row settles or appears in queued', async (t) => {
  // Synchronous render-level projection drops a failed steer as soon as its settled row exists.
  const failedItem = {
    id: 'sub-lost-reply',
    kind: 'user',
    text: 'delivered anyway',
    pending: true,
    accepted: false,
    submittedAt: 10,
    queuedBehindTurn: true,
    steer: 'failed',
  };
  assert.deepEqual(
    pendingPromptTranscriptItems(
      [failedItem],
      [...baseRunning, { kind: 'user', id: 'sub-lost-reply', text: 'delivered anyway' }]
    ),
    [],
    'pendingPromptTranscriptItems hides failed steer once durable row exists'
  );

  // Hook-level release when durable row arrives after lost reply.
  const pane = await mountPendingHarness(t, { queuedAtSubmit: true });
  await pane.show({ settledItems: baseRunning, busy: true, queued: [] });
  const sending = await pane.submit('delivered anyway', 'sub-lost-reply');
  await pane.accept(sending, false);
  assert.equal(pane.view.optimisticPrompts[0].steer, 'failed');

  await pane.show({
    settledItems: [...baseRunning, { kind: 'user', id: 'sub-lost-reply', text: 'delivered anyway', steered: true }],
    busy: true,
    queued: [],
  });
  assert.deepEqual(pane.view.optimisticPrompts, []);
  assert.deepEqual(pane.view.steerItems, []);

  // Hook-level release when matching entry appears in queued after lost reply, so later cancel leaves no stale "Send again".
  const sendingQueued = await pane.submit('queued anyway', 'sub-lost-queued');
  await pane.accept(sendingQueued, false);
  assert.equal(pane.view.optimisticPrompts[0].steer, 'failed');

  await pane.show({
    settledItems: baseRunning,
    busy: true,
    queued: [{ id: 'sub-lost-queued', displayText: 'queued anyway', submittedAt: 20 }],
  });
  assert.deepEqual(pane.view.optimisticPrompts, [], 'stale failed twin removed once real queued entry appears');
  assert.equal(pane.view.steerItems.length, 1);
  assert.equal(pane.view.steerItems[0].steer, 'pending');

  await pane.show({ settledItems: baseRunning, busy: true, queued: [] });
  assert.deepEqual(pane.view.steerItems, [], 'cancelling real queued entry leaves no revived Send again card');
});

test('r2 probe 1: acceptance during restore batched with restore completion in one commit releases zombie (and keeps if queued)', async (t) => {
  // Case A: harness — accept resolves while restoring: true, and restore completion (restoring: false, idle, empty queued)
  // lands in the exact same React commit with NO intermediate accepted: true && restoring: true render.
  const pane = await mountPendingHarness(t, { queuedAtSubmit: true });
  await pane.show({ settledItems: baseRunning, busy: true, queued: [], restoring: true, snapshotRevision: 1 });

  const sending = await pane.submit('batched cancel during restore', 'sub-r2-batch-cancel');
  assert.equal(pane.view.optimisticPrompts[0].accepted, false);

  await pane.acceptAndShow(sending, true, {
    settledItems: baseRunning,
    busy: false,
    queued: [],
    restoring: false,
    snapshotRevision: 1,
  });
  assert.deepEqual(
    pane.view.optimisticPrompts,
    [],
    'batched restore completion releases absent prompt on first commit'
  );
  assert.deepEqual(pane.view.steerItems, []);

  // Case B: same single-commit batch, but post-restore snapshot DOES include the prompt in queued -> kept,
  // and later normal mid-turn dequeue still enters draining cleanly instead of flashing away.
  await pane.show({ settledItems: baseRunning, busy: true, queued: [], restoring: true, snapshotRevision: 2 });
  const sendingKept = await pane.submit('batched kept in queued', 'sub-r2-batch-keep');
  await pane.acceptAndShow(sendingKept, true, {
    settledItems: baseRunning,
    busy: true,
    queued: [{ id: 'sub-r2-batch-keep', displayText: 'batched kept in queued', submittedAt: 10 }],
    restoring: false,
    snapshotRevision: 2,
  });
  assert.equal(pane.view.optimisticPrompts.length, 1);
  assert.equal(pane.view.steerItems.length, 1);
  assert.equal(pane.view.steerItems[0].steerLocal, undefined);

  // Dequeue on the live busy turn before durable row arrives -> enters draining cleanly.
  await pane.show({ settledItems: baseRunning, busy: true, queued: [], restoring: false, snapshotRevision: 2 });
  assert.equal(pane.view.optimisticPrompts.length, 1, 'later live-turn dequeue holds during drain');
  await pane.show({
    settledItems: [...baseRunning, { kind: 'user', id: 'sub-r2-batch-keep', text: 'batched kept in queued' }],
    busy: true,
    queued: [],
    restoring: false,
    snapshotRevision: 2,
  });
  assert.deepEqual(pane.view.optimisticPrompts, []);
  assert.deepEqual(pane.view.steerItems, []);

  // Case C: full useConversationSubmission wiring with restoreOwed clearing in the same commit as hostResolve(true).
  const { root } = mountDom(t);
  const sessionId = 's-r2-batch-sub';
  defaultSessionLaneStore.clear();
  t.after(() => defaultSessionLaneStore.clear());

  let hostResolve = null;
  let latestSubmission = null;
  function Pane({ snapshot }) {
    latestSubmission = useConversationSubmission(
      {
        snapshot,
        routeSnapshot: snapshot,
        sessionAddress: null,
        selectedSessionId: sessionId,
        submit: () =>
          new Promise((resolve) => {
            hostResolve = resolve;
          }),
        invokeResult: (action) => action(),
        applySnapshot: () => {},
        onNewTask: () => {},
        onResumeSession: () => {},
        onOpenSessions: () => {},
        onOpenProjects: () => {},
        onOpenSettings: () => {},
        onOpenCommandSurface: () => {},
        onClearToNewTask: () => {},
        onInheritSession: async () => false,
      },
      {
        draftMode: false,
        settledItems: snapshot.items ?? [],
        transcriptSessionKey: sessionId,
        promotedOwnDraft: { current: false },
        routeSessionIdRef: { current: sessionId },
        armFollow: () => {},
        resetTranscriptToLive: () => {},
        suppressDraftSubmitPaintHandoff: { current: false },
      }
    );
    return null;
  }

  const restoringSnap = {
    sessionId,
    items: baseRunning,
    busy: true,
    queued: [],
    restoreOwed: true,
    snapshotRevision: 1,
  };
  defaultSessionLaneStore.apply({
    sessionId,
    frameSource: 'replay',
    snapshot: restoringSnap,
    streamPosition: { epoch: 'e1', seq: 10, order: 1 },
  });
  await act(async () => root.render(React.createElement(Pane, { snapshot: restoringSnap })));

  let subSending;
  await act(async () => {
    subSending = latestSubmission.actions.composerSubmit('batched in submission', { id: 'sub-r2-sub-batch' });
  });

  // Resolve submit acceptance AND deliver restored idle snapshot in ONE act() commit.
  const idleRestoredSnap = { sessionId, items: baseRunning, busy: false, queued: [], snapshotRevision: 1 };
  await act(async () => {
    hostResolve(true);
    await subSending;
    defaultSessionLaneStore.apply({
      sessionId,
      frameSource: 'live',
      snapshot: idleRestoredSnap,
      streamPosition: { epoch: 'e1', seq: 20, order: 1 },
    });
    root.render(React.createElement(Pane, { snapshot: idleRestoredSnap }));
  });
  assert.deepEqual(latestSubmission.steerItems, [], 'useConversationSubmission releases batched restore zombie');
});

test('r2 probe 2: real multi-prompt drain keeps both bubbles visible when queued: [] arrives before first durable user row', async (t) => {
  const pane = await mountPendingHarness(t, { queuedAtSubmit: true });
  await pane.show({ settledItems: baseRunning, busy: true, queued: [], turnId: 'turn-1' });

  const sending1 = await pane.submit('first steer', 'sub-m1');
  await pane.accept(sending1, true);
  const sending2 = await pane.submit('second steer', 'sub-m2');
  await pane.accept(sending2, true);

  await pane.show({
    settledItems: baseRunning,
    busy: true,
    turnId: 'turn-1',
    queued: [
      { id: 'sub-m1', displayText: 'first steer', submittedAt: 10 },
      { id: 'sub-m2', displayText: 'second steer', submittedAt: 11 },
    ],
  });
  assert.equal(pane.view.steerItems.length, 2);

  // Core dequeues both prompts (queued: []) BEFORE the agent commits the first durable user row.
  await pane.show({ settledItems: baseRunning, busy: true, turnId: 'turn-1', queued: [] });
  assert.equal(pane.view.optimisticPrompts.length, 2, 'both bubbles stay visible across empty-queue handoff');
  assert.equal(pane.view.steerItems.length, 2);

  // First durable user row lands: sub-m1 settles cleanly, sub-m2 stays visible.
  const withFirst = [...baseRunning, { kind: 'user', id: 'sub-m1', text: 'first steer', steered: true }];
  await pane.show({ settledItems: withFirst, busy: true, turnId: 'turn-1', queued: [] });
  assert.deepEqual(
    pane.view.optimisticPrompts.map((item) => item.id),
    ['sub-m2']
  );
  assert.deepEqual(
    pane.view.steerItems.map((item) => item.id),
    ['sub-m2']
  );

  // Second durable user row lands: sub-m2 settles cleanly with zero flicker.
  await pane.show({
    settledItems: [...withFirst, { kind: 'user', id: 'sub-m2', text: 'second steer', steered: true }],
    busy: true,
    turnId: 'turn-1',
    queued: [],
  });
  assert.deepEqual(pane.view.optimisticPrompts, []);
  assert.deepEqual(pane.view.steerItems, []);
});

test('r2 probe 3: phone follower replayPending intermediate idle frame does not prematurely drop un-echoed accepted steer', async (t) => {
  const { root } = mountDom(t);
  const threadId = 't-phone-replay-pending';
  defaultSessionLaneStore.clear();
  t.after(() => defaultSessionLaneStore.clear());

  const row = (id) => ({
    id,
    preview: '',
    title: 'Phone replay pending',
    updatedAt: 1,
    messageCount: 1,
    cwd: '/w',
    classification: {},
    projectPath: null,
  });
  const baseWireItems = [{ id: 'u1', type: 'userMessage', content: [{ type: 'text', text: 'first prompt' }] }];
  const net = new MockNetwork();
  let conn = null;
  let resumeCount = 0;
  let resumeMode = 'snapshot';
  const serve = (request, activeConn) => {
    if (request.method === 'thread/resume') {
      resumeCount += 1;
      if (resumeMode === 'snapshot') {
        activeConn.serverSend({
          id: request.id,
          result: {
            thread: row(threadId),
            subscription: { id: `sub-${resumeCount}`, mode: 'snapshot', epoch: 'e1', startSeq: 1 },
          },
        });
        activeConn.serverSend({
          method: 'thread/snapshot',
          params: {
            thread: row(threadId),
            items: baseWireItems,
            state: { title: 'Phone replay pending', runtime: { busy: true, turnId: 'turn-1' }, queued: [] },
            hasOlder: false,
          },
          feed: { id: threadId, epoch: 'e1', seq: 1 },
        });
        return;
      }
      if (resumeMode === 'replay-keep') {
        // Boundary is seq 24 (liveSeq - 1). Send only seq 21..22 first (historical idle frame while replayPending === true).
        activeConn.serverSend({
          id: request.id,
          result: {
            thread: row(threadId),
            subscription: { id: `sub-${resumeCount}`, mode: 'replay', epoch: 'e1', startSeq: 21, liveSeq: 25 },
          },
        });
        activeConn.serverSend({
          method: 'thread/runtime/updated',
          params: { threadId, value: { busy: false, turnId: '' } },
          feed: { id: threadId, epoch: 'e1', seq: 21 },
        });
        activeConn.serverSend({
          method: 'thread/frame',
          params: { threadId, structureChanged: false },
          feed: { id: threadId, epoch: 'e1', seq: 22 },
        });
        return;
      }
      // Second replay: completes without the prompt in queued or items -> must release zombie at replayComplete.
      activeConn.serverSend({
        id: request.id,
        result: {
          thread: row(threadId),
          subscription: { id: `sub-${resumeCount}`, mode: 'replay', epoch: 'e1', startSeq: 26, liveSeq: 28 },
        },
      });
      activeConn.serverSend({
        method: 'thread/queue/changed',
        params: { threadId, queued: [] },
        feed: { id: threadId, epoch: 'e1', seq: 26 },
      });
      activeConn.serverSend({
        method: 'thread/frame',
        params: { threadId, structureChanged: false },
        feed: { id: threadId, epoch: 'e1', seq: 27 },
      });
      return;
    }
    if (request.id !== undefined) activeConn.serverSend({ id: request.id, result: {} });
  };
  const acceptNext = async () => {
    const nextConn = await net.accept();
    const init = JSON.parse(await nextConn.nextSent());
    nextConn.serverSend({ id: init.id, result: { ...protocolOptions.initializeResult, serverInstanceId: 's1' } });
    await nextConn.nextSent();
    void (async () => {
      for (;;) {
        let raw;
        try {
          raw = await nextConn.nextSent();
        } catch {
          return;
        }
        serve(JSON.parse(raw), nextConn);
      }
    })();
    return nextConn;
  };
  const connecting = connect({
    target: { id: 'local' },
    connector: net,
    clientInfo: protocolOptions.clientInfo,
    capabilities: protocolOptions.capabilities,
    threadReducer: sessionReducer,
    clock: { sleep: () => Promise.resolve() },
    random: () => 0,
  });
  conn = await acceptNext();
  const client = await connecting;
  t.after(() => client.close());

  const updates = [];
  const follower = followSessionStates(client, {
    publish: (update) => {
      updates.push(update);
      defaultSessionLaneStore.apply(update);
    },
    decorate: (state) => state,
    stateOf: (id) => sessionStateOf(client, id),
  });
  t.after(() => follower.stop());

  let hostResolve = null;
  let latestSubmission = null;
  function Pane({ snapshot }) {
    latestSubmission = useConversationSubmission(
      {
        snapshot,
        routeSnapshot: snapshot,
        sessionAddress: null,
        selectedSessionId: threadId,
        submit: () =>
          new Promise((resolve) => {
            hostResolve = resolve;
          }),
        invokeResult: (action) => action(),
        applySnapshot: () => {},
        onNewTask: () => {},
        onResumeSession: () => {},
        onOpenSessions: () => {},
        onOpenProjects: () => {},
        onOpenSettings: () => {},
        onOpenCommandSurface: () => {},
        onClearToNewTask: () => {},
        onInheritSession: async () => false,
      },
      {
        draftMode: false,
        settledItems: snapshot.items ?? [],
        transcriptSessionKey: threadId,
        promotedOwnDraft: { current: false },
        routeSessionIdRef: { current: threadId },
        armFollow: () => {},
        resetTranscriptToLive: () => {},
        suppressDraftSubmitPaintHandoff: { current: false },
      }
    );
    return null;
  }

  const waitForUpdates = async (count) => {
    await act(async () => {
      for (let i = 0; i < 100 && updates.length < count; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    });
    assert.ok(updates.length >= count, `expected at least ${count} updates, got ${updates.length}`);
  };

  await act(async () => {
    await client.resumeThread(threadId, { lastItems: 40 });
  });
  await waitForUpdates(1);
  const snap1 = updates.at(-1).snapshot;
  await act(async () => root.render(React.createElement(Pane, { snapshot: snap1 })));

  // Submit & accept a steer; queue echo has not arrived yet before disconnect.
  let sending;
  await act(async () => {
    sending = latestSubmission.actions.composerSubmit('survives replay idle frame', { id: 'sub-replay-keep' });
  });
  await act(async () => {
    hostResolve(true);
    await sending;
  });
  assert.equal(latestSubmission.steerItems.length, 1);
  assert.equal(latestSubmission.steerItems[0].steerLocal, true);

  // Reconnect in replay mode: seq 21..22 publish an intermediate historical idle frame while replayPending === true.
  resumeMode = 'replay-keep';
  const countBeforeReplay = updates.length;
  await act(async () => {
    conn.serverClose(1006);
    conn = await acceptNext();
  });
  await waitForUpdates(countBeforeReplay + 1);
  const snapMid = updates.at(-1).snapshot;
  assert.equal(snapMid.replayPending, true, 'intermediate replay frame is marked replayPending: true');
  assert.equal(snapMid.busy, false, 'intermediate replay frame reflects historical idle state');
  assert.deepEqual(snapMid.queued, []);
  await act(async () => root.render(React.createElement(Pane, { snapshot: snapMid })));
  assert.equal(
    latestSubmission.steerItems.length,
    1,
    'intermediate replayPending idle frame does NOT prematurely drop accepted steer'
  );

  // Replay finishes with seq 23 (queue echo for our steer) and seq 24 (replayComplete: true).
  const countBeforeFinish = updates.length;
  await act(async () => {
    conn.serverSend({
      method: 'thread/queue/changed',
      params: {
        threadId,
        queued: [
          { id: 'q-keep', clientSubmissionId: 'sub-replay-keep', text: 'survives replay idle frame', enqueuedAt: 10 },
        ],
      },
      feed: { id: threadId, epoch: 'e1', seq: 23 },
    });
    conn.serverSend({
      method: 'thread/frame',
      params: { threadId, structureChanged: false },
      feed: { id: threadId, epoch: 'e1', seq: 24 },
    });
  });
  await waitForUpdates(countBeforeFinish + 1);
  const snapAfterReplay = updates.at(-1).snapshot;
  assert.equal(snapAfterReplay.replayPending, undefined, 'replayPending clears on replayComplete');
  assert.ok(snapAfterReplay.snapshotRevision > snap1.snapshotRevision, 'snapshotRevision advances on replayComplete');
  await act(async () => root.render(React.createElement(Pane, { snapshot: snapAfterReplay })));
  assert.equal(latestSubmission.steerItems.length, 1);
  assert.equal(latestSubmission.steerItems[0].id, 'sub-replay-keep');
  assert.equal(latestSubmission.steerItems[0].steerLocal, undefined);

  // Verify a cancelled prompt that is still absent when replayComplete fires IS released cleanly.
  await act(async () => {
    conn.serverSend({
      method: 'thread/runtime/updated',
      params: { threadId, value: { busy: true, turnId: 'turn-2' } },
      feed: { id: threadId, epoch: 'e1', seq: 25 },
    });
  });
  const busySnap = {
    ...snapAfterReplay,
    items: [
      ...(snapAfterReplay.items ?? []),
      { kind: 'user', id: 'sub-replay-keep', text: 'survives replay idle frame' },
    ],
    busy: true,
    turnId: 'turn-2',
    queued: [],
  };
  await act(async () => root.render(React.createElement(Pane, { snapshot: busySnap })));
  assert.deepEqual(latestSubmission.steerItems, []);

  let sendingGone;
  await act(async () => {
    sendingGone = latestSubmission.actions.composerSubmit('cancelled before replay end', { id: 'sub-replay-gone' });
  });
  await act(async () => {
    hostResolve(true);
    await sendingGone;
  });
  assert.equal(latestSubmission.steerItems.length, 1);

  resumeMode = 'replay-gone';
  const countBeforeGoneReplay = updates.length;
  await act(async () => {
    conn.serverClose(1006);
    conn = await acceptNext();
  });
  await waitForUpdates(countBeforeGoneReplay + 1);
  const snapGone = updates.at(-1).snapshot;
  assert.equal(snapGone.replayPending, undefined);
  assert.ok(snapGone.snapshotRevision > snapAfterReplay.snapshotRevision);
  await act(async () => root.render(React.createElement(Pane, { snapshot: snapGone })));
  assert.deepEqual(latestSubmission.steerItems, [], 'absent prompt releases once replayComplete clears replayPending');
});

test('r3 probe 1: post-compaction idle frames (with_facts) keep prompt visible until durable row or subsequent progress/restore', async (t) => {
  const pane = await mountPendingHarness(t, { queuedAtSubmit: true });
  await pane.show({
    settledItems: baseRunning,
    busy: true,
    compacting: false,
    queued: [],
    turnId: 'turn-1',
    snapshotRevision: 1,
  });

  // Case A: compaction clears commandBusy while core still reads input facts across multiple idle frames,
  // including a compaction boundary row appended while compacting: true -> bubble must NOT flicker away before durable row lands.
  const sending = await pane.submit('deferred after compact', 'sub-r3-compact-ok');
  await pane.accept(sending, true);
  await pane.show({
    settledItems: baseRunning,
    busy: true,
    compacting: false,
    turnId: 'turn-1',
    queued: [{ id: 'sub-r3-compact-ok', displayText: 'deferred after compact', submittedAt: 10 }],
    snapshotRevision: 1,
  });

  const ended = [...baseRunning, { kind: 'turndone', id: 'd1' }];
  await pane.show({ settledItems: ended, busy: false, compacting: true, turnId: '', queued: [], snapshotRevision: 1 });
  const withBoundary = [...ended, { kind: 'notice', id: 'compact-1', text: 'Compacted context' }];
  await pane.show({
    settledItems: withBoundary,
    busy: false,
    compacting: true,
    turnId: '',
    queued: [],
    snapshotRevision: 1,
  });
  assert.equal(pane.view.optimisticPrompts.length, 1);

  // Compaction finishes (compacting: false), two intervening idle frames arrive while core runs with_facts.
  await pane.show({
    settledItems: withBoundary,
    busy: false,
    compacting: false,
    turnId: '',
    queued: [],
    snapshotRevision: 1,
  });
  assert.equal(pane.view.optimisticPrompts.length, 1, 'held on first idle frame after compaction');
  assert.equal(pane.view.steerItems.length, 1);

  await pane.show({
    settledItems: withBoundary,
    busy: false,
    compacting: false,
    turnId: '',
    queued: [],
    snapshotRevision: 1,
  });
  assert.equal(pane.view.optimisticPrompts.length, 1, 'held on repeated idle frames during with_facts');

  // Durable user row + turn start land -> settles seamlessly.
  await pane.show({
    settledItems: [
      ...withBoundary,
      { kind: 'user', id: 'sub-r3-compact-ok', text: 'deferred after compact', fromQueue: true },
    ],
    busy: true,
    compacting: false,
    turnId: 'turn-2',
    queued: [],
    snapshotRevision: 1,
  });
  assert.deepEqual(pane.view.optimisticPrompts, []);
  assert.deepEqual(pane.view.steerItems, []);

  // Case B: post-compaction drain releases cleanly when a turn starts and finishes without the prompt (busy: true -> false).
  const sendingTurnEnd = await pane.submit('compact then turn ends', 'sub-r3-compact-turn-end');
  await pane.accept(sendingTurnEnd, true);
  await pane.show({
    settledItems: withBoundary,
    busy: true,
    compacting: false,
    turnId: '',
    queued: [{ id: 'sub-r3-compact-turn-end', displayText: 'compact then turn ends', submittedAt: 20 }],
    snapshotRevision: 2,
  });
  await pane.show({
    settledItems: withBoundary,
    busy: false,
    compacting: true,
    turnId: '',
    queued: [],
    snapshotRevision: 2,
  });
  await pane.show({
    settledItems: withBoundary,
    busy: false,
    compacting: false,
    turnId: '',
    queued: [],
    snapshotRevision: 2,
  });
  assert.equal(pane.view.optimisticPrompts.length, 1, 'held during post-compaction with_facts');
  await pane.show({
    settledItems: withBoundary,
    busy: true,
    compacting: false,
    turnId: '',
    queued: [],
    snapshotRevision: 2,
  });
  assert.equal(pane.view.optimisticPrompts.length, 1, 'held while started turn runs before user row');
  await pane.show({
    settledItems: withBoundary,
    busy: false,
    compacting: false,
    turnId: '',
    queued: [],
    snapshotRevision: 2,
  });
  assert.deepEqual(pane.view.optimisticPrompts, [], 'released once started turn ends without prompt');

  // Case C: post-compaction drain releases cleanly on authoritative snapshotRevision advance.
  const sendingRev = await pane.submit('compact then restore', 'sub-r3-compact-rev');
  await pane.accept(sendingRev, true);
  await pane.show({
    settledItems: withBoundary,
    busy: true,
    compacting: false,
    turnId: 'turn-3',
    queued: [{ id: 'sub-r3-compact-rev', displayText: 'compact then restore', submittedAt: 30 }],
    snapshotRevision: 3,
  });
  await pane.show({
    settledItems: withBoundary,
    busy: false,
    compacting: true,
    turnId: '',
    queued: [],
    snapshotRevision: 3,
  });
  await pane.show({
    settledItems: withBoundary,
    busy: false,
    compacting: false,
    turnId: '',
    queued: [],
    snapshotRevision: 3,
  });
  assert.equal(pane.view.optimisticPrompts.length, 1);
  await pane.show({
    settledItems: withBoundary,
    busy: false,
    compacting: false,
    turnId: '',
    queued: [],
    snapshotRevision: 4,
  });
  assert.deepEqual(pane.view.optimisticPrompts, [], 'released on authoritative snapshotRevision advance');
});

test('r3 probe 2: queue echo before RPC reply records baseline so hasOlder drain keeps bubbles and skipped-idle turn change releases zombie', async (t) => {
  // Case A: hasOlder: true — two prompts seen in queued before RPC replies resolve, both leave queued before replies arrive,
  // then replies resolve accepted: true before first durable user row. Both must stay visible (not misclassified as trimmed).
  const pane = await mountPendingHarness(t, { queuedAtSubmit: true });
  await pane.show({
    settledItems: baseRunning,
    busy: true,
    hasOlder: true,
    turnId: 'turn-1',
    queued: [],
    snapshotRevision: 1,
  });

  const sending1 = await pane.submit('pre-ack 1', 'sub-r3-pre1');
  const sending2 = await pane.submit('pre-ack 2', 'sub-r3-pre2');
  assert.equal(pane.view.optimisticPrompts[0].accepted, false);
  assert.equal(pane.view.optimisticPrompts[1].accepted, false);

  // Queue echoes both prompts while RPC replies are still pending.
  await pane.show({
    settledItems: baseRunning,
    busy: true,
    hasOlder: true,
    turnId: 'turn-1',
    queued: [
      { id: 'sub-r3-pre1', displayText: 'pre-ack 1', submittedAt: 10 },
      { id: 'sub-r3-pre2', displayText: 'pre-ack 2', submittedAt: 11 },
    ],
    snapshotRevision: 1,
  });

  // Both leave queued before either RPC reply arrives.
  await pane.show({
    settledItems: baseRunning,
    busy: true,
    hasOlder: true,
    turnId: 'turn-1',
    queued: [],
    snapshotRevision: 1,
  });
  assert.equal(pane.view.optimisticPrompts.length, 2);

  // Both RPC replies resolve accepted: true before the first durable user row lands.
  await pane.accept(sending1, true);
  await pane.accept(sending2, true);
  assert.deepEqual(
    pane.view.optimisticPrompts.map((item) => item.id),
    ['sub-r3-pre1', 'sub-r3-pre2'],
    'recorded pre-accept baseline prevents false trimmedPastBaseline drop on hasOlder: true'
  );

  // Durable rows land one by one.
  const withFirst = [...baseRunning, { kind: 'user', id: 'sub-r3-pre1', text: 'pre-ack 1', steered: true }];
  await pane.show({
    settledItems: withFirst,
    busy: true,
    hasOlder: true,
    turnId: 'turn-1',
    queued: [],
    snapshotRevision: 1,
  });
  assert.deepEqual(
    pane.view.optimisticPrompts.map((item) => item.id),
    ['sub-r3-pre2']
  );

  await pane.show({
    settledItems: [...withFirst, { kind: 'user', id: 'sub-r3-pre2', text: 'pre-ack 2', steered: true }],
    busy: true,
    hasOlder: true,
    turnId: 'turn-1',
    queued: [],
    snapshotRevision: 1,
  });
  assert.deepEqual(pane.view.optimisticPrompts, []);
  assert.deepEqual(pane.view.steerItems, []);

  // Case B: untrimmed transcript (hasOlder: false) — prompt seen in queued on turn-1 before RPC reply,
  // leaves queued and React skips the intervening idle frame directly to turn-2 -> recorded turnId baseline detects turnChanged.
  await pane.show({
    settledItems: baseRunning,
    busy: true,
    hasOlder: false,
    turnId: 'turn-1',
    queued: [],
    snapshotRevision: 2,
  });
  const sendingTurnSkip = await pane.submit('turn skip pre-ack', 'sub-r3-turn-skip');
  await pane.show({
    settledItems: baseRunning,
    busy: true,
    hasOlder: false,
    turnId: 'turn-1',
    queued: [{ id: 'sub-r3-turn-skip', displayText: 'turn skip pre-ack', submittedAt: 20 }],
    snapshotRevision: 2,
  });
  await pane.show({
    settledItems: baseRunning,
    busy: true,
    hasOlder: false,
    turnId: 'turn-2',
    queued: [],
    snapshotRevision: 2,
  });
  assert.equal(pane.view.optimisticPrompts.length, 1, 'still in flight until RPC reply resolves');

  await pane.accept(sendingTurnSkip, true);
  assert.deepEqual(
    pane.view.optimisticPrompts,
    [],
    'pre-accept baseline turnId detects turnChanged and releases zombie'
  );
  assert.deepEqual(pane.view.steerItems, []);
});

test('r3 probe 3: lost RPC reply after queue echo + remote cancel releases instead of sticking as Send again', async (t) => {
  const pane = await mountPendingHarness(t, { queuedAtSubmit: true });
  await pane.show({ settledItems: baseRunning, busy: true, turnId: 'turn-1', queued: [], snapshotRevision: 1 });

  // Case A: prompt observed in queued while RPC is in flight, cancelled remotely before RPC fails with opOutcomeUnknown (false).
  const sending = await pane.submit('cancelled before lost reply', 'sub-r3-lost-cancel');
  await pane.show({
    settledItems: baseRunning,
    busy: true,
    turnId: 'turn-1',
    queued: [{ id: 'sub-r3-lost-cancel', displayText: 'cancelled before lost reply', submittedAt: 10 }],
    snapshotRevision: 1,
  });

  // Remote device cancels it while RPC is still in flight.
  await pane.show({ settledItems: baseRunning, busy: true, turnId: 'turn-1', queued: [], snapshotRevision: 1 });
  assert.equal(pane.view.optimisticPrompts.length, 1);

  // RPC reply fails -> keepFailedSteer sets steer: 'failed'.
  await pane.accept(sending, false);
  assert.equal(pane.view.optimisticPrompts.length, 1, 'holds briefly during live busy-turn drain window');

  // Once the turn progresses past user rows / finishes idle / restores, the already-seen prompt releases cleanly (NOT permanent Send again).
  await pane.show({
    settledItems: [...baseRunning, { kind: 'assistant', id: 'a2', text: 'turn moved on' }],
    busy: true,
    turnId: 'turn-1',
    queued: [],
    snapshotRevision: 1,
  });
  assert.deepEqual(pane.view.optimisticPrompts, [], 'seen-in-queue failed steer releases when turn progresses');
  assert.deepEqual(pane.view.steerItems, []);

  // Case B: seen in queued, cancelled remotely, authoritative restore arrives before/after RPC failure -> releases immediately.
  const sendingRestore = await pane.submit('cancelled then restored', 'sub-r3-lost-restore');
  await pane.show({
    settledItems: baseRunning,
    busy: true,
    turnId: 'turn-1',
    queued: [{ id: 'sub-r3-lost-restore', displayText: 'cancelled then restored', submittedAt: 20 }],
    snapshotRevision: 2,
  });
  await pane.show({ settledItems: baseRunning, busy: true, turnId: 'turn-1', queued: [], snapshotRevision: 3 });
  await pane.accept(sendingRestore, false);
  assert.deepEqual(
    pane.view.optimisticPrompts,
    [],
    'seen-in-queue failed steer releases immediately after authoritative snapshot advance'
  );
  assert.deepEqual(pane.view.steerItems, []);

  // Case C: genuinely failed steer NEVER seen in queued or settledIds STILL stays as Send again across idle & restore.
  const sendingRealFail = await pane.submit('genuinely failed', 'sub-r3-real-fail');
  await pane.accept(sendingRealFail, false);
  await pane.show({ settledItems: baseRunning, busy: false, turnId: '', queued: [], snapshotRevision: 5 });
  assert.equal(pane.view.optimisticPrompts.length, 1);
  assert.equal(pane.view.optimisticPrompts[0].steer, 'failed');
  assert.equal(pane.view.steerItems.length, 1);
  assert.equal(pane.view.steerItems[0].steer, 'failed');
});
