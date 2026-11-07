// Generates native/core/crates/mixdog-ai/src/catalog/offline_floors.json from Node's own lists: the offline floors a
// provider's `listModels` answers when its roster fetch fails (or, for the API-key routes, has no key or lists nothing).
//   node benchmarks/rust-core/recorders/gen-offline-floors.mjs --tree <tree>
import { writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const at = process.argv.indexOf('--tree');
if (at < 0 || !process.argv[at + 1]) throw new Error('usage: gen-offline-floors.mjs --tree <tree>');
const tree = resolve(process.argv[at + 1]);
const providers = join(tree, 'src', 'runtime', 'agent', 'orchestrator', 'providers');
const { MODELS } = await import(pathToFileURL(join(providers, 'lib', 'anthropic-models.mjs')).href);
const { GEMINI_MODELS } = await import(pathToFileURL(join(providers, 'lib', 'gemini-model-catalog.mjs')).href);
const rows = (list) => list.map(({ id, name, family, contextWindow }) => ({ id, name, ...(family ? { family } : {}), contextWindow }));
const out = join(HERE, '..', '..', '..', 'native', 'core', 'crates', 'mixdog-ai', 'src', 'catalog', 'offline_floors.json');
writeFileSync(out, `${JSON.stringify({ source: { anthropic: 'src/runtime/agent/orchestrator/providers/lib/anthropic-models.mjs MODELS', gemini: 'src/runtime/agent/orchestrator/providers/lib/gemini-model-catalog.mjs GEMINI_MODELS' }, anthropic: rows(MODELS), gemini: rows(GEMINI_MODELS) }, null, 2)}\n`);
console.log(`wrote ${out}`);
