// The session lane (session-lane.ts) over a connection whose client is the library's own fold of real snapshots
// (`sessionReducer`): what a window is pushed of a followed thread, what a read of an unfollowed one publishes, and the
// catalog read page by page. The core's replies are the shapes a core on a converted profile answered (2026-11-13).
import assert from 'node:assert/strict';
import test from 'node:test';

import { readFileSync } from 'node:fs';
import { sessionReducer } from '../../../../../packages/protocol-client/src/index.ts';
import { connect } from '../../../../../packages/protocol-client/src/client.ts';
import { MockNetwork } from '../../../../../packages/protocol-client/src/mock.ts';

const clientOptions = JSON.parse(
  readFileSync(new URL('../../../../../packages/protocol-client/conformance/options.json', import.meta.url), 'utf8')
);
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { installTestDom } from '../../renderer/test-support/test-dom.mjs';
import { useComposerUserMessages } from '../../renderer/conversation-pane-user-messages.ts';
import { useComposerMessageSelector } from '../../renderer/use-composer-message-selector.ts';
import { createSessionLaneStore, useSessionLane } from '../../renderer/session-lane-store.ts';
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

const replyRow = (id, text) => ({ type: 'agentMessage', id, text, meta: { status: 'completed', at: 2 } });
const toolRow = (id, name, input) => ({
  type: 'toolCall',
  id,
  name,
  input,
  output: `out ${id}`,
  meta: { status: 'completed', at: 3 },
});

/** A session of few prompts and many agents, far below the fold's bound (session-state.ts `FOLD_MAX_ITEMS`): each turn is
 *  one prompt, then `agents` agent results with a reply after every second one. */
function agentSession(turns = 3, agents = 60) {
  const items = [];
  for (let turn = 0; turn < turns; turn += 1) {
    items.push(userRow(`p${turn}`, `prompt ${turn}`));
    for (let agent = 0; agent < agents; agent += 1) {
      items.push(toolRow(`g${turn}-${agent}`, 'agent', { type: 'result', task_id: `task-${turn}-${agent}` }));
      if (agent % 2) items.push(replyRow(`a${turn}-${agent}`, `reply ${turn}-${agent}`));
    }
  }
  return items;
}

/** The lane over `core`, its frames applied to a renderer lane store as the window applies them. */
function shownLane(core) {
  const lane = createSessionLane({ protocol: core.protocol });
  const store = createSessionLaneStore();
  lane.subscribeSessionStates((update) => store.apply(update));
  return { lane, store, rows: () => store.get('t1').items };
}

/** One item the core completes, and the frame that publishes it. */
const land = (core, item) => {
  core.notify('t1', 'item/completed', { item });
  core.notify('t1', 'thread/frame', { structureChanged: true });
};

/** The composer dock's wiring of the Esc Esc selector (conversation-pane-composer-dock.tsx, Composer.tsx) over the lane's
 *  settled rows. */
async function mountedSelector(t, store) {
  const { restore } = installTestDom(null, { jsdom: { url: 'http://localhost/' } });
  const root = createRoot(document.getElementById('root'));
  t.after(async () => {
    await act(async () => root.unmount());
    restore();
  });
  const dock = { selector: null, notices: [] };
  const Dock = () => {
    const snapshot = useSessionLane('t1', store);
    const userMessages = useComposerUserMessages(snapshot?.items ?? []);
    dock.selector = useComposerMessageSelector({
      userMessages,
      restoring: false,
      setRestoring: () => undefined,
      invokeCapability: async () => undefined,
      setDraft: () => undefined,
      textarea: { current: null },
      historyNavigation: { current: { index: -1, seed: '' } },
      showNotice: (message) => dock.notices.push(message),
    });
    return null;
  };
  await act(async () => root.render(React.createElement(Dock)));
  return dock;
}

