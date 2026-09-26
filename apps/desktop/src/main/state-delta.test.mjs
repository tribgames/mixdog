import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createSnapshotDeltaDecoder,
  createSnapshotDeltaEncoder,
  isNoDelta,
  markCompactWire,
  reconcileSessionProjection,
} from './state-delta.ts';
import { viewResumeLane } from '../shared/remote-view-resume.ts';

for (const compact of [false, true]) {
  for (const changeBusy of [false, true]) {
    test(`cancelled suffixes and empty transcripts survive the wire (compact=${compact}, busy change=${changeBusy})`, () => {
      const encoder = createSnapshotDeltaEncoder({ compact });
      const decoder = createSnapshotDeltaDecoder();
      const retained = { id: 'retained', kind: 'assistant', text: 'previous answer' };
      const cancelled = { id: 'cancelled', kind: 'user', text: 'restore this prompt' };
      const nextPrompt = { id: 'next', kind: 'user', text: 'new request' };
      const deliver = (snapshot) => {
        const encoded = encoder.encode(snapshot);
        assert.equal(isNoDelta(encoded), false, 'a transcript change must be delivered');
        const wire = JSON.parse(JSON.stringify(encoded));
        if (compact && !Object.hasOwn(wire, '__itemsRevision')) markCompactWire(wire);
        const decoded = decoder.decode(wire);
        assert.equal(decoded.ok, true);
        assert.deepEqual(decoded.snapshot.items, snapshot.items);
      };
      const first = { sessionId: 'session', items: [retained, cancelled], busy: true };
      deliver(first);
      const restored = { ...first, items: [retained], busy: !changeBusy };
      deliver(restored);
      deliver({ ...restored, items: [retained, nextPrompt], busy: true });
      deliver({ ...restored, items: [] });
      // A new turn after clearing must not splice onto the cancelled history.
      deliver({ ...restored, items: [nextPrompt], busy: true });
    });
  }
}

const row = (id) => ({ id, kind: 'assistant', text: `row ${id} `.repeat(40) });
const received = (encoded, compact) => {
  const wire = JSON.parse(JSON.stringify(encoded));
  if (compact && !Object.hasOwn(wire, '__itemsRevision')) markCompactWire(wire);
  return wire;
};

for (const compact of [false, true]) {
  test(`an older-history page travels as the revealed rows only (compact=${compact})`, () => {
    const encoder = createSnapshotDeltaEncoder({ compact, prepend: true });
    const decoder = createSnapshotDeltaDecoder();
    const held = ['r0', 'r1', 'r2', 'r3'].map(row);
    const first = { sessionId: 'session', items: held, transcriptHasOlder: true };
    const baseline = decoder.decode(received(encoder.encode(first), compact));
    assert.equal(baseline.ok, true);
    const heldOnClient = baseline.snapshot.items;

    const revealed = ['h0', 'h1', 'h2'].map(row);
    // The page lands together with a live append at the tail.
    const tail = row('t0');
    const paged = { ...first, items: [...revealed, ...held, tail] };
    const encoded = encoder.encode(paged);
    const patch = compact ? encoded.ip : encoded.__itemsPatch;
    assert.deepEqual(compact ? patch.h : patch.prepend, revealed, 'only the revealed rows travel');
    assert.equal(compact ? patch.p : patch.prefix, held.length, 'every held row is kept');
    assert.deepEqual(compact ? patch.a : patch.append, [tail]);
    assert.ok(JSON.stringify(encoded).length < JSON.stringify(paged).length * 0.6);

    const decoded = decoder.decode(received(encoded, compact));
    assert.equal(decoded.ok, true);
    assert.deepEqual(decoded.snapshot.items, paged.items);
    // The rows already delivered stay the client's own objects.
    for (let index = 0; index < held.length; index += 1) {
      assert.equal(decoded.snapshot.items[revealed.length + index], heldOnClient[index]);
    }

    // The stream continues from the grown baseline.
    const next = encoder.encode({ ...paged, items: [...paged.items, row('t1')] });
    const appended = decoder.decode(received(next, compact));
    assert.equal(appended.ok, true);
    assert.deepEqual(
      appended.snapshot.items.map((item) => item.id),
      ['h0', 'h1', 'h2', 'r0', 'r1', 'r2', 'r3', 't0', 't1']
    );
  });

  test(`a peer that never announced prepend keeps receiving the whole list (compact=${compact})`, () => {
    const encoder = createSnapshotDeltaEncoder({ compact });
    const decoder = createSnapshotDeltaDecoder();
    const held = ['r0', 'r1'].map(row);
    decoder.decode(received(encoder.encode({ sessionId: 'session', items: held }), compact));
    const paged = { sessionId: 'session', items: [row('h0'), ...held] };
    const encoded = encoder.encode(paged);
    const patch = compact ? encoded.ip : encoded.__itemsPatch;
    assert.equal(compact ? patch.p : patch.prefix, 0);
    assert.equal((compact ? patch.a : patch.append).length, 3);
    assert.equal(Object.hasOwn(patch, compact ? 'h' : 'prepend'), false);
    assert.deepEqual(decoder.decode(received(encoded, compact)).snapshot.items, paged.items);
  });
}

