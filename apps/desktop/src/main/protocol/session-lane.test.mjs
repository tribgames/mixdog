// The session lane (session-lane.ts) over a connection whose client is the library's own fold of real snapshots
// (`sessionReducer`): what a window is pushed of a followed thread, what a read of an unfollowed one publishes, and the
// catalog read page by page. The core's replies are the shapes a core on a converted profile answered (2026-11-13).
import assert from 'node:assert/strict';
import test from 'node:test';

import { sessionReducer } from '../../../../../packages/protocol-client/src/index.ts';
import { createSessionLane } from './session-lane.ts';

const snapshotOf = (threadId, items, hasOlder = false) => ({
  thread: { id: threadId, title: 'T', cwd: 'C:\\Project', classification: 'project', projectPath: 'C:\\Project' },
  state: {},
  items,
  hasOlder,
});
const userRow = (id, text) => ({ type: 'userMessage', id, content: [{ type: 'text', text }], meta: { at: 1 } });

/** A connection whose client folds what the test hands it: `follow` is the fold a `thread/resume` brings. */
function connection(answer = async () => ({})) {
  const calls = [];
  const threads = new Map();
  const sections = new Map();
  const storeListeners = new Set();
  const eventListeners = new Set();
  const replacedListeners = new Set();
  const change = (value) => {
    for (const listener of [...storeListeners]) listener(value);
  };
  const follow = (threadId, items, hasOlder) => {
    threads.set(threadId, {
      feed: { id: threadId, epoch: 'e', seq: 1 },
      order: 1,
      state: sessionReducer.initial(snapshotOf(threadId, items, hasOlder)),
    });
    change({ type: 'thread', threadId });
  };
  /** One thread feed notification folded, announced as the library announces every fold. */
  const notify = (threadId, method, params = {}) => {
    const held = threads.get(threadId);
    threads.set(threadId, {
      ...held,
      feed: { ...held.feed, seq: held.feed.seq + 1 },
      state: sessionReducer.apply(held.state, { method, params: { threadId, ...params } }),
    });
    change({ type: 'thread', threadId });
  };
  const requests = [];
  const client = {
    store: {
      thread: (threadId) => threads.get(threadId),
      section: (section, key = null) => sections.get(`${section}\0${key ?? ''}`),
      sections: () => [],
      subscribe: (listener) => {
        storeListeners.add(listener);
        return () => storeListeners.delete(listener);
      },
    },
    pendingServerRequests: () => requests,
  };
  const resumes = [];
  const protocol = {
    call: async (method, params) => {
      calls.push({ method, params });
      return answer(method, params);
    },
    client: () => client,
    whenSynced: async () => undefined,
    onEvent: (listener) => {
      eventListeners.add(listener);
      return () => eventListeners.delete(listener);
    },
    onStoreChange: (listener) => {
      storeListeners.add(listener);
      return () => storeListeners.delete(listener);
    },
    onReplaced: (listener) => {
      replacedListeners.add(listener);
      return () => replacedListeners.delete(listener);
    },
    resumeThread: async (threadId, window) => {
      resumes.push({ threadId, window });
      return {};
    },
  };
  return {
    protocol,
    calls,
    resumes,
    threads,
    sections,
    requests,
    change,
    follow,
    notify,
    replaced: () =>
      [...replacedListeners].forEach((listener) => {
        listener();
      }),
  };
}

const framesOf = (lane) => {
  const frames = [];
  lane.subscribeSessionStates((update) => frames.push(update));
  return frames;
};

test('a followed thread is pushed as its folded state with every fold, a live frame stamped with the remote session', () => {
  const core = connection();
  const lane = createSessionLane({ protocol: core.protocol });
  const frames = framesOf(lane);
  core.sections.set('hostState\0remoteSession', {
    section: 'hostState',
    key: 'remoteSession',
    revision: 1,
    value: { sessionId: 'sess_remote' },
  });
  core.follow('t1', [userRow('m1', 'hello')]);
  assert.equal(frames.length, 1);
  const [{ sessionId, snapshot, frameSource }] = frames;
  assert.deepEqual([sessionId, frameSource], ['t1', 'live']);
  assert.equal(snapshot.sessionId, 't1');
  assert.deepEqual(
    snapshot.items.map((row) => row.id),
    ['m1']
  );
  assert.equal(snapshot.remoteSessionId, 'sess_remote');
  core.follow('t1', [userRow('m1', 'hello'), userRow('m2', 'again')]);
  assert.deepEqual(
    frames[1].snapshot.items.map((row) => row.id),
    ['m1', 'm2']
  );
});

