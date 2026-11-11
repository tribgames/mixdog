#!/usr/bin/env node
// When the provider registry says it is initialized (WP-AI-CORE): the REAL Node
// `providersInitialized()` of providers/registry.mjs, driven through `initProviders` with
// scripted configs. The promise settles at the first initialization that applied a config; a
// refused init (empty config, only invalid custom providers) leaves it pending, and a later
// refused init never unsettles it. Rust `ProviderRegistry::wait_initialized` must answer the same
// after every step.
//
//   node benchmarks/rust-core/recorders/record-provider-ready.mjs [--tree <dir with node_modules>]
//
// Output: native/core/fixtures/provider-ready/golden.json. No network, no credential: a custom
// provider with `preconnect: false` is built without touching the wire. Every user directory is a
// fresh temp one BEFORE any product module loads.
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const sandbox = mkdtempSync(join(tmpdir(), 'provider-ready-'));
const dirs = Object.fromEntries(['data', 'home', 'appdata', 'localappdata'].map((name) => [name, join(sandbox, name)]));
for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true });
Object.assign(process.env, {
  MIXDOG_DATA_DIR: dirs.data,
  MIXDOG_HOME: dirs.home,
  MIXDOG_SKIP_USER_DATA_BACKUP: '1',
  HOME: dirs.home,
  USERPROFILE: dirs.home,
  APPDATA: dirs.appdata,
  LOCALAPPDATA: dirs.localappdata,
});
const { FIXTURES_ROOT, commitStage, parseArgs, resolveTree, stageSet, writeJson, recordingProvenance, writeSetManifest } = await import('./lib/common.mjs');

const tree = resolveTree(parseArgs());
const finalDir = join(FIXTURES_ROOT, 'provider-ready');
const stage = stageSet(finalDir);
const recorder = 'benchmarks/rust-core/recorders/record-provider-ready.mjs';
const REGISTRY = pathToFileURL(join(tree, 'src/runtime/agent/orchestrator/providers/registry.mjs')).href;

const base = { type: 'custom', name: 'Mine', baseURL: 'https://llm.example.com/v1', enabled: true };
// The configs a step names: `empty` is refused outright, `invalid_custom` is skipped as the only
// provider (all disabled), `valid` registers one.
const CONFIGS = {
  empty: {},
  invalid_custom: { 'custom-bad': { ...base, protocol: 'nope', apiKey: 'k', models: [{ id: 'm1' }] } },
  valid: { 'custom-ok': { ...base, protocol: 'openai-chat', apiKey: 'k', preconnect: false, models: [{ id: 'm1' }] } },
};
// `apply` runs initProviders; `wait` attaches a waiter that stays attached for the later steps.
const SCENARIOS = [
  { name: 'never_initialized', steps: [] },
  { name: 'empty_config_refused', steps: [{ op: 'apply', config: 'empty' }] },
  { name: 'only_invalid_custom_refused', steps: [{ op: 'apply', config: 'invalid_custom' }] },
  { name: 'valid_config_settles', steps: [{ op: 'apply', config: 'valid' }] },
  { name: 'a_later_refusal_never_unsettles', steps: [{ op: 'apply', config: 'valid' }, { op: 'apply', config: 'empty' }, { op: 'apply', config: 'invalid_custom' }] },
  { name: 'a_waiter_resolves_at_the_first_applied_config', steps: [{ op: 'wait' }, { op: 'apply', config: 'empty' }, { op: 'apply', config: 'invalid_custom' }, { op: 'apply', config: 'valid' }, { op: 'apply', config: 'empty' }] },
  { name: 'a_second_valid_config_changes_nothing', steps: [{ op: 'apply', config: 'valid' }, { op: 'apply', config: 'valid' }] },
];

// Event-loop turns, not wall time: a settled promise has run its reactions after two.
const turn = () => new Promise((resolve) => setImmediate(resolve));
async function settled(promise) {
  let done = false;
  promise.then(() => { done = true; });
  await turn();
  await turn();
  return done;
}

const stderrWrite = process.stderr.write;
const recorded = [];
let n = 0;
for (const scenario of SCENARIOS) {
  n += 1;
  // A fresh module instance per scenario: its readiness promise is its own.
  const registry = await import(`${REGISTRY}?scenario=${n}`);
  const waiter = scenario.steps.some((s) => s.op === 'wait') ? registry.providersInitialized() : null;
  const record = { name: scenario.name, initial: await settled(registry.providersInitialized()), steps: [] };
  for (const step of scenario.steps) {
    const row = { ...step };
    if (step.op === 'apply') {
      process.stderr.write = () => true;
      try {
        await registry.initProviders(structuredClone(CONFIGS[step.config]));
        row.outcome = 'ok';
      } catch {
        row.outcome = 'refused';
      } finally {
        process.stderr.write = stderrWrite;
      }
    }
    row.ready = await settled(registry.providersInitialized());
    if (waiter) row.waiter = await settled(waiter);
    record.steps.push(row);
  }
  recorded.push(record);
}
writeJson(join(stage, 'golden.json'), { configs: CONFIGS, scenarios: recorded });
writeSetManifest(stage, { set: 'provider-ready', recorder, command: 'node ' + recorder + ' --tree <tree>', identityTree: tree, extra: recordingProvenance(recorder, ['benchmarks/rust-core/recorders/lib/common.mjs']) });
commitStage(stage, finalDir);
