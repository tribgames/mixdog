// Records the Node golden for the Rust catalog lookup: getModelMetadataSync,
// fastCapableFor, ultrafastCapableFor and enrichModels over the fixtures in
// this directory. Run from the repository root:
//   node native/core/crates/mixdog-ai/fixtures/catalog-lookup/record.mjs
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(process.argv[2] || process.cwd());
const read = (name) => readFileSync(join(here, name), 'utf-8');

const data = mkdtempSync(join(tmpdir(), 'catalog-golden-'));
process.env.MIXDOG_DATA_DIR = data;
mkdirSync(data, { recursive: true });
writeFileSync(join(data, 'litellm-catalog.json'), `{"fetchedAt":1,"data":${read('litellm.json')}}\n`);
writeFileSync(join(data, 'modelsdev-catalog.json'), `{"fetchedAt":1,"data":${read('modelsdev.json')}}\n`);
for (const [file, body] of Object.entries(JSON.parse(read('rosters.json')))) {
  writeFileSync(join(data, file), JSON.stringify(body));
}

const mod = (path) => import(pathToFileURL(join(root, path)).href);
const catalog = await mod('src/runtime/shared/llm/model-catalog.mjs');
const caps = await mod('src/runtime/agent/orchestrator/runtime-core/model-capabilities.mjs');
await catalog.warmCatalogFromDisk();

const CUSTOM = 'custom-0123abcd-0123-4567-89ab-0123456789ab';
const providers = [
  '', 'openai', 'openai-oauth', 'anthropic', 'anthropic-oauth', 'gemini', 'vertex-ai', 'grok-oauth', 'deepseek',
  'xai', 'muse-code-oauth', 'mimo-oauth', 'antigravity-oauth', 'command-code-oauth', 'opencode-go-oauth',
  'cursor-oauth', 'cursor-api', 'devin-oauth', 'openrouter', 'mixdog-local', CUSTOM,
];
const litellm = JSON.parse(read('litellm.json'));
const modelsDev = JSON.parse(read('modelsdev.json'));
const ids = new Set(Object.keys(litellm).filter((k) => k !== 'sample_spec'));
for (const key of [...ids]) ids.add(key.slice(key.lastIndexOf('/') + 1));
for (const entry of Object.values(modelsDev)) for (const id of Object.keys(entry.models || {})) ids.add(id);
for (const rows of Object.values(JSON.parse(read('rosters.json')))) {
  for (const row of Array.isArray(rows) ? rows : rows.models) ids.add(row.id || row.name);
}
for (const extra of [
  'gpt-5.5-2025-08-07', 'gpt-5.5-20250807', 'claude-opus-4.8', 'claude-sonnet-4.5', 'gemini-3.1-pro@regional',
  'claude-sonnet-4-5@20250929', 'claude-sonnet-4-5@default', 'grok-4.7-build-fast', 'grok-code-fast-1', 'composer-2.5',
  'unknown-model', 'muse-spark-1.5', 'muse-spark-1.3.1-contributor', 'mimo-v2.6-pro-20260101', 'mimo-v2-omni',
  'vendor/claude-sonnet-4-5', 'openrouter/claude-sonnet-4-5', 'gpt-5.6-sol', 'gpt-6.1-sol-2026-01-02', 'gpt-5.4-mini',
  'claude-opus-5@regional', 'gemini-3.8-flash-low', 'Claude-Opus-5',
]) ids.add(extra);

const clean = (value) => (value === undefined ? null : JSON.parse(JSON.stringify(value)));
const rows = [];
for (const provider of providers) {
  for (const id of [...ids].sort()) {
    const meta = catalog.getModelMetadataSync(id, provider || undefined);
    rows.push({
      provider,
      id,
      meta: clean(meta),
      known: Boolean(meta),
      fast: caps.fastCapableFor(provider, { id }, null, {}),
      ultrafast: caps.ultrafastCapableFor(provider, { id }),
    });
  }
}

const respond = (body) => async () => ({ ok: true, json: async () => body });
const listed = [
  { provider: 'opencode-go-oauth', id: 'kimi-k2.7-code' },
  { provider: 'opencode-go-oauth', id: 'glm-5', display: 'GLM 5' },
  { provider: 'cursor-oauth', id: 'claude-sonnet-4-5', contextWindow: 123456, supportsVision: true, reasoningLevels: ['low'] },
  { provider: 'command-code-oauth', id: 'gemini-2.5-pro', reasoningOptions: [{ type: 'effort', values: ['low', 'high'] }], contextWindow: 333 },
  { provider: CUSTOM, id: 'openrouter/claude-sonnet-4-5', supportsReasoning: true },
  { provider: CUSTOM, id: 'totally-unknown' },
  { provider: 'openai', id: 'gpt-5.5', contextWindow: 111 },
  { provider: 'antigravity-oauth', id: 'gemini-9-hyper', reasoningLevels: ['low'] },
  { provider: 'mimo-oauth', id: 'mimo-v2.6-pro-ultraspeed', contextWindow: 5 },
  { provider: 'muse-code-oauth', id: 'muse-spark-1.3-contributor', reasoningLevels: ['minimal', 'max'] },
  { provider: 'devin-oauth', id: 'gpt-5.4', name: 'x' },
  { provider: 'zzz', id: 'y' },
  { provider: 'vertex-ai', id: 'claude-sonnet-4-5@20250929' },
];
let call = 0;
const fetchFn = async (url) => {
  call += 1;
  return respond(String(url).includes('litellm') ? litellm : modelsDev)();
};
const enriched = await catalog.enrichModels(listed, { fetchFn });

writeFileSync(
  join(here, 'golden.json'),
  `${JSON.stringify({ rows, enriched: listed.map((input, i) => ({ input, out: clean(enriched[i]) })) })}\n`
);
console.log(`recorded ${rows.length} lookups, ${listed.length} enrichments (${call} fetches)`);
process.exit(0);
