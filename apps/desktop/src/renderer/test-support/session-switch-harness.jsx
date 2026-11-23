// Browser entry of the session-switch rig (session-switch-rig.mjs): the real PaneWorkspace and PaneConversation over the
// real lane store, fed by a core stand-in that folds its threads with the protocol client's own reducer. A thread is
// followed only while a pane shows it, and is resumed with the default tail, as service-route.ts does.
import { parseMarkdownToHast } from '../markdown-ast';
import { resetTurnChangesCache } from '../turn-changes-model';
import { _failMarkdownParsersForTest } from '../markdown-worker-client';
import { _runIdleReclaimForTest } from '../idle-reclaim';
import React, { useState } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { PaneConversation } from '../app-snapshot-views';
import { PaneWorkspace } from '../PaneWorkspace';
import { defaultSessionLaneStore } from '../session-lane-store';
import {
  activateTabInPaneLeaf,
  closeTabInPaneLeaf,
  createPaneLeaf,
  findPaneLeaf,
  openTabInPaneLeaf,
  paneLeaves,
  splitPaneLeaf,
} from '../pane-layout';
import { navigationKey } from '../text-format';
import { DESKTOP_TRANSCRIPT_TAIL_ITEMS } from '../../shared/desktop-transcript-limits';
import { desktopSessionState, sessionReducer, windowWant } from '../../../../../packages/protocol-client/src/index.ts';
import { installChatTextSize, setChatTextSize } from '../chat-text-size-preference';
import { requestTranscriptJump } from '../transcript-jump';
import { readerPlace, readerPlaceCount } from '../transcript-list-reader-place';
import { transcriptVirtualCacheStats } from '../transcript-virtual-cache';

const pos = (id) => `h1:0:${id}`;
const cont = (position) => ({ kind: 'continuation', position });
const END = { kind: 'end' };
const WORDS = 'transcript rows wrap differently at every width so a row that moved is visible ';
const stored = (item, record) => ({ ...item, meta: { ...item.meta, ext: { ...item.meta?.ext, historyPosition: pos(record) } } });

// ───────────────────────────── the core stand-in ─────────────────────────────

const threads = new Map();
const listeners = new Set();
let delivery = 'now';
const pending = [];
/** Every window move a pane asked, in order. */
const moves = [];
/** The connection is down: a call fails, and nothing is told. */
let cut = false;
let grantsAnything = false;
/** The moves asked of the core and not answered. */
const outstanding = new Set();
let stamp = 0;

function thread(id) {
  let t = threads.get(id);
  if (!t) {
    t = { id, records: [], loose: [], live: null, runtime: { busy: false }, requests: [], sub: null, turn: 0, resumes: 0 };
    threads.set(id, t);
  }
  return t;
}

function emit(update) {
  for (const listener of [...listeners]) listener(update);
}

function publish(t) {
  if (!t.sub || t.sub.restoring) return;
  const snapshot = desktopSessionState(t.sub.fold, t.requests);
  if (t.sub.published?.fold === t.sub.fold && t.sub.published.requests === t.requests.length) return;
  t.sub.published = { fold: t.sub.fold, requests: t.requests.length };
  emit({ sessionId: t.id, snapshot, frameSource: 'live', streamPosition: { epoch: `e${t.resumes}`, seq: ++stamp, order: stamp } });
}

/** Folds notifications of a followed thread and publishes the state they leave, as one frame does. */
function tell(t, ...notifications) {
  if (!t.sub) return;
  for (const [method, params] of notifications) {
    t.sub.fold = sessionReducer.apply(t.sub.fold, { method, params: { threadId: t.id, ...params } });
  }
  publish(t);
}

const unitOf = (record) => ({ position: pos(record.id), items: record.items, ordinal: record.ordinal });
/** A record stored: it takes the next ordinal of its thread's log, with room left as the records that show no row leave. */
function store(t, record) {
  t.ordinal = (t.ordinal ?? 0) + 1 + (t.records.length % 3);
  record.ordinal = t.ordinal;
  t.records.push(record);
}

function tailOf(t, lastItems) {
  let from = t.records.length;
  for (let items = 0; from > 0 && items < lastItems; from -= 1) items += t.records[from - 1].items.length;
  return from;
}

/** `thread/resume` with a `lastItems` window: the newest records, the rows no record holds, the reply being streamed. */
function resume(t) {
  t.resumes += 1;
  const from = tailOf(t, DESKTOP_TRANSCRIPT_TAIL_ITEMS);
  const tail = t.records.slice(from);
  const loose = [...t.loose];
  if (t.live) loose.push({ type: 'agentMessage', id: t.live.id, text: t.live.text, meta: { status: 'inProgress' } });
  const fold = sessionReducer.initial({
    thread: { id: t.id },
    state: { runtime: t.runtime, route: { provider: 'openai-oauth', model: 'test-model' } },
    items: loose,
    hasOlder: from > 0,
    window: {
      windowVersion: 1,
      lineage: 1,
      ranges: [{ id: 'tail', older: from > 0 && tail.length ? cont(pos(tail[0].id)) : END, newer: END }],
      added: [{ range: 'tail', units: tail.map(unitOf) }],
      followTail: true,
    },
  });
  t.sub = { fold, ranges: new Map([['tail', { older: from > 0 ? pos(tail[0]?.id) : null }]]), pages: 0, published: null };
  publish(t);
}