test('a streamed reply is projected once per core frame: its deltas fold unpublished, the frame publishes all they appended', () => {
  const core = connection();
  const lane = createSessionLane({ protocol: core.protocol });
  const frames = framesOf(lane);
  core.follow('t1', [userRow('m1', 'hello')]);
  frames.length = 0;
  for (const delta of ['Hel', 'lo\nwor', 'ld']) core.notify('t1', 'item/agentMessage/delta', { itemId: 'a1', delta });
  assert.equal(frames.length, 0, 'nothing is projected before the frame');
  core.notify('t1', 'thread/frame', { structureChanged: false });
  assert.equal(frames.length, 1);
  assert.equal(frames[0].snapshot.streamingTail.text, 'Hello\n');
  assert.deepEqual(frames[0].snapshot.streamingPartial, { id: 'a1', from: 6, text: 'world' });
  assert.deepEqual(
    frames[0].streamPosition,
    { epoch: 'e', seq: 5, order: 1 },
    'a publication names the feed position it was folded up to'
  );
  core.notify('t1', 'thread/frame', { structureChanged: false });
  assert.equal(frames.length, 2);
  assert.equal(
    frames[1].snapshot,
    frames[0].snapshot,
    'a frame that changed nothing the state shows is no new projection'
  );
  assert.deepEqual(
    frames[1].streamPosition,
    { epoch: 'e', seq: 6, order: 1 },
    'the state already published is handed on as current at the frame'
  );
  // Telemetry the core sends without a frame (phone_frame.rs: stage, model-request, tool-batch) leaves the fold as it was: the
  // state is current at the note's position too, so a call that read its position there is not stranded.
  core.notify('t1', 'thread/stage/updated', { value: { stage: 'requesting' } });
  assert.equal(frames.length, 3);
  assert.equal(frames[2].snapshot, frames[0].snapshot);
  assert.deepEqual(frames[2].streamPosition, { epoch: 'e', seq: 7, order: 1 });
  // A change of what the state shows is not current before its frame: a note after it hands nothing on.
  core.notify('t1', 'item/agentMessage/delta', { itemId: 'a1', delta: '!' });
  core.notify('t1', 'thread/modelRequest/updated', { value: {} });
  assert.equal(frames.length, 3);
  core.notify('t1', 'thread/frame', { structureChanged: false });
  assert.equal(frames.length, 4);
  assert.notEqual(frames[3].snapshot, frames[0].snapshot);
  assert.deepEqual(frames[3].streamPosition, { epoch: 'e', seq: 10, order: 1 });
});

test('an approval arriving or resolving between a delta and its frame is published as it lands', () => {
  const core = connection();
  const lane = createSessionLane({ protocol: core.protocol });
  const frames = framesOf(lane);
  core.follow('t1', []);
  frames.length = 0;
  core.notify('t1', 'item/agentMessage/delta', { itemId: 'a1', delta: 'Running ls' });
  assert.equal(frames.length, 0);
  core.requests.push({
    id: 7,
    method: 'item/tool/requestApproval',
    params: { threadId: 't1', order: 1, card: { kind: 'shell', command: 'ls' } },
  });
  core.change({ type: 'thread', threadId: 't1' });
  assert.equal(frames.length, 1, 'the approval does not wait for the frame');
  assert.deepEqual(frames[0].snapshot.toolApproval, { kind: 'shell', command: 'ls' });
  assert.equal(frames[0].snapshot.streamingPartial.text, 'Running ls', 'with what was folded before it');
  core.notify('t1', 'item/agentMessage/delta', { itemId: 'a1', delta: '…' });
  core.requests.length = 0;
  core.change({ type: 'thread', threadId: 't1' });
  assert.equal(frames.length, 2, 'its resolution does not wait either');
  assert.equal(frames[1].snapshot.toolApproval, null);
  core.notify('t1', 'thread/frame', { structureChanged: false });
  assert.equal(frames.length, 3);
  assert.equal(frames[2].snapshot, frames[1].snapshot, 'the frame brings nothing the last publication did not show');
});

