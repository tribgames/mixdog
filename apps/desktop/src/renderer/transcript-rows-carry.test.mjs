// What a pane derives from the lane's rows is carried on from what it derived before: a frame's unchanged rows are not
// read again, and what is carried on is what a derivation from nothing gives.
import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { createTurnIndexer } from './conversation-turn-index.ts';
import { installTestDom } from './test-support/test-dom.mjs';
import { useTranscriptRows } from './use-conversation-rows.ts';
import { carriedFirsts, carriedFrom, carriedLast, carriedSum, noteCarried, placedHash } from './list-carry.ts';
import { transcriptTurnKeys } from './renderer-logic.mjs';
import { appendLiveTranscriptRows, createSettledProjector, projectSettledTranscriptRows } from './transcript-rows.ts';
import { turnFailuresOf } from './turn-failures.ts';
import { fileChangeKey, transcriptReviewKey } from './turn-review-model.ts';
import { visualizedTargets } from './visualize-card-model.ts';

// The pane's own indexer is not exported as a map (a reader names its rows on every read); this one stands for it.
const { turnIndexOf } = createTurnIndexer(visualizedTargets);

function randomOf(seed) {
  let state = seed;
  const next = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
  return { next, pick: (list) => list[Math.floor(next() * list.length)], chance: (odds) => next() < odds };
}

/** Transcripts that change the way a session's do: rows land, a tool finishes in place, an early prompt is shown again,
 *  a turn ends (and is closed again under the same checkpoint), a rewind takes the tail, a window is replaced. */
function sessionOf(seed) {
  const random = randomOf(seed);
  let serial = 0;
  const id = (prefix) => `${prefix}${++serial}`;
  const checkpoints = [];
  const make = () => {
    const roll = random.next();
    if (roll < 0.14) {
      const checkpointId = random.chance(0.3) ? id('cp') : undefined;
      if (checkpointId) checkpoints.push(checkpointId);
      return {
        id: id('u'),
        kind: 'user',
        text: `prompt ${serial}`,
        at: serial,
        ...(checkpointId ? { checkpointId } : {}),
      };
    }
    if (roll < 0.34) {
      const text = random.chance(0.1)
        ? ' '
        : random.chance(0.3)
          ? `see [file](src/file-${serial % 7}.ts)`
          : `reply ${serial}`;
      return { id: id('a'), kind: 'assistant', text, at: serial };
    }
    if (roll < 0.72) {
      const visualize = random.chance(0.2);
      const done = random.chance(0.7);
      return {
        id: id('t'),
        kind: 'tool',
        name: visualize ? 'visualize' : random.pick(['read', 'grep', 'edit', 'agent']),
        args: visualize
          ? { action: 'open', input: { targets: [`out/page-${serial % 5}.html`] } }
          : { file_path: `src/file-${serial % 9}.ts` },
        startedAt: serial,
        ...(done ? { completedAt: serial, result: visualize ? `Opened as tab v${serial % 4}` : 'ok' } : {}),
      };
    }
    if (roll < 0.8)
      return random.chance(0.5)
        ? { id: id('n'), kind: 'notice', text: 'notice' }
        : { kind: 'notice', text: `note ${serial}` };
    if (roll < 0.84) return { id: id('s'), kind: 'statusdone', status: random.pick(['', 'compacted']) };
    const status = random.pick(['', '', 'completed', 'failed', 'cancelled']);
    return {
      id: id('d'),
      kind: 'turndone',
      status,
      ...(random.chance(0.35) && checkpoints.length ? { checkpointId: random.pick(checkpoints) } : {}),
      ...(random.chance(0.1) ? { attemptId: id('att') } : {}),
      ...(random.chance(0.05) ? { archived: true } : {}),
    };
  };
  const change = (item) => {
    if (item.kind === 'tool') return { ...item, completedAt: ++serial, result: 'done' };
    if (item.kind === 'turndone') return { ...item, status: random.pick(['', 'failed', 'cancelled']) };
    return { ...item, text: `${item.text ?? ''} (again)` };
  };
  let items = [];
  const step = () => {
    const roll = random.next();
    if (items.length === 0 || roll < 0.6) {
      const landed = Array.from({ length: 1 + Math.floor(random.next() * 3) }, make);
      items = [...items, ...landed];
    } else if (roll < 0.82) {
      // Mostly near the end (a tool finishing), sometimes anywhere (an early prompt shown again).
      const at = random.chance(0.6)
        ? Math.max(0, items.length - 1 - Math.floor(random.next() * 4))
        : Math.floor(random.next() * items.length);
      items = [...items.slice(0, at), change(items[at]), ...items.slice(at + 1)];
    } else if (roll < 0.9) {
      items = items.slice(0, Math.floor(random.next() * (items.length + 1)));
    } else if (roll < 0.95) {
      const at = Math.floor(random.next() * (items.length + 1));
      items = random.chance(0.5)
        ? [...items.slice(0, at), make(), ...items.slice(at)]
        : [...items.slice(0, at), ...items.slice(at + 1)];
    } else if (roll < 0.98) {
      items = items.slice(Math.floor(random.next() * items.length));
    } else {
      items = items.slice();
    }
    return items;
  };
  return { step, random };
}