/** `thread/read` of a thread, published as the replay it is: its newest rows, no window (session-lane.ts `readOnce`). */
function readOnce(t) {
  const from = tailOf(t, DESKTOP_TRANSCRIPT_TAIL_ITEMS);
  const fold = sessionReducer.initial({
    thread: { id: t.id },
    state: { runtime: t.runtime, route: { provider: 'openai-oauth', model: 'test-model' } },
    items: t.records.slice(from).flatMap((record) => record.items),
    hasOlder: from > 0,
  });
  emit({ sessionId: t.id, snapshot: desktopSessionState(fold, t.requests), frameSource: 'replay' });
}

function deliver(work) {
  if (cut) return;
  if (delivery === 'now') work();
  else pending.push(work);
}

function setVisible(ids) {
  const wanted = new Set(ids);
  for (const t of threads.values()) {
    if (!wanted.has(t.id)) t.sub = null;
  }
  for (const id of wanted) {
    const t = thread(id);
    if (t.sub || t.resuming) continue;
    t.resuming = true;
    deliver(() => {
      t.resuming = false;
      if (currentVisible.has(id) && !t.sub) resume(t);
    });
  }
}
let currentVisible = new Set();

/** What `thread/window/set` answers a move of the window held now (`windowWant`): the ranges kept and the
 *  `thread/window/changed` that tells them. null: the window serves the move as it is; false: the core refuses it. */
function windowChange(t, to) {
  const held = t.sub.fold.held;
  const others = [...(t.sub.readers?.values() ?? [])].filter((stood) => stood !== to);
  const want = windowWant(held, to, others);
  if (!want) return null;
  const kept = new Map();
  const added = [];
  for (const range of want.ranges) {
    if (range.at === 'retain') {
      const known = t.sub.ranges.get(range.id);
      if (known) kept.set(range.id, known);
      continue;
    }
    const at = t.records.findIndex((record) => pos(record.id) === range.position);
    // A record the history no longer holds: the core refuses the change, or (`grantsAnything`) grants a window that
    // holds none of it.
    if (at < 0) {
      if (grantsAnything) continue;
      return false;
    }
    const last = t.records.length - 1;
    let from = at;
    let to = at;
    const before = range.at === 'before' ? range.rows : range.at === 'around' ? range.before : 0;
    const after = range.at === 'after' ? range.rows : range.at === 'around' ? range.after : 0;
    for (let rows = 0; from > 0 && rows < before; from -= 1) rows += t.records[from - 1].items.length;
    for (let rows = 0; to < last && rows < after; to += 1) rows += t.records[to + 1].items.length;
    const page = t.records.slice(from, to + 1);
    const rangeId = `q:${++t.sub.pages}`;
    kept.set(rangeId, { older: from > 0 ? pos(page[0].id) : null, newer: to < last ? pos(page.at(-1).id) : null });
    added.push({ range: rangeId, units: page.map(unitOf) });
  }
  // A want that follows the tail and retains no tail range: the tail is read anew from the newest records.
  if (want.followTail && !kept.has('tail')) {
    const from = tailOf(t, DESKTOP_TRANSCRIPT_TAIL_ITEMS);
    const tail = t.records.slice(from);
    kept.set('tail', { older: from > 0 ? pos(tail[0].id) : null });
    added.push({ range: 'tail', units: tail.map(unitOf) });
  }
  const removed = [...t.sub.ranges.keys()].filter((rangeId) => !kept.has(rangeId));
  const params = {
    subscriptionId: 'sub',
    requestId: `w${++stamp}`,
    windowVersion: held.version + 1,
    lineage: 1,
    atFeedPosition: { epoch: 'e', seq: stamp },
    ranges: [...kept].map(([rangeId, range]) => ({
      id: rangeId,
      older: range.older ? cont(range.older) : END,
      newer: range.newer ? cont(range.newer) : END,
    })),
    removed,
    added,
    followTail: true,
  };
  return { kept, params };
}

/** A pane's move of the window: one request of a thread is out at a time (protocol-client `moveTranscriptWindow`), and
 *  the window changes when it lands. */
function move(id, to) {
  const t = thread(id);
  const sub = t.sub;
  const held = sub?.fold.held;
  // Served: the window the move left holds rows of the record asked for (`at`), as the client's driver answers.
  const served = () => to.kind !== 'at' || (t.sub?.fold.held?.units.get(to.position)?.rows.length ?? 0) > 0;
  if (!held || sub.restoring) return Promise.resolve(false);
  // Where each reader stands, as the client's driver keeps it (protocol-client `moveTranscriptWindow`).
  sub.readers ??= new Map();
  if (to.kind === 'follow') sub.readers.delete(to.reader ?? '');
  else sub.readers.set(to.reader ?? '', to);
  return new Promise((resolve, reject) => {
    const run = () => {
      const now = t.sub?.fold.held;
      if (t.sub !== sub || !now) return resolve(false);
      const change = windowChange(t, to);
      if (!change) return resolve(change === null && served());
      sub.moving = true;
      const out = { reject };
      outstanding.add(out);
      deliver(() => {
        outstanding.delete(out);
        sub.moving = false;
        if (t.sub === sub && sub.fold.held === now) {
          sub.ranges = change.kept;
          tell(t, ['thread/window/changed', change.params]);
        }
        resolve(served());
        sub.queue?.shift()?.();
      });
    };
    if (!sub.moving) return run();
    // A record asked for while a move is out is read after it; any other move is served by the one that is out.
    if (to.kind !== 'at') return resolve(true);
    (sub.queue ??= []).push(run);
  });
}

