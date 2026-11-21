export const SUMMARY_TAG = '[failure-summary]';

const keyOf = (record) => `${record.file}\u0000${record.name}`;
const byLocation = (a, b) => (a.file === b.file ? a.name.localeCompare(b.name) : a.file.localeCompare(b.file));

// Flaky: failed, then passed within the re-run budget. Failed: failed every attempt, or first appeared during a re-run.
// attempts: [{ files: [rerun file paths], failures: [{ file, name }] }]
export function classifyRerunOutcomes(initialFailures, attempts = []) {
  const pending = new Map(initialFailures.map((record) => [keyOf(record), { ...record }]));
  const flaky = new Map();
  for (const [index, attempt] of attempts.entries()) {
    const attemptNumber = index + 1;
    const rerunFiles = new Set(attempt.files);
    const stillFailing = new Set(attempt.failures.map(keyOf));
    for (const [key, record] of [...pending]) {
      if (!rerunFiles.has(record.file) || stillFailing.has(key)) continue;
      pending.delete(key);
      flaky.set(key, { ...record, passedOnAttempt: attemptNumber });
    }
    for (const record of attempt.failures) {
      const key = keyOf(record);
      if (pending.has(key) || flaky.has(key)) continue;
      pending.set(key, { ...record, firstSeenOnRerun: attemptNumber });
    }
  }
  return { failed: [...pending.values()].sort(byLocation), flaky: [...flaky.values()].sort(byLocation) };
}

// Exit-code policy, stated wherever the classification is shown.
export function policyLine(rerunFailed) {
  return rerunFailed > 0
    ? `policy: --rerun-failed ${rerunFailed} is set, so a flaky test does not fail the run; a test that fails every re-run still exits 1`
    : 'policy: --rerun-failed is off, so every failure fails the run (pass --rerun-failed <n> to classify flaky)';
}

// `hung`: one "hung after N min: <files>" message per batch the watchdog killed; it fails the run.
// A non-zero `exitCode` with no failed test or hung batch is its own failure.
// `pids`: the node --test processes that exited non-zero.
export function formatFailureSummary({ failed = [], flaky = [], rerunFailed = 0, hung = [], exitCode = 0, pids = [] }) {
  const hungCount = hung.length > 0 ? `, ${hung.length} hung batch(es)` : '';
  const unexplained = exitCode !== 0 && failed.length === 0 && hung.length === 0;
  const runner = pids.length > 0 ? `node --test pid ${pids.join(' ')}: ` : '';
  const lines = [
    unexplained
      ? `${SUMMARY_TAG} RUN FAILED: exit code ${exitCode} with no failed test recorded (${runner}bad argument, runner error or killed from outside; see output above)`
      : `${SUMMARY_TAG} ${failed.length} failed, ${flaky.length} flaky${hungCount} (every failed test is named below)`,
  ];
  for (const message of hung) lines.push(`${SUMMARY_TAG} HUNG ${message}`);
  for (const record of failed) {
    const origin = record.firstSeenOnRerun ? ` (first seen on re-run ${record.firstSeenOnRerun})` : '';
    const exit = record.exit ? ` (${record.exit})` : '';
    lines.push(`${SUMMARY_TAG} FAILED ${record.file} > ${record.name}${exit}${origin}`);
  }
  for (const record of flaky) {
    lines.push(
      `${SUMMARY_TAG} FLAKY ${record.file} > ${record.name} (failed, then passed on re-run ${record.passedOnAttempt}/${rerunFailed})`
    );
  }
  if (failed.length > 0 || flaky.length > 0 || hung.length > 0) lines.push(`${SUMMARY_TAG} ${policyLine(rerunFailed)}`);
  return `${lines.join('\n')}\n`;
}