/** A row list as a from-nothing projection under another session key would name it. */
const underKey = (rows, from, to) =>
  rows.map((row) => ({
    ...row,
    key: row.key.startsWith(`${from}:`) ? `${to}:${row.key.slice(from.length + 1)}` : row.key,
  }));

const turnsOf = (index) =>
  [...index].map(([turnKey, turn]) => ({
    turnKey,
    surfacedBefore: [...turn.surfacedBefore],
    replyText: turn.replyText,
    endedAt: turn.endedAt,
    changes: turn.changes,
    visualized: [...turn.visualized()],
    toolItems: [...turn.toolItems()],
    lastRow: turn.lastRow,
    running: turn.running,
  }));

test('the rows, turn keys, failed turns and turn index carried on through a session are the ones made from nothing', () => {
  for (const seed of [1, 7, 42, 2026, 90210]) {
    const { step, random } = sessionOf(seed);
    const projector = createSettledProjector();
    let failures;
    let shown;
    let extraFailed = [];
    for (let frame = 0; frame < 400; frame += 1) {
      const items = step();
      const where = `seed ${seed} frame ${frame} (${items.length} items)`;
      failures = turnFailuresOf(failures, items);
      const whole = turnFailuresOf(undefined, items);
      assert.deepEqual(failures.turnKeys, transcriptTurnKeys(items), `turn keys, ${where}`);
      assert.deepEqual(failures.failedTurnKeys, whole.failedTurnKeys, `failed turns, ${where}`);
      assert.equal(failures.chars, whole.chars, `key characters, ${where}`);
      // A turn the host marks failed on other grounds, now and then.
      if (random.chance(0.05)) extraFailed = random.chance(0.5) ? [] : [random.pick(failures.turnKeys) ?? ''];
      const failedTurns = new Set([...failures.failedTurnKeys, ...extraFailed]);
      const input = { items, turnKeys: failures.turnKeys, failedTurns };
      const carried = projector.project({ sessionKey: 'carried', ...input });
      const fresh = projectSettledTranscriptRows({ sessionKey: 'fresh', ...input });
      assert.deepEqual(carried.rows, underKey(fresh.rows, 'fresh', 'carried'), `rows, ${where}`);
      assert.deepEqual(
        [carried.currentTurnKey, carried.previousRowWasUser, carried.itemCount, carried.endsWithFoldedCompletion],
        [fresh.currentTurnKey, fresh.previousRowWasUser, fresh.itemCount, fresh.endsWithFoldedCompletion],
        `projection state, ${where}`
      );
      for (const probe of [items.at(-1)?.id, items[0]?.id, 'u1', 't2', 'absent']) {
        assert.equal(carried.hasSettledItem(probe), fresh.hasSettledItem(probe), `settled id ${probe}, ${where}`);
      }
      for (const row of fresh.rows.slice(-3)) {
        const key = `carried:${row.key.slice('fresh:'.length)}`;
        assert.equal(carried.hasRowKey(key), fresh.hasRowKey(row.key), `row key ${key}, ${where}`);
      }
      const live = random.chance(0.3) ? { id: 'live', kind: 'assistant', text: 'streaming', streaming: true } : null;
      shown = appendLiveTranscriptRows({
        sessionKey: 'carried',
        settled: carried,
        liveItem: live,
        thinking: random.chance(0.5),
        turnRunning: random.chance(0.5),
        prior: shown,
      });
      assert.deepEqual(
        turnsOf(turnIndexOf(shown)),
        turnsOf(createTurnIndexer(visualizedTargets).turnIndexOf(shown)),
        `turn index, ${where}`
      );
    }
  }
});

