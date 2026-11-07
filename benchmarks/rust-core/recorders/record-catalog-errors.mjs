#!/usr/bin/env node
// `withCatalogErrors(setup)` (session-runtime/provider-auth/setup.mjs) over failures recorded by the
// real `recordProviderCatalogOutcome` (providers/catalog-failures.mjs): a provider whose model
// list failed says why on its row. Each scenario records the failures as the store holds them
// (`providerCatalogFailure(id)`) and the setup before and after the overlay. Rust
// `mixdog_core_domains::domains::ai_account::setup_overlays::with_catalog_errors` must produce the
// same document from the same failures, key order included.
//
//   node benchmarks/rust-core/recorders/record-catalog-errors.mjs [--tree <dir>]
//
// Output: native/core/fixtures/catalog-errors/golden.json.
process.env.TZ = 'UTC';
process.env.MIXDOG_SKIP_USER_DATA_BACKUP = '1';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FIXTURES_ROOT, commitStage, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

const tree = resolveTree(parseArgs());
const finalDir = join(FIXTURES_ROOT, 'catalog-errors');
const stage = stageSet(finalDir);
const recorder = 'benchmarks/rust-core/recorders/record-catalog-errors.mjs';
process.env.MIXDOG_DATA_DIR = mkdtempSync(join(tmpdir(), 'catalog-errors-rec-'));
process.env.MIXDOG_HOME = mkdtempSync(join(tmpdir(), 'catalog-errors-home-'));
const failuresMod = await importFrom(tree, 'src/runtime/agent/orchestrator/providers/catalog-failures.mjs');
const { withCatalogErrors } = await importFrom(tree, 'src/session-runtime/provider-auth/setup.mjs');

const failure = (message, extra = {}) => Object.assign(new Error(message), extra);
const SETUP = () => ({
  keychain: { state: 'locked' },
  api: [{ id: 'openai', name: 'OpenAI API', status: 'Set' }, { id: 'xai', name: 'xAI API' }, { id: 'custom-1', custom: true }],
  oauth: [{ id: 'openai-oauth', authenticated: true }, { id: 'grok-oauth' }],
  local: [{ id: 'mixdog-local' }],
  extra: 1,
});
const SCENARIOS = [
  { name: 'no failures', fail: {} },
  { name: 'one api provider', fail: { openai: failure('Incorrect API key provided', { status: 401 }) } },
  { name: 'one per group', fail: { xai: failure('boom'), 'grok-oauth': failure('expired', { status: 403 }), 'mixdog-local': failure('not installed') } },
  { name: 'whitespace is collapsed', fail: { openai: failure('line one\n  line   two\t\tend') } },
  { name: 'a long message is cut to 300', fail: { openai: failure('x'.repeat(500)) } },
  { name: 'the provider error is appended', fail: { openai: failure('request failed', { providerError: { message: 'insufficient_quota' } }) } },
  { name: 'timeouts and rate limits', fail: { xai: failure('timed out', { status: 429 }), 'custom-1': failure('too slow', { name: 'TimeoutError' }) } },
  { name: 'a recovered provider has none', fail: { openai: failure('first'), xai: failure('second') }, recover: ['openai'] },
  { name: 'a provider that is not on the page', fail: { gemini: failure('nobody sees this') } },
  { name: 'secret-like text in a message', fail: { openai: failure('Bearer abc.def-ghi rejected for key=hidden-value') } },
];
const scenarios = [];
for (const scenario of SCENARIOS) {
  failuresMod.clearProviderCatalogFailures();
  for (const [name, error] of Object.entries(scenario.fail)) failuresMod.recordProviderCatalogOutcome(name, error);
  for (const name of scenario.recover ?? []) failuresMod.recordProviderCatalogOutcome(name, null);
  const held = {};
  for (const id of ['openai', 'xai', 'custom-1', 'openai-oauth', 'grok-oauth', 'mixdog-local', 'gemini']) {
    const f = failuresMod.providerCatalogFailure(id);
    if (f) held[id] = { message: f.message, errorKind: f.errorKind };
  }
  const before = SETUP();
  scenarios.push({ name: scenario.name, held, before, after: withCatalogErrors(before) });
}
// Not a setup at all: returned as it came.
const passthrough = [null, 'text', 5].map((value) => ({ value, after: withCatalogErrors(value) }));
writeJson(join(stage, 'golden.json'), { scenarios, passthrough });
writeSetManifest(stage, { set: 'catalog-errors', recorder, command: 'node ' + recorder + ' --tree <tree>', identityTree: tree });
commitStage(stage, finalDir);
process.exit(0);