const text = (seed, lines) => WORDS.repeat(1 + ((seed * 7) % lines));
const PICTURE =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="420" height="180"><rect width="420" height="180" fill="#888"/></svg>');
/** A reply whose box is not known from its text: a code block, a table and a picture. */
const richText = (seed) =>
  [
    `Reply ${seed}: ${text(seed + 3, 3)}`,
    '```ts\n' + Array.from({ length: 3 + (seed % 5) }, (_, n) => `const value${n} = compute(${n}, "${seed}");`).join('\n') + '\n```',
    '| name | value |\n| --- | --- |\n' + Array.from({ length: 2 + (seed % 3) }, (_, n) => `| row ${n} | ${seed * n} |`).join('\n'),
    `![chart](${PICTURE})`,
  ].join('\n\n');

const core = {
  threads,
  /** 'now': a resume or a page lands in the call that asks it; 'held': when `release` says. */
  hold() {
    delivery = 'held';
  },
  release(count = pending.length) {
    for (const work of pending.splice(0, count)) work();
    if (pending.length === 0) delivery = 'now';
  },
  pendingCount: () => pending.length,
  /** The connection drops: what was asked and not answered is never answered, and every call from now on fails. */
  cut() {
    cut = true;
    pending.length = 0;
    delivery = 'now';
    for (const out of [...outstanding]) out.reject(new Error('The core connection is not open.'));
    outstanding.clear();
  },
  /** The core grants a window around a record it does not hold, with no row of it. */
  grantAnything() {
    grantsAnything = true;
  },
  /** The thread is deleted: its lane ends for every pane, and it can no longer be read. */
  delete(id) {
    const t = thread(id);
    t.sub = null;
    t.deleted = true;
    emit({ sessionId: id, snapshot: null, frameSource: 'live', laneEnd: 'gone' });
  },
  resumes: (id) => thread(id).resumes,
  moves: () => moves,
  /** A read of the thread answered now, whatever follows it. */
  read: (id) => readOnce(thread(id)),
  /** The history lets go of a stored record (a rewind above it, a compaction). */
  forget(id, record) {
    const t = thread(id);
    t.records = t.records.filter((candidate) => candidate.id !== record);
  },
  followed: () => [...threads.values()].filter((t) => t.sub).map((t) => t.id),
  /** `turns` finished turns: a prompt, `tools` tool calls, a reply and its end. */
  seed(id, turns, options = {}) {
    for (let n = 0; n < turns; n += 1) core.turn(id, options);
  },
  /** `long`: a reply longer than a commit parses itself (markdown-worker-client.ts), so it is parsed off the page.
   *  `writes`: the turns (by number) that write a file, and the file each writes: a `write` call of the turn. */
  turn(id, { tools = 0, rich = false, long = false, writes = {} } = {}) {
    const n = core.prompt(id);
    for (let k = 0; k < tools; k += 1) core.tool(id, `${id}-t${n}.${k}`);
    // Several files are several calls in a row: the transcript shows them as one card.
    [writes[n] ?? []].flat().forEach((path, k) =>
      core.tool(id, `${id}-w${n}${k ? `.${k}` : ''}`, { name: 'write', input: { path, content: 'one\ntwo\nthree\n' } })
    );
    core.reply(id, long ? { body: `**Reply ${n}:** ${WORDS.repeat(1 + Math.ceil(4200 / WORDS.length))}\n\n- one\n- two` } : rich ? { body: richText(n) } : {});
    core.end(id);
    return n;
  },
  /** The core reads the followed tail anew from its newest records and lets the rest of the window go. */
  reread(id) {
    const t = thread(id);
    const held = t.sub?.fold.held;
    if (!held) return;
    const from = tailOf(t, DESKTOP_TRANSCRIPT_TAIL_ITEMS);
    const tail = t.records.slice(from);
    const removed = [...t.sub.ranges.keys()].filter((rangeId) => rangeId !== 'tail');
    t.sub.ranges = new Map([['tail', { older: from > 0 ? pos(tail[0].id) : null }]]);
    tell(t, [
      'thread/window/changed',
      {
        subscriptionId: 'sub',
        requestId: `c${++stamp}`,
        windowVersion: held.version + 1,
        lineage: 1,
        atFeedPosition: { epoch: 'e', seq: stamp },
        ranges: [{ id: 'tail', older: from > 0 ? cont(pos(tail[0].id)) : END, newer: END }],
        removed,
        added: [{ range: 'tail', units: tail.map(unitOf) }],
        followTail: true,
      },
    ]);
  },
  /** A stored reply is written again (its record replaced), as a compaction or an edit of the history does. */
  rewrite(id, record, body) {
    const t = thread(id);
    const at = t.records.findIndex((candidate) => candidate.id === record);
    const items = t.records[at].items.map((item) => (item.type === 'agentMessage' ? { ...item, text: body } : item));
    t.records[at] = { id: record, items, ordinal: t.records[at].ordinal };
    if (t.sub?.fold.held?.units.has(pos(record))) {
      tell(t, ['thread/transcript/changed', { lineage: 1, change: { op: 'replace', unit: unitOf(t.records[at]) } }]);
    }
  },
  /** The rows the core holds for the pane that follows the thread: the tail's stretch and the one apart from it. */
  heldRows(id) {
    const fold = thread(id).sub?.fold;
    if (!fold) return 0;
    const state = desktopSessionState(fold, []);
    return (state.items?.length ?? 0) + (state.transcriptViewItems?.length ?? 0);
  },
  /** A prompt is stored as it is sent, and its turn runs. */
  prompt(id) {
    const t = thread(id);
    const n = ++t.turn;
    const record = `${id}-u${n}`;
    const item = stored({ type: 'userMessage', id: record, content: [{ type: 'text', text: `Prompt ${n}: ${text(n, 2)}` }] }, record);
    store(t, { id: record, items: [item] });
    t.runtime = { ...t.runtime, busy: true };
    tell(
      t,
      ['thread/transcript/changed', { lineage: 1, change: { op: 'insert', unit: unitOf(t.records.at(-1)) } }],
      ['thread/runtime/updated', { value: t.runtime }],
      ['turn/started', { turnId: `turn${n}` }]
    );
    return n;
  },
  /** A tool call: shown running until `done`, then stored as a record. */
  tool(id, callId, { done = true, name = 'read', input = { path: 'src/app.ts' } } = {}) {
    const t = thread(id);
    const base = { type: 'toolCall', id: callId, name, input, run: { callId } };
    if (!t.loose.some((item) => item.id === callId)) {
      t.loose.push({ ...base, meta: { status: 'inProgress' } });
      tell(t, ['item/started', { turnId: `turn${t.turn}`, item: t.loose.at(-1) }]);
    }
    if (!done) return;
    t.loose = t.loose.filter((item) => item.id !== callId);
    const item = stored({ ...base, output: 'ok', meta: { status: 'completed' } }, callId);
    store(t, { id: callId, items: [item] });
    tell(t, ['thread/transcript/changed', { lineage: 1, change: { op: 'insert', unit: unitOf(t.records.at(-1)) } }]);
  },
  /** The reply starts streaming (a row no record holds). */
  stream(id, delta = '') {
    const t = thread(id);
    if (!t.live) {
      t.live = { id: `${id}-r${t.turn}`, text: '' };
      tell(t, [
        'item/started',
        { turnId: `turn${t.turn}`, item: { type: 'agentMessage', id: t.live.id, text: '', meta: { status: 'inProgress' } } },
      ]);
    }
    if (delta) {
      t.live.text += delta;
      tell(t, ['item/agentMessage/delta', { itemId: t.live.id, delta }]);
    }
  },
  /** The reply is stored. `storedId`: the id its record carries, when it is not the one it streamed under. */
  reply(id, { storedId, body: given } = {}) {
    const t = thread(id);
    const live = t.live;
    const record = storedId ?? live?.id ?? `${id}-r${t.turn}`;
    const body = live?.text || given || `Reply ${t.turn}: ${text(t.turn + 3, 5)}`;
    t.live = null;
    const item = stored({ type: 'agentMessage', id: record, text: body }, record);
    store(t, { id: record, items: [item] });
    tell(t, ['thread/transcript/changed', { lineage: 1, change: { op: 'insert', unit: unitOf(t.records.at(-1)) } }]);
  },
  /** The turn ends: its end is stored with the reply's record and the session goes idle. */
  end(id) {
    const t = thread(id);
    const record = t.records.at(-1);
    const reply = record.items.find((item) => item.type === 'agentMessage');
    const endId = `${id}-e${t.turn}`;
    const item = stored(
      { type: 'turnEnd', id: endId, status: 'done', elapsedMs: 1200, ...(reply ? { finalAssistantId: reply.id } : {}) },
      record.id
    );
    t.records[t.records.length - 1] = { id: record.id, items: [...record.items, item], ordinal: record.ordinal };
    t.runtime = { ...t.runtime, busy: false };
    tell(
      t,
      ['thread/transcript/changed', { lineage: 1, change: { op: 'replace', unit: unitOf(t.records.at(-1)) } }],
      ['turn/completed', { turnId: `turn${t.turn}` }],
      ['thread/runtime/updated', { value: t.runtime }]
    );
  },
  /** A question (`ask_user`) or an approval waits on the session. */
  ask(id, kind = 'question') {
    const t = thread(id);
    const callId = `${id}-ask${t.turn}`;
    const args = { questions: [{ question: 'Which one?', options: [{ label: 'Red' }, { label: 'Blue' }] }] };
    if (kind === 'question') core.tool(id, callId, { done: false, name: 'ask_user', input: args });
    const card =
      kind === 'question'
        ? { id: `req-${callId}`, kind: 'question', name: 'ask_user', toolCallId: callId, args }
        : { id: `req-${callId}`, name: 'shell', kind: 'command', remember: ['once'], args: { command: 'npm test' } };
    t.requests = [
      ...t.requests,
      {
        id: `req-${callId}`,
        method: kind === 'question' ? 'item/tool/requestUserInput' : 'item/commandExecution/requestApproval',
        params: { threadId: id, order: t.requests.length + 1, card },
      },
    ];
    publish(t);
  },
  answer(id) {
    const t = thread(id);
    t.requests = [];
    publish(t);
  },
};