test('an early prompt the core shows again changes once, in its place, and the rewind picker offers it once', async (t) => {
  const core = connection();
  const { store, rows } = shownLane(core);
  const items = agentSession();
  core.follow('t1', items);
  // Frames go on arriving for a long while before the amendment.
  for (let n = 0; n < 40; n += 1) land(core, replyRow(`late-${n}`, `late ${n}`));
  const before = rows();
  const at = before.findIndex((row) => row.id === 'p0');
  // A bot reacts to the first prompt, or a turn records the skills applied to it (handle.rs `amend_shown`).
  land(core, { ...items[0], content: [{ type: 'text', text: 'prompt 0 (amended)' }] });
  const after = rows();
  assert.equal(after.length, before.length, 'no row is added');
  assert.equal(after[at].text, 'prompt 0 (amended)');
  assert.deepEqual(
    after.flatMap((row, index) => (row === before[index] ? [] : [index])),
    [at],
    'the amended prompt is the only row that changed'
  );
  assert.equal(after.filter((row) => row.id === 'p0').length, 1);
  const dock = await mountedSelector(t, store);
  assert.deepEqual(
    dock.selector.messages.map((message) => [message.id, message.text]),
    [
      ['p0', 'prompt 0 (amended)'],
      ['p1', 'prompt 1'],
      ['p2', 'prompt 2'],
    ]
  );
  // The frames after it are carried on as before.
  land(core, replyRow('after', 'after'));
  const next = rows();
  assert.equal(next.length, after.length + 1);
  for (const [index, row] of after.entries()) assert.equal(next[index], row);
});

test('a frame leaves a reader above the tail and its selection where they are, while another pane follows', async (t) => {
  const core = connection();
  const { store, rows } = shownLane(core);
  const items = agentSession();
  core.follow('t1', items);
  const { restore } = installTestDom(null, { jsdom: { url: 'http://localhost/' } });
  const root = createRoot(document.getElementById('root'));
  // The store tells a pane of a frame on the next animation frame.
  const painted = [];
  const priorFrame = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = (callback) => painted.push(callback);
  t.after(async () => {
    await act(async () => root.unmount());
    globalThis.requestAnimationFrame = priorFrame;
    restore();
  });
  // Two panes of the session: each renders the lane's rows, keyed as the transcript keys them.
  const Pane = ({ name }) => {
    const snapshot = useSessionLane('t1', store);
    return React.createElement(
      'section',
      { id: name },
      (snapshot?.items ?? []).map((row) =>
        React.createElement('p', { key: row.id, 'data-row': row.id }, row.text ?? row.kind)
      )
    );
  };
  await act(async () =>
    root.render(
      React.createElement(
        React.Fragment,
        null,
        React.createElement(Pane, { name: 'following' }),
        React.createElement(Pane, { name: 'reading' })
      )
    )
  );
  const reading = document.getElementById('reading');
  const shown = () => [...reading.children];
  // The reader selects from the first prompt down into the second turn.
  const held = shown();
  const first = held.find((node) => node.dataset.row === 'p0');
  const last = held.find((node) => node.dataset.row === 'a1-1');
  const range = document.createRange();
  range.setStart(first.firstChild, 0);
  range.setEnd(last.firstChild, last.firstChild.length);
  const selection = window.getSelection();
  selection.addRange(range);
  const copied = selection.toString();
  assert.ok(copied.startsWith('prompt 0') && copied.endsWith('reply 1-1'));
  const settled = () =>
    act(async () => {
      for (const callback of painted.splice(0)) callback(0);
    });
  const unmoved = (message) => {
    const now = shown();
    for (const [index, node] of held.entries()) assert.equal(now[index], node, message);
    assert.equal(selection.toString(), copied, message);
    assert.equal(document.getElementById('following').children.length, now.length);
  };
  // Frames of a session that goes on.
  for (let n = 0; n < 8; n += 1) land(core, replyRow(`late-${n}`, `late ${n}`));
  await settled();
  assert.equal(shown().length, held.length + 8);
  unmoved('rows that land below leave every row above as the node it was');
  // The connection is followed again from a shorter tail window.
  const grown = [...items, ...Array.from({ length: 8 }, (_, n) => replyRow(`late-${n}`, `late ${n}`))];
  core.follow('t1', grown.slice(-32), true);
  land(core, replyRow('resumed', 'resumed'));
  await settled();
  assert.equal(rows().at(-1).id, 'resumed');
  assert.equal(shown().length, held.length + 9);
  unmoved('a shorter window keeps the rows the reader is among');
});

