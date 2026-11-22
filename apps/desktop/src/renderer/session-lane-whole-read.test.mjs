// A lane that is told what each frame left in place (the protocol fold merges a transcript on from the one before) shows
// the rows a lane shows that reads every frame whole. Both are fed the same folds: one the fold's own arrays, the other
// fresh arrays, of which nothing is known.
import assert from 'node:assert/strict';
import test from 'node:test';

import { desktopSessionState, sessionReducer } from '../../../../packages/protocol-client/src/session-state.ts';
import { createSessionLaneStore } from './session-lane-store.ts';
import { createTranscriptSnapshotDecorator } from './snapshot-transcript-decoration.ts';

const user = (id, text = id) => ({ type: 'userMessage', id, content: [{ type: 'text', text }], meta: { at: 1 } });
const reply = (id, text) => ({ type: 'agentMessage', id, text, meta: { status: 'completed', at: 2 } });
/** A tool call: unfinished without `output`; `live`, a call of the turn running (it is on a card from its start). */
const call = (id, name, input, output, live = false) => ({
  type: 'toolCall',
  id,
  name,
  input,
  ...(output === undefined ? {} : { output }),
  ...(live ? { run: { live: true, callId: id } } : {}),
  meta: { status: output === undefined ? 'inProgress' : 'completed', at: 3 },
});
const read = (id, path = 'f') => call(id, 'read', { path }, 'out');
/** A skill load: hidden until its result lands, and for good when the result names a built-in skill. */
const skill = (id, output, live = false) => call(id, 'skill', { name: 'notes' }, output, live);
const agent = (id, status = 'completed') => ({ type: 'subAgentActivity', id, agent: 'worker', meta: { status, at: 3 } });

/** Two lanes of one thread: `carried` is handed each fold's own state, `whole` a copy whose item array is new. Each
 *  publication travels under what `envelope` gives for it: the lane it came by (`frameSource`, live when unsaid) and the
 *  content generation it states (`contentRevision`), if any. */
function lanes(sessionId, envelope = () => ({})) {
  const thread = { id: sessionId };
  const carried = createSessionLaneStore({ decorator: createTranscriptSnapshotDecorator({ register: false }) });
  const whole = createSessionLaneStore({ decorator: createTranscriptSnapshotDecorator({ register: false }) });
  let fold = null;
  const hand = (state, under) => {
    const frame = { sessionId, frameSource: 'live', ...under };
    carried.apply({ ...frame, snapshot: state });
    whole.apply({ ...frame, snapshot: { ...state, items: state.items.slice() } });
  };
  const publish = (extra = {}) => hand({ ...desktopSessionState(fold, []), ...extra }, envelope());
  const note = (method, params) => {
    fold = sessionReducer.apply(fold, { jsonrpc: '2.0', method, params: { threadId: sessionId, ...params } });
  };
  const ids = (store) => store.get(sessionId).items.map((item) => String(item.id));
  return {
    /** The thread is followed (again) from `items`, the end of its history; `fields`: what the frame says beside rows. */
    follow(items, hasOlder = false, fields = {}) {
      fold = sessionReducer.initial({ thread, items, state: {}, hasOlder });
      publish(fields);
    },
    /** One notification folded, not yet published: a frame holds every one since the last. */
    start: (item) => note('item/started', { item }),
    complete: (item) => note('item/completed', { item }),
    delta: (itemId, delta) => note('item/agentMessage/delta', { itemId, delta }),
    /** The thread is cut back to end at `fromItemId` (a rewind), or emptied (a clear). */
    reset: (fromItemId) => note('thread/historyReset', fromItemId === undefined ? {} : { fromItemId }),
    publish,
    /** A frame as the store is handed it: these rows, this very list, under this envelope. */
    frame: (items, under = {}) => hand({ sessionId, items }, under),
    land(item) {
      note('item/completed', { item });
      publish();
    },
    /** A frame that changes no row: the reply streams, under the id `tailId`. */
    stream(tailId, text) {
      publish({ streamingTail: { id: tailId, kind: 'assistant', text, streaming: true } });
    },
    carried: () => ids(carried),
    whole: () => ids(whole),
    /** Everything each lane shows, rows and fields. */
    shown: () => ({ carried: carried.get(sessionId), whole: whole.get(sessionId) }),
    close() {
      carried.clear();
      whole.clear();
    },
  };
}

