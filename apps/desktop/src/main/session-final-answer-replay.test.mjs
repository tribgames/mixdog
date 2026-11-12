// Replay of native/core/fixtures/session-final-answer-cases (record-session-final-answer-cases.mjs, Node b6f10295a): the answer a
// finished turn announces and the host's read of the requested session, on the product's own modules, compared whole.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { finalAnswerScenarios } from '../../../../benchmarks/rust-core/recorders/lib/final-answer-scenarios.mjs';
import { exact } from '../../../../benchmarks/rust-core/recorders/lib/exact.mjs';
import { restoreTranscriptItems } from '../../../../src/runtime/agent/orchestrator/session/transcript-restore/restore.mjs';
import { isSessionMissingError, sessionFinalAnswer, SESSION_NOT_AVAILABLE_CODE } from './session-final-answer.ts';
import { SessionHost } from './session-host.ts';

const golden = JSON.parse(readFileSync(new URL('../../../../native/core/fixtures/session-final-answer-cases/golden.json', import.meta.url), 'utf8'));
const scenarios = finalAnswerScenarios({ isSessionMissingError, sessionFinalAnswer, SESSION_NOT_AVAILABLE_CODE, SessionHost, restoreTranscriptItems });

assert.deepEqual(golden.cases.map((c) => c.case), Object.keys(scenarios), 'every recorded case is replayed, in the recorded order');
for (const recorded of golden.cases) {
  test(recorded.case, async () => {
    assert.deepEqual(exact(await scenarios[recorded.case](), { path: recorded.case }), recorded.observed);
  });
}