window.mixdogDesktop = {
  previewSession: async () => null,
  subscribeSessionState(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  async setVisibleSessions(ids) {
    currentVisible = new Set(ids);
    setVisible(ids);
    return true;
  },
  moveTranscriptWindow: async (id, to) => {
    moves.push({ id, ...to });
    if (cut) throw new Error('The core connection is not open.');
    return move(id, to);
  },
  prefetchSession: async (id) => {
    if (cut || thread(id).deleted) throw new Error('The session is no longer available.');
    publish(thread(id));
    return true;
  },
  resyncSessionState: (id) => publish(thread(id)),
  // A turn's changed files and the review bar: read, and empty, but for the turns `core.changes` gave files. A read of
  // a turn's changes waits while `core.holdReads` holds them.
  invokeCapability: async ({ capability, args }) => {
    capabilityCalls.push(capability);
    if (capability !== 'getTurnChanges') {
      // The dock's reads (a turn's review, the session's changes): never answered while `core.holdReviews` holds them.
      if (reviewsHeld) await new Promise((answer) => heldReviews.push(answer));
      return NO_CHANGES(args);
    }
    if (readsHeld) await new Promise((answer) => heldReads.push(answer));
    const checkpointId = args?.[0]?.checkpointId ?? '';
    const files = changedFiles.get(checkpointId);
    if (!files) return NO_CHANGES(args);
    return { value: { status: 'ready', checkpointId, revision: 1, root: 'C:/repo', files, canUndo: true, canReapply: false } };
  },
  perfLog() {},
};

const changedFiles = new Map();
const capabilityCalls = [];
let readsHeld = false;
const heldReads = [];
let reviewsHeld = false;
const heldReviews = [];
// Markdown longer than a commit parses is parsed off the page (markdown-worker-client.ts). The page has no worker
// file to load, so the parser's worker is this one: it answers each request with the parsed tree, and while
// `core.holdParses` holds them it answers none.
let parsesHeld = false;
const heldParses = [];
window.Worker = class extends EventTarget {
  postMessage({ id, text: source }) {
    const answer = () => this.dispatchEvent(new MessageEvent('message', { data: { id, root: parseMarkdownToHast(source) } }));
    if (parsesHeld) heldParses.push(answer);
    else queueMicrotask(answer);
  }
  terminate() {}
};
Object.assign(core, {
  /** The turn of `checkpointId` (its prompt's record) changed `files`: its card lists them. */
  changes(checkpointId, files) {
    changedFiles.set(
      checkpointId,
      files.map((path) => ({ path, status: 'M', additions: 3, deletions: 1, state: 'applied', revertable: true }))
    );
  },
  holdReads() {
    readsHeld = true;
  },
  answerReads() {
    readsHeld = false;
    for (const answer of heldReads.splice(0)) answer();
  },
  heldReads: () => heldReads.length,
  /** Every capability asked of the core, in order. */
  capabilityCalls: () => [...capabilityCalls],
  holdReviews() {
    reviewsHeld = true;
  },
  answerReviews() {
    reviewsHeld = false;
    for (const answer of heldReviews.splice(0)) answer();
  },
  heldReviews: () => heldReviews.length,
  /** The worker and the page's parser both fail from here on. */
  failParses: () => _failMarkdownParsersForTest(true),
  holdParses() {
    parsesHeld = true;
  },
  releaseParses() {
    parsesHeld = false;
    for (const send of heldParses.splice(0)) send();
  },
  heldParses: () => heldParses.length,
  /** Every row the core holds for the thread's subscription, whichever stretch it is in. */
  windowRows(id) {
    const held = thread(id).sub?.fold.held;
    let rows = 0;
    for (const unit of held?.units.values() ?? []) rows += unit.rows.length;
    return rows;
  },
});

const NO_CHANGES = (args) => ({
    value: {
      status: 'none',
      checkpointId: args?.[0]?.checkpointId ?? '',
      supported: true,
      authoritative: true,
      complete: true,
      snapshotKind: 'worktree',
      checkpointId: 'prompt',
      patch: '',
      files: [],
      agents: [],
    },
  });

// ───────────────────────────── the workspace ─────────────────────────────

const noop = () => {};
const session = (id) => ({ kind: 'session', id });
const draft = (draftId = 'd1') => ({ kind: 'new', draftId });
let setLayout = noop;
let layoutNow = null;
let focusedNow = '';

function conversationProps(selection, focused, visible) {
  const sessionId = selection.kind === 'session' ? selection.id : '';
  const draftKey = selection.kind === 'new' ? selection.draftId || 'default' : '';
  return {
    focused,
    sessionId,
    hidden: false,
    surfaceVisible: visible,
    transcriptPending: false,
    reconcileOnMount: true,
    invokeResult: async (action) => action(),
    errors: [],
    submit: async () => true,
    applySnapshot: noop,
    transitioning: false,
    composerFocusRequest: 0,
    onNewTask: noop,
    onClearProject: noop,
    onResumeSession: noop,
    onOpenSessions: noop,
    onOpenProjects: noop,
    onOpenSettings: noop,
    projects: [],
    showProjectSelector: Boolean(draftKey),
    draftMode: Boolean(draftKey),
    draftId: draftKey,
    activeProjectPath: 'C:/fixture',
    activeProjectLabel: 'fixture',
    onSelectProject: noop,
    onOpenCommandSurface: noop,
  };
}

function Workspace() {
  const [state, set] = useState(() => {
    const leaf = createPaneLeaf(draft(), 'pane-1');
    return { layout: leaf, focused: leaf.id };
  });
  layoutNow = state.layout;
  focusedNow = state.focused;
  setLayout = (next) => flushSync(() => set((current) => (typeof next === 'function' ? next(current) : next)));
  const leaves = paneLeaves(state.layout);
  const workspace = {
    layout: state.layout,
    restoredFromStorage: true,
    restorePending: false,
    leaves,
    focusedLeaf: leaves.find((leaf) => leaf.id === state.focused) ?? leaves[0],
    focusedLeafId: state.focused,
    focusLeaf: (id) => set((current) => ({ ...current, focused: id })),
    activateTab: (leafId, key) =>
      set((current) => ({ ...current, layout: activateTabInPaneLeaf(current.layout, leafId, key) })),
    setRatio: noop,
  };
  return (
    <PaneWorkspace
      workspace={new Proxy(workspace, { get: (target, key) => (key in target ? target[key] : noop) })}
      renderActive={() => null}
      renderStrip={(leaf) => (
        <div className="rig-strip" data-leaf={leaf.id}>
          {leaf.tabs.map((tab) => navigationKey(tab)).join(' | ')}
        </div>
      )}
      renderConversation={(selection, focused, _focusPane, _leafId, _warm, visible) => (
        <PaneConversation {...conversationProps(selection, focused, visible)} />
      )}
      onFocusSelection={noop}
    />
  );
}

const ws = {
  session,
  draft,
  leaves: () => paneLeaves(layoutNow).map((leaf) => ({ id: leaf.id, active: leaf.activeKey, tabs: leaf.tabs.map(navigationKey) })),
  /** A tab click, or a session-list click on a session that has a tab: the tab is opened if absent and activated. */
  open(selection, leafId = focusedNow) {
    setLayout((current) => ({ ...current, layout: openTabInPaneLeaf(current.layout, leafId, selection) }));
  },
  activate(selection, leafId = focusedNow) {
    setLayout((current) => ({ ...current, layout: activateTabInPaneLeaf(current.layout, leafId, navigationKey(selection)) }));
  },
  /** A session-list click that takes the active tab's place (the tab shows another session from now on). */
  replace(selection, leafId = focusedNow) {
    setLayout((current) => ({
      ...current,
      layout: openTabInPaneLeaf(current.layout, leafId, selection, findPaneLeaf(current.layout, leafId).activeKey),
    }));
  },
  /** The tab is closed (its close button, or the session's deletion in the list). */
  close(selection, leafId = focusedNow) {
    setLayout((current) => ({
      ...current,
      layout: closeTabInPaneLeaf(current.layout, leafId, navigationKey(selection)) ?? current.layout,
    }));
  },
  split(selection, leafId = focusedNow, id = 'pane-2') {
    setLayout((current) => ({
      focused: current.focused,
      layout: splitPaneLeaf(current.layout, leafId, 'row', createPaneLeaf(selection, id)),
    }));
  },
  focus(leafId) {
    setLayout((current) => ({ ...current, focused: leafId }));
  },
  activeOf: (leafId) => findPaneLeaf(layoutNow, leafId)?.activeKey,
};

// ───────────────────────────── what the user sees ─────────────────────────────

const round = (value) => Math.round(value * 10) / 10;
let watched = null;

/** One pane as painted now: the conversation surface its pane presents (not one kept mounted unseen, nor one being
 *  prepared behind it; a tree without the handover has neither attribute on the one it shows). */
const SLOT = 'pane-conversation-slot-';
const paneIdOf = (cell) => cell.querySelector('.pane-conversation-slot')?.id.slice(SLOT.length) ?? '';
const hostsOf = (leafId) => [...document.querySelectorAll(`#${SLOT}${leafId} > .persistent-pane-surface`)];
const surfaceOf = (leafId) =>
  hostsOf(leafId).find((host) => !host.hasAttribute('data-retained') && !host.hasAttribute('data-preparing'));

function paneView(cell) {
  const pane = paneIdOf(cell);
  const surface = surfaceOf(pane);
  const view = surface?.querySelector('.transcript');
  if (!view) return { pane, session: null };
  const box = view.getBoundingClientRect();
  const thread = view.querySelector('.thread');
  const threadBox = thread?.getBoundingClientRect();
  const hidden = getComputedStyle(view).visibility !== 'visible';
  const cover = Boolean(surface.querySelector('.pane-surface-cover'));
  const rows = [...view.querySelectorAll('.transcript-virtual-row')]
    .map((row) => ({ row, index: Number(row.dataset.index), key: row.dataset.timelineKey, box: row.getBoundingClientRect() }))
    .sort((a, b) => a.index - b.index);
  const visible = rows.filter(({ box: row }) => row.bottom > box.top + 0.5 && row.top < box.bottom - 0.5 && row.height > 0);
  const composer = surface.querySelector('form.composer')?.getBoundingClientRect();
  const rail = cell.querySelector('.session-rail')?.getBoundingClientRect();
  return {
    pane,
    session: view.dataset.sessionKey,
    following: view.dataset.following === 'true',
    cover,
    hidden,
    /** The pane says the session cannot be read. */
    unavailable: Boolean(surface.querySelector('.session-unavailable')),
    /** The rows a reader can see: null while the transcript is covered or held hidden, or shows no row of a session. */
    shown:
      cover || hidden || (visible.length === 0 && view.dataset.sessionKey !== 'new-task')
        ? null
        : visible.map(({ key, box: row }) => `${key}@${Math.round(row.top - box.top)}`),
    blank: visible.length === 0,
    /** The session the pane is switching to, while it still shows another. */
    preparing:
      hostsOf(pane)
        .find((host) => host.hasAttribute('data-preparing'))
        ?.querySelector('.transcript')?.dataset.sessionKey ?? null,
    mounted: rows.map(({ index, key }) => `${index}:${key}`),
    /** Mounted rows whose boxes lie wholly more than a viewport height from the view. */
    far: rows.filter(({ box: row }) => row.bottom < box.top - box.height || row.top > box.bottom + box.height).length,
    first: visible[0] ? { key: visible[0].key, offset: round(visible[0].box.top - box.top) } : null,
    last: visible.at(-1) ? { key: visible.at(-1).key, bottom: round(visible.at(-1).box.bottom - box.top) } : null,
    gap: round(view.scrollHeight - view.clientHeight - view.scrollTop),
    top: round(view.scrollTop),
    height: round(view.scrollHeight),
    column: threadBox ? { left: round(threadBox.left), width: round(threadBox.width) } : null,
    viewport: { left: round(box.left), width: round(box.width), top: round(box.top), height: round(box.height) },
    composer: composer ? { left: round(composer.left), width: round(composer.width), top: round(composer.top) } : null,
    island: Boolean(surface.querySelector('.composer-island-slot')),
    rail: rail ? { left: round(rail.left), width: round(rail.width) } : null,
    busy: view.getAttribute('aria-busy') === 'true',
    question: Boolean(surface.querySelector('.question-option')),
    approval: Boolean(surface.querySelector('.approval-card, .approval-prompt')),
    liveBand: Boolean(view.querySelector('.live-activity-slot[data-busy="true"]')),
    ...(watched ? { watched: rows.find(({ key }) => key === watched)?.row.textContent ?? null } : {}),
  };
}

const view = () => [...document.querySelectorAll('.pane-cell')].map(paneView);

const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));