// A realistic capped history: 50 newest-first prompts of ~1.3KB each, about
// the 68KB field the relay meter caught riding every submit.
const prompt = (index) => `prompt ${index}: ${'please look at the remote relay traffic again '.repeat(28)}`.trim();
const HISTORY_CAP = 50;
const fullHistory = Array.from({ length: HISTORY_CAP }, (_, index) => prompt(index));
const historyItems = [row('r0')];
const historySnapshot = (promptHistoryList, extra = {}) => ({
  sessionId: 'session',
  items: historyItems,
  streamingTail: null,
  busy: false,
  promptHistoryList,
  ...extra,
});
const resumeDigestsMatch = async (encoder, decoder) => {
  const [sent, held] = await Promise.all([
    viewResumeLane(encoder.resumePoint()),
    viewResumeLane(decoder.resumePoint()),
  ]);
  return sent !== null && held !== null && sent.revision === held.revision && sent.digest === held.digest;
};

for (const compact of [false, true]) {
  const statePatchOf = (encoded) =>
    compact ? { changed: encoded.sc, lists: encoded.sl } : encoded.__statePatch;

  test(`a submit on a full prompt history travels as the new prompt only (compact=${compact})`, async (t) => {
    const encoder = createSnapshotDeltaEncoder({ compact, historyPatch: true });
    const decoder = createSnapshotDeltaDecoder();
    const first = historySnapshot(fullHistory);
    assert.equal(decoder.decode(received(encoder.encode(first), compact)).ok, true);

    // Newest first, capped: the submitted prompt goes in front and the
    // oldest one falls off the end.
    let history = fullHistory;
    for (let submit = 0; submit < 3; submit += 1) {
      const submitted = `fresh prompt ${submit}`;
      history = [submitted, ...history].slice(0, HISTORY_CAP);
      const next = historySnapshot(history, { busy: true });
      const encoded = encoder.encode(next);
      const patch = statePatchOf(encoded);
      assert.deepEqual(patch.lists.promptHistoryList, { h: [submitted], k: HISTORY_CAP - 1 });
      assert.equal(Object.hasOwn(patch.changed ?? {}, 'promptHistoryList'), false, 'the field is not re-sent');
      const patchBytes = JSON.stringify(encoded).length;
      const fullFieldBytes = JSON.stringify(history).length;
      assert.ok(patchBytes * 50 < fullFieldBytes, `patch ${patchBytes} bytes vs field ${fullFieldBytes} bytes`);
      if (submit === 0) t.diagnostic(`submit frame ${patchBytes} bytes; whole field ${fullFieldBytes} bytes`);

      const decoded = decoder.decode(received(encoded, compact));
      assert.equal(decoded.ok, true);
      assert.deepEqual(decoded.snapshot, next);
      assert.ok(await resumeDigestsMatch(encoder, decoder), 'the resume digest matches after a patched update');
    }

    // Growing below the cap keeps every held entry.
    const short = ['b', 'a'];
    const growing = createSnapshotDeltaEncoder({ compact, historyPatch: true });
    const growingDecoder = createSnapshotDeltaDecoder();
    growingDecoder.decode(received(growing.encode(historySnapshot(short)), compact));
    const grown = historySnapshot(['d', 'c', ...short]);
    const encoded = growing.encode(grown);
    assert.deepEqual(statePatchOf(encoded).lists.promptHistoryList, { h: ['d', 'c'], k: 2 });
    assert.deepEqual(growingDecoder.decode(received(encoded, compact)).snapshot, grown);
  });

  test(`rewind, abort, truncation and reorder send the whole prompt history (compact=${compact})`, async () => {
    const encoder = createSnapshotDeltaEncoder({ compact, historyPatch: true });
    const decoder = createSnapshotDeltaDecoder();
    decoder.decode(received(encoder.encode(historySnapshot(fullHistory)), compact));
    const changes = [
      ['rewind drops the newest prompt', (list) => list.slice(1)],
      ['abort hands a middle prompt back to the draft', (list) => [...list.slice(0, 3), ...list.slice(4)]],
      // Keeping the newest entry in place and cutting the rest is exactly a
      // "held index 0 moved to the front" patch, so it need not fall back.
      ['truncation with nothing new', (list) => list.slice(0, 20), (list) => ({ h: [list[0]], k: 19, x: 0 })],
      ['two held prompts swap places', (list) => [list[0], list[1], list[3], list[2], ...list.slice(4)]],
      ['two held prompts move to the front at once', (list) => [list[4], list[7], ...list.filter((_, i) => i !== 4 && i !== 7)]],
      ['truncation to a single entry', (list) => list.slice(0, 1)],
      ['a new project swaps the whole list', () => ['other project prompt']],
      ['an emptied history', () => []],
      ['a history rebuilt from nothing', () => fullHistory.slice(0, 4)],
    ];
    let history = fullHistory;
    for (const [label, change, expectedPatch] of changes) {
      history = change(history);
      const next = historySnapshot(history);
      const encoded = encoder.encode(next);
      const patch = statePatchOf(encoded);
      if (expectedPatch) {
        assert.deepEqual(patch.lists.promptHistoryList, expectedPatch(history), `${label}: exact head patch`);
      } else {
        assert.equal(patch.lists, undefined, `${label}: no head patch`);
        assert.deepEqual(patch.changed.promptHistoryList, history, `${label}: the whole field travels`);
      }
      const decoded = decoder.decode(received(encoded, compact));
      assert.equal(decoded.ok, true, label);
      assert.deepEqual(decoded.snapshot, next, label);
      assert.ok(await resumeDigestsMatch(encoder, decoder), `${label}: resume digest`);
    }
  });

  test(`re-sending a held prompt moves it to the front as a small patch (compact=${compact})`, async (t) => {
    const encoder = createSnapshotDeltaEncoder({ compact, historyPatch: true });
    const decoder = createSnapshotDeltaDecoder();
    decoder.decode(received(encoder.encode(historySnapshot(fullHistory)), compact));
    let history = fullHistory;
    // From the middle, the tail (the oldest held entry), the second slot, and
    // after a fresh submit has already shifted the list.
    const resends = [
      [25, { x: 25 }],
      [HISTORY_CAP - 1, {}],
      [1, { x: 1 }],
      ['fresh', {}],
      [10, { x: 10 }],
    ];
    for (const [index, expected] of resends) {
      const moved = index === 'fresh' ? 'a fresh prompt' : history[index];
      history = [moved, ...history.filter((entry) => entry !== moved)].slice(0, HISTORY_CAP);
      const next = historySnapshot(history);
      const encoded = encoder.encode(next);
      const patch = statePatchOf(encoded);
      assert.deepEqual(patch.lists.promptHistoryList, { h: [moved], k: HISTORY_CAP - 1, ...expected }, `re-send ${index}`);
      assert.equal(Object.hasOwn(patch.changed ?? {}, 'promptHistoryList'), false);
      const patchBytes = JSON.stringify(encoded).length;
      assert.ok(patchBytes * 20 < JSON.stringify(history).length, `re-send ${index}: ${patchBytes} bytes`);
      if (index === 25) t.diagnostic(`move-to-front frame ${patchBytes} bytes; whole field ${JSON.stringify(history).length} bytes`);
      const decoded = decoder.decode(received(encoded, compact));
      assert.equal(decoded.ok, true);
      assert.deepEqual(decoded.snapshot, next);
      assert.ok(await resumeDigestsMatch(encoder, decoder), `re-send ${index}: resume digest`);
    }

    // The common case: a short repeated prompt ("ㄱㄱ") sitting in a capped
    // history of long ones, and the same below the cap.
    for (const held of [
      [...fullHistory.slice(0, 30), 'ㄱㄱ', ...fullHistory.slice(30, HISTORY_CAP - 1)],
      ['체크', 'ㅊㅋ', 'ㄱㄱ', 'first'],
    ]) {
      const short = createSnapshotDeltaEncoder({ compact, historyPatch: true });
      const shortDecoder = createSnapshotDeltaDecoder();
      shortDecoder.decode(received(short.encode(historySnapshot(held)), compact));
      const at = held.indexOf('ㄱㄱ');
      const resent = historySnapshot(['ㄱㄱ', ...held.filter((entry) => entry !== 'ㄱㄱ')]);
      const encoded = short.encode(resent);
      assert.deepEqual(statePatchOf(encoded).lists.promptHistoryList, { h: ['ㄱㄱ'], k: held.length - 1, x: at });
      const bytes = Buffer.byteLength(JSON.stringify(encoded));
      const fieldBytes = Buffer.byteLength(JSON.stringify(resent.promptHistoryList));
      t.diagnostic(`short re-send frame ${bytes} bytes; whole field ${fieldBytes} bytes`);
      assert.deepEqual(shortDecoder.decode(received(encoded, compact)).snapshot, resent);
      assert.ok(await resumeDigestsMatch(short, shortDecoder));
    }
  });

  test(`a peer that never announced history patches keeps receiving the whole field (compact=${compact})`, () => {
    const encoder = createSnapshotDeltaEncoder({ compact });
    const decoder = createSnapshotDeltaDecoder();
    decoder.decode(received(encoder.encode(historySnapshot(fullHistory)), compact));
    const history = ['fresh prompt', ...fullHistory].slice(0, HISTORY_CAP);
    const encoded = encoder.encode(historySnapshot(history));
    assert.equal(Object.hasOwn(encoded, 'sl'), false);
    assert.equal(Object.hasOwn(encoded.__statePatch ?? {}, 'lists'), false);
    assert.deepEqual(statePatchOf(encoded).changed.promptHistoryList, history);
    assert.deepEqual(decoder.decode(received(encoded, compact)).snapshot.promptHistoryList, history);
  });
}

