import assert from 'node:assert/strict';
import test from 'node:test';
import { annotateSpan, createSlowSpans, markPhase, shortId } from './slow-span.mjs';

function fixture(options = {}) {
  let t = 0;
  const logs = [];
  const spans = createSlowSpans({ now: () => t, log: (line) => logs.push(line), ...options });
  return { spans, logs, advance: (ms) => (t += ms), at: () => t };
}

test('spans under the ring threshold are dropped, slower ones kept with phases', async () => {
  const { spans, advance } = fixture();
  await spans.trace('fast', async () => advance(10));
  await spans.trace('session.read#abc', async () => {
    advance(30);
    markPhase('load');
    advance(40);
    markPhase('action');
    annotateSpan('getX');
  });
  const [only, ...rest] = spans.recent;
  assert.equal(rest.length, 0);
  assert.equal(only.label, 'session.read#abc:getX');
  assert.equal(only.ms, 70);
  assert.deepEqual(only.phases, [
    ['load', 30],
    ['action', 40],
  ]);
});

test('the ring is bounded to its capacity, oldest evicted', async () => {
  const { spans, advance } = fixture({ capacity: 3 });
  for (let i = 0; i < 5; i++) await spans.trace(`op${i}`, async () => advance(30));
  assert.deepEqual(
    spans.recent.map((s) => s.label),
    ['op2', 'op3', 'op4']
  );
});

test('overlapping picks spans touching the window, longest overlap first, limited', async () => {
  const { spans, advance } = fixture();
  await spans.trace('before', async () => advance(100)); // 0-100
  await spans.trace('big', async () => advance(500)); // 100-600
  await spans.trace('small', async () => advance(50)); // 600-650
  await spans.trace('after', async () => advance(100)); // 650-750
  assert.deepEqual(
    spans.overlapping(550, 640).map((s) => s.label),
    ['big', 'small']
  );
  assert.deepEqual(
    spans.overlapping(590, 640).map((s) => s.label),
    ['small', 'big']
  );
  assert.deepEqual(
    spans.overlapping(100, 700, 1).map((s) => s.label),
    ['big']
  );
  assert.deepEqual(spans.overlapping(750, 900), []);
  assert.equal(spans.describe(590, 640), 'spans: small 50ms; big 500ms');
  assert.equal(spans.describe(900, 950), '');
});

test('spans over the slow threshold log [slow-op] with label and ms', async () => {
  const { spans, logs, advance } = fixture();
  await spans.trace('session.read#abcd1234', async () => {
    advance(1200);
    markPhase('load');
  });
  await spans.trace('quick', async () => advance(900));
  assert.deepEqual(logs, ['[slow-op] session.read#abcd1234 1200ms load=1200']);
});

test('a throwing call is still recorded and rethrown', async () => {
  const { spans, advance } = fixture();
  await assert.rejects(
    spans.trace('boom', async () => {
      advance(60);
      throw new Error('x');
    }),
    /x/
  );
  assert.equal(spans.recent[0].label, 'boom');
});

test('shortId truncates and tolerates missing ids', () => {
  assert.equal(shortId('0123456789abcdef'), '01234567');
  assert.equal(shortId(undefined), '');
});
