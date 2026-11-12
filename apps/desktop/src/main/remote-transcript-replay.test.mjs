// Replay of native/core/fixtures/remote-transcript-cases (record-remote-transcript-cases.mjs, Node b6f10295a): what a paired phone is
// sent of a session's transcript (capped tool output, bounded prompt history, secret-bearing rows whole) and which rows it may read in
// full, on the product's own modules, compared whole.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { exact } from '../../../../benchmarks/rust-core/recorders/lib/exact.mjs';
import { remoteTranscriptScenarios } from '../../../../benchmarks/rust-core/recorders/lib/remote-transcript-scenarios.mjs';
import * as methods from './remote-methods.ts';
import * as sessionMethods from './remote-session-methods.ts';
import * as sessionState from './remote-relay-session-state.ts';
import * as transcript from './remote-transcript.ts';
import * as delta from './state-delta.ts';

const golden = JSON.parse(readFileSync(new URL('../../../../native/core/fixtures/remote-transcript-cases/golden.json', import.meta.url), 'utf8'));
const scenarios = remoteTranscriptScenarios({ ...methods, ...sessionMethods, ...sessionState, ...transcript, ...delta });

assert.deepEqual(golden.cases.map((c) => c.case), Object.keys(scenarios), 'every recorded case is replayed, in the recorded order');
for (const recorded of golden.cases) {
  test(recorded.case, async () => {
    assert.deepEqual(exact(await scenarios[recorded.case](), { path: recorded.case }), recorded.observed);
  });
}