test('a session read after a snapshot it was hidden for is republished on host changes', async () => {
  const core = connection();
  const lane = createSessionLane({ protocol: core.protocol });
  const frames = framesOf(lane);
  const interested = new Set();
  lane.setInterest((threadId) => interested.has(threadId));
  core.follow('t1', [userRow('m1', 'hello')]);
  assert.equal(frames.length, 0, 'hidden: its snapshot is not projected');
  interested.add('t1');
  assert.equal(await lane.prefetchSession('t1', 1, 'trace-1'), true);
  assert.equal(frames.length, 1);
  core.sections.set('hostShellJobs\0', { section: 'hostShellJobs', key: null, revision: 2, value: { count: 2 } });
  core.change({ type: 'section', section: 'hostShellJobs', key: null });
  assert.equal(frames.length, 2, 'the read made it a shown session');
  assert.deepEqual(frames[1].snapshot.hostShellJobs, { count: 2 });
});

test('nothing of a session is retained once its subscription ends, unsubscribed without a loss', {
  skip: typeof globalThis.gc !== 'function' && 'requires node --expose-gc',
}, async () => {
  const core = connection();
  const lane = createSessionLane({ protocol: core.protocol });
  core.follow('t1', [userRow('m1', 'x'.repeat(1 << 20))]);
  core.notify('t1', 'item/agentMessage/delta', { itemId: 'a1', delta: 'live text' });
  core.notify('t1', 'thread/frame', { structureChanged: false });
  const projectedFold = new WeakRef(core.threads.get('t1').state);
  const rows = new WeakRef(core.threads.get('t1').state.items);
  // The client's own unsubscribe: the fold leaves the store and no change is announced.
  core.threads.delete('t1');
  for (let i = 0; i < 5 && (projectedFold.deref() || rows.deref()); i++) {
    await new Promise((resolve) => setImmediate(resolve));
    globalThis.gc();
  }
  assert.equal(projectedFold.deref(), undefined, 'the projected fold is released');
  assert.equal(rows.deref(), undefined, 'the transcript rows are released');
  lane.dispose();
});

test('a hidden session unsubscribed without a loss leaves the shown sessions: host changes no longer visit it', () => {
  const core = connection();
  const lookups = [];
  const thread = core.protocol.client().store.thread;
  core.protocol.client().store.thread = (threadId) => {
    lookups.push(threadId);
    return thread(threadId);
  };
  const lane = createSessionLane({ protocol: core.protocol });
  const frames = framesOf(lane);
  const interested = new Set(['t1']);
  const asked = [];
  lane.setInterest((threadId) => {
    asked.push(threadId);
    return interested.has(threadId);
  });
  core.follow('t1', []);
  assert.equal(frames.length, 1);
  interested.delete('t1');
  core.threads.delete('t1');
  const hostChange = (count) => {
    core.sections.set('hostShellJobs\0', { section: 'hostShellJobs', key: null, revision: count, value: { count } });
    core.change({ type: 'section', section: 'hostShellJobs', key: null });
  };
  asked.length = 0;
  hostChange(1);
  lookups.length = 0;
  hostChange(2);
  assert.equal(frames.length, 1, 'neither host change publishes it');
  assert.deepEqual(asked, [], 'neither host change visits it for a publication');
  assert.deepEqual(
    lookups,
    [],
    'it left the shown sessions with its subscription: the second host change does not look it up'
  );
});

