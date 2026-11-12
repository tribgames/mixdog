#!/usr/bin/env node
// Recording of apps/desktop/src/shared/remote-view-baseline.test.mjs (b6f10295a): the baselines a phone's connection retains (bounded,
// pinned during recovery, isolated from consumer mutation, expiring), and a reconnect that references only identical full baselines
// by key and rebuilds a usable delta decoder from them. The real baseline cache, view synchronisation, state lane and delta
// encoder/decoder with a scripted host; every frame sent is recorded whole.
//
//   node --import ./apps/desktop/scripts/test-env.mjs --import ./apps/desktop/scripts/test-tsx.mjs \
//        benchmarks/rust-core/recorders/record-remote-view-baseline-cases.mjs --tree <export of b6f10295a with node_modules>
import { openSet } from './lib/case-set.mjs';
import { REPLAY_TARGETS } from './lib/replay-targets.mjs';
import { viewBaselineScenarios } from './lib/view-baseline-scenarios.mjs';

REPLAY_TARGETS['remote-view-baseline-cases'] = {
  missing: ['the baseline offer and key references of a reconnecting phone are the desktop relay\'s (apps/desktop/src/shared/remote-view-baseline.ts, main/remote-view-sync.ts); the core has feed resume (thread/resume with a window) and no compact view baseline'],
};
const set = openSet('remote-view-baseline-cases', import.meta.url);
const modules = {
  ...(await set.load('apps/desktop/src/shared/remote-view-baseline.ts')),
  ...(await set.load('apps/desktop/src/main/remote-view-sync.ts')),
  ...(await set.load('apps/desktop/src/main/remote-state-lane.ts')),
  ...(await set.load('apps/desktop/src/main/state-delta.ts')),
  ...(await set.load('apps/desktop/src/shared/list-delta.ts')),
};
for (const [name, scenario] of Object.entries(viewBaselineScenarios(modules))) await set.run(name, scenario);

await set.finish({
  entry: { runs: 'createRemoteViewBaselineCache, readViewBaselineOffer, registerAndSynchronizeRelayViews, createRemoteStateLane, createSnapshotDeltaDecoder, createKeyedListDeltaEncoder', notRun: 'a scripted host answers the snapshot, the session list and the agent pool; the cache\'s clock is a variable the case sets', hops: 'The frames handed to the send function are recorded whole.' },
  replay: { entry: 'the desktop relay\'s view baseline cache and reconnect synchronisation on the product modules; compare each case whole', normalised: {} },
});
process.exit(0);
