import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./routing-corpus.mjs', import.meta.url));

const row = (session, ts, iteration, tool_name, tool_args, extra = {}) => ({
  kind: 'tool',
  session_id: session,
  ts,
  payload: { tool_name, tool_args, iteration, ...extra },
});

function corpusOf(rows) {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-routing-corpus-'));
  try {
    const trace = join(dir, 'trace.jsonl');
    writeFileSync(trace, rows.map((r) => JSON.stringify(r)).join('\n'));
    const run = spawnSync(process.execPath, [script, '--trace', trace, '--json'], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    return JSON.parse(run.stdout);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const observationsOf = (corpus, session) => corpus.cases.find((c) => c.session_id === session).observations;

test('two reads of different files in one iteration are a same-turn batch opportunity', () => {
  const corpus = corpusOf([row('a', 1, 1, 'read', { path: 'x.js' }), row('a', 2, 1, 'read', { path: 'y.js' })]);
  assert.deepEqual(observationsOf(corpus, 'a'), ['same_turn_batch_opportunity']);
});

test('single-target searches that differ only in the target are a batch opportunity', () => {
  const corpus = corpusOf([
    row('g', 1, 1, 'grep', { pattern: 'one', path: 'src' }),
    row('g', 2, 1, 'grep', { pattern: 'two', path: 'src' }),
  ]);
  assert.deepEqual(observationsOf(corpus, 'g'), ['same_turn_batch_opportunity']);
});

test('calls in different iterations, a mutation between them, or a failure are not a batch opportunity', () => {
  const corpus = corpusOf([
    row('i', 1, 1, 'read', { path: 'x.js' }),
    row('i', 2, 2, 'read', { path: 'y.js' }),
    row('m', 1, 1, 'read', { path: 'x.js' }),
    row('m', 2, 1, 'edit', { path: 'x.js' }),
    row('m', 3, 1, 'read', { path: 'y.js' }),
    row('f', 1, 1, 'read', { path: 'x.js' }),
    row('f', 2, 1, 'read', { path: 'y.js' }, { result_kind: 'error' }),
  ]);
  for (const session of ['i', 'm', 'f']) assert.deepEqual(observationsOf(corpus, session), [], session);
});
