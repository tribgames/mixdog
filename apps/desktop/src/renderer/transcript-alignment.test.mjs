import assert from 'node:assert/strict';
import test from 'node:test';
import { legacyAlignment } from '../../../../scripts/perf/transcript-baseline.mjs';
import { findTranscriptAlignment } from './transcript-alignment.ts';
import { adoptTranscriptIdentity, createTranscriptIdentityReconciler } from './transcript-identity.ts';

// Four rows per turn; the texts are never prefixes of each other.
const turnRow = (index, prefix) => {
  const turn = Math.floor(index / 4);
  const kind = ['user', 'tool', 'assistant', 'turndone'][index % 4];
  return {
    id: `${prefix}${index}`,
    kind,
    ...(kind === 'user' ? { text: `question ${turn}.` } : {}),
    ...(kind === 'assistant' ? { text: `answer ${turn}.` } : {}),
    ...(kind === 'tool' ? { name: 'read' } : {}),
    ...(kind === 'turndone' ? { status: 'done', label: `Worked ${turn}s` } : {}),
  };
};
const turnRows = (from, to, prefix = 'h') => Array.from({ length: to - from }, (_, i) => turnRow(from + i, prefix));

test('an older page that starts at an arbitrary row keeps its own ids and the displayed ones', () => {
  // The displayed window ends on a turn-completion row; the page's first row
  // is another turn-completion row. That lone weak match used to give the
  // page's first row the newest row's id.
  const previous = turnRows(64, 128);
  const incoming = turnRows(3, 128);
  const result = adoptTranscriptIdentity({ items: previous, tail: null }, incoming, null);
  assert.equal(result.items, undefined, 'every row keeps the id it arrived with');
  assert.equal(result.offset, 0);

  const reconciler = createTranscriptIdentityReconciler();
  reconciler.reconcile({ sessionId: 's', items: previous });
  const paged = reconciler.reconcile({ sessionId: 's', items: incoming });
  const ids = paged.items.map((item) => item.id);
  assert.equal(new Set(ids).size, ids.length, 'no id appears twice');
  assert.deepEqual(ids, incoming.map((item) => item.id));
  // The page became the baseline: the next live append aligns against it.
  const appended = reconciler.reconcile({ sessionId: 's', items: [...incoming, turnRow(128, 'h')] });
  assert.deepEqual(
    appended.items.map((item) => item.id),
    [...ids, 'h128']
  );
});

test('an older page from another id namespace adopts the displayed ids for the rows it repeats', () => {
  const previous = turnRows(64, 128, 'live-');
  const incoming = turnRows(3, 128, 'disk-');
  const result = adoptTranscriptIdentity({ items: previous, tail: null }, incoming, null);
  assert.deepEqual(
    result.items.map((item) => item.id),
    [...turnRows(3, 64, 'disk-'), ...previous].map((item) => item.id)
  );
});

test('a lone weak row match is not an alignment', () => {
  const previous = [
    { id: 'a', kind: 'user', text: 'first.' },
    { id: 'b', kind: 'turndone', status: 'done' },
  ];
  const incoming = [
    { id: 'x', kind: 'turndone', status: 'done' },
    { id: 'y', kind: 'user', text: 'other.' },
    { id: 'z', kind: 'assistant', text: 'reply.' },
  ];
  const result = adoptTranscriptIdentity({ items: previous, tail: null }, incoming, null);
  assert.equal(result.items, undefined);
  assert.equal(result.offset, 0);
});

test('optimized alignment preserves exhaustive ranking across duplicate ids, windows and history rewrites', () => {
  let seed = 1729;
  const random = (n) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed % n;
  };
  const row = () => ({
    kind: ['assistant', 'user', 'tool', 'statusdone'][random(4)],
    id: [undefined, null, 'a', 'b', 1, '1'][random(6)],
    name: ['read', 'shell'][random(2)],
    text: ['', 'a', 'ab', 'z'][random(4)],
    status: ['done', 'failed'][random(2)],
  });
  for (let run = 0; run < 4000; run++) {
    const previous = Array.from({ length: random(24) }, row);
    let incoming =
      run % 2
        ? previous.slice(random(previous.length + 1)).map((item) => ({ ...item }))
        : Array.from({ length: random(24) }, row);
    if (run % 3 === 0) incoming = incoming.map((item) => ({ ...item, id: `new-${random(4)}` }));
    assert.deepEqual(findTranscriptAlignment(previous, incoming), legacyAlignment(previous, incoming));
  }
});

test('a repeated tail window retains the displayed row ids across source namespaces', () => {
  const previous = Array.from({ length: 2000 }, (_, index) => ({
    kind: 'statusdone',
    id: `old-${index}`,
    status: 'done',
  }));
  const incoming = previous.slice(-500).map((item, index) => ({ ...item, id: `disk-${index}` }));
  const result = adoptTranscriptIdentity({ items: previous, tail: null }, incoming, null);
  assert.equal(result.offset, 1500);
  assert.deepEqual(
    result.items.map((item) => item.id),
    previous.slice(-500).map((item) => item.id)
  );
});