/** What the panes still owe, by their own signals: a handover not made, an entry not revealed, a reader's gesture the
 *  list holds its corrections for, sizes it has yet to relearn, a request the core stand-in has yet to answer. '' when
 *  they owe nothing. */
function owed() {
  if (document.querySelector('.persistent-pane-surface[data-preparing]')) return 'a pane is switching';
  for (const cell of document.querySelectorAll('.pane-cell')) {
    const surface = surfaceOf(paneIdOf(cell));
    if (!surface) return 'a pane presents nothing';
    if (surface.querySelector('.conversation[data-transcript-entering]')) return 'an entry is not revealed';
    if (surface.querySelector('.transcript[data-transcript-relearn]')) return 'row sizes are being relearned';
  }
  if (delivery === 'now' && pending.length > 0) return 'the core has not answered';
  return '';
}

// The product times a reader's gesture by `Date.now()` (use-transcript-follow.ts: the list holds its corrections while
// one is open). The rig is the reader: it says when its gesture is over by moving that clock past every such window,
// and never waits one out.
const wallClock = Date.now.bind(Date);
let clockAhead = 0;
Date.now = () => wallClock() + clockAhead;
// The page's other clock, moved with it by `advance`: nothing the panes present may depend on either.
const frameClock = performance.now.bind(performance);
let frameClockAhead = 0;
performance.now = () => frameClock() + frameClockAhead;
function advance(ms) {
  clockAhead += ms;
  frameClockAhead += ms;
}
let gesturing = false;
const GESTURE_OVER_MS = 60_000;

