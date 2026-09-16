import assert from 'node:assert/strict';
import test from 'node:test';
import { reviewHistory, HISTORY_REVIEW_MAX_BYTES } from './memory-cycle2-review.mjs';

function source(count, summary) {
  const rows = Array.from({ length: count }, (_, i) => ({
    id: 100 + i,
    ts: 1000 + i,
    element: `topic-${i}`,
    summary,
    project_id: 'project',
  }));
  const predecessors = rows.flatMap((row) =>
    Array.from({ length: 6 }, (_, i) => ({
      newer_id: row.id,
      older_id: i + 1,
      older_ts: i,
      older_element: `prior-${i}`,
      older_summary: summary,
      project_id: 'project',
    }))
  );
  return { rows, db: { query: async () => ({ rows: predecessors }) } };
}

test('UTF-8-heavy summaries split into bounded requests without dropping selected evidence', async () => {
  const { rows, db } = source(7, '필수 조건은 유지됩니다. '.repeat(180));
  const seen = new Map();
  let calls = 0;
  const result = await reviewHistory(
    db,
    rows,
    {},
    {
      preset: 'test',
      callLlm: async (_request, prompt) => {
        calls++;
        assert.ok(Buffer.byteLength(prompt, 'utf8') <= HISTORY_REVIEW_MAX_BYTES);
        const input = JSON.parse(prompt.split('\n\n').at(-1));
        for (const row of input) {
          if (!seen.has(row.id)) seen.set(row.id, []);
          seen.get(row.id).push(...row.predecessors.map((prior) => prior.older_id));
          assert.equal(row.summary, rows[0].summary);
          assert.ok(row.predecessors.every((prior) => prior.older_summary === rows[0].summary));
        }
        return JSON.stringify(input.map((row) => ({ id: row.id, action: 'keep' })));
      },
    }
  );
  assert.ok(calls > 1);
  assert.deepEqual(
    result.verdicts.map((verdict) => verdict.row.id),
    rows.map((row) => row.id)
  );
  for (const id of rows.map((row) => row.id)) assert.deepEqual(seen.get(id), [1, 2, 3, 4, 5, 6]);
});

test('one source spanning requests reunites all relationship verdicts with concurrency bounded', async () => {
  const { rows, db } = source(1, 'Evidence '.repeat(6500));
  let active = 0;
  let peak = 0;
  const result = await reviewHistory(
    db,
    rows,
    {},
    {
      preset: 'test',
      callLlm: async (_request, prompt) => {
        assert.ok(Buffer.byteLength(prompt, 'utf8') <= HISTORY_REVIEW_MAX_BYTES);
        active++;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setImmediate(resolve));
        active--;
        const input = JSON.parse(prompt.split('\n\n').at(-1));
        return JSON.stringify(
          input.map((row) => ({ id: row.id, action: 'lineage', older_id: row.predecessors[0].older_id }))
        );
      },
    }
  );
  assert.equal(result.verdicts.length, 1);
  assert.equal(result.verdicts[0].actions.length, 6);
  assert.deepEqual(
    result.verdicts[0].actions.map((action) => action.prior.older_id),
    [1, 2, 3, 4, 5, 6]
  );
  assert.ok(peak <= 4);
});
