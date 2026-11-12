// Replay of native/core/fixtures/remote-view-baseline-cases (record-remote-view-baseline-cases.mjs, Node b6f10295a): the baselines a
// phone's connection retains and a reconnect that references only identical full baselines and rebuilds a usable delta decoder, on the
// product's own modules, compared whole.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { exact } from '../../../../benchmarks/rust-core/recorders/lib/exact.mjs';
import { viewBaselineScenarios } from '../../../../benchmarks/rust-core/recorders/lib/view-baseline-scenarios.mjs';
import { createKeyedListDeltaEncoder } from './list-delta.ts';
import { createRemoteViewBaselineCache, readViewBaselineOffer } from './remote-view-baseline.ts';
import { createRemoteStateLane } from '../main/remote-state-lane.ts';
import { createSnapshotDeltaDecoder } from '../main/state-delta.ts';
import { registerAndSynchronizeRelayViews } from '../main/remote-view-sync.ts';

const golden = JSON.parse(readFileSync(new URL('../../../../native/core/fixtures/remote-view-baseline-cases/golden.json', import.meta.url), 'utf8'));
const scenarios = viewBaselineScenarios({ createRemoteViewBaselineCache, readViewBaselineOffer, registerAndSynchronizeRelayViews, createRemoteStateLane, createSnapshotDeltaDecoder, createKeyedListDeltaEncoder });

assert.deepEqual(golden.cases.map((c) => c.case), Object.keys(scenarios), 'every recorded case is replayed, in the recorded order');
for (const recorded of golden.cases) {
  test(recorded.case, async () => {
    assert.deepEqual(exact(await scenarios[recorded.case](), { path: recorded.case }), recorded.observed);
  });
}
