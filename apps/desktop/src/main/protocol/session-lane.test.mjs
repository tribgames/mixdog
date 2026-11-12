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
    threads.set(threadId, { feed: { id: threadId, epoch: 'e', seq: 1 }, state: sessionReducer.initial(snapshotOf(threadId, items, hasOlder)) });
    change({ type: 'thread', threadId });
  };
  const client = {
    store: {
      thread: (threadId) => threads.get(threadId),
      section: (section, key = null) => sections.get(`${section}\0${key ?? ''}`),
      sections: () => [],
      subscribe: (listener) => (storeListeners.add(listener), () => storeListeners.delete(listener)),
    },
    pendingServerRequests: () => [],
  };
  const resumes = [];
  const protocol = {
    call: async (method, params) => {
      calls.push({ method, params });
      return answer(method, params);
    },
    client: () => client,
    whenSynced: async () => undefined,
    onEvent: (listener) => (eventListeners.add(listener), () => eventListeners.delete(listener)),
    onStoreChange: (listener) => (storeListeners.add(listener), () => storeListeners.delete(listener)),
    onReplaced: (listener) => (replacedListeners.add(listener), () => replacedListeners.delete(listener)),
    resumeThread: async (threadId, window) => {
      resumes.push({ threadId, window });
      return {};
    },
  };
  return { protocol, calls, resumes, threads, sections, change, follow, replaced: () => [...replacedListeners].forEach((listener) => listener()) };
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
  core.sections.set('hostState\0remoteSession', { section: 'hostState', key: 'remoteSession', revision: 1, value: { sessionId: 'sess_remote' } });
  core.follow('t1', [userRow('m1', 'hello')]);
  assert.equal(frames.length, 1);
  const [{ sessionId, snapshot, frameSource }] = frames;
  assert.deepEqual([sessionId, frameSource], ['t1', 'live']);
  assert.equal(snapshot.sessionId, 't1');
  assert.deepEqual(snapshot.items.map((row) => row.id), ['m1']);
  assert.equal(snapshot.remoteSessionId, 'sess_remote');
  core.follow('t1', [userRow('m1', 'hello'), userRow('m2', 'again')]);
  assert.deepEqual(frames[1].snapshot.items.map((row) => row.id), ['m1', 'm2']);
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
  assert.deepEqual(frames.map((frame) => frame.sessionId), ['t1']);
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
  assert.deepEqual(frames[0].snapshot.items.map((row) => row.id), ['m1']);
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
  const row = (id, activityAt) => ({ id, preview: 'p', title: `T ${id}`, updatedAt: activityAt, messageCount: 2, cwd: 'C:\\Project\\mixdog', classification: 'project', projectPath: 'C:\\Project\\mixdog', activityAt });
  const core = connection(async (method, params) => {
    assert.equal(method, 'thread/list');
    return params.cursor ? { data: [{ ...row('sess_b', 1), forkedFromId: 'sess_a' }] } : { data: [row('sess_a', 2)], nextCursor: 'c1' };
  });
  const lane = createSessionLane({ protocol: core.protocol });
  const pushed = [];
  lane.subscribeSessions((rows) => pushed.push(rows.map((session) => session.id)));
  const rows = await lane.listSessions();
  assert.deepEqual(core.calls.map(({ params }) => params.cursor), [undefined, 'c1']);
  assert.deepEqual(rows.map(({ id, title, classification, projectPath }) => ({ id, title, classification, projectPath })), [
    { id: 'sess_a', title: 'T sess_a', classification: 'project', projectPath: 'C:\\Project\\mixdog' },
    { id: 'sess_b', title: 'T sess_b', classification: 'project', projectPath: 'C:\\Project\\mixdog' },
  ]);
  assert.equal(rows[1].inheritedFromSessionId, 'sess_a');
  assert.deepEqual(pushed, [['sess_a', 'sess_b']], 'the read is also what the windows are pushed');
  core.calls.length = 0;
  core.replaced();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(core.calls.length, 2, 'the catalog of the connection that is open now');
});

test('the whole conversation is every page of the items, oldest first', async () => {
  const pages = { undefined: { data: [userRow('m3', 'c')], hasOlder: true, nextCursor: 'm3' }, m3: { data: [userRow('m1', 'a'), userRow('m2', 'b')], hasOlder: false } };
  const core = connection(async (method, params) => {
    assert.equal(method, 'thread/items/list');
    return pages[params.cursor?.itemId];
  });
  // The chat adapter's shared readers are built on the client itself.
  Object.assign(core.protocol.client(), { call: core.protocol.call, respond: () => undefined, on: () => () => undefined, status: { state: 'ready' } });
  const lane = createSessionLane({ protocol: core.protocol });
  const history = await lane.readSessionHistory('t1');
  assert.equal(history.sessionId, 't1');
  assert.deepEqual(history.items.map((item) => item.id), ['m1', 'm2', 'm3']);
  assert.deepEqual(core.calls.map(({ params }) => params.cursor), [undefined, { type: 'item', itemId: 'm3' }]);
});
