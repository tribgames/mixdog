#!/usr/bin/env node
// Golden twin of the model argument of `webSearchCapableFor(provider, model)` as the workflow
// config methods call it (`makeWebSearchCapableFor(webSearchProviderFamily, catalogRowFor)`,
// model-capabilities.mjs; the session runtime binds it in shared.mjs): `model` is a bare id, a
// route row, or absent, and the catalog's row for the id is consulted by `catalogRowFor(id, provider)`.
// The catalog is a fixed table here; everything else is Node's own code.
//
//   node benchmarks/rust-core/recorders/record-config-hosts.mjs --tree <dir>
import { join } from 'node:path';
import { FIXTURES_ROOT, importFrom, parseArgs, refreshSetManifest, resolveTree, writeJson } from './lib/common.mjs';

const tree = resolveTree(parseArgs());
const { makeWebSearchCapableFor } = await importFrom(tree, 'src/runtime/agent/orchestrator/runtime-core/model-capabilities.mjs');
const { webSearchProviderFamily } = await importFrom(tree, 'src/runtime/agent/orchestrator/runtime-core/workflow.mjs');

const CATALOG = {
  'gpt-5': { id: 'gpt-5', supportsWebSearch: false },
  'gpt-4o': { id: 'gpt-4o', supportedTools: [{ type: 'web_search' }] },
  'grok-4': { id: 'grok-4', tools: ['web_search'] },
  'gemini-2.5-pro': { id: 'gemini-2.5-pro', capabilities: { tools: ['code_execution'] } },
  'claude-opus-4-5': { id: 'claude-opus-4-5', supportsWebSearch: true },
};
const catalogRowFor = (id) => CATALOG[id] ?? null;
const webSearchCapableFor = makeWebSearchCapableFor(webSearchProviderFamily, catalogRowFor);

const providers = ['openai', 'openai-oauth', 'xai', 'grok', 'gemini', 'anthropic', 'anthropic-oauth', 'mixdog-local', 'custom-x', ''];
const ids = ['gpt-5', 'gpt-4o', 'gpt-4o-mini', 'o1', 'text-embedding-3-small', 'grok-4', 'grok-2-image', 'gemini-2.5-pro',
  'gemini-embedding-001', 'claude-opus-4-5', 'claude-3-haiku', ' gpt-5 ', ''];
const rows = [
  (id) => ({ id }),
  (id) => ({ id, supportsWebSearch: true }),
  (id) => ({ id, supportsWebSearch: false }),
  (id) => ({ id, supportedTools: [{ name: 'web_search' }] }),
  (id) => ({ id, tools: [] }),
];
const cases = [];
for (const provider of providers) {
  cases.push({ provider, model: null, expected: webSearchCapableFor(provider, undefined) });
  for (const id of ids) {
    cases.push({ provider, model: id, expected: webSearchCapableFor(provider, id) });
    for (const row of rows) {
      const model = row(id);
      cases.push({ provider, model, expected: webSearchCapableFor(provider, model) });
    }
  }
}
writeJson(join(FIXTURES_ROOT, 'desktop', 'settings', 'config-hosts-twin.json'), {
  domain: 'config-hosts-twin',
  recorder: 'benchmarks/rust-core/recorders/record-config-hosts.mjs',
  catalog: CATALOG,
  cases,
});
refreshSetManifest(join(FIXTURES_ROOT, 'desktop'), tree);
console.log(`recorded ${cases.length} web-search cases (${cases.filter((c) => c.expected).length} capable)`);
