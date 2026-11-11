// The rebuild worker's scan leaves the facts of a log's messages in a
// checkpoint (their previews are text of the transcript). A value marked
// sensitive replaces the log with a redacted one: nothing of the value may stay
// in what the old log's scans left behind.
import '../../../../../../scripts/lib/isolated-test-env.mjs';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const root = mkdtempSync(join(tmpdir(), 'mixdog-rebuild-redaction-'));
process.env.MIXDOG_DATA_DIR = root;
mkdirSync(join(root, 'sessions'), { recursive: true });

const { drainSessionStore, saveSessionDurably } = await import('../store.mjs');
const { settleSessionSummaryIndex } = await import('./listing.mjs');
const { _scanStoredSessionSummaryRowsAsync, _setResumableMinBytesForTest } = await import('./summary-cache.mjs');
const { sessionScanCheckpointDir } = await import('./session-paths.mjs');
const { _setScanCheckpointStrideForTest } = await import('./session-scan-checkpoint.mjs');
const { rememberSensitiveValues } = await import('../sensitive-values.mjs');

test.after(async () => {
  _setScanCheckpointStrideForTest(null);
  _setResumableMinBytesForTest(null);
  await settleSessionSummaryIndex();
  drainSessionStore();
  rmSync(root, { recursive: true, force: true });
});

const holding = (dir, value) =>
  readdirSync(dir).filter((name) => readFileSync(join(dir, name), 'utf8').includes(value));

test('a value marked sensitive leaves nothing of itself in the checkpoints of its session', async () => {
  _setScanCheckpointStrideForTest(1);
  _setResumableMinBytesForTest(0);
  const id = 'sess_rebuild_redaction';
  const session = {
    id,
    owner: 'agent',
    messages: [{ role: 'user', content: 'first alpha-111111' }, { role: 'assistant', content: 'noted' }],
  };
  await saveSessionDurably(session);
  await _scanStoredSessionSummaryRowsAsync({ resumable: true });
  const dir = sessionScanCheckpointDir();
  assert.equal(holding(dir, 'alpha-111111').length, 1, 'the scan kept the preview of the first message');

  rememberSensitiveValues(id, [{ name: 'browser', arguments: { action: 'fill', input: { sensitive: true, text: 'alpha-111111' } } }]);
  await saveSessionDurably(session);
  assert.deepEqual(holding(dir, 'alpha-111111'), [], 'no checkpoint holds the value');
  assert.deepEqual(holding(join(root, 'sessions'), 'alpha-111111'), [], 'no file of the store holds it');
});
