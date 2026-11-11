import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createDecisionSummary, decisionLog } from './decision-log.mjs';

const lines = (file) =>
  readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));

function tempLog(t) {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-decision-log-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return {
    file: join(root, 'effort-judge', 'decisions.jsonl'),
    previous: join(root, 'effort-judge', 'decisions.1.jsonl'),
    summary: join(root, 'effort-judge', 'decisions-summary.jsonl'),
    leaving: join(root, 'effort-judge', 'decisions.leaving.jsonl'),
  };
}

const step = (n, extra) => ({
  at: `2026-11-11T10:00:${String(n).padStart(2, '0')}.000Z`,
  sessionId: `s${n % 2}`,
  provider: 'anthropic-oauth',
  model: 'claude-opus-5-5',
  mode: 'on',
  atStep: n,
  ...extra,
});

test('old decisions are kept as counts per day, route and kind', () => {
  const summary = createDecisionSummary();
  const answered = { base: 'medium', step: 0, level: 1, confidence: 0.5, probs: [0.2, 0.5, 0.2, 0.1] };
  for (const entry of [
    step(1, { ...answered, effort: 'medium', ms: 99 }),
    step(2, { ...answered, effort: 'high', ms: 100 }),
    step(3, { ...answered, effort: 'medium', ms: 499 }),
    step(4, { ...answered, effort: 'medium', ms: 500 }),
    step(5, { skipped: 'timeout' }),
    step(6, { skipped: 'load-error: model.onnx is damaged' }),
    { ...step(7, { ...answered, effort: 'low', ms: 250 }), atStep: undefined, chosen: 'medium', requestChars: 40 },
    { ...step(8, { skipped: 'busy' }), at: '2026-11-12T00:00:00.000Z', model: 'gpt-6.1-sol' },
  ]) {
    summary.add(JSON.stringify(entry));
  }
  summary.add('{"at":"2026-11-11T10:00:09.000Z","sessionId":"s9","provider":"anthro');
  summary.add('{"no":"time"}');
  assert.deepEqual(summary.rows(), [
    {
      day: '2026-11-11',
      provider: 'anthropic-oauth',
      model: 'claude-opus-5-5',
      kind: 'step',
      from: '2026-11-11T10:00:01.000Z',
      to: '2026-11-11T10:00:06.000Z',
      judged: 6,
      sessions: 2,
      skipped: { 'load-error': 1, timeout: 1 },
      efforts: { 'medium>high': 1, 'medium>medium': 3 },
      ms: { from500: 1, under100: 1, under200: 1, under500: 1 },
    },
    {
      day: '2026-11-11',
      provider: 'anthropic-oauth',
      model: 'claude-opus-5-5',
      kind: 'turn',
      from: '2026-11-11T10:00:07.000Z',
      to: '2026-11-11T10:00:07.000Z',
      judged: 1,
      sessions: 1,
      skipped: {},
      efforts: { 'medium>low': 1 },
      ms: { under300: 1 },
    },
    {
      day: '2026-11-12',
      provider: 'anthropic-oauth',
      model: 'gpt-6.1-sol',
      kind: 'step',
      from: '2026-11-12T00:00:00.000Z',
      to: '2026-11-12T00:00:00.000Z',
      judged: 1,
      sessions: 1,
      skipped: { busy: 1 },
      efforts: {},
      ms: {},
    },
  ]);
});

test('the log keeps two segments as written and counts what is older', async (t) => {
  const paths = tempLog(t);
  const entry = (n) => step(n, { skipped: 'timeout' });
  const segmentBytes = 4 * Buffer.byteLength(`${JSON.stringify(entry(1))}\n`);
  const log = decisionLog(paths.file, { segmentBytes });
  for (let n = 1; n <= 5; n += 1) log.record(entry(n));
  await log.settled();
  // The fifth line passed the segment: the five became the previous segment.
  assert.deepEqual(lines(paths.previous), [1, 2, 3, 4, 5].map(entry));
  assert.equal(existsSync(paths.file), false);
  assert.equal(existsSync(paths.summary), false);

  for (let n = 6; n <= 10; n += 1) log.record(entry(n));
  await log.settled();
  // The next segment took its place; the first five are counts now.
  assert.deepEqual(lines(paths.previous), [6, 7, 8, 9, 10].map(entry));
  assert.equal(existsSync(paths.file), false);
  assert.equal(existsSync(paths.leaving), false);
  assert.deepEqual(lines(paths.summary), [
    {
      day: '2026-11-11',
      provider: 'anthropic-oauth',
      model: 'claude-opus-5-5',
      kind: 'step',
      from: '2026-11-11T10:00:01.000Z',
      to: '2026-11-11T10:00:05.000Z',
      judged: 5,
      sessions: 2,
      skipped: { timeout: 5 },
      efforts: {},
      ms: {},
    },
  ]);

  log.record(entry(11));
  await log.settled();
  assert.deepEqual(lines(paths.file), [entry(11)]);
  assert.deepEqual(lines(paths.previous), [6, 7, 8, 9, 10].map(entry));
});

test('a log grown before segments existed is counted whole, and a half-counted segment is finished', async (t) => {
  const paths = tempLog(t);
  const entry = (n) => step(n, { skipped: 'busy' });
  const lineBytes = Buffer.byteLength(`${JSON.stringify(entry(1))}\n`);
  const log = decisionLog(paths.file, { segmentBytes: 2 * lineBytes });
  log.record(entry(1));
  await log.settled();
  // What an older version left: one file far past two segments, and a segment a stopped process was counting.
  writeFileSync(paths.file, [2, 3, 4, 5, 6, 7, 8, 9].map((n) => `${JSON.stringify(entry(n))}\n`).join(''));
  writeFileSync(paths.leaving, `${JSON.stringify(entry(20))}\n`);
  log.record(entry(10));
  log.record(entry(11));
  await log.settled();
  assert.equal(existsSync(paths.leaving), false);
  assert.equal(existsSync(paths.previous), false);
  const counted = lines(paths.summary);
  assert.deepEqual(
    counted.map((row) => [row.from, row.to, row.judged]),
    [
      ['2026-11-11T10:00:20.000Z', '2026-11-11T10:00:20.000Z', 1],
      ['2026-11-11T10:00:02.000Z', '2026-11-11T10:00:11.000Z', 10],
    ]
  );
  assert.equal(existsSync(paths.file), false);
});
