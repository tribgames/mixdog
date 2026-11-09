#!/usr/bin/env node
// Node's shared provider catalog (`sharedProviderCatalog`, session-runtime/provider-catalog-cache.mjs over
// catalog-deadline.mjs) when a provider's listing ends exactly at the 4 s deadline: its listModels answers on a
// 4000 ms timer, armed after the deadline's own 4000 ms timer, so the deadline fires first. Each scenario reads the
// catalog once, waits for the late listing to settle, and reads it again unforced. The recording holds each read's
// entries (models, error, retryAt from a frozen clock) and how often each provider was asked. Rust's
// `ProviderCatalog` must publish the same models and state and ask the same providers again.
//
//   node benchmarks/rust-core/recorders/record-catalog-deadline-tie.mjs --tree <export of b6f10295a with node_modules>
//
// Output: native/core/fixtures/catalog-deadline-tie/golden.json (+ MANIFEST.json, identity exact at the commit).
import { join } from 'node:path';
import { FIXTURES_ROOT, commitStage, importFrom, parseArgs, productIdentity, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

const NODE_COMMIT = 'b6f10295a2f698afc85332467192de28500bd146';
const recorder = 'benchmarks/rust-core/recorders/record-catalog-deadline-tie.mjs';
const NOW = 1_800_000_000_000;
const SCENARIOS = [
  { name: 'tie-alone', providers: [{ name: 'tie', answersAfterMs: 4_000 }] },
  { name: 'tie-beside-a-fast-provider', providers: [{ name: 'fast', answersAfterMs: 10 }, { name: 'tie', answersAfterMs: 4_000 }] },
];

const tree = resolveTree(parseArgs());
const cache = await importFrom(tree, 'src/session-runtime/provider-catalog-cache.mjs');
const realNow = Date.now;
Date.now = () => NOW;

const entryOf = (entry) => ({
  name: entry.name,
  models: entry.models.map((m) => m.id),
  ...(Object.hasOwn(entry, 'error') ? { error: { code: entry.error.code, message: entry.error.message }, retryAfterMs: entry.retryAt - NOW } : {}),
});

const results = [];
for (const scenario of SCENARIOS) {
  // A new registry revision per scenario: nothing of the previous one is reused.
  const revision = results.length + 1;
  const calls = Object.fromEntries(scenario.providers.map((p) => [p.name, 0]));
  const listed = [];
  const providers = scenario.providers.map(({ name, answersAfterMs }) => [
    name,
    {
      listModels() {
        calls[name] += 1;
        const answer = new Promise((resolve) => setTimeout(() => resolve([{ id: 'm' }]), answersAfterMs));
        listed.push(answer);
        return answer;
      },
    },
  ]);
  const registry = { providerCatalogRevision: () => revision, getAllProviders: () => providers };
  const first = (await cache.sharedProviderCatalog(registry)).map(entryOf);
  const callsAfterFirst = { ...calls };
  // The late listing settles (and leaves catalog-deadline's table on the turn after) before the second read.
  await Promise.all(listed);
  await new Promise((resolve) => setImmediate(resolve));
  const second = (await cache.sharedProviderCatalog(registry)).map(entryOf);
  // The same before the next scenario: a listing still pending would be a stalled one to it (catalog-deadline's table
  // is process-wide).
  await Promise.all(listed);
  await new Promise((resolve) => setImmediate(resolve));
  results.push({ name: scenario.name, providers: scenario.providers, first, callsAfterFirst, second, callsAfterSecond: { ...calls } });
}
Date.now = realNow;

const identity = productIdentity(tree, NODE_COMMIT);
if (!identity.refComparison.exact) throw new Error(`the tree is not an exact export of ${NODE_COMMIT}: ${JSON.stringify(identity.refComparison)}`);
const finalDir = join(FIXTURES_ROOT, 'catalog-deadline-tie');
const stage = stageSet(finalDir);
writeJson(join(stage, 'golden.json'), { now: NOW, scenarios: results });
writeSetManifest(stage, { set: 'catalog-deadline-tie', recorder, command: `node ${recorder} --tree <tree>`, identity });
commitStage(stage, finalDir);
