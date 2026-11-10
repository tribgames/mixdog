import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NODE_ROW, judgeToolFailureRows, toolFailureCheck } from './smoke-mixdogd.mjs';

const RUN = { sessionId: 'thread-1', cwd: 'C:\\work', startedAt: 1000, endedAt: 2000 };
// The core's row for the provoked call: Node's recorded row with this run's own values.
const mine = (over = {}) => JSON.stringify({ ...NODE_ROW, session_id: RUN.sessionId, cwd: RUN.cwd, ts: 1500, tool_ms: 4, ...over });

test('a missing or empty spool is a failure that names the missing writer and its owner, never a pass', () => {
  for (const rows of [null, []]) assert.throws(() => judgeToolFailureRows(rows, RUN), /no tool-failure writer yet.*Owner: rs-tool-failures.*NOT covered/s);
});

test('exactly the provoked row passes', () => {
  assert.equal(judgeToolFailureRows([mine()], RUN).tool_name, 'read');
});

test('another set of rows, or another call\'s row, fails', () => {
  assert.throws(() => judgeToolFailureRows([mine(), mine()], RUN), /exactly the one provoked tool-failure row, found 2/);
  // A row of another session.
  assert.throws(() => judgeToolFailureRows([mine({ session_id: 'thread-2' })], RUN), /differs from Node's row in: session_id "thread-2"/);
  // The same tool and error text, but a path was given.
  assert.throws(
    () => judgeToolFailureRows([mine({ tool_args: { path: 'x' }, error_first_line: 'Error: read requires "path" and more' })], RUN),
    /tool_args \{"path":"x"\}.*error_first_line/,
  );
  // Other workspace, a time outside the run, a field missing from Node's schema, a field added.
  assert.throws(() => judgeToolFailureRows([mine({ cwd: 'C:\\other' })], RUN), /cwd/);
  assert.throws(() => judgeToolFailureRows([mine({ ts: 5 })], RUN), /ts 5/);
  const { category, ...missing } = JSON.parse(mine());
  assert.throws(() => judgeToolFailureRows([JSON.stringify(missing)], RUN), /keys/);
  assert.throws(() => judgeToolFailureRows([mine({ extra: 1 })], RUN), /keys/);
  assert.throws(() => judgeToolFailureRows([mine({ iteration: 2 })], RUN), /iteration 2/);
});

// Needs the real core: MIXDOGD_BIN, which the lane sets (release-gate.yml, rust-core job); without it the test FAILS, since a skip
// would read as a pass. MIXDOG_TESTS_WITHOUT_CORE=1 is the explicit local opt-out; no lane sets it.
// The scripted turn must reach the failed tool result (otherwise the check throws something else). Until rs-tool-failures
// (the core's tool-failure writer) lands, the verdict is the owner message and that is accepted here; once it has, the
// row must be the provoked one and this test must drop the catch.
test('the scripted turn provokes the failure in the real core', { skip: process.env.MIXDOG_TESTS_WITHOUT_CORE === '1' && 'MIXDOG_TESTS_WITHOUT_CORE=1: no mixdogd built', timeout: 180_000 }, async () => {
  assert.ok(process.env.MIXDOGD_BIN, 'MIXDOGD_BIN is not set: the lane that runs this file (release-gate.yml, rust-core job) builds mixdogd and sets it');
  try {
    const row = await toolFailureCheck(process.env.MIXDOGD_BIN);
    assert.equal(row.tool_name, 'read');
  } catch (error) {
    assert.match(error.message, /Owner: rs-tool-failures/, 'only the missing writer (owner rs-tool-failures) is accepted here');
  }
});