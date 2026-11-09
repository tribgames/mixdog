#!/usr/bin/env node
// Golden twin of what Node's `ensureStandaloneEnvironment` (session-runtime/services/seeds.mjs) changes in how the runtime behaves:
//  - MIXDOG_EMBED_WARMUP ??= '0': whether the eager embedding warm-up may start (`embeddingWarmupCanStart`) and the on-demand load
//    (`embeddingOnDemandCanStart`), read with the real memory-config-flags.mjs after the real function ran over each starting value;
//  - MIXDOG_STANDALONE ??= '1': the reply of the channel worker's real `reload_config` (tool-dispatch.mjs `createToolDispatch`), whose
//    agent-runtime reload (initProviders + refreshCatalogs) runs only when MIXDOG_STANDALONE !== '1'.
// Replayed by `mixdog-services` `model_install/trigger_tests.rs` and `channels/tests_runtime.rs`.
//
//   node benchmarks/rust-core/recorders/record-standalone-defaults.mjs --tree <git checkout at --commit, with node_modules> --commit <40-hex>
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FIXTURES_ROOT, commitCheckoutIdentity, commitStage, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

const cli = parseArgs();
const tree = resolveTree(cli);
const commit = cli.get('commit');
const identity = commitCheckoutIdentity(tree, commit);
const outDir = cli.get('out') ?? join(FIXTURES_ROOT, 'standalone-defaults');
const stage = stageSet(outDir);

const { ensureStandaloneEnvironment } = await importFrom(tree, 'src/session-runtime/services/seeds.mjs');
const flags = await importFrom(tree, 'src/runtime/memory/lib/memory-config-flags.mjs');
const { onnxRuntimeSupported } = await importFrom(tree, 'src/runtime/shared/onnx-runtime-support.mjs');
const { createToolDispatch } = await importFrom(tree, 'src/runtime/channels/lib/tool-dispatch.mjs');

const work = mkdtempSync(join(tmpdir(), 'standalone-defaults-'));
let counter = 0;
/** Runs the real function from a process environment holding exactly `env` (of the names we vary), returns the process env after it. */
function start(env) {
  for (const name of ['MIXDOG_EMBED_WARMUP', 'MIXDOG_STANDALONE', 'MIXDOG_MEMORY_SECONDARY']) delete process.env[name];
  for (const [name, value] of Object.entries(env)) process.env[name] = value;
  const dataDir = join(work, `data-${counter += 1}`);
  ensureStandaloneEnvironment({ rootDir: join(tree, 'src'), dataDir });
  return dataDir;
}

const warmupStarts = [undefined, '0', '1', 'false', 'FALSE', ' no ', 'off', 'true', 'on', 'YES', '', '  ', 'maybe', '2'];
const warmup = warmupStarts.map((value) => {
  start(value === undefined ? {} : { MIXDOG_EMBED_WARMUP: value });
  return {
    embedWarmup: value ?? null,
    onnxRuntimeSupported: onnxRuntimeSupported(),
    warmupCanStart: flags.embeddingWarmupCanStart(),
    onDemandCanStart: flags.embeddingOnDemandCanStart(),
  };
});

const noop = async () => {};
const reloads = [];
for (const standalone of [undefined, '1']) {
  const dataDir = start(standalone === undefined ? {} : { MIXDOG_STANDALONE: standalone });
  let runtimeReloads = 0;
  const lifecycle = {
    getChannelBridgeActive: () => false, getOwned: () => true, setChannelBridgeActive: noop, writeBridgeState: noop,
    notifyRemoteAcquired: noop, startChannelBridge: noop, stopOwnedRuntime: noop, renameSchedule: noop,
    reloadRuntimeConfig: async () => { runtimeReloads += 1; },
  };
  const result = await createToolDispatch({ isChannelsDegraded: () => false, lifecycle }).handleToolCall('reload_config', {});
  reloads.push({ standalone: standalone ?? null, standaloneAfterStart: process.env.MIXDOG_STANDALONE, runtimeReloads, result, dataDirEntries: readdirSync(dataDir).sort() });
}

writeJson(join(stage, 'twin.json'), { warmup, reloads });
writeSetManifest(stage, {
  set: 'standalone-defaults',
  recorder: 'benchmarks/rust-core/recorders/record-standalone-defaults.mjs',
  command: `node benchmarks/rust-core/recorders/record-standalone-defaults.mjs --tree <git checkout of ${commit}> --commit ${commit}`,
  identity,
});
commitStage(stage, outDir);
rmSync(work, { recursive: true, force: true });
console.log(`standalone-defaults: ${warmup.length} warm-up states, ${reloads.length} reloads -> ${outDir}`);