test('a reply landing under a head kept above a reconnect that showed another under its id: the head stands once', () => {
  const lane = lanes('whole-read-kept-head');
  try {
    lane.follow([reply('H', 'ok'), reply('A', 'ok')]);
    // A shorter window holding only another reply with the same words: it is shown under `A`, with `H` kept above.
    lane.follow([reply('B', 'ok')], true);
    assert.deepEqual(lane.carried(), ['H', 'A']);
    assert.deepEqual(lane.whole(), ['H', 'A']);
    lane.land(reply('A', 'ok'));
    assert.deepEqual(lane.whole(), ['H', 'A']);
    assert.deepEqual(lane.carried(), lane.whole());
    lane.land(user('next'));
    assert.deepEqual(lane.carried(), lane.whole());
  } finally {
    lane.close();
  }
});

test('a second read landing after a reconnect whose reply and read were shown under the ids held: the rows of a whole read', () => {
  const lane = lanes('whole-read-aggregate');
  try {
    lane.follow([user('p'), reply('A', 'ok'), read('C')]);
    lane.follow([user('p'), reply('B', 'ok'), read('D')]);
    assert.deepEqual(lane.carried(), ['p', 'A', 'C']);
    assert.deepEqual(lane.whole(), ['p', 'A', 'C']);
    // The read is now one of two: the protocol hands the pair over as one card under the first one's id.
    lane.land(read('E'));
    assert.deepEqual(lane.whole(), ['p', 'B', 'D']);
    assert.deepEqual(lane.carried(), lane.whole());
    lane.land(reply('F', 'ok'));
    assert.deepEqual(lane.carried(), lane.whole());
  } finally {
    lane.close();
  }
});

test('the reply a reconnect showed another under the id of arrives itself: each reply once, as a whole read shows them', () => {
  const lane = lanes('whole-read-renamed-then-real');
  try {
    lane.follow([user('prompt'), reply('A', 'the same words')]);
    lane.follow([user('prompt'), reply('B', 'the same words')]);
    assert.deepEqual(lane.carried(), ['prompt', 'A']);
    assert.deepEqual(lane.whole(), ['prompt', 'A']);
    lane.land(reply('A', 'the same words'));
    assert.deepEqual(lane.whole(), ['prompt', 'B', 'A']);
    assert.deepEqual(lane.carried(), lane.whole());
    lane.land(user('next'));
    assert.deepEqual(lane.carried(), lane.whole());
  } finally {
    lane.close();
  }
});

test('a reply streaming after a reconnect to a shorter window keeps the rows, the project and the stats a whole read keeps', () => {
  const lane = lanes('whole-read-tail-under-retained');
  const fields = { cwd: '/work/project', stats: { turns: 4 } };
  try {
    lane.follow([user('a'), user('b'), user('c'), user('d')], false, fields);
    lane.follow([user('c'), user('d')], true);
    for (const text of ['Wor', 'Working', 'Working on it']) {
      lane.stream('live', text);
      const { carried, whole } = lane.shown();
      assert.deepEqual(lane.whole(), ['a', 'b', 'c', 'd']);
      assert.equal(whole.cwd, fields.cwd);
      assert.deepEqual(whole.stats, fields.stats);
      assert.deepEqual(carried, whole, `after "${text}"`);
    }
  } finally {
    lane.close();
  }
});

test('two hidden skill loads settling in one frame, one joining the load after it and one showing before the agent: the rows of a whole read', () => {
  const lane = lanes('whole-read-settled-among-shown');
  try {
    lane.follow([user('P')]);
    // Parallel calls of the turn running, each on a card from its start. An unfinished skill load is hidden: the pane
    // shows the others.
    lane.start(skill('S', undefined, true));
    lane.complete(skill('T', 'Loaded skill: notes', true));
    lane.complete(call('R', 'read', { path: 'f' }, 'out', true));
    lane.start(skill('U', undefined, true));
    lane.complete(agent('G'));
    lane.publish();
    assert.deepEqual(lane.whole(), ['P', 'T', 'R', 'G']);
    assert.deepEqual(lane.carried(), lane.whole());
    // Both loads finish before the next frame: `S` and `T` are one card under `S`, and `U` shows before `G`. Only `P`
    // stayed in place, and the rows after it no longer match the rows shown.
    lane.complete(skill('S', 'Loaded skill: notes', true));
    lane.complete(skill('U', 'Loaded skill: notes', true));
    lane.publish();
    assert.deepEqual(lane.whole(), ['P', 'S', 'R', 'U', 'G']);
    assert.deepEqual(lane.carried(), lane.whole());
    lane.land(reply('done', 'ok'));
    assert.deepEqual(lane.carried(), lane.whole());
  } finally {
    lane.close();
  }
});

