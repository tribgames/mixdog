import assert from 'node:assert/strict';
import test from 'node:test';
import { createTranscriptRowHeightStore, transcriptRowShape } from './transcript-row-estimates.ts';
import { TRANSCRIPT_ROW_ESTIMATE } from './transcript-virtual-cache.ts';

const reply = (id, text) => ({
  _tag: 'AssistantPart',
  key: `s:${id}`,
  turnKey: 't',
  item: { id, kind: 'assistant', text },
});
const tools = (id, count) => ({
  _tag: 'ToolActivity',
  key: `s:tools:${id}`,
  turnKey: 't',
  items: Array.from({ length: count }, (_, index) => ({ id: `${id}-${index}`, kind: 'tool' })),
});
const report = (n) => `Steps ${n} done.\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n\`\`\`js\nconsole.log(${n});\n\`\`\``;

function memoryStorage() {
  const data = new Map();
  return { getItem: (key) => data.get(key) ?? null, setItem: (key, value) => data.set(key, value), data };
}

test('an unknown row starts at the flat estimate', () => {
  const store = createTranscriptRowHeightStore(null);
  assert.equal(store.estimate(reply(1, 'hello'), 400), TRANSCRIPT_ROW_ESTIMATE);
  assert.equal(store.estimate(undefined, 400), TRANSCRIPT_ROW_ESTIMATE);
  assert.equal(store.estimate(reply(1, 'hello'), 0), TRANSCRIPT_ROW_ESTIMATE);
});

test('rows of a measured shape take that shape’s median height', () => {
  const store = createTranscriptRowHeightStore(null);
  store.record(reply(1, report(1)), 411, 264);
  store.record(reply(2, report(5)), 411, 272);
  store.record(reply(3, report(9)), 411, 264);
  store.record(tools(1, 4), 411, 38);
  // Never-measured rows of the same shapes.
  assert.equal(store.estimate(reply(4, report(13)), 411), 264);
  assert.equal(store.estimate(tools(2, 4), 411), 38);
  // A different shape or width is not guessed from them.
  assert.equal(store.estimate(reply(5, 'ok'), 411), TRANSCRIPT_ROW_ESTIMATE);
  assert.equal(store.estimate(reply(4, report(13)), 1200), TRANSCRIPT_ROW_ESTIMATE);
});

test('a row remembers its own height, and one row is one shape sample', () => {
  const store = createTranscriptRowHeightStore(null);
  const row = reply(1, report(1));
  for (const size of [100, 120, 140, 160, 300]) store.record(row, 411, size);
  assert.equal(store.estimate(row, 411), 300, 'its own latest height wins');
  // The re-measured row counted once: the shape still holds its first height.
  assert.equal(store.estimate(reply(2, report(2)), 411), 100);
});

test('heights survive a reload through storage; positional keys do not', () => {
  const storage = memoryStorage();
  const first = createTranscriptRowHeightStore(storage);
  first.record(reply(7, report(1)), 411, 264);
  const positional = {
    _tag: 'AssistantPart',
    key: 's:assistant-3',
    turnKey: 't',
    item: { kind: 'assistant', text: 'x' },
  };
  first.record(positional, 411, 500);
  return new Promise((resolve) => setTimeout(resolve, 2_100)).then(() => {
    const second = createTranscriptRowHeightStore(storage);
    assert.equal(second.estimate(reply(7, report(1)), 411), 264);
    assert.equal(second.estimate(reply(8, report(2)), 411), 264, 'learned shape restored too');
    const stored = JSON.parse(storage.data.get('mixdog.transcript-row-heights.v2'));
    assert.equal(
      stored.keys.some(([key]) => key.endsWith('s:assistant-3')),
      false
    );
  });
});

test('an agent chat learns its hidden tool rounds as 0px; coding estimates stay its own', () => {
  const store = createTranscriptRowHeightStore(null);
  store.record(tools(1, 1), 411, 26);
  store.record(tools(2, 1), 411, 0, 'agent');
  store.record(tools(3, 1), 411, 0, 'agent');
  assert.equal(store.estimate(tools(4, 1), 411, 'agent'), 0, 'a measured 0px row teaches its shape');
  assert.equal(store.knows(tools(4, 1), 411, 'agent'), true);
  assert.equal(store.estimate(tools(3, 1), 411, 'agent'), 0, 'and its own key');
  assert.equal(store.estimate(tools(4, 1), 411), 26, 'coding keeps what coding measured');
  assert.equal(store.estimate(tools(4, 1), 411, 'coding'), 26);
  // An agent chat's bubble never moves a coding reply's median.
  store.record(reply(1, report(1)), 411, 264);
  store.record(reply(2, report(2)), 411, 120, 'agent');
  store.record(reply(3, report(3)), 411, 120, 'agent');
  assert.equal(store.estimate(reply(9, report(9)), 411), 264);
  assert.equal(store.estimate(reply(9, report(9)), 411, 'agent'), 120);
  assert.equal(store.estimate(reply(8, 'ok'), 411, 'agent'), TRANSCRIPT_ROW_ESTIMATE);
});

test('coding heights stored before surfaces existed still restore', () => {
  const storage = memoryStorage();
  storage.setItem(
    'mixdog.transcript-row-heights.v2',
    JSON.stringify({ keys: [['411|s:7', 264]], shapes: [[`416|${transcriptRowShape(reply(7, report(1)))}`, [250]]] })
  );
  const store = createTranscriptRowHeightStore(storage);
  assert.equal(store.estimate(reply(7, report(1)), 411), 264);
  assert.equal(store.estimate(reply(8, report(2)), 411), 250);
  assert.equal(store.estimate(reply(8, report(2)), 411, 'agent'), TRANSCRIPT_ROW_ESTIMATE);
});

test('heights measured under the previous typography are discarded', () => {
  const storage = memoryStorage();
  storage.setItem(
    'mixdog.transcript-row-heights.v1',
    JSON.stringify({ keys: [['411|s:7', 264]], shapes: [[`416|${transcriptRowShape(reply(7, report(1)))}`, [250]]] })
  );
  const store = createTranscriptRowHeightStore(storage);
  assert.equal(store.knows(reply(7, report(1)), 411), false);
  assert.equal(store.estimate(reply(7, report(1)), 411), TRANSCRIPT_ROW_ESTIMATE);
  assert.equal(store.estimate(reply(8, report(2)), 411), TRANSCRIPT_ROW_ESTIMATE);
});

test('shapes separate the features that change a reply’s height', () => {
  assert.notEqual(transcriptRowShape(reply(1, 'short')), transcriptRowShape(reply(2, report(1))));
  assert.notEqual(transcriptRowShape(tools(1, 1)), transcriptRowShape(tools(2, 4)));
  assert.equal(transcriptRowShape(reply(1, report(1))), transcriptRowShape(reply(2, report(7))));
});