/** Resolves once the panes owe nothing and two frames in a row paint the same, the rig's own gesture over and what the
 *  list held for it landed. Never by a count of frames: a pane that does not come to rest fails the case, naming what
 *  it still owes. */
async function settle() {
  const started = frameClock();
  let before = '';
  for (;;) {
    await nextFrame();
    const waiting = owed();
    const now = waiting ? '' : JSON.stringify(view());
    if (!waiting && now === before) {
      if (!gesturing) return;
      gesturing = false;
      clockAhead += GESTURE_OVER_MS;
      before = '';
      continue;
    }
    before = now;
    if (frameClock() - started > 10_000) throw new Error(`the panes did not come to rest: ${waiting || 'the view keeps changing'}`);
  }
}

/** What each of `count` frames paints: sampled after its layout (a ResizeObserver created last), with `act` run inside
 *  frame 1's animation callback and `then[k]` inside frame k's. */
function frames(count, act, then = {}) {
  return new Promise((done) => {
    const out = [];
    const probe = document.createElement('div');
    probe.style.cssText = 'position:fixed;left:-20px;top:0;width:1px;height:1px';
    document.body.append(probe);
    let frame = 0;
    let armed = false;
    const observer = new ResizeObserver(() => {
      if (armed) out.push(view());
    });
    observer.observe(probe);
    const tick = () => {
      frame += 1;
      if (frame === 1) {
        armed = true;
        act();
      }
      then[frame]?.();
      probe.style.width = `${(frame % 2) + 1}px`;
      if (frame < count) requestAnimationFrame(tick);
      else
        requestAnimationFrame(() => {
          observer.disconnect();
          probe.remove();
          done(out);
        });
    };
    requestAnimationFrame(tick);
  });
}