test('a tool run that goes on in the next frame stays one card, and the rows before it are the rows held', () => {
  const core = connection();
  const { rows } = shownLane(core);
  const read = (n) => toolRow(`r${n}`, 'read', { file_path: `file-${n}.ts` });
  core.follow('t1', [...agentSession(), userRow('p-last', 'read them'), read(0), read(1)]);
  const before = rows();
  const card = before.at(-1);
  assert.deepEqual([card.aggregate, card.count], [true, 2]);
  land(core, read(2));
  land(core, read(3));
  const after = rows();
  assert.equal(after.length, before.length, 'the run is one card across the frames');
  assert.deepEqual([after.at(-1).aggregate, after.at(-1).count], [true, 4]);
  for (const [index, row] of before.slice(0, -1).entries()) assert.equal(after[index], row);
  // A row that is no tool ends the run: the next reads are another card.
  land(core, replyRow('done', 'done'));
  land(core, read(4));
  land(core, read(5));
  const next = rows();
  assert.deepEqual(
    next.slice(-3).map((row) => [row.kind, row.count ?? null]),
    [
      ['tool', 4],
      ['assistant', null],
      ['tool', 2],
    ]
  );
  for (const [index, row] of after.slice(0, -1).entries()) assert.equal(next[index], row);
});

test('a narrower replay keeps the rows above it; a rewind the core states takes the rows it rewound', () => {
  const core = connection();
  const { rows } = shownLane(core);
  const items = agentSession();
  core.follow('t1', items);
  const whole = rows();
  // A replay of the last rows alone: the lane holds what it showed above them.
  core.follow('t1', items.slice(-32), true);
  assert.deepEqual(
    rows().map((row) => row.id),
    whole.map((row) => row.id)
  );
  for (const [index, row] of whole.entries()) assert.equal(rows()[index], row);
  land(core, replyRow('next', 'next'));
  assert.equal(rows().length, whole.length + 1);
  for (const [index, row] of whole.entries()) assert.equal(rows()[index], row);
  // The core rewinds to a prompt of the window it holds: the rows after it are gone, here as there.
  core.follow('t1', [...items, replyRow('next', 'next')]);
  core.notify('t1', 'thread/historyReset', { fromItemId: 'p1', hasOlder: false });
  core.notify('t1', 'thread/frame', { structureChanged: true });
  const kept = whole.slice(0, whole.findIndex((row) => row.id === 'p1') + 1);
  assert.deepEqual(
    rows().map((row) => row.id),
    kept.map((row) => row.id),
    'no row the rewind took is kept above or below'
  );
  land(core, replyRow('again', 'again'));
  assert.deepEqual(
    rows().map((row) => row.id),
    [...kept.map((row) => row.id), 'again']
  );
});

