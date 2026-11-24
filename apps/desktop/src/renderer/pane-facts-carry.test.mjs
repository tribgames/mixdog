// What a pane keeps of a transcript besides its rows (the review's turn, the ids that settled, the hand-off lines, the
// seats of cards and peeks) is carried on from the list a frame made it from: it is what a reading from nothing gives, and
// a frame is read from the rows it did not leave in place.
import assert from 'node:assert/strict';
import test from 'node:test';
import { installTestDom } from './test-support/test-dom.mjs';

installTestDom(null, {
  html: '<!doctype html><html><body></body></html>',
  jsdom: { url: 'https://mixdog.test/' },
  expose: ['HTMLElement', 'navigator'],
});

const { handoffLinesAt, roomQuestionSeatsAt, taskReportHidden } = await import('./agent-chat-place.ts');
const { askUserCardKey } = await import('./ask-user-record.tsx');
const { lastBrowserRoundOfTurn } = await import('./browser-peek-line.tsx');
const { childSurfacePeeksAt } = await import('./child-surface-peeks.tsx');
const { itemPlacesById, pendingPromptTranscriptItems, unsettledQueueEntries } = await import(
  './conversation-prompt-items.ts'
);
const { carriedFirsts, carriedLatest, carriedSum, noteCarried, placedHash, sharedPrefix } = await import(
  './list-carry.ts'
);
const { turnReviewScope } = await import('./turn-review-scope.ts');
const { fileChangeKey, transcriptReviewKey } = await import('./turn-review-model.ts');

function randomOf(seed) {
  let state = seed;
  const next = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
  return { next, pick: (list) => list[Math.floor(next() * list.length)], chance: (odds) => next() < odds };
}

/** Lists that change the way a session's do: entries land, one near the end changes in place, the tail is taken back,
 *  now and then one far up changes or the whole window is replaced. Most frames say which entries they left in place. */
function framesOf(random, make, change) {
  let list = [];
  return () => {
    const roll = random.next();
    let next;
    if (list.length === 0 || roll < 0.6) {
      next = [...list, ...Array.from({ length: 1 + Math.floor(random.next() * 3) }, make)];
    } else if (roll < 0.85) {
      const at = random.chance(0.7)
        ? Math.max(0, list.length - 1 - Math.floor(random.next() * 4))
        : Math.floor(random.next() * list.length);
      next = [...list.slice(0, at), change(list[at]), ...list.slice(at + 1)];
    } else if (roll < 0.93) {
      next = list.slice(0, Math.floor(random.next() * (list.length + 1)));
    } else if (roll < 0.97) {
      const at = Math.floor(random.next() * (list.length + 1));
      next = random.chance(0.5) ? [...list.slice(0, at), make(), ...list.slice(at)] : list.toSpliced(at, 1);
    } else {
      next = list.slice(Math.floor(random.next() * list.length));
    }
    if (random.chance(0.85)) noteCarried(next, list, sharedPrefix(next, list));
    list = next;
    return list;
  };
}

/** The turn a review is of, read from the whole list: the function as it stood before it was carried on. */
function wholeTurnReviewScope(transcript) {
  const keyOf = (item, index) =>
    item?.id !== undefined && item?.id !== null
      ? String(item.id)
      : `${item?.kind || 'item'}:${item?.text || item?.label || item?.status || ''}:${index}`;
  let activeStart = -1;
  let latestStart = -1;
  for (let index = 0; index < transcript.length; index += 1) {
    const item = transcript[index];
    if (item?.kind === 'user' && activeStart < 0) {
      activeStart = index;
      latestStart = index;
    }
    if (item?.kind === 'turndone') activeStart = -1;
  }
  const startIndex = activeStart >= 0 ? activeStart : latestStart;
  let hasActivity = false;
  for (let index = startIndex + 1; index < transcript.length; index += 1) {
    const item = transcript[index];
    if (item && item.kind !== 'user') {
      hasActivity = true;
      break;
    }
  }
  return {
    startIndex,
    key: startIndex >= 0 ? keyOf(transcript[startIndex], startIndex) : 'none',
    hasActivity,
    truncated: startIndex < 0 && transcript.length > 0,
  };
}