test('a hidden skill load settling inside a window shown under a head kept above it: the head goes, as in a whole read', () => {
  const lane = lanes('whole-read-settled-under-head');
  try {
    lane.follow([user('H'), user('P'), skill('S'), read('R')]);
    assert.deepEqual(lane.whole(), ['H', 'P', 'R']);
    // The window from `P` on, under the ids shown: `H` is kept above it.
    lane.follow([user('P'), skill('S'), read('R')], true);
    assert.deepEqual(lane.whole(), ['H', 'P', 'R']);
    assert.deepEqual(lane.carried(), lane.whole());
    // The load finishes: the window is `P`, `S`, `R`, with only `P` in place, and no longer matches the rows shown.
    lane.land(skill('S', 'Loaded skill: notes'));
    assert.deepEqual(lane.whole(), ['P', 'S', 'R']);
    assert.deepEqual(lane.carried(), lane.whole());
    lane.land(reply('done', 'ok'));
    assert.deepEqual(lane.carried(), lane.whole());
  } finally {
    lane.close();
  }
});

test('the rows kept above a one-row window landing again in one frame: the frame begins before the rows shown, as in a whole read', () => {
  const lane = lanes('whole-read-head-returns');
  try {
    lane.follow([user('H1'), user('H2'), user('P')]);
    lane.follow([user('P')], true);
    assert.deepEqual(lane.whole(), ['H1', 'H2', 'P']);
    // `P` stays in place, and the two rows after it match the two rows kept above by their ids: more rows than the
    // window itself matches, so the frame is a window that starts before the rows shown and replaces them.
    lane.complete(user('H1'));
    lane.complete(user('H2'));
    lane.publish();
    assert.deepEqual(lane.whole(), ['P', 'H1', 'H2']);
    assert.deepEqual(lane.carried(), lane.whole());
    lane.land(reply('done', 'ok'));
    assert.deepEqual(lane.carried(), lane.whole());
  } finally {
    lane.close();
  }
});

test('a newer generation publishing the list a replay brought as a shorter window: shown as published, without the head the replay kept', () => {
  const lane = lanes('whole-read-generation-over-replay');
  const row = (id) => ({ id, kind: 'user', text: `prompt ${id}` });
  try {
    lane.frame([row('H'), row('P')], { frameSource: 'live', contentRevision: 1 });
    // A replay that states no generation brings the window from `P` on: `H` is kept above it.
    const window = [row('P')];
    lane.frame(window, { frameSource: 'replay' });
    assert.deepEqual(lane.whole(), ['H', 'P']);
    assert.deepEqual(lane.carried(), lane.whole());
    // The next generation publishes that very list. It changed no row since the replay, and a newer generation is still
    // shown as published: what an earlier window kept above is not part of it.
    lane.frame(window, { frameSource: 'live', contentRevision: 2 });
    assert.deepEqual(lane.whole(), ['P']);
    assert.deepEqual(lane.carried(), lane.whole());
    // The same list once more, under the generation shown and then under none: the rows shown stand in both lanes.
    lane.frame(window, { frameSource: 'live', contentRevision: 2 });
    assert.deepEqual(lane.carried(), lane.whole());
    lane.frame(window, { frameSource: 'live' });
    assert.deepEqual(lane.whole(), ['P']);
    assert.deepEqual(lane.shown().carried, lane.shown().whole);
  } finally {
    lane.close();
  }
});

function randomOf(seed) {
  let state = seed;
  const next = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
  return {
    next,
    below: (count) => Math.floor(next() * count),
    pick: (list) => list[Math.floor(next() * list.length)],
    chance: (odds) => next() < odds,
  };
}