test('Esc Esc offers nothing when the settled rows hold no prompt, and reads no history for one', async (t) => {
  const core = connection();
  const { store } = shownLane(core);
  // The tail window of a session whose prompts all lie above it.
  core.follow(
    't1',
    agentSession()
      .filter((item) => item.type !== 'userMessage')
      .slice(-32),
    true
  );
  const dock = await mountedSelector(t, store);
  assert.deepEqual(dock.selector.messages, []);
  core.calls.length = 0;
  act(() => dock.selector.openSelector());
  await act(async () => new Promise((resolve) => setImmediate(resolve)));
  assert.equal(dock.selector.open, false);
  assert.equal(dock.notices.length, 1);
  assert.deepEqual(core.calls, []);
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

test('a read of a followed thread grows its window in core items, and says false once nothing older joins it', async () => {
  const core = connection();
  const lane = createSessionLane({ protocol: core.protocol });
  framesOf(lane);
  const calls = (from, count) =>
    Array.from({ length: count }, (_, k) => ({
      type: 'toolCall',
      id: `c${from + k}`,
      name: 'read',
      input: { path: 'f' },
      output: 'ok',
      meta: { status: 'completed', at: 1 },
    }));
  const tick = () => new Promise((resolve) => setImmediate(resolve));
  // Fifty calls show as one card: a page of 64 rows is 64 core items past the 50 held, not 65 items.
  core.follow('t1', calls(150, 50), true);
  const grown = lane.prefetchSession('t1', 65);
  await tick();
  assert.deepEqual(core.resumes, [{ threadId: 't1', window: { lastItems: 114 } }]);
  core.follow('t1', calls(86, 114), true);
  assert.equal(await grown, true, 'the window begins at an older call');
  // The core's view ends at 200 items: the page brings the same start back.
  const ended = lane.prefetchSession('t1', 65);
  await tick();
  assert.deepEqual(core.resumes.at(-1).window, { lastItems: 178 });
  core.follow('t1', calls(86, 114), true);
  assert.equal(await ended, false, 'nothing older joined the window');
  assert.equal(await lane.prefetchSession('t1', 65), false);
  assert.equal(core.resumes.length, 2, 'a window the core sent short is not asked again');
});

/** The client's own account of a followed thread (`threadSubscription`), as the test sets it. */
function subscribed(core, state) {
  const client = core.protocol.client();
  client.threadSubscription = () => ({ followed: true, replayPending: false, ...state() });
  client.feedPosition = () => ({ epoch: 'e', seq: 1, order: 1 });
  return client;
}

/** A session lane over the library's own client on a mock transport: `conn` is the core's side of the connection. */
async function liveLane() {
  const net = new MockNetwork();
  const connecting = connect({
    target: { id: 'local' },
    connector: net,
    clientInfo: clientOptions.clientInfo,
    capabilities: clientOptions.capabilities,
    clock: { sleep: () => Promise.resolve() },
    random: () => 0,
    threadReducer: sessionReducer,
  });
  const conn = await net.accept();
  const init = JSON.parse(await conn.nextSent());
  conn.serverSend({ id: init.id, result: { ...clientOptions.initializeResult, serverInstanceId: 's1' } });
  await conn.nextSent();
  const client = await connecting;
  const lane = createSessionLane({
    protocol: {
      call: (method, params) => client.call(method, params),
      client: () => client,
      whenSynced: async () => undefined,
      onEvent: (listener) => client.on(listener),
      onStoreChange: (listener) => client.store.subscribe(listener),
      onReplaced: () => () => undefined,
      resumeThread: (threadId, window) => client.resumeThread(threadId, window),
    },
  });
  return { conn, client, lane };
}
const turn = () => new Promise((resolve) => setImmediate(resolve));

const resumesOf = (conn) =>
  conn.sent.map((text) => JSON.parse(text)).filter((request) => request.method === 'thread/resume');
const attachAnswer = (id, sub) => ({
  id,
  result: { subscription: { id: sub, epoch: 'e', startSeq: 2, liveSeq: 2, mode: 'snapshot' } },
});
const rows = (count) => Array.from({ length: count }, (_, k) => userRow(`m${k}`, `row ${k}`));

for (const [name, hasOlder] of [
  ['the history is exhausted: no growth', false],
  ['more is owed: one growth of the size asked', true],
]) {
  test(`a read for 50 rows during an attach for 32 sends nothing before the answer or the fold; ${name}`, async (t) => {
    const { conn, client, lane } = await liveLane();
    t.after(() => client.close());
    framesOf(lane);
    const attach = client.resumeThread('t1', { lastItems: 32 });
    const first = JSON.parse(await conn.nextSent());
    assert.deepEqual(first.params.window, { lastItems: 32 });

    let read;
    const reading = lane.prefetchSession('t1', 50, 'trace-50').then((value) => (read = value));
    await turn();
    assert.deepEqual(conn.sent, [], 'one attach on the wire before the answer');
    conn.serverSend(attachAnswer(first.id, 's1'));
    await attach;
    await turn();
    assert.deepEqual(conn.sent, [], 'and before the fold');
    assert.equal(read, undefined);

    conn.serverSend({
      method: 'thread/snapshot',
      params: snapshotOf('t1', rows(32), hasOlder),
      feed: { id: 't1', epoch: 'e', seq: 1 },
    });
    if (!hasOlder) {
      await reading;
      assert.equal(read, true, 'the thread starts inside the window: it answers as it is');
      assert.deepEqual(conn.sent, []);
      return;
    }
    const growth = JSON.parse(await conn.nextSent());
    assert.deepEqual([growth.method, growth.params.window], ['thread/resume', { lastItems: 50 }]);
    conn.serverSend(attachAnswer(growth.id, 's2'));
    await turn();
    assert.equal(read, undefined, 'the page is not its acknowledgement');
    conn.serverSend({
      method: 'thread/snapshot',
      params: snapshotOf('t1', rows(50), false),
      feed: { id: 't1', epoch: 'e', seq: 1 },
    });
    await reading;
    assert.equal(read, true);
    assert.deepEqual(resumesOf(conn), [], 'one growth');
  });
}

test('Retry ends the attach that is out as the loss of the thread and opens it again; what waited on the old one is refused', async (t) => {
  const { conn, client, lane } = await liveLane();
  t.after(() => client.close());
  const frames = framesOf(lane);
  const attach = client.resumeThread('t1', { lastItems: 32 });
  attach.catch(() => undefined);
  const first = JSON.parse(await conn.nextSent());
  const automatic = lane.prefetchSession('t1', undefined, 'trace-auto');
  automatic.catch(() => undefined);
  await turn();
  assert.deepEqual(conn.sent, [], 'the read on mount waits for the attach: one resume');

  const retried = lane.prefetchSession('t1', undefined, 'trace-retry', { retry: true });
  const second = JSON.parse(await conn.nextSent());
  assert.equal(second.method, 'thread/resume', 'Retry is a request of its own');
  assert.notEqual(second.id, first.id);
  assert.equal(second.params.resumeFrom, undefined);
  await assert.rejects(attach, 'the stalled attach ended as a loss');
  await assert.rejects(automatic, 'and the read that waited on it does not inherit the new open');

  conn.serverSend(attachAnswer(second.id, 's2'));
  // The stalled request is answered after all: nothing of it counts.
  conn.serverSend(attachAnswer(first.id, 's1'));
  conn.serverSend({
    method: 'thread/snapshot',
    params: snapshotOf('t1', [userRow('m1', 'hello')]),
    feed: { id: 't1', epoch: 'e', seq: 1 },
  });
  assert.equal(await retried, true);
  assert.deepEqual(
    frames
      .filter((frame) => frame.snapshot)
      .map((frame) => [frame.frameSource, frame.snapshot.items.map((row) => row.id), frame.readTraceId]),
    [
      ['live', ['m1'], undefined],
      ['live', ['m1'], 'trace-retry'],
    ],
    'the fold of the new snapshot, then the answer to the read that asked'
  );
  assert.deepEqual(conn.sent, [], 'two resumes in all');
});

test('a read whose wait ended because the thread was let go ends there: no read is sent and nothing is published', async (t) => {
  const { conn, client, lane } = await liveLane();
  t.after(() => client.close());
  const frames = framesOf(lane);
  const attach = client.resumeThread('t1', { lastItems: 32 });
  const first = JSON.parse(await conn.nextSent());
  conn.serverSend(attachAnswer(first.id, 's1'));
  await attach;
  const reading = lane.prefetchSession('t1', undefined, 'trace-left');
  await turn();
  void client.unsubscribeThread('t1').catch(() => undefined);
  await reading;
  await turn();
  assert.deepEqual(
    conn.sent.map((text) => JSON.parse(text).method),
    ['thread/unsubscribe'],
    'the conversation that was left is not read'
  );
  assert.deepEqual(frames, []);
});

test('a Retry the core refuses is not an accepted read', async (t) => {
  const { conn, client, lane } = await liveLane();
  t.after(() => client.close());
  client.resumeThread('t1', { lastItems: 32 }).catch(() => undefined);
  await conn.nextSent();
  const retried = lane.prefetchSession('t1', undefined, undefined, { retry: true });
  const second = JSON.parse(await conn.nextSent());
  conn.serverSend({
    id: second.id,
    error: { code: -32000, message: 'thread missing', data: { reason: 'threadNotFound' } },
  });
  await assert.rejects(retried);
});

test('a page waits for the snapshot it asked for: an ordinary frame folded meanwhile is not its outcome', async () => {
  const core = connection();
  const lane = createSessionLane({ protocol: core.protocol });
  framesOf(lane);
  core.follow('t1', [userRow('m1', 'a'), userRow('m2', 'b')], true);
  let paged;
  const page = lane.prefetchSession('t1', 4).then((value) => (paged = value));
  await turn();
  assert.deepEqual(core.resumes, [{ threadId: 't1', window: { lastItems: 4 } }]);
  // The resume is acknowledged and the thread folds an event of its own: the larger snapshot is still out.
  core.notify('t1', 'thread/frame', { structureChanged: false });
  await turn();
  assert.equal(paged, undefined, 'neither landed nor exhausted yet');
  core.follow('t1', [userRow('m0', 'older'), userRow('m1', 'a'), userRow('m2', 'b')], false);
  await page;
  assert.equal(paged, true);
});

test('a read of the state answers that it was read, whatever its window can still page', async () => {
  const core = connection();
  const lane = createSessionLane({ protocol: core.protocol });
  const frames = framesOf(lane);
  const calls = (from, count) =>
    Array.from({ length: count }, (_, k) => ({
      type: 'toolCall',
      id: `c${from + k}`,
      name: 'read',
      input: { path: 'f' },
      output: 'ok',
      meta: { status: 'completed', at: 1 },
    }));
  // A window the core sent short of what its page asked for: nothing older can join it.
  core.follow('t1', calls(150, 50), true);
  assert.equal(await lane.prefetchSession('t1'), true);
  assert.deepEqual(core.resumes, [], 'a tail of fifty calls shows one card, and the state read still sends no resume');
  const grown = lane.prefetchSession('t1', 65);
  await turn();
  core.follow('t1', calls(86, 114), true);
  await grown;
  const ended = lane.prefetchSession('t1', 65);
  await turn();
  core.follow('t1', calls(86, 114), true);
  assert.equal(await ended, false);
  assert.equal(await lane.prefetchSession('t1', 65), false, 'a page says the window is exhausted');

  frames.length = 0;
  const resumes = core.resumes.length;
  assert.equal(await lane.prefetchSession('t1', undefined, 'trace-state'), true, 'the state was read');
  assert.equal(core.resumes.length, resumes);
  assert.deepEqual(
    frames.map((frame) => [frame.frameSource, frame.readTraceId]),
    [['live', 'trace-state']]
  );
});

test('a restore over a state the window shows marks it as owed, apart from the transcript, until the restored state is published', async () => {
  const core = connection();
  const listeners = new Set();
  core.protocol.onEvent = (listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  let restoring = false;
  subscribed(core, () => ({ restoring, snapshotPending: restoring }));
  const lane = createSessionLane({ protocol: core.protocol });
  const frames = framesOf(lane);
  core.follow('t1', [userRow('m1', 'hello')]);
  assert.deepEqual([frames.length, frames[0].frameSource, frames[0].snapshot.restoreOwed], [1, 'live', undefined]);

  // The connection is back and the client's restore of the thread is out, unanswered.
  restoring = true;
  for (const listener of [...listeners]) listener({ type: 'status', status: { state: 'ready' } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(frames.length, 2, 'the window is told what it shows is owed again');
  assert.deepEqual(
    [
      frames[1].frameSource,
      frames[1].snapshot.restoreOwed,
      frames[1].snapshot.transcriptPreview,
      frames[1].snapshot.items.map((row) => row.id),
    ],
    ['replay', true, undefined, ['m1']]
  );

  restoring = false;
  core.change({ type: 'subscription', feedId: 't1', state: 'restored' });
  assert.equal(frames.length, 3);
  assert.deepEqual([frames[2].frameSource, frames[2].snapshot.restoreOwed], ['live', undefined]);
  lane.dispose();
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