/** Scrolls the pane's transcript as a reader's wheel does. */
async function wheel(leafId, deltaY) {
  gesturing = true;
  const log = surfaceOf(leafId).querySelector('.transcript');
  log.dispatchEvent(new WheelEvent('wheel', { deltaY, bubbles: true, cancelable: true }));
  log.scrollTop += deltaY;
  await settle();
}

/** Moves the pane's transcript in one step, as Home or a dragged scrollbar does. */
function jump(leafId, top) {
  gesturing = true;
  surfaceOf(leafId).querySelector('.transcript').scrollTop = top;
}

/** One wheel notch, with no wait after it. */
function nudge(leafId, deltaY) {
  gesturing = true;
  const log = surfaceOf(leafId).querySelector('.transcript');
  log.dispatchEvent(new WheelEvent('wheel', { deltaY, bubbles: true, cancelable: true }));
  log.scrollTop += deltaY;
}

/** Opens the session at a stored record, as choosing a search hit does (SessionSearchDialog.tsx `openRow`). */
function openAt(id, record, leafId = focusedNow) {
  requestTranscriptJump(id, pos(record));
  ws.open(session(id), leafId);
}

/** What the renderer holds, by layer: rows of followed sessions (the core's windows, as their lanes show them), rows
 *  of sessions no pane shows, rows mounted in the document, row sizes remembered, readers' places. */
