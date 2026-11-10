import assert from 'node:assert/strict';
import { test } from 'node:test';
import { judgeToolFailureRows, toolFailureCheck } from './smoke-mixdogd.mjs';

const ROW = JSON.stringify({ tool_name: 'read', result_kind: 'error', error_first_line: 'Error: read requires "path" (or alias file_path).' });

test('a missing or empty spool is a failure that names the missing writer and its owner, never a pass', () => {
  for (const rows of [null, []]) assert.throws(() => judgeToolFailureRows(rows), /no tool-failure writer yet.*Owner: rs-tool-failures.*NOT covered/s);
});

test('exactly the provoked row passes, any other set of rows fails', () => {
  assert.equal(judgeToolFailureRows([ROW]).tool_name, 'read');
  assert.throws(() => judgeToolFailureRows([ROW, ROW]), /exactly the one provoked tool-failure row, found 2/);
  assert.throws(() => judgeToolFailureRows([JSON.stringify({ tool_name: 'grep', result_kind: 'error', error_first_line: 'x' })]), /not the provoked one/);
  assert.throws(() => judgeToolFailureRows([JSON.stringify({ tool_name: 'read', result_kind: 'error', error_first_line: 'other' })]), /not the provoked one/);
});

// Needs the real core: MIXDOGD_BIN. The scripted turn must reach the failed tool result (otherwise the check throws something else);
// until the core has the writer the verdict is the owner message, and once it has, the row must be the provoked one.
test('the scripted turn provokes the failure in the real core', { skip: !process.env.MIXDOGD_BIN && 'MIXDOGD_BIN is not set', timeout: 180_000 }, async () => {
  try {
    const row = await toolFailureCheck(process.env.MIXDOGD_BIN);
    assert.equal(row.tool_name, 'read');
  } catch (error) {
    assert.match(error.message, /Owner: rs-tool-failures/);
  }
});