test("a change of a thread's server requests is published as it lands", () => {
  const core = connection();
  const lane = createSessionLane({ protocol: core.protocol });
  const frames = framesOf(lane);
  core.follow('t1', []);
  core.change({ type: 'thread', threadId: 't1' });
  assert.equal(frames.length, 1, 'the same fold and the same requests: nothing to publish');
  core.requests.push({
    id: 7,
    method: 'item/tool/requestApproval',
    params: { threadId: 't1', order: 1, card: { kind: 'shell', command: 'ls' } },
  });
  core.change({ type: 'thread', threadId: 't1' });
  assert.equal(frames.length, 2);
  assert.deepEqual(frames[1].snapshot.toolApproval, { kind: 'shell', command: 'ls' });
});

test('a thread no listener is interested in is not projected, on its own changes or on a host change', () => {
  const core = connection();
  const lane = createSessionLane({ protocol: core.protocol });
  const frames = framesOf(lane);
  const interested = new Set(['t1']);
  lane.setInterest((threadId) => interested.has(threadId));
  core.follow('t1', []);
  core.follow('t2', []);
  core.notify('t2', 'thread/frame', { structureChanged: false });
  assert.deepEqual(
    frames.map((frame) => frame.sessionId),
    ['t1']
  );
  core.sections.set('hostShellJobs\0', { section: 'hostShellJobs', key: null, revision: 2, value: { count: 1 } });
  core.change({ type: 'section', section: 'hostShellJobs', key: null });
  assert.deepEqual(
    frames.map((frame) => frame.sessionId),
    ['t1', 't1']
  );
  // Shown from now on: its next change publishes what it holds, and the frame after it holds nothing new.
  interested.add('t2');
  core.notify('t2', 'item/agentMessage/delta', { itemId: 'a1', delta: 'hi' });
  core.notify('t2', 'thread/frame', { structureChanged: false });
  assert.deepEqual(
    frames.map((frame) => frame.sessionId),
    ['t1', 't1', 't2', 't2']
  );
  assert.equal(frames[3].snapshot, frames[2].snapshot, 'the frame after it holds nothing new');
  assert.deepEqual(frames[2].snapshot.streamingPartial, {
    id: 'a1',
    from: 0,
    text: 'hi',
    tail: { id: 'a1', kind: 'assistant', streaming: true },
  });
});

test("the host's shell jobs and the remote session republish the threads shown; one no longer followed is let go", () => {
  const core = connection();
  const lane = createSessionLane({ protocol: core.protocol });
  const frames = framesOf(lane);
  core.follow('t1', []);
  core.follow('t2', []);
  core.threads.delete('t2');
  frames.length = 0;
  core.sections.set('hostShellJobs\0', { section: 'hostShellJobs', key: null, revision: 2, value: { count: 3 } });
  core.change({ type: 'section', section: 'hostShellJobs', key: null });
  assert.deepEqual(
    frames.map((frame) => frame.sessionId),
    ['t1']
  );
  assert.deepEqual(frames[0].snapshot.hostShellJobs, { count: 3 });
  core.change({ type: 'section', section: 'config', key: null });
  assert.equal(frames.length, 1, 'another section is not a state of the thread');
});

test('a subscription the core dropped ends the lane as gone', () => {
  const core = connection();
  const lane = createSessionLane({ protocol: core.protocol });
  const frames = framesOf(lane);
  core.follow('t1', []);
  core.threads.delete('t1');
  core.change({ type: 'subscription', feedId: 't1', state: 'lost' });
  assert.deepEqual(frames.at(-1), { sessionId: 't1', snapshot: null, frameSource: 'live', laneEnd: 'gone' });
  core.change({ type: 'subscription', feedId: 'app', state: 'lost' });
  assert.equal(frames.length, 2, 'the app feed is no thread');
});

test('a cold transcript preview reads stored items without following or publishing a live state', async () => {
  const core = connection(async () => ({
    data: [userRow('m1', 'first'), userRow('m2', 'last')],
    hasOlder: true,
  }));
  const lane = createSessionLane({ protocol: core.protocol });
  const frames = framesOf(lane);
  const preview = await lane.previewSession('t9');
  assert.deepEqual(
    core.calls.map(({ method }) => method),
    ['thread/items/list']
  );
  assert.deepEqual(core.resumes, []);
  assert.deepEqual(frames, []);
  assert.deepEqual(
    preview.items.map((row) => row.id),
    ['m1', 'm2']
  );
});