test('a head patch that does not fit the held history is refused, never mis-applied', () => {
  for (const sl of [
    { promptHistoryList: { h: ['x'], k: 3 } },
    { promptHistoryList: { h: [], k: 1 } },
    { promptHistoryList: { h: ['x'], k: 0 } },
    // A removed index outside the held list, not an integer, or leaving too
    // few held entries for `k`.
    { promptHistoryList: { h: ['x'], k: 1, x: 2 } },
    { promptHistoryList: { h: ['x'], k: 1, x: -1 } },
    { promptHistoryList: { h: ['x'], k: 1, x: 0.5 } },
    { promptHistoryList: { h: ['x'], k: 1, x: '0' } },
    { promptHistoryList: { h: ['x'], k: 2, x: 0 } },
    { promptHistoryList: ['x'] },
    { busy: { h: ['x'], k: 1 } },
  ]) {
    const encoder = createSnapshotDeltaEncoder({ compact: true, historyPatch: true });
    const decoder = createSnapshotDeltaDecoder();
    decoder.decode(received(encoder.encode(historySnapshot(['b', 'a'])), true));
    const wire = { r: 2, sl, __v: 2 };
    assert.equal(decoder.decode(wire).ok, false, JSON.stringify(sl));
    // The held state is untouched: the next valid patch still applies.
    const next = historySnapshot(['c', 'b', 'a']);
    const decoded = decoder.decode(received(encoder.encode(next), true));
    assert.equal(decoded.ok, true);
    assert.deepEqual(decoded.snapshot, next);
  }
});

test('a re-read stored window grown at its head keeps the held rows by identity', () => {
  const held = ['r0', 'r1', 'r2'].map(row);
  const previous = { sessionId: 'session', items: held, transcriptHasOlder: true };
  // A stored read parses a brand-new object graph.
  const reread = JSON.parse(JSON.stringify({ ...previous, items: [row('h0'), row('h1'), ...held] }));
  const merged = reconcileSessionProjection(previous, reread);
  assert.deepEqual(merged.items, reread.items);
  assert.equal(merged.items[0], reread.items[0]);
  for (let index = 0; index < held.length; index += 1) assert.equal(merged.items[2 + index], held[index]);
  // A held row that changed while the page was read is replaced, not kept.
  const settled = JSON.parse(JSON.stringify(reread));
  settled.items[4].text = 'settled';
  const changed = reconcileSessionProjection(previous, settled);
  assert.equal(changed.items[2], held[0]);
  assert.equal(changed.items[4].text, 'settled');
});