function itemMaker(random) {
  let serial = 0;
  const id = (prefix) => `${prefix}${++serial}`;
  const make = () => {
    const roll = random.next();
    if (roll < 0.12) {
      return { ...(random.chance(0.9) ? { id: id('u') } : {}), kind: 'user', text: `prompt ${serial}`, at: ++serial };
    }
    if (roll < 0.3) return { id: id('a'), kind: 'assistant', text: `reply ${serial}` };
    if (roll < 0.36) return { id: id('q'), kind: 'tool', name: 'ask_user', args: { questions: [] } };
    if (roll < 0.8) {
      return {
        id: id('t'),
        kind: 'tool',
        name: random.pick(['read', 'edit', 'write', 'apply_patch']),
        args: { file_path: `src/file-${serial % 9}.ts`, content: 'line\n' },
        ...(random.chance(0.6) ? { completedAt: ++serial, result: 'ok' } : {}),
      };
    }
    if (roll < 0.9) return { id: id('n'), kind: 'notice', text: 'notice' };
    return { id: id('d'), kind: random.pick(['turndone', 'turndone', 'statusdone']), status: 'completed' };
  };
  const change = (item) => {
    if (item.kind === 'tool') return { ...item, completedAt: ++serial, result: 'done' };
    return { ...item, text: `${item.text ?? ''} (again)` };
  };
  return { make, change };
}

test('what a pane keeps of the items carried on through a session is what the items read whole give', () => {
  for (const seed of [3, 19, 77, 2027]) {
    const random = randomOf(seed);
    const { make, change } = itemMaker(random);
    const frame = framesOf(random, make, change);
    for (let step = 0; step < 300; step += 1) {
      const items = frame();
      const whole = items.slice();
      const where = `seed ${seed} frame ${step} (${items.length} items)`;
      assert.deepEqual(turnReviewScope(items), wholeTurnReviewScope(items), `review scope, ${where}`);
      const firsts = new Map();
      items.forEach((item, at) => {
        if (item.id !== undefined && !firsts.has(item.id)) firsts.set(item.id, at);
      });
      assert.deepEqual([...itemPlacesById(items)].sort(), [...firsts].sort(), `item places, ${where}`);
      const waitingId = random.chance(0.5) ? (random.pick(items)?.id ?? 'absent') : 'absent';
      const waiting = [{ id: waitingId, kind: 'user', text: 'sent', submittedAt: 1 }];
      assert.deepEqual(
        pendingPromptTranscriptItems(waiting, items),
        pendingPromptTranscriptItems(waiting, whole),
        `waiting prompts, ${where}`
      );
      const queue = [{ id: waitingId }, { id: 'absent' }, {}];
      assert.deepEqual(unsettledQueueEntries(queue, items), unsettledQueueEntries(queue, whole), `queue, ${where}`);
      assert.equal(askUserCardKey(items, ''), askUserCardKey(whole, ''), `question card, ${where}`);
      assert.equal(fileChangeKey(items), fileChangeKey(whole), `file changes, ${where}`);
      assert.equal(transcriptReviewKey(items), transcriptReviewKey(whole), `review items, ${where}`);
    }
  }
});

const DAY = new Date(2026, 9, 27, 10, 10).getTime();
const SHOWN = 'Shown in the browser panel: page p4 — Quarterly (report) (https://dart.example/main.do).';