test('a read of a thread that is not followed is one thread/read, published as a replay under its trace id', async () => {
  const core = connection(async (method, params) => {
    assert.equal(method, 'thread/read');
    return snapshotOf(params.threadId, [userRow('m1', 'stored')], true);
  });
  const lane = createSessionLane({ protocol: core.protocol });
  const frames = framesOf(lane);
  assert.equal(await lane.prefetchSession('t9', 64, 'trace-1'), true);
  assert.deepEqual(core.calls, [{ method: 'thread/read', params: { threadId: 't9', window: { lastItems: 64 } } }]);
  assert.deepEqual(core.resumes, [], 'a read follows nothing');
  assert.equal(frames.length, 1);
  assert.deepEqual([frames[0].sessionId, frames[0].frameSource, frames[0].readTraceId], ['t9', 'replay', 'trace-1']);
  assert.deepEqual(
    frames[0].snapshot.items.map((row) => row.id),
    ['m1']
  );
});

test('a read of a followed thread republishes what is held; it asks the core again only for rows the window lacks', async () => {
  const core = connection();
  const lane = createSessionLane({ protocol: core.protocol });
  const frames = framesOf(lane);
  core.follow('t1', [userRow('m1', 'a'), userRow('m2', 'b')], true);
  frames.length = 0;

  assert.equal(await lane.prefetchSession('t1', 2, 'trace-held'), true);
  assert.deepEqual(core.resumes, [], 'the window holds the rows asked for');
  assert.deepEqual([frames[0].frameSource, frames[0].readTraceId], ['live', 'trace-held']);

  const grown = lane.prefetchSession('t1', 4, 'trace-grown');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(core.resumes, [{ threadId: 't1', window: { lastItems: 4 } }]);
  assert.equal(frames.length, 1, 'nothing is published before the larger window is folded');
  core.follow('t1', [userRow('m0', 'older'), userRow('m1', 'a'), userRow('m2', 'b')], false);
  assert.equal(await grown, true);
  assert.deepEqual([frames[1].readTraceId, frames[1].snapshot.items.length], ['trace-grown', 3]);

  assert.equal(await lane.prefetchSession('t1', 512), true);
  assert.equal(core.resumes.length, 1, 'the core has no older row: the held window is the whole transcript');
  assert.equal(frames[2].readTraceId, undefined);
});

test('the catalog is read to its last page and answered as sidebar rows; a reopened connection reads it again', async () => {
  const row = (id, activityAt) => ({
    id,
    preview: 'p',
    title: `T ${id}`,
    updatedAt: activityAt,
    messageCount: 2,
    cwd: 'C:\\Project\\mixdog',
    classification: 'project',
    projectPath: 'C:\\Project\\mixdog',
    activityAt,
  });
  const core = connection(async (method, params) => {
    assert.equal(method, 'thread/list');
    return params.cursor
      ? { data: [{ ...row('sess_b', 1), forkedFromId: 'sess_a' }] }
      : { data: [row('sess_a', 2)], nextCursor: 'c1' };
  });
  const lane = createSessionLane({ protocol: core.protocol });
  const pushed = [];
  lane.subscribeSessions((rows) => pushed.push(rows.map((session) => session.id)));
  const rows = await lane.listSessions();
  assert.deepEqual(
    core.calls.map(({ params }) => params.cursor),
    [undefined, 'c1']
  );
  assert.deepEqual(
    rows.map(({ id, title, classification, projectPath }) => ({ id, title, classification, projectPath })),
    [
      { id: 'sess_a', title: 'T sess_a', classification: 'project', projectPath: 'C:\\Project\\mixdog' },
      { id: 'sess_b', title: 'T sess_b', classification: 'project', projectPath: 'C:\\Project\\mixdog' },
    ]
  );
  assert.equal(rows[1].inheritedFromSessionId, 'sess_a');
  assert.deepEqual(pushed, [['sess_a', 'sess_b']], 'the read is also what the windows are pushed');
  core.calls.length = 0;
  core.replaced();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(core.calls.length, 2, 'the catalog of the connection that is open now');
});
