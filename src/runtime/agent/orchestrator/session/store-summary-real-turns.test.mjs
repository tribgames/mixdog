// The summary row carries `realTurnCount` (real human turns + compact
// summaries) and the lead catalog row passes it, with detachedReason, to the
// desktop, so synthetic-only and resume-scratch rows are told apart from a
// compacted real conversation.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-real-turns-'));
process.env.MIXDOG_DATA_DIR = dataDir;
const { _normalizeSummaryIndex, _sessionSummary } = await import('./store-summary-index.mjs');
const { normalizedRow } = await import('./store-summary-catalog.mjs');
const { SCHEMA_VERSION, rowFromDb, upsertParams } = await import('./catalog-db/schema.mjs');
const { listLeadSessions } = await import('../../../../session-runtime/lifecycle/session-catalog.mjs');
const { makeSummaryMessage } = await import('./compact/messages.mjs');

test.after(() => rmSync(dataDir, { recursive: true, force: true }));

const session = (messages, extra = {}) => ({
  id: `sess_real_turns_${Math.random().toString(36).slice(2)}`,
  updatedAt: 1000,
  messages: [{ role: 'system', content: 'rules' }, ...messages],
  ...extra,
});

const SYNTHETIC = [
  { role: 'user', content: '[mixdog-runtime] resumed' },
  { role: 'assistant', content: 'ok' },
  { role: 'user', content: 'continue the goal', meta: { source: 'goal-continuation', synthetic: true } },
  { role: 'user', content: '[request interrupted by user]' },
  { role: 'user', content: '<system-reminder>clock</system-reminder>' },
];

test('synthetic-only transcripts have no real turns; a human prompt or a compact summary counts', () => {
  assert.equal(_sessionSummary(session(SYNTHETIC)).realTurnCount, 0);
  const real = session([...SYNTHETIC, { role: 'user', content: 'Fix the login bug' }]);
  assert.equal(_sessionSummary(real).realTurnCount, 1);
  // Compaction can leave only the summary: it stands for earlier human turns.
  const compacted = session([makeSummaryMessage('A previous model worked on this task...'), ...SYNTHETIC]);
  assert.equal(_sessionSummary(compacted).realTurnCount, 1);
  // Append-only growth keeps counting from the memoized projection.
  real.messages.push({ role: 'assistant', content: 'done' }, { role: 'user', content: 'and another' });
  assert.equal(_sessionSummary(real).realTurnCount, 2);
});

test('control markers and synthetic/internal provenance are not real turns; summaries and imports are', () => {
  const marker = [
    { role: 'user', content: '[truncated]', meta: { synthetic: true } },
    { role: 'assistant', content: '[request interrupted by user]' },
  ];
  assert.equal(_sessionSummary(session(marker)).realTurnCount, 0);
  assert.equal(_sessionSummary(session([{ role: 'user', content: '[truncated]' }])).realTurnCount, 0);
  assert.equal(
    _sessionSummary(
      session([
        { role: 'user', content: 'queued note', meta: { source: 'task-notification' } },
        { role: 'user', content: 'flagged', internal: true },
        { role: 'user', content: 'flagged too', synthetic: true },
      ])
    ).realTurnCount,
    0
  );
  assert.equal(
    _sessionSummary(session([{ role: 'user', content: '[truncated]', meta: { source: 'import' } }])).realTurnCount,
    1
  );
  assert.equal(_sessionSummary(session([makeSummaryMessage('A previous model...'), ...marker])).realTurnCount, 1);
  // The catalog cold path and the lead row agree with the index projection.
  const raw = session(marker);
  assert.equal(normalizedRow(_sessionSummary(raw)).realTurnCount, 0);
  const [lead] = listLeadSessions({ listSessions: () => [raw] });
  assert.equal(lead.realTurnCount, 0);
});

test('the field survives index normalization and the catalog row; rows without it stay null', () => {
  const summary = _sessionSummary(session([{ role: 'user', content: 'hello there' }]));
  const [indexed] = _normalizeSummaryIndex({ rows: [summary] }).rows;
  assert.equal(indexed.realTurnCount, 1);
  assert.equal(normalizedRow(summary).realTurnCount, 1);
  const { realTurnCount, ...legacy } = summary;
  assert.equal(_normalizeSummaryIndex({ rows: [legacy] }).rows[0].realTurnCount, null);
  assert.equal(normalizedRow(legacy).realTurnCount, null);
});

test('the catalog DB codec round-trips realTurnCount under the bumped schema', () => {
  assert.ok(SCHEMA_VERSION >= 5);
  const row = normalizedRow(_sessionSummary(session([{ role: 'user', content: 'hello there' }])));
  assert.ok(upsertParams({ row, fingerprint: null, leadVisible: true }, 'sig').includes(1));
  assert.equal(rowFromDb({ id: row.id, real_turn_count: 3 }).realTurnCount, 3);
});

test('the compaction count, the epoch of the message numbering, reaches the summary, the catalog DB and the lead row', () => {
  const hello = [{ role: 'user', content: 'hello there' }];
  // A session that never compacted is epoch 0; a compacted one carries its count.
  assert.equal(_sessionSummary(session(hello)).compactCount, 0);
  const compacted = session(hello, { compaction: { compactCount: 17, lastStage: 'pre_send_check' } });
  const summary = _sessionSummary(compacted);
  assert.equal(summary.compactCount, 17);
  assert.equal(_normalizeSummaryIndex({ rows: [summary] }).rows[0].compactCount, 17);
  const row = normalizedRow(summary);
  assert.equal(row.compactCount, 17);
  assert.ok(upsertParams({ row, fingerprint: null, leadVisible: true }, 'sig').includes('17'));
  assert.equal(rowFromDb({ id: row.id, compact_count: '17' }).compactCount, 17);
  // A row written before the field, or read off a session file, has none.
  assert.equal('compactCount' in normalizedRow({ ...summary, compactCount: undefined }), false);
  assert.equal('compactCount' in rowFromDb({ id: row.id, compact_count: null }), false);
  // The lead row carries it for the desktop. The manager lists summary rows,
  // which hold it at the top; a stored session holds it in its compaction record.
  const lead = (input) => listLeadSessions({ listSessions: () => [input] })[0];
  assert.equal(lead(summary).compactCount, 17);
  assert.equal(lead(compacted).compactCount, 17);
  assert.equal(lead(_sessionSummary(session(hello))).compactCount, 0, 'never compacted is epoch 0');
  // Unknown stays absent, never 0.
  const { compactCount: _count, ...older } = summary;
  assert.equal('compactCount' in lead(older), false);
  assert.equal('compactCount' in lead(session(hello)), false);
});

test('the lead catalog row exposes realTurnCount and detachedReason to the desktop', () => {
  const summary = _sessionSummary(
    session([{ role: 'user', content: 'Fix the login bug' }], { detachedReason: 'cli-resume' })
  );
  const [lead] = listLeadSessions({ listSessions: () => [summary] });
  assert.equal(lead.realTurnCount, 1);
  assert.equal(lead.detachedReason, 'cli-resume');
  const [ordinary] = listLeadSessions({
    listSessions: () => [_sessionSummary(session([{ role: 'user', content: 'Fix the login bug' }]))],
  });
  assert.equal('detachedReason' in ordinary, false);
});
