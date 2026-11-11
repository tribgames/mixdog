// A checkpoint of a log must never outlive the content it was made of
// (session-scan-checkpoint.mjs): it holds digests of the log's first and last
// bytes, which would let a guesser test a candidate of a short secret against
// content that was redacted away. Redaction retires the checkpoints before its
// rewrite starts (session-scan-checkpoint.mjs).
import '../../../../../../scripts/lib/isolated-test-env.mjs';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const root = mkdtempSync(join(tmpdir(), 'mixdog-scan-checkpoint-lifetime-'));
process.env.MIXDOG_DATA_DIR = root;
mkdirSync(join(root, 'sessions'), { recursive: true });

const { drainSessionStore, saveSessionDurably } = await import('../store.mjs');
const { readSessionLogSync } = await import('./session-log-reader.mjs');
const { rememberSensitiveValues } = await import('../sensitive-values.mjs');
const { sessionLogPath, sessionScanCheckpointDir } = await import('./session-paths.mjs');
const { _setScanCheckpointStrideForTest, scanCheckpointPath } = await import('./session-scan-checkpoint.mjs');

test.beforeEach(() => {
  _setScanCheckpointStrideForTest(1);
  rmSync(sessionScanCheckpointDir(), { recursive: true, force: true });
});
test.after(() => {
  _setScanCheckpointStrideForTest(null);
  drainSessionStore();
  rmSync(root, { recursive: true, force: true });
});

const msg = (text) => ({ role: 'user', content: text });
const scanned = (logPath) => readSessionLogSync(logPath, { messages: false, checkpoints: sessionScanCheckpointDir() });
// The epoch tokens (`.epoch`) hold a path and a random value, nothing of a log.
const leftBy = () => {
  try {
    return readdirSync(sessionScanCheckpointDir()).filter((name) => !name.endsWith('.epoch'));
  } catch {
    return [];
  }
};
const CODE = '482913';
const fill = { name: 'browser', arguments: { action: 'fill', input: { sensitive: true, text: CODE } } };

// (A scan that began on the old log and publishes after the redaction: see
// session-scan-checkpoint-processes.test.mjs, with two real processes.)
test('a checkpoint another process left for the log before its rewrite is refused at adoption', async () => {
  const id = 'sess_cp_stale_adoption';
  const session = { id, owner: 'agent', messages: [msg(`pin ${CODE} ${'d'.repeat(2000)}`), msg('two'), msg('three')] };
  await saveSessionDurably(session);
  const logPath = sessionLogPath(id);
  scanned(logPath);
  const file = scanCheckpointPath(sessionScanCheckpointDir(), logPath);
  const stale = join(root, 'stale-checkpoint.json');
  copyFileSync(file, stale);
  rememberSensitiveValues(id, [fill]);
  await saveSessionDurably({ ...session, messages: [...session.messages, msg('four')] });
  assert.deepEqual(leftBy(), [], 'the redaction removed the checkpoint before it rewrote');
  // The other process's late publication, as a crash or a race would leave it.
  copyFileSync(stale, file);
  const resumed = scanned(logPath);
  const whole = readSessionLogSync(logPath, { messages: false });
  assert.deepEqual(resumed.header, whole.header);
  assert.equal(resumed.messageCount, whole.messageCount);
  assert.notEqual(
    JSON.parse(readFileSync(file, 'utf8')).first,
    JSON.parse(readFileSync(stale, 'utf8')).first,
    'the stale place was dropped and replaced (first-bytes digest: the rewrite renews the log id)'
  );
});