/** A session of few prompts and many agents: each turn a prompt, then rounds of tool calls with a reply after each. The
 *  arguments of every call count how often they are read. */
function watchedSession(turns = 3, rounds = 40) {
  const reads = new Map();
  const watched = (id, args) =>
    new Proxy(args, {
      get(target, key, receiver) {
        reads.set(id, (reads.get(id) ?? 0) + 1);
        return Reflect.get(target, key, receiver);
      },
    });
  const tool = (id, extra = {}) => ({
    id,
    kind: 'tool',
    name: 'read',
    args: watched(id, { file_path: `src/${id}.ts` }),
    startedAt: 1,
    ...extra,
  });
  const items = [];
  for (let turn = 0; turn < turns; turn += 1) {
    items.push({ id: `p${turn}`, kind: 'user', text: `prompt ${turn}` });
    for (let round = 0; round < rounds; round += 1) {
      items.push(tool(`t${turn}-${round}-a`, { completedAt: 2, result: 'ok' }), tool(`t${turn}-${round}-b`));
      items.push({ id: `a${turn}-${round}`, kind: 'assistant', text: `reply ${turn}-${round}` });
    }
    if (turn < turns - 1) items.push({ id: `d${turn}`, kind: 'turndone', status: 'completed' });
  }
  return { items, reads, tool };
}

/** The pane's derivations of one frame, each carried on from the frame before. */
function paneOf() {
  const projector = createSettledProjector();
  let failures;
  let shown;
  let lane;
  return (items, kept) => {
    // The lane says which rows it left in place (session-lane-store.ts).
    if (lane && kept !== undefined) noteCarried(items, lane, kept);
    lane = items;
    failures = turnFailuresOf(failures, items, kept);
    const settled = projector.project({
      sessionKey: 'pane',
      items,
      turnKeys: failures.turnKeys,
      failedTurns: new Set(failures.failedTurnKeys),
    });
    shown = appendLiveTranscriptRows({ sessionKey: 'pane', settled, thinking: true, turnRunning: true, prior: shown });
    // The turn index reads every tool round's cards (its visualize targets).
    for (const turn of turnIndexOf(shown).values()) turn.visualized();
    return shown;
  };
}

test('a frame that changes one row derives that row alone: every other row model is the one held, and no other call is read', () => {
  const { items, reads, tool } = watchedSession();
  const frame = paneOf();
  const before = frame(items);
  assert.ok(reads.size > 200, 'every call was read once to index its round');
  const changedRows = (rows) => rows.flatMap((row, at) => (row === before[at] ? [] : [at]));

  // A call in the middle of the second turn finishes.
  const at = items.findIndex((item) => item.id === 't1-20-b');
  reads.clear();
  const finished = [...items.slice(0, at), tool('t1-20-b', { completedAt: 3, result: 'ok' }), ...items.slice(at + 1)];
  const after = frame(finished, at);
  assert.equal(after.length, before.length);
  const changed = changedRows(after);
  assert.equal(changed.length, 1, 'one row model is made');
  assert.deepEqual(
    after[changed[0]].items.map((item) => item.id),
    ['t1-20-a', 't1-20-b']
  );
  assert.deepEqual([...reads.keys()], ['t1-20-b'], 'only the call that changed is read');

  // The first prompt is shown again (a bot reacted to it): no list tells the pane which rows were left in place.
  reads.clear();
  const amended = [{ ...finished[0], text: 'prompt 0 (amended)' }, ...finished.slice(1)];
  const again = frame(amended);
  assert.deepEqual(
    again.flatMap((row, index) => (row === after[index] ? [] : [index])),
    [0],
    'the prompt row is the only one made again'
  );
  assert.equal(again[0].item.text, 'prompt 0 (amended)');
  assert.deepEqual([...reads.keys()], [], 'no call is read');

  // A row lands at the end of the running turn.
  reads.clear();
  const landed = [...amended, tool('t-new')];
  const grown = frame(landed, amended.length);
  assert.equal(grown.length, again.length + 1, 'its round is a row of its own, above the live band');
  assert.deepEqual(
    grown.flatMap((row, index) => (row === again[index] ? [] : [index])),
    [again.length - 1, again.length],
    'the new round, and the live band moved below it'
  );
  assert.equal(grown.at(-1), again.at(-1), 'the live band is the row it was');
  assert.deepEqual([...reads.keys()], ['t-new']);
});