function rowMaker(random) {
  let serial = 0;
  let turn = 0;
  const key = (prefix) => `${prefix}${++serial}`;
  const sessions = ['sess_a', 'sess_b', 'sess_c'];
  const sends = [];
  const send = () => {
    const id = key('c');
    const sessionId = random.pick(sessions);
    const sendId = random.chance(0.85) ? `s-${id}` : '';
    if (sendId) sends.push([sessionId, sendId]);
    return {
      kind: 'tool',
      id,
      name: 'session',
      args: { action: 'send', session_id: sessionId, prompt: id },
      result: JSON.stringify({ sessionId, accepted: true, reportsBack: true, ...(sendId ? { sendId } : {}) }),
      status: 'done',
      startedAt: DAY + serial,
    };
  };
  const make = () => {
    const turnKey = `t${turn}`;
    const roll = random.next();
    if (roll < 0.08) {
      turn += 1;
      const id = key('u');
      return { _tag: 'UserMessage', key: id, turnKey: `t${turn}`, item: { kind: 'user', id, at: DAY + serial } };
    }
    if (roll < 0.3) {
      const id = key('a');
      const text = random.chance(0.1) ? '' : 'Sent';
      return {
        _tag: 'AssistantPart',
        key: id,
        turnKey,
        ...(random.chance(0.2) ? { live: true } : {}),
        item: { kind: 'assistant', id, text, at: DAY + serial },
      };
    }
    if (roll < 0.36) return { _tag: 'Thinking', key: key('k'), turnKey };
    if (roll < 0.56) {
      const items = Array.from({ length: 1 + Math.floor(random.next() * 2) }, send);
      return { _tag: 'ToolActivity', key: key('r'), turnKey, items };
    }
    if (roll < 0.64) {
      const open = { kind: 'tool', id: key('o'), name: 'browser', args: { action: 'open', input: {} }, result: SHOWN };
      return {
        _tag: 'ToolActivity',
        key: key('r'),
        turnKey,
        items: [{ ...open, completedAt: 1, startedAt: DAY + serial }],
      };
    }
    if (roll < 0.7) {
      const read = { kind: 'tool', id: key('f'), name: 'read', args: { path: 'a' }, result: 'ok', completedAt: 1 };
      return { _tag: 'ToolActivity', key: key('r'), turnKey, items: [{ ...read, startedAt: DAY + serial }] };
    }
    if (roll < 0.9) {
      const id = key('n');
      const status = random.pick(['working', 'working', 'blocked', 'completed', 'failed']);
      const [sessionId, sendId] = sends.length && random.chance(0.7) ? random.pick(sends) : [random.pick(sessions), ''];
      const routine = { kind: 'task', sessionId, status, line: `progress ${serial}`, ...(sendId ? { sendId } : {}) };
      return { _tag: 'AssistantPart', key: id, turnKey, item: { kind: 'notice', id, routine, at: DAY + serial } };
    }
    if (roll < 0.96) {
      const id = key('s');
      const room = { kind: 'speech', speaker: random.pick(['m1', 'm2', 'm3']) };
      return { _tag: 'AssistantPart', key: id, turnKey, item: { kind: 'notice', id, room, at: DAY + serial } };
    }
    return { _tag: 'TurnGap', key: key('g'), turnKey };
  };
  const change = (row) => {
    if (row._tag === 'ToolActivity') return { ...row, items: [...row.items, send()] };
    if (row._tag === 'AssistantPart') return { ...row, live: !row.live, item: { ...row.item } };
    return { ...row };
  };
  return { make, change };
}

const WAITING = new Set(['sess_a', 'sess_c']);
const ASKING = ['m1', 'm3', 'm4'];
const PEEKS = [100, 900, 2500, 9e15].map((offset, at) => ({
  childSessionId: `sub-${at}`,
  childName: 'child',
  surface: 'browser',
  title: '',
  tabId: '',
  failed: '',
  at: DAY + offset,
}));

/** What every row of `rows` carries: its hand-off lines, whether its task report is hidden, its question seats, its
 *  browser line and its child lines. */
const carriedByRows = (rows) =>
  rows.map((_, index) => ({
    lines: handoffLinesAt(rows, index),
    hidden: taskReportHidden(rows, index, WAITING),
    seats: roomQuestionSeatsAt(rows, index, ASKING),
    page: lastBrowserRoundOfTurn(rows, index),
    peeks: childSurfacePeeksAt(rows, index, PEEKS).map((peek) => peek.childSessionId),
  }));

test('what the rows carry (hand-off lines, hidden reports, question seats, browser and child lines) is what the rows read whole carry', () => {
  for (const seed of [5, 23, 404, 31337]) {
    const random = randomOf(seed);
    const { make, change } = rowMaker(random);
    const frame = framesOf(random, make, change);
    let lined = 0;
    for (let step = 0; step < 250; step += 1) {
      const rows = frame();
      const carried = carriedByRows(rows);
      assert.deepEqual(carried, carriedByRows(rows.slice()), `seed ${seed} frame ${step} (${rows.length} rows)`);
      lined += carried.filter((row) => row.lines.length > 0).length;
    }
    assert.ok(lined > 100, `the session of seed ${seed} painted hand-off lines`);
  }
});

/** Entries that count every read of a field, by `name`. */
function watching(reads) {
  return (name, entry) =>
    new Proxy(entry, {
      get(target, field, receiver) {
        if (typeof field === 'string') reads.set(name, (reads.get(name) ?? 0) + 1);
        return Reflect.get(target, field, receiver);
      },
    });
}