function memory() {
  const followed = [...threads.values()].filter((t) => t.sub).map((t) => t.id);
  const stats = defaultSessionLaneStore.stats();
  return {
    followed,
    windowRows: Object.fromEntries(followed.map((id) => [id, laneRows(id)])),
    hiddenRows: defaultSessionLaneStore.hiddenRows(),
    lanes: stats.entries,
    hiddenBytes: stats.estimatedBytes,
    mountedRows: document.querySelectorAll('.transcript-virtual-row').length,
    conversations: document.querySelectorAll('.persistent-pane-surface .conversation').length,
    measuredRows: transcriptVirtualCacheStats(),
    places: readerPlaceCount(),
    heap: performance.memory?.usedJSHeapSize ?? 0,
  };
}

/** The rows the lane shows of a session: its tail's stretch and the one apart from it. */
function laneRows(id) {
  const lane = defaultSessionLaneStore.get(id);
  return (lane?.items?.length ?? 0) + (lane?.transcriptViewItems?.length ?? 0);
}

const rowText = (leafId, key) =>
  [...surfaceOf(leafId).querySelectorAll('.transcript-virtual-row')].find((row) => row.dataset.timelineKey === key)
    ?.textContent ?? null;

installChatTextSize();
createRoot(document.getElementById('root')).render(<Workspace />);
window.rig = {
  advance,
  /** The renderer's idle reclaim: every parsed reply and cached read it may drop is dropped. */
  reclaim: _runIdleReclaimForTest,
  /** No reply of a turn's changes is held: each card reads again. */
  forgetChanges: resetTurnChangesCache,
  core,
  ws,
  view,
  frames,
  settle,
  owed,
  wheel,
  nudge,
  jump,
  openAt,
  memory,
  setTextSize: setChatTextSize,
  laneRows,
  rowText,
  /** Every view reads the text of the row `key` from now on (`watched`). */
  watch(key) {
    watched = key;
  },
  store: defaultSessionLaneStore,
  /** Where the pane's reader of the session is, as kept (transcript-list-reader-place.ts). */
  place: (id, leafId = 'pane-1') => readerPlace(leafId, id),
};
