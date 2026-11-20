#!/usr/bin/env node
// Node's prompt_cache_key for the Codex route, recorded: every case of cache-key-cases.json goes to Node's real
// buildStableProviderPromptCacheKey('openai-oauth', options, prefix) (b6f10295a) under the case's environment, and the key
// it returns is the recording. The Rust test reads this file and gives its own function the same inputs.
// Usage: node node-cache-key-capture.mjs <node-tree> --node-commit <sha> --out <recording.json>
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const arg = (name) => process.argv[process.argv.indexOf(name) + 1];
const root = resolve(process.argv[2]);
const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
const { buildStableProviderPromptCacheKey } = await import(
  pathToFileURL(join(root, 'src/runtime/agent/orchestrator/agent-runtime/cache-strategy.mjs')).href
);
const cases = JSON.parse(readFileSync(join(here, 'cache-key-cases.json'), 'utf8')).cases;
const names = ['MIXDOG_OAI_CACHE_KEY_SHARED', 'MIXDOG_OAI_CODEX_THREAD_CACHE_KEY'];
const recorded = cases.map((c) => {
  for (const name of names) delete process.env[name];
  Object.assign(process.env, c.env || {});
  return { ...c, key: buildStableProviderPromptCacheKey('openai-oauth', c.options, c.prefix) };
});
writeFileSync(
  resolve(arg('--out')),
  `${JSON.stringify({
    manifest: {
      exact: true,
      nodeCommit: arg('--node-commit'),
      casesSha256: sha256(join(here, 'cache-key-cases.json')),
      harness: { 'node-cache-key-capture.mjs': sha256(fileURLToPath(import.meta.url)) },
    },
    cases: recorded,
  }, null, 1)}\n`,
);
console.log(`${recorded.length} cases recorded`);