test('a frame that lands one item reads that item, and the prompt the review is of, for what the pane keeps of the list', () => {
  const reads = new Map();
  const watch = watching(reads);
  const items = [];
  for (let turn = 0; turn < 3; turn += 1) {
    items.push(watch(`p${turn}`, { id: `p${turn}`, kind: 'user', text: 'go', device: 'PC' }));
    for (let round = 0; round < 120; round += 1) {
      const id = `t${turn}-${round}`;
      items.push(
        watch(id, { id, kind: 'tool', name: 'edit', args: { file_path: 'a.ts' }, completedAt: 1, result: 'ok' })
      );
    }
    if (turn < 2) items.push(watch(`d${turn}`, { id: `d${turn}`, kind: 'turndone', status: 'completed' }));
  }
  const waiting = [{ id: 'sent-1', kind: 'user', text: 'sent', submittedAt: 1 }];
  const queue = [{ id: 'sent-1' }];
  const keep = (list) => [
    turnReviewScope(list).key,
    itemPlacesById(list).get('t1-7'),
    pendingPromptTranscriptItems(waiting, list).length,
    unsettledQueueEntries(queue, list).length,
    askUserCardKey(list, ''),
    fileChangeKey(list),
    transcriptReviewKey(list),
  ];
  const before = keep(items);
  assert.ok(reads.size === items.length, 'every item was read once to begin with');

  reads.clear();
  const landed = [
    ...items,
    watch('t-new', { id: 't-new', kind: 'tool', name: 'edit', args: {}, completedAt: 2, result: 'ok' }),
  ];
  noteCarried(landed, items, items.length);
  const after = keep(landed);
  assert.deepEqual(
    [...reads.keys()].sort(),
    ['p2', 't-new'],
    'the row that landed, and the prompt the review is keyed by'
  );
  assert.deepEqual(after.slice(0, 5), before.slice(0, 5));
  assert.notEqual(after[5], before[5], 'a finished edit moves the file-change key');
  assert.deepEqual(after, keep(landed.slice()), 'and the list read whole gives the same');
});

/** Three turns of a hundred rounds each, four of them hand-offs left open: every row counts its reads. */
function openHandoffRows(watch) {
  const send = (id, sessionId) => ({
    kind: 'tool',
    id,
    name: 'session',
    args: { action: 'send', session_id: sessionId, prompt: id },
    result: JSON.stringify({ sessionId, accepted: true, sendId: `s-${id}`, reportsBack: true }),
    status: 'done',
  });
  const rows = [];
  for (let turn = 0; turn < 3; turn += 1) {
    const turnKey = `t${turn}`;
    rows.push(
      watch(`u${turn}`, { _tag: 'UserMessage', key: `u${turn}`, turnKey, item: { kind: 'user', id: `u${turn}` } })
    );
    for (let round = 0; round < 100; round += 1) {
      const id = `${turn}-${round}`;
      const items = [
        round % 25 === 0 ? send(`c${id}`, `sess_${id}`) : { kind: 'tool', id: `f${id}`, name: 'read', args: {} },
      ];
      rows.push(watch(`r${id}`, { _tag: 'ToolActivity', key: `r${id}`, turnKey, items }));
      const item = { kind: 'assistant', id: `a${id}`, text: 'Sent' };
      rows.push(watch(`a${id}`, { _tag: 'AssistantPart', key: `a${id}`, turnKey, item }));
    }
  }
  return rows;
}

test('a row that lands under hundreds of rows with open hand-offs is the only row read to place their lines', () => {
  const reads = new Map();
  const watch = watching(reads);
  const rows = openHandoffRows(watch);
  const linesOf = (list) =>
    list.flatMap((_, index) => handoffLinesAt(list, index).map((line) => `${index}:${line.id}`));
  const before = linesOf(rows);
  assert.equal(before.length, 12, 'four open hand-offs a turn');
  assert.ok(reads.size === rows.length);

  reads.clear();
  const reply = {
    _tag: 'AssistantPart',
    key: 'a-new',
    turnKey: 't2',
    item: { kind: 'assistant', id: 'a-new', text: 'More' },
  };
  const landed = [...rows, watch('a-new', reply)];
  noteCarried(landed, rows, rows.length);
  const after = linesOf(landed);
  assert.deepEqual(after, linesOf(landed.slice()), 'the lines are those of the rows read whole');
  assert.deepEqual(after.slice(0, 8), before.slice(0, 8), 'the ended turns keep their lines where they were');
  assert.ok(
    after.slice(8).every((line) => line.startsWith(`${landed.length - 1}:`)),
    'the running turn carries its lines at its new reply'
  );
  // The copy read whole above read every row; what the carried list read is counted from before it.
  reads.clear();
  const again = [...landed, watch('a-next', { ...reply, key: 'a-next', item: { ...reply.item, id: 'a-next' } })];
  noteCarried(again, landed, landed.length);
  linesOf(again);
  assert.deepEqual(
    [...reads.keys()],
    ['a-next'],
    'the new reply: the ended turns are not read to place their lines again'
  );
});

