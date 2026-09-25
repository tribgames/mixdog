import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_SOFFICE_STDERR_CHARS, runSoffice } from './portable-soffice.mjs';

test('a failed LibreOffice run reports a bounded slice of what it wrote to stderr', async () => {
  // A child that floods stderr well past the cap and then fails, the way a
  // converter warning on every page of a long document would.
  const flood = MAX_SOFFICE_STDERR_CHARS * 4;
  const script = `process.stderr.write('w'.repeat(${flood}), () => process.exit(3));`;
  const result = await runSoffice(process.execPath, ['-e', script], {
    signal: null,
    timeoutMs: 60_000,
    timeoutMessage: 'timed out',
    cancelMessage: 'cancelled',
  });
  assert.equal(result.ok, false);
  assert.ok(result.error.length > 0);
  assert.ok(result.error.length <= MAX_SOFFICE_STDERR_CHARS, `error carried ${result.error.length} characters`);
});