test('a pane carries its rows on through its frames: the hook that makes them reads only the call a frame changed', async (t) => {
  const { items, reads, tool } = watchedSession();
  const { restore } = installTestDom(null, { jsdom: { url: 'http://localhost/' } });
  const root = createRoot(document.getElementById('root'));
  t.after(async () => {
    await act(async () => root.unmount());
    restore();
  });
  let rows;
  // The lane's decorated snapshot of each frame (snapshot-transcript-decoration.ts), as the timeline hands it over.
  let failures;
  const Pane = ({ list }) => {
    rows = useTranscriptRows({
      identity: 'pane',
      sessionKey: 'pane',
      settledItems: list,
      settledRowItems: list,
      failedTurnKeys: failures.failedTurnKeys,
      precomputedTurnKeys: failures.turnKeys,
      pendingItems: NONE,
      liveItem: null,
      busy: true,
      commandBusy: false,
      commandActivityVisible: false,
      optimisticActivityStartedAt: 0,
    }).transcriptRows;
    for (const turn of turnIndexOf(rows).values()) turn.visualized();
    return null;
  };
  const show = async (list) => {
    failures = turnFailuresOf(failures, list);
    await act(async () => root.render(React.createElement(Pane, { list })));
    return rows;
  };
  const before = await show(items);
  reads.clear();
  const at = items.findIndex((item) => item.id === 't2-5-a');
  const after = await show([
    ...items.slice(0, at),
    tool('t2-5-a', { completedAt: 9, result: 'ok' }),
    ...items.slice(at + 1),
  ]);
  assert.deepEqual(
    after.flatMap((row, index) => (row === before[index] ? [] : [index])).map((index) => after[index].items[0].id),
    ['t2-5-a']
  );
  assert.deepEqual([...reads.keys()], ['t2-5-a']);
});

const NONE = [];

test('under a head kept above a shorter window the pane makes its own turn keys, and says which it took over from the frame before', async (t) => {
  const { items, reads, tool } = watchedSession(3, 30);
  const { restore } = installTestDom(null, { jsdom: { url: 'http://localhost/' } });
  const root = createRoot(document.getElementById('root'));
  t.after(async () => {
    await act(async () => root.unmount());
    restore();
  });
  let made;
  // The lane's keys cover the reconnect's window alone (the last ten items); the list shown has the head kept above it.
  const Pane = ({ list }) => {
    made = useTranscriptRows({
      identity: 'pane',
      sessionKey: 'pane',
      settledItems: list,
      settledRowItems: list,
      failedTurnKeys: NONE,
      precomputedTurnKeys: transcriptTurnKeys(list.slice(-10)),
      pendingItems: NONE,
      liveItem: null,
      busy: true,
      commandBusy: false,
      commandActivityVisible: false,
      optimisticActivityStartedAt: 0,
    });
    return null;
  };
  let shown = items;
  const show = async (list, kept) => {
    // The lane says which rows it left in place (session-lane-store.ts).
    if (kept !== undefined) noteCarried(list, shown, kept);
    shown = list;
    await act(async () => root.render(React.createElement(Pane, { list })));
    return made;
  };
  let before = await show(items);
  assert.deepEqual(before.settledTurnKeys, transcriptTurnKeys(items));
  // Items land one after another in the running turn: each frame's keys are the keys before, and one more.
  for (const id of ['t-new-1', 't-new-2', 't-new-3']) {
    reads.clear();
    const after = await show([...shown, tool(id)], shown.length);
    assert.deepEqual(after.settledTurnKeys, transcriptTurnKeys(shown));
    assert.deepEqual(
      carriedFrom(after.settledTurnKeys),
      { prior: before.settledTurnKeys, kept: before.settledTurnKeys.length },
      `the keys of ${id} are carried on from the keys before, all of them left in place`
    );
    assert.equal(carriedFrom(after.transcriptRows)?.prior, before.transcriptRows, 'and so are the rows');
    assert.deepEqual([...reads.keys()], [id], 'only the call that landed is read');
    before = after;
  }
  // The turn ends: its items take the key of its end, and only the keys before them are said to be left in place.
  const turnStart = shown.findLastIndex((item) => item.kind === 'user');
  const ended = await show(
    [...shown, { id: 'd-end', kind: 'turndone', status: 'completed', attemptId: 'att-1' }],
    shown.length
  );
  assert.deepEqual(ended.settledTurnKeys, transcriptTurnKeys(shown));
  const note = carriedFrom(ended.settledTurnKeys);
  assert.equal(note.prior, before.settledTurnKeys);
  assert.deepEqual(ended.settledTurnKeys.slice(0, note.kept), before.settledTurnKeys.slice(0, note.kept));
  assert.ok(note.kept >= turnStart, 'the turns closed before it keep their keys');
});