test('text streaming in the newest turn leaves the hand-off lines of every turn as placed: only the streaming row is read', () => {
  const reads = new Map();
  const watch = watching(reads);
  const rows = openHandoffRows(watch);
  const anchors = [
    rows.findLastIndex((row) => row.turnKey === 't0'),
    rows.findLastIndex((row) => row.turnKey === 't1'),
  ];
  const streaming = (text) =>
    watch('live', {
      _tag: 'AssistantPart',
      key: 'live',
      turnKey: 't2',
      live: true,
      item: { kind: 'assistant', id: 'live', text },
    });
  // The reply opens: the newest turn's lines move under it, the older turns' stay.
  let shown = [...rows, streaming('W')];
  noteCarried(shown, rows, rows.length);
  handoffLinesAt(rows, 0);
  const placed = [...anchors, shown.length - 1].map((at) => handoffLinesAt(shown, at));
  assert.deepEqual(
    placed.map((lines) => lines.length),
    [4, 4, 4]
  );
  for (const text of ['Wo', 'Wor', 'Work', 'Working']) {
    reads.clear();
    const next = [...rows, streaming(text)];
    noteCarried(next, shown, rows.length);
    shown = next;
    [...anchors, shown.length - 1].forEach((at, turn) => {
      assert.equal(
        handoffLinesAt(shown, at),
        placed[turn],
        `the lines of turn ${turn} are the ones placed, at "${text}"`
      );
    });
    assert.deepEqual([...reads.keys()], ['live'], `only the streaming row is read, at "${text}"`);
    const whole = shown.slice();
    assert.deepEqual(
      shown.map((_, at) => handoffLinesAt(shown, at)),
      whole.map((_, at) => handoffLinesAt(whole, at)),
      `and they are the lines of the rows read whole, at "${text}"`
    );
  }
});

test('the newest entry of each key, the first place of each key and a sum with places are those of the list read whole', () => {
  const random = randomOf(29);
  const entryOf = (entry, index) => (entry.says ? [entry.name, `${entry.value}@${index}`] : undefined);
  const latest = carriedLatest(entryOf);
  const firsts = carriedFirsts((entry) => (entry.says ? entry.name : undefined));
  const placed = carriedSum((entry, index) => placedHash(entry.value, index));
  let value = 0;
  const make = () => ({ name: `name ${Math.floor(random.next() * 5)}`, says: random.chance(0.7), value: ++value });
  const frame = framesOf(random, make, (entry) => ({ ...entry, says: !entry.says }));
  for (let step = 0; step < 400; step += 1) {
    const list = frame();
    const newest = new Map();
    const first = new Map();
    list.forEach((entry, index) => {
      if (!entry.says) return;
      newest.set(entry.name, `${entry.value}@${index}`);
      if (!first.has(entry.name)) first.set(entry.name, index);
    });
    assert.deepEqual([...latest(list)].sort(), [...newest].sort(), `newest, frame ${step}`);
    assert.deepEqual([...firsts(list)].sort(), [...first].sort(), `first places, frame ${step}`);
    assert.deepEqual(
      placed(list),
      carriedSum((entry, index) => placedHash(entry.value, index))(list),
      `sum, frame ${step}`
    );
  }
});

test('the map made for a list stays that list’s: a frame carried on from it changes a map of its own', () => {
  const latest = carriedLatest((entry) => [entry.name, entry.value]);
  const first = [
    { name: 'a', value: 1 },
    { name: 'b', value: 2 },
  ];
  const held = latest(first);
  const second = [first[0], { name: 'b', value: 3 }, { name: 'c', value: 4 }];
  noteCarried(second, first, 1);
  assert.deepEqual(
    [...latest(second)],
    [
      ['a', 1],
      ['b', 3],
      ['c', 4],
    ]
  );
  assert.deepEqual(
    [...held],
    [
      ['a', 1],
      ['b', 2],
    ],
    'the map a reader holds for the list before is as it was'
  );
  assert.equal(latest(first), held);
  // A frame that says nothing new keeps the map made before.
  const third = [...second];
  noteCarried(third, second, second.length);
  assert.equal(latest(third), latest(second));
});
