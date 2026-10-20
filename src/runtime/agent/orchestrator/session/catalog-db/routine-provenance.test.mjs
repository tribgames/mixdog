import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { SCHEMA_SQL, UPSERT_SQL, rowFromDb, rowSignature, upsertParams } from './schema.mjs';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizedRow, scanSessionFiles } from '../store-summary-catalog.mjs';
import { _sessionSummary } from '../store-summary-index.mjs';
import { routineResultMessage } from '../routine-result.mjs';
import { leadSessionRow } from '../../../../../session-runtime/lifecycle/session-catalog.mjs';

const routine = (overrides) => routineResultMessage({ name: 'daily', ok: true, text: 'All green.', ...overrides });

test('the last line carries its routine provenance; a look-alike user message carries none', () => {
  const session = { id: 'sess_home_lead', messages: [routine({ messageId: 'm1' })] };
  assert.deepEqual(_sessionSummary(session).lastMessageRoutine, {
    kind: 'schedule',
    name: 'daily',
    status: 'ok',
    summary: 'All green.',
  });
  session.messages.push(routine({ kind: 'webhook', name: 'deploy', ok: false, text: 'HTTP 502', messageId: 'm2' }));
  assert.deepEqual(_sessionSummary(session).lastMessageRoutine, {
    kind: 'webhook',
    name: 'deploy',
    status: 'failed',
    error: 'HTTP 502',
  });
  // A human typing the same shape is plain text, never a routine result.
  session.messages.push({ role: 'user', content: '⏱ Schedule · daily — Failed: just kidding' });
  const row = _sessionSummary(session);
  assert.equal(row.lastMessagePreview, '⏱ Schedule · daily — Failed: just kidding');
  assert.equal(row.lastMessageRoutine, null);
});

test('a session the index does not describe still lists its last line from the file read', (t) => {
  const previous = process.env.MIXDOG_DATA_DIR;
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-last-line-'));
  process.env.MIXDOG_DATA_DIR = dir;
  t.after(() => {
    if (previous === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  });
  mkdirSync(join(dir, 'sessions'));
  const write = (id, messages) =>
    writeFileSync(
      join(dir, 'sessions', `${id}.json`),
      JSON.stringify({ id, owner: 'cli', agent: 'lead', sourceType: 'lead', updatedAt: 5, lastUsedAt: 5, messages })
    );
  // A reply followed by a tool-only assistant turn: the line is the reply.
  write('sess_home_lead', [
    { role: 'user', content: 'Say hi.' },
    { role: 'assistant', content: [{ type: 'text', text: 'Hello! How can I help?' }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'read', input: {} }] },
  ]);
  write('sess_home_reviewer', [routine({ name: 'nightly', ok: false, text: 'boom', messageId: 'm9' })]);
  const rows = new Map(scanSessionFiles(new Map(), true).map((row) => [row.id, row]));
  const mixy = rows.get('sess_home_lead');
  assert.equal(mixy.lastMessagePreview, 'Hello! How can I help?');
  assert.equal(mixy.lastMessageRoutine, null);
  assert.equal(mixy.messageCount, 3);
  const reviewer = rows.get('sess_home_reviewer');
  assert.deepEqual(reviewer.lastMessageRoutine, { kind: 'schedule', name: 'nightly', status: 'failed', error: 'boom' });
  assert.equal(
    reviewer.lastMessagePreview,
    _sessionSummary({ id: 'x', messages: [routine({ name: 'nightly', ok: false, text: 'boom' })] }).lastMessagePreview
  );
  assert.equal(reviewer.preview, '', 'a routine result is never the first-prompt preview');
  assert.equal(reviewer.messageCount, 1);
});

test('the catalog round-trips the marker; an older row without it reads null', () => {
  const marker = { kind: 'webhook', name: 'deploy', status: 'ok', summary: 'Deployed v2' };
  const base = { id: 'sess_home_lead', updatedAt: 2, lastMessagePreview: '🔗 Webhook · deploy — Deployed v2' };
  const row = normalizedRow({ ...base, lastMessageRoutine: marker });
  assert.deepEqual(row.lastMessageRoutine, marker);
  assert.equal(normalizedRow(base).lastMessageRoutine, null, 'a row written before the marker');
  assert.equal(
    normalizedRow({ ...base, lastMessageRoutine: { kind: 'other', name: 'x', status: 'ok' } }).lastMessageRoutine,
    null
  );

  const db = new DatabaseSync(':memory:');
  try {
    db.exec(SCHEMA_SQL);
    const upsert = db.prepare(UPSERT_SQL);
    for (const entry of [{ row }, { row: normalizedRow({ ...base, id: 'sess_old' }) }]) {
      upsert.run(...upsertParams(entry, rowSignature(entry)));
    }
    const read = (id) => rowFromDb(db.prepare('SELECT * FROM sessions WHERE id = ?').get(id));
    assert.deepEqual(read('sess_home_lead').lastMessageRoutine, marker);
    assert.equal(read('sess_old').lastMessageRoutine, null);
  } finally {
    db.close();
  }

  // The session catalog hands it on to clients, only when present.
  const listed = leadSessionRow({ ...row, messages: undefined, messageCount: 3, owner: 'user' });
  assert.deepEqual(listed.lastMessageRoutine, marker);
  assert.equal(
    Object.hasOwn(leadSessionRow({ ...normalizedRow(base), messageCount: 3, owner: 'user' }), 'lastMessageRoutine'),
    false
  );
});
