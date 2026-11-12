// A value a fill marked sensitive is in none of the session's stored copies
// beside its messages: the header (its title, the repeat-failure guards that
// keep each failed call's arguments) and the summary index (the title and the
// previews, rows written before the mark included) hold the marker.
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-sensitive-summary-'));
process.env.MIXDOG_DATA_DIR = dataDir;
const { rememberSensitiveValues } = await import('./sensitive-values.mjs');
const { _sessionHeaderForDisk } = await import('./store/serialize.mjs');
const {
  _sessionSummary,
  _upsertSessionSummary,
  foldSummaryIndexForRedaction,
  settleSummaryIndexWrites,
  summaryIndexPath,
} = await import('./store-summary-index.mjs');
const { summaryLogPath } = await import('./store-summary-log.mjs');

const CODE = '482913';
const fill = (text) => ({ name: 'browser', arguments: { action: 'fill', input: { ref: 'e1', sensitive: true, text } } });
const signature = (text) => `browser:${JSON.stringify(fill(text).arguments)}`;

test.after(() => rmSync(dataDir, { recursive: true, force: true }));

test('the header keeps a marked value only as the marker in its title and repeat-failure guards', () => {
  const id = 'sess_1_1_1_header';
  const session = {
    id,
    title: `${CODE} is the code`,
    _repeatFailGuard: { sig: signature(CODE), count: 1 },
    _repeatFailHistory: [signature(CODE), 'read:{"path":"a"}'],
    _repeatArgShapeFailGuard: null,
    messages: [],
  };
  assert.equal(_sessionHeaderForDisk(session), session, 'nothing marked: the same header');
  rememberSensitiveValues(id, [fill(CODE)]);
  const stored = _sessionHeaderForDisk(session);
  assert.ok(!JSON.stringify(stored).includes(CODE), JSON.stringify(stored));
  assert.equal(stored.title, '[redacted] is the code');
  assert.equal(stored._repeatFailHistory[1], 'read:{"path":"a"}');
  assert.equal(session._repeatFailGuard.sig, signature(CODE), 'the live session keeps the value');
});

test('the summary rows written before the mark leave the index once the redacted row lands', async () => {
  const id = 'sess_1_1_1_summary';
  const session = {
    id,
    title: `${CODE} is the code`,
    messages: [
      { role: 'user', content: `${CODE} is the code from the mail.` },
      { role: 'assistant', content: `Yes, ${CODE} was accepted.` },
    ],
  };
  _upsertSessionSummary(session);
  assert.ok(await settleSummaryIndexWrites({ ids: [id] }));
  assert.ok(readFileSync(summaryLogPath(summaryIndexPath()), 'utf8').includes(CODE), 'the row before the mark');
  rememberSensitiveValues(id, [fill(CODE)]);
  const row = _sessionSummary(session);
  assert.ok(!JSON.stringify(row).includes(CODE), JSON.stringify(row));
  _upsertSessionSummary(session);
  await foldSummaryIndexForRedaction(id);
  for (const file of [summaryIndexPath(), summaryLogPath(summaryIndexPath())]) {
    assert.ok(!readFileSync(file, 'utf8').includes(CODE), file);
  }
  assert.equal(JSON.parse(readFileSync(summaryIndexPath(), 'utf8')).rows[0].preview, '[redacted] is the code from the mail.');
});
