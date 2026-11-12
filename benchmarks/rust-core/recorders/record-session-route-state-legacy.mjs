#!/usr/bin/env node
// The header Node wrote before the prune-after-save fix, recorded from the UNPATCHED Node of the reference commit. The route-state
// recording (`record-session-route-state.mjs`) is made from the commit plus `node-fix-prune-after-save.patch`, whose sessions carry a
// reference set (`offloadSources`, `offloadSourcesRules`); a session an older Node saved has neither, and the core must read it as
// it is and leave it so through a save (`route_state.rs`, `a_header_node_wrote_without_a_reference_set_keeps_none_through_a_save`).
// The case is the heir of the route-state recording's inheritance cases (`inheritanceRouteTarget`, the target of a carry that was
// refused, so unchanged), saved and loaded through Node's real session store.
//
//   node benchmarks/rust-core/recorders/record-session-route-state-legacy.mjs --tree <dir> --commit b6f10295a2f698afc85332467192de28500bd146
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exact } from './lib/exact.mjs';
import { runSessionRecorder } from './lib/session-rec.mjs';

const DATA = join(tmpdir(), 'rec-session-route-state-legacy');
rmSync(DATA, { recursive: true, force: true });
mkdirSync(DATA, { recursive: true });
process.env.MIXDOG_DATA_DIR = DATA;
process.env.MIXDOG_AGENT_TRACE_DISABLE = '1';

await runSessionRecorder(import.meta.url, {
  set: 'session-route-state-legacy',
  testFile: 'src/session-runtime/session-lifecycle.test.mjs',
  entry: 'NO PATCH APPLIED: the tree is exactly the reference commit (product.exact, no `patches`). Saved the heir session of the inheritance cases (inheritanceRouteTarget of an anthropic-oauth claude-opus-5 route with a 500000 window, no messages) through the real session store (store.mjs saveSessionAsync on a temp MIXDOG_DATA_DIR) and read it back with loadSession: the stored header of a session this Node wrote. Checked here that it holds neither offloadSources nor offloadSourcesRules.',
  replay: 'mixdog-core-replays tests/dispatch/route_state.rs a_header_node_wrote_without_a_reference_set_keeps_none_through_a_save: the recorded header, unchanged, is the stored header of a thread opened by the core; a save (thread/name/set) leaves it as it was but for the fields the rename writes.',
  values: 'exact (benchmarks/rust-core/recorders/lib/exact.mjs)',
  exclusions: ['no value is normalised: the header is the one loadSession returned, whole; Date.now() is not fixed, so its stamps are this run\'s (the replay compares the header the core stores with the recorded one whole, whatever the stamps)'],
}, async ({ imp }) => {
  const store = await imp('src/runtime/agent/orchestrator/session/store.mjs');
  const { inheritanceRouteTarget } = await imp('src/session-runtime/inheritance-fit.mjs');
  const route = { provider: 'anthropic-oauth', model: 'claude-opus-5', selectedContextWindow: 500_000 };
  const heir = { id: 'heir', messages: [], ...inheritanceRouteTarget(route) };
  await store.saveSessionAsync(structuredClone(heir), {});
  const header = store.loadSession('heir');
  for (const key of ['offloadSources', 'offloadSourcesRules']) {
    if (key in header) throw new Error(`the unpatched Node's stored header holds ${key}: this is not the legacy header`);
  }
  return { cases: [{ name: 'header-saved-before-the-reference-set', input: exact({ route, heir }), result: exact({ header }) }] };
});
process.exit(0);
