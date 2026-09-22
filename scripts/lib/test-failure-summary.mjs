// Run-level failure classification and the final summary block.
//
// A filtered run log loses a failure: `ℹ fail 1` says a test failed but never
// which one. Every line here carries SUMMARY_TAG and names its file and test,
// so the block survives `grep`/`Select-String` filtering, and the runner
// prints it after all other output (scripts/lib/run-node-tests.mjs).
export const SUMMARY_TAG = '[failure-summary]';

const keyOf = (record) => `${record.file}\u0000${record.name}`;
const byLocation = (a, b) => (a.file === b.file ? a.name.localeCompare(b.name) : a.file.localeCompare(b.file));

// A test that failed and then passed inside the re-run budget is flaky; one
// that fails every attempt stays failed. A failure that only appears during a
// re-run joins the failed set from the attempt that produced it, so a re-run
// can never hide a test it just broke.
//
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

export function formatFailureSummary({ failed = [], flaky = [], rerunFailed = 0 }) {
  const lines = [`${SUMMARY_TAG} ${failed.length} failed, ${flaky.length} flaky (every failed test is named below)`];
  for (const record of failed) {
    const origin = record.firstSeenOnRerun ? ` (first seen on re-run ${record.firstSeenOnRerun})` : '';
    lines.push(`${SUMMARY_TAG} FAILED ${record.file} > ${record.name}${origin}`);
  }
  for (const record of flaky) {
    lines.push(
      `${SUMMARY_TAG} FLAKY ${record.file} > ${record.name} (failed, then passed on re-run ${record.passedOnAttempt}/${rerunFailed})`
    );
  }
  if (failed.length > 0 || flaky.length > 0) lines.push(`${SUMMARY_TAG} ${policyLine(rerunFailed)}`);
  return `${lines.join('\n')}\n`;
}