test('the turn index after a frame is the index built from nothing, with each untouched turn the entry it was', () => {
  const { items, tool } = watchedSession(4, 12);
  const frame = paneOf();
  const fromNothing = (rows) => turnsOf(createTurnIndexer(visualizedTargets).turnIndexOf(rows));
  let rows = frame(items);
  const first = turnIndexOf(rows);
  const held = new Map(first);
  assert.deepEqual(turnsOf(first), fromNothing(rows));
  // A reply lands in the running turn, then that turn ends, then a prompt opens the next.
  const steps = [
    (list) => [...list, { id: 'a-late', kind: 'assistant', text: 'see [notes](docs/notes.md)' }],
    (list) => [...list, tool('t-late', { completedAt: 5, result: 'ok' })],
    (list) => [...list, { id: 'd-last', kind: 'turndone', status: 'completed', checkpointId: 'cp1' }],
    (list) => [...list, { id: 'p-next', kind: 'user', text: 'next' }],
    // A rewind takes the new prompt and the turn's end.
    (list) => list.slice(0, -2),
  ];
  let list = items;
  for (const [at, step] of steps.entries()) {
    const next = step(list);
    rows = frame(next, Math.min(list.length, next.length));
    list = next;
    const index = turnIndexOf(rows);
    assert.deepEqual(turnsOf(index), fromNothing(rows), `after step ${at}`);
    for (const turnKey of ['turn:p0', 'turn:p1']) {
      assert.equal(index.get(turnKey), held.get(turnKey), `the entry of ${turnKey} is the one held, after step ${at}`);
    }
  }
});

test('rows older than the newest indexed are read as their own index: a render that kept them sees nothing of the newer frame', () => {
  const { turnIndexOf: indexOf, turnOf } = createTurnIndexer(visualizedTargets);
  const fromNothing = (rows) => turnsOf(createTurnIndexer(visualizedTargets).turnIndexOf(rows));
  const { items, tool } = watchedSession(3, 6);
  const frame = paneOf();
  const first = frame(items);
  const before = turnsOf(indexOf(first));
  // A frame ends the running turn and opens another: a render of it (one React may never commit) carries the index on.
  const ended = [
    ...items,
    tool('t-late', { completedAt: 5, result: 'ok' }),
    { id: 'd-last', kind: 'turndone', status: 'completed' },
    { id: 'p-next', kind: 'user', text: 'next' },
    { id: 'a-next', kind: 'assistant', text: 'see [notes](docs/notes.md)' },
  ];
  const second = frame(ended, items.length);
  assert.deepEqual(turnsOf(indexOf(second)), fromNothing(second));
  assert.ok(turnOf(second, 'turn:p-next'));
  // The pane still showing the rows before renders again: it names those rows and is told of them alone.
  assert.equal(turnOf(first, 'turn:p-next'), undefined, 'no turn of the newer frame');
  assert.equal(turnOf(first, 'turn:p2').running, true, 'its last turn still runs');
  assert.deepEqual(turnsOf(indexOf(first)), before);
  assert.deepEqual(turnsOf(indexOf(first)), fromNothing(first));
  // And the newer rows, then a frame carried on from them, read as before.
  assert.deepEqual(turnsOf(indexOf(second)), fromNothing(second));
  const third = frame([...ended, { id: 'a-more', kind: 'assistant', text: 'more' }], ended.length);
  assert.deepEqual(turnsOf(indexOf(third)), fromNothing(third));
  assert.deepEqual(turnsOf(indexOf(first)), before, 'the older rows keep their own index through it');
});

