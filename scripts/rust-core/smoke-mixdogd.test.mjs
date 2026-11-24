import assert from 'node:assert/strict';
import { test } from 'node:test';
import { judgeBoot, judgeToolFailureRows, slowestBootSteps, toolFailureCheck } from './smoke-mixdogd.mjs';

const BOOT = [
  { phase: 'compose-start', ms: 40 },
  { phase: 'core-composed', ms: 900 },
  { phase: 'sessions-bound', ms: 910 },
  { phase: 'daemon-ready', ms: 950.5 },
];
const CLEAN = { code: 0, signal: null };

test('a boot passes on its steps, their order and its exit, whatever it took', () => {
  assert.deepEqual(judgeBoot(BOOT, CLEAN), []);
  assert.deepEqual(
    judgeBoot(
      BOOT.map((mark) => ({ ...mark, ms: mark.ms * 100 })),
      CLEAN
    ),
    []
  );
});

test('a missing, repeated or reordered step, or an unclean exit, fails the boot', () => {
  assert.match(judgeBoot(BOOT.slice(1), CLEAN).join('\n'), /compose-start 0 times/);
  assert.match(judgeBoot([...BOOT, { phase: 'daemon-ready', ms: 5000 }], CLEAN).join('\n'), /daemon-ready 2 times/);
  const late = BOOT.map((mark) => (mark.phase === 'core-composed' ? { ...mark, ms: 990 } : mark));
  assert.match(judgeBoot(late, CLEAN).join('\n'), /sessions-bound \(910ms\) was marked before core-composed/);
  assert.match(judgeBoot(BOOT, { code: 1, signal: null }).join('\n'), /did not exit cleanly/);
  assert.match(judgeBoot(BOOT, { code: null, signal: 'SIGKILL' }).join('\n'), /did not exit cleanly/);
  assert.match(judgeBoot(BOOT, undefined).join('\n'), /did not exit cleanly/);
});

test('the boot steps start at serve entry and follow the marks by their instants', () => {
  const phases = [
    { phase: 'runtime-resolved', ms: 900 },
    { phase: 'compose-start', ms: 1000 },
    { phase: 'catalog-index-job-started', ms: 1100 },
    { phase: 'core-composed', ms: 1500 },
  ].reverse();
  assert.deepEqual(slowestBootSteps(phases, 2), [
    { step: 'serve-entry -> runtime-resolved', ms: 900 },
    { step: 'catalog-index-job-started -> core-composed', ms: 400 },
  ]);
});

const RUN = { sessionId: 'thread-1', cwd: 'C:\\work', startedAt: 1000, endedAt: 2000 };
// The core's row for the provoked call, with this run's own values.
const ROW = {
  iteration: 1,
  tool_name: 'read',
  tool_kind: 'builtin',
  result_kind: 'error',
  category: 'runtime/failure',
  agent: 'lead',
  model: 'smoke',
  tool_args: null,
  error_first_line: 'Error: read requires "path" (or alias file_path).',
  error_preview: 'Error: read requires "path" (or alias file_path).',
  result_bytes_est: 49,
  result_lines_est: 1,
};
const mine = (over = {}) =>
  JSON.stringify({ ...ROW, session_id: RUN.sessionId, cwd: RUN.cwd, ts: 1500, tool_ms: 4, ...over });

test('a missing or empty spool is a failure that names the writer and its owner, never a pass', () => {
  for (const rows of [null, []])
    assert.throws(
      () => judgeToolFailureRows(rows, RUN),
      /did not record the failed call.*Owner: rs-tool-failures.*NOT covered/s
    );
});

test('exactly the provoked row passes', () => {
  assert.equal(judgeToolFailureRows([mine()], RUN).tool_name, 'read');
});

test("another set of rows, or another call's row, fails", () => {
  assert.throws(
    () => judgeToolFailureRows([mine(), mine()], RUN),
    /exactly the one provoked tool-failure row, found 2/
  );
  // A row of another session.
  assert.throws(
    () => judgeToolFailureRows([mine({ session_id: 'thread-2' })], RUN),
    /differs from the expected row in: session_id "thread-2"/
  );
  // The same tool and error text, but a path was given.
  assert.throws(
    () =>
      judgeToolFailureRows(
        [mine({ tool_args: { path: 'x' }, error_first_line: 'Error: read requires "path" and more' })],
        RUN
      ),
    /tool_args \{"path":"x"\}.*error_first_line/
  );
  // A Lead's own call is the Lead's, not null.
  assert.throws(() => judgeToolFailureRows([mine({ agent: null })], RUN), /agent null \(expected: "lead"\)/);
  // Other workspace, a time outside the run, a field missing from the schema, a field added.
  assert.throws(() => judgeToolFailureRows([mine({ cwd: 'C:\\other' })], RUN), /cwd/);
  assert.throws(() => judgeToolFailureRows([mine({ ts: 5 })], RUN), /ts 5/);
  const { category, ...missing } = JSON.parse(mine());
  assert.throws(() => judgeToolFailureRows([JSON.stringify(missing)], RUN), /keys/);
  assert.throws(() => judgeToolFailureRows([mine({ extra: 1 })], RUN), /keys/);
  assert.throws(() => judgeToolFailureRows([mine({ iteration: 2 })], RUN), /iteration 2/);
});

test('the scripted turn provokes the failure in the real core', {
  skip: process.env.MIXDOG_TESTS_WITHOUT_CORE === '1' && 'MIXDOG_TESTS_WITHOUT_CORE=1: no mixdogd built',
  timeout: 180_000,
}, async () => {
  assert.ok(
    process.env.MIXDOGD_BIN,
    'MIXDOGD_BIN is not set: the lane that runs this file (release-gate.yml, rust-core job) builds mixdogd and sets it'
  );
  const row = await toolFailureCheck(process.env.MIXDOGD_BIN);
  assert.equal(row.tool_name, 'read');
  assert.equal(row.result_kind, 'error');
});
