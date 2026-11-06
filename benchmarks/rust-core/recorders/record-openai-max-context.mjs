#!/usr/bin/env node
// OpenAI Codex max context window (WP-AI-OPENAI): the REAL Node `_codexMaxContextWindow`
// (openai-codex-model.mjs) over the validated 1M ids in both cases, a reported value
// below, at and above 1M, none, and ids outside the validated set.
//
//   node benchmarks/rust-core/recorders/record-openai-max-context.mjs [--tree <dir>]
//
// Output: native/core/fixtures/providers/oracles/openai-max-context-golden.json (listed in
// providers/MANIFEST.json; refresh it with verify-manifests.mjs --refresh providers).
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { FIXTURES_ROOT, importFrom, parseArgs, resolveTree, writeJson } from './lib/common.mjs';

const P = 'src/runtime/agent/orchestrator/providers';
const IDS = ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'GPT-5.6-Terra', 'GPT-5.6-LUNA', 'gpt-5.5', 'gpt-5.6-sol-mini'];
const REPORTED = [null, 0, 'junk', 272000, 500000, 1_000_000, 2_000_000];

export async function recordOpenAiMaxContext(tree, outFile) {
  const { _codexMaxContextWindow } = await importFrom(tree, `${P}/openai-codex-model.mjs`);
  const cases = [];
  for (const id of IDS) {
    for (const reported of REPORTED) {
      cases.push({ id, reported, maxContextWindow: _codexMaxContextWindow(id, reported) });
    }
  }
  writeJson(outFile, {
    _doc: 'Recorded from src/runtime/agent/orchestrator/providers/openai-codex-model.mjs (_codexMaxContextWindow). reported is the catalog row max_context_window as sent.',
    recorder: 'benchmarks/rust-core/recorders/record-openai-max-context.mjs',
    cases,
  });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const tree = resolveTree(parseArgs());
  await recordOpenAiMaxContext(tree, join(FIXTURES_ROOT, 'providers', 'oracles', 'openai-max-context-golden.json'));
  console.log('recorded openai-max-context-golden');
  process.exit(0);
}