test('through sessions of every kind of frame the product has, the lane shows what a whole read shows', () => {
  /** The frame classes the sessions went through: each must have been reached, and often. */
  const seen = {
    renamedWindows: 0,
    shorterWindows: 0,
    fullWindows: 0,
    repliesSettledUnderOwnId: 0,
    repliesSettledUnderStreamedId: 0,
    hiddenCallsShownMidWindow: 0,
    hiddenCallsNeverShown: 0,
    callsSettledTogether: 0,
    cardsFormed: 0,
    cardsSplit: 0,
    idsReturnedInWindow: 0,
    idsReturnedAboveWindow: 0,
    headRowsReturnedTogether: 0,
    rewinds: 0,
    clears: 0,
    framesOfSeveralNotes: 0,
    framesWithRowsWithoutId: 0,
    newerGenerations: 0,
    newerGenerationsOfTheSameList: 0,
    sameGenerations: 0,
    replays: 0,
    framesRefused: 0,
    frames: 0,
  };
  for (let seed = 1; seed <= 120; seed += 1) {
    const random = randomOf(seed * 2654435761);
    const trace = [];
    // The content generation the lane last showed a frame of, and whether a frame since changed any row.
    let revision = 0;
    let changed = true;
    /** What a publication travels under: mostly a live frame that states no generation, as the stream's frames are. */
    const envelope = () => {
      const roll = random.next();
      let under = {};
      if (roll < 0.1) {
        under = { frameSource: 'live', contentRevision: ++revision };
        seen.newerGenerations += 1;
        if (!changed) seen.newerGenerationsOfTheSameList += 1;
      } else if (roll < 0.15 && revision > 0) {
        under = { frameSource: 'live', contentRevision: revision };
        seen.sameGenerations += 1;
      } else if (roll < 0.21) {
        under = { frameSource: 'replay' };
        seen.replays += 1;
      } else if (roll < 0.25) {
        under = { frameSource: 'replay', contentRevision: ++revision };
        seen.replays += 1;
      } else if (roll < 0.3 && revision > 0) {
        // The generation shown again as a replay, or an older one: the lane refuses both.
        const stale = random.chance(0.5) && revision > 1;
        under = { frameSource: random.chance(0.5) || !stale ? 'replay' : 'live', contentRevision: revision - (stale ? 1 : 0) };
        seen.framesRefused += 1;
      }
      trace.push(`  under ${JSON.stringify(under)}`);
      changed = false;
      return under;
    };
    const lane = lanes(`whole-read-${seed}`, envelope);
    let serial = 0;
    const id = (prefix) => `${prefix}${++serial}`;
    // Few distinct words: equal rows are what an id is adopted across.
    const words = () => random.pick(['ok', 'ok', 'done', `words ${serial % 3}`]);
    const finished = (roll = random.next()) => {
      if (roll < 0.2) return user(id('u'), random.pick(['go', 'go', `ask ${serial % 3}`]));
      if (roll < 0.5) return reply(id('a'), words());
      if (roll < 0.75) return read(id('t'), random.pick(['f', 'f', 'g']));
      if (roll < 0.83) return call(id('x'), 'shell', { command: 'ls' }, 'out');
      if (roll < 0.9) return skill(id('k'), 'Loaded skill: notes');
      if (roll < 0.93) return agent(id('g'));
      // Rows without an id: a reply and a notice a host that names none hands over.
      if (roll < 0.955) return { type: 'agentMessage', text: words(), meta: { status: 'completed', at: 2 } };
      if (roll < 0.97) return { type: 'statusRow', kind: 'notice', meta: { label: `note ${serial % 2}`, at: 4 } };
      return { type: 'turnEnd', id: id('e'), status: 'done', elapsedMs: 1, meta: { at: 5 } };
    };
    /** A call as it starts, and as it ends: under the same id. */
    const unfinished = () => {
      const roll = random.next();
      const live = random.chance(0.5);
      if (roll < 0.45) return skill(id('k'), undefined, live);
      if (roll < 0.75) return call(id('t'), 'read', { path: random.pick(['f', 'g']) }, undefined, live);
      if (roll < 0.9) return call(id('x'), 'shell', { command: 'ls' }, undefined, live);
      return agent(id('g'), 'inProgress');
    };
    const ended = (item) => {
      if (item.type === 'subAgentActivity') return agent(item.id);
      if (item.name === 'skill') {
        const output = random.chance(0.3) ? 'Loaded built-in skill: notes' : 'Loaded skill: notes';
        return skill(item.id, output, item.run !== undefined);
      }
      return { ...item, output: 'out', meta: { ...item.meta, status: 'completed' } };
    };
    // The thread as the core holds it, oldest first; the first item the fold follows it from; every id it ever used.
    let history = Array.from({ length: 1 + random.below(4) }, () => finished());
    let from = 0;
    const used = history.map((item) => item.id).filter((held) => held !== undefined);
    const pending = () => history.filter((item) => item.meta?.status === 'inProgress');
    trace.push(`follow ${history.map((item) => item.id)}`);
    /** The tool cards a whole read shows, each with how many calls it holds. */
    const cards = () =>
      new Map(
        lane
          .shown()
          .whole.items.filter((row) => row.kind === 'tool')
          .map((row) => [String(row.id), Number(row.count) || 1])
      );
    const same = (what) => {
      seen.frames += 1;
      const at = `seed ${seed}, after ${what}\n${trace.join('\n')}`;
      assert.deepEqual(lane.carried(), lane.whole(), at);
      const { carried, whole } = lane.shown();
      assert.deepEqual(carried, whole, at);
      if (whole.items.some((row) => row.id === undefined || row.id === null)) seen.framesWithRowsWithoutId += 1;
    };
    try {
      lane.follow(history, false, { cwd: '/work/project', stats: { turns: 1 } });
      same('the first window');
      // The words of the reply streaming under an id of the pane's own, and the reply the fold itself streams.
      let streaming = null;
      let live = null;
      // Notifications folded since the last frame, and whether one of them cut the thread back.
      let owed = 0;
      let cut = false;
      for (let step = 0; step < 100; step += 1) {
        const roll = random.next();
        let published = false;
        if (roll < 0.26) {
          // Rows land: a streamed reply mostly settles, as a row with its words under an id of its own or the id it
          // streamed under.
          const settlesOwn = streaming !== null && random.chance(0.7);
          const settlesLive = !settlesOwn && live !== null && random.chance(0.7);
          const item = settlesOwn
            ? reply(id('a'), streaming)
            : settlesLive
              ? reply(live.id, live.text)
              : finished();
          if (settlesOwn) seen.repliesSettledUnderOwnId += 1;
          if (settlesLive) seen.repliesSettledUnderStreamedId += 1;
          if (settlesOwn) streaming = null;
          if (settlesLive) live = null;
          history.push(item);
          if (item.id !== undefined) used.push(item.id);
          trace.push(`land ${item.type} ${item.name ?? ''} ${item.id}`);
          lane.complete(item);
          owed += 1;
        } else if (roll < 0.4) {
          const item = unfinished();
          history.push(item);
          used.push(item.id);
          trace.push(`start ${item.name ?? item.type} ${item.id}${item.run ? ' (live)' : ''}`);
          lane.start(item);
          owed += 1;
        } else if (roll < 0.55) {
          // Calls end, several of them between two frames.
          const open = pending();
          const count = Math.min(open.length, 1 + random.below(3));
          if (count > 1) seen.callsSettledTogether += 1;
          for (let nth = 0; nth < count; nth += 1) {
            const item = open.splice(random.below(open.length), 1)[0];
            const at = history.indexOf(item);
            const done = ended(item);
            history[at] = done;
            if (item.name === 'skill') {
              if (done.output.startsWith('Loaded built-in')) seen.hiddenCallsNeverShown += 1;
              else if (at >= from && at < history.length - 1) seen.hiddenCallsShownMidWindow += 1;
            }
            trace.push(`end ${done.name ?? done.type} ${done.id} "${done.output ?? ''}"`);
            lane.complete(done);
            owed += 1;
          }
        } else if (roll < 0.62) {
          streaming = words();
          trace.push(`stream "${streaming}"`);
          if (owed > 0) changed = true;
          lane.stream(id('live'), streaming);
          owed = 0;
          cut = false;
          published = true;
        } else if (roll < 0.7) {
          // The fold's own live reply: it starts, or goes on, under the id it will settle under.
          if (live === null) {
            live = { id: id('a'), text: '' };
            used.push(live.id);
            trace.push(`reply ${live.id} starts`);
            lane.start({ type: 'agentMessage', id: live.id, text: '', meta: { status: 'inProgress', at: 2 } });
          }
          const delta = random.pick(['ok', 'done\n', 'words\nmore', ' and']);
          live.text += delta;
          trace.push(`delta ${JSON.stringify(delta)}`);
          lane.delta(live.id, delta);
          owed += 1;
        } else if (roll < 0.72 && from > 1) {
          // The oldest items above the window come again, in their order, between two frames: the rows the lane kept
          // above the window are then the rows at its end.
          const count = 2 + random.below(Math.min(2, from - 1));
          const again = history.splice(0, count);
          from -= count;
          for (const item of again) {
            history.push(item);
            trace.push(`land again ${item.type} ${item.name ?? ''} ${item.id}`);
            lane.complete(item);
          }
          owed += count;
          seen.headRowsReturnedTogether += 1;
        } else if (roll < 0.77 && used.length > 0) {
          // An id the thread used before comes again: a row of the window is replaced in place, or a row whose id the
          // lane may still show above the window lands at its end.
          const returned = random.pick(used);
          const made = finished(random.next() * 0.9);
          const item = { ...made, id: returned };
          const at = history.findIndex((held) => held.id === returned);
          if (live?.id === returned) live = null;
          if (at >= from) {
            history[at] = item;
            seen.idsReturnedInWindow += 1;
          } else {
            if (at >= 0) history.splice(at, 1);
            if (at >= 0) from -= 1;
            history.push(item);
            seen.idsReturnedAboveWindow += 1;
          }
          trace.push(`land again ${item.type} ${item.name ?? ''} ${item.id}`);
          lane.complete(item);
          owed += 1;
        } else if (roll < 0.82) {
          const to = history.length === 0 || random.chance(0.15) ? -1 : random.below(history.length);
          // A rewind names the item it ends at: one without an id cannot be named, and the thread is emptied instead.
          if (to < 0 || history[to].id === undefined) {
            history = [];
            from = 0;
            seen.clears += 1;
            trace.push('clear');
            lane.reset();
          } else {
            // A rewind to an item of the window, or to one above it (nothing the fold holds stays).
            const at = to;
            history = history.slice(0, at + 1);
            from = Math.min(from, history.length);
            seen.rewinds += 1;
            trace.push(`rewind to ${history[at].id}`);
            lane.reset(history[at].id);
          }
          streaming = null;
          live = null;
          owed += 1;
          cut = true;
        } else {
          // The thread is followed again: the same rows, some of them under other ids, from somewhere in its history.
          if (history.length === 0) history.push(finished());
          if (random.chance(0.5)) {
            history = history.map((item) => (random.chance(0.35) ? { ...item, id: id('n') } : item));
            for (const item of history) if (item.id !== undefined && !used.includes(item.id)) used.push(item.id);
            seen.renamedWindows += 1;
          }
          from = random.chance(0.6) ? random.below(history.length) : 0;
          if (from > 0) seen.shorterWindows += 1;
          else seen.fullWindows += 1;
          // A reply being streamed is in the window as the item in progress, or the stream ended with the connection.
          if (live !== null && random.chance(0.5)) live = null;
          const window = history.slice(from);
          if (live !== null) {
            window.push({ type: 'agentMessage', id: live.id, text: live.text, meta: { status: 'inProgress', at: 2 } });
          }
          streaming = null;
          trace.push(`follow ${window.map((item) => item.id)}${from > 0 ? ' (older above)' : ''}`);
          changed = true;
          lane.follow(window, from > 0, from > 0 ? {} : { cwd: '/work/project', stats: { turns: step } });
          owed = 0;
          cut = false;
          published = true;
        }
        // A frame is published after one notification or after several.
        if (!published && (step === 99 || random.chance(0.7))) {
          if (owed > 1) seen.framesOfSeveralNotes += 1;
          const before = cards();
          trace.push('frame');
          if (owed > 0) changed = true;
          lane.publish();
          const after = cards();
          // A card forms where several calls are first shown as one, and splits where the calls of one are shown apart
          // (a call between them came to show) without the thread having been cut back.
          for (const [card, count] of after) if (count > 1 && !((before.get(card) ?? 0) > 1)) seen.cardsFormed += 1;
          for (const [card, count] of before) {
            if (!cut && count > 1 && (after.get(card) ?? 0) < count) seen.cardsSplit += 1;
          }
          owed = 0;
          cut = false;
          published = true;
        }
        if (published) same(`step ${step}`);
      }
    } finally {
      lane.close();
    }
  }
  for (const [frameClass, count] of Object.entries(seen)) {
    assert.ok(count >= 40, `the sessions reached ${frameClass} only ${count} times`);
  }
});