test('the keys of a session’s changes: order, a row outside the ones a review reads, and the rows it does read', () => {
  const user = { id: 'u', kind: 'user', text: 'go' };
  const patch = (id, done = true) => ({
    id,
    kind: 'tool',
    name: 'apply_patch',
    args: { patch: `*** Update File: ${id}.ts` },
    ...(done ? { completedAt: 1, result: 'ok' } : {}),
  });
  const reply = (id) => ({ id, kind: 'assistant', text: 'done' });
  const first = patch('e1');
  const second = patch('e2');
  const base = [user, first, second];

  // The worktree key is of which calls finished, not of their order: the same calls in another order finished nothing.
  assert.equal(fileChangeKey([user, second, first]), fileChangeKey(base));
  assert.equal(fileChangeKey([...base, reply('a1')]), fileChangeKey(base), 'a reply changes no file');
  assert.notEqual(fileChangeKey([user, first]), fileChangeKey(base), 'a call that left');
  assert.notEqual(fileChangeKey([...base, patch('e3')]), fileChangeKey(base), 'a call that finished');
  assert.notEqual(fileChangeKey([user, first, patch('e9')]), fileChangeKey(base), 'another call in its place');
  assert.equal(
    fileChangeKey([...base, patch('e4', false)]),
    fileChangeKey(base),
    'a running call has changed nothing yet'
  );

  // The transcript's own review reads its patch and write calls in order: the key moves with any of them, and with
  // their places, and with nothing else.
  const key = transcriptReviewKey(base);
  assert.equal(transcriptReviewKey(base.slice()), key, 'the same items in the same places');
  assert.equal(transcriptReviewKey([...base, reply('a1')]), key, 'a reply after them is not read');
  assert.equal(transcriptReviewKey([...base, { id: 'r', kind: 'tool', name: 'read', args: {}, result: 'x' }]), key);
  assert.notEqual(transcriptReviewKey([user, second, first]), key, 'the same patches in another order');
  assert.notEqual(transcriptReviewKey([user, first]), key, 'a patch that left');
  assert.notEqual(transcriptReviewKey([user, first, { ...second }]), key, 'a patch row that changed');
  assert.notEqual(transcriptReviewKey([...base, patch('e3')]), key, 'a patch that landed');
  assert.notEqual(
    transcriptReviewKey([...base, { ...patch('e5'), isError: true }]).split(':')[0],
    '3',
    'a failed patch is not read'
  );

  // A sum of hashes that carry their places tells two orders apart; one that leaves the place out does not.
  const plain = carriedSum((entry) => entry.hash);
  const placed = carriedSum((entry, index) => placedHash(entry.hash, index));
  const pair = [{ hash: 0x1234567 }, { hash: -0x7654321 }];
  const swapped = [pair[1], pair[0]];
  assert.deepEqual(plain(swapped), plain(pair));
  assert.notEqual(placed(swapped).sum, placed(pair).sum);
});

test('a sum, a last match and the first places read from a list carried on are those of the list read whole', () => {
  const random = randomOf(11);
  const countedValue = (entry) => (entry.count ? entry.value : undefined);
  const marked = (entry) => entry.count && entry.value % 3 === 0;
  const sum = carriedSum(countedValue);
  const last = carriedLast(marked);
  const firsts = carriedFirsts();
  let list = [];
  let names = [];
  for (let frame = 0; frame < 400; frame += 1) {
    const kept = Math.floor(random.next() * (list.length + 1));
    const landed = Array.from({ length: Math.floor(random.next() * 4) }, () => ({
      count: random.chance(0.7),
      value: Math.floor(random.next() * 0xffffffff) | 0,
    }));
    const next = [...list.slice(0, kept), ...landed];
    const nextNames = [...names.slice(0, kept), ...landed.map((entry) => `name ${Math.abs(entry.value) % 6}`)];
    if (random.chance(0.8)) {
      noteCarried(next, list, kept);
      noteCarried(nextNames, names, kept);
    }
    list = next;
    names = nextNames;
    assert.deepEqual(sum(list), carriedSum(countedValue)(list), `sum, frame ${frame}`);
    assert.equal(last(list), list.findLastIndex(marked), `last match, frame ${frame}`);
    assert.deepEqual(
      [...firsts(names)].sort(),
      [...new Set(names)].map((name) => [name, names.indexOf(name)]).sort(),
      `first places, frame ${frame}`
    );
  }
  // The key a session's file changes are read under moves with a finished write, carried on or not.
  const edit = (id, done) => ({
    id,
    kind: 'tool',
    name: 'edit',
    args: { file_path: 'a.ts' },
    ...(done ? { completedAt: 1 } : {}),
  });
  const running = [{ id: 'u', kind: 'user', text: 'go' }, edit('e1', true), edit('e2', false)];
  const finished = [...running.slice(0, 2), edit('e2', true)];
  const key = fileChangeKey(running);
  noteCarried(finished, running, 2);
  assert.notEqual(fileChangeKey(finished), key);
  assert.equal(fileChangeKey(finished), fileChangeKey(finished.slice()));
  assert.equal(fileChangeKey(running.slice()), key);
});
