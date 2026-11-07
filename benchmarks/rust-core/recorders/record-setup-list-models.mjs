#!/usr/bin/env node
// Golden twin of the setup tool's `list_models` action: the real `createSetupToolExecutor` over a
// recording facade whose `listProviderModels` / `listWebSearchModels` answer the rows of each
// case: the provider index, a provider's paged compact rows, one model's detail, and the
// refusals. A case keeps the facade call (and its `refresh` flag) and the answer Node printed.
//
//   node benchmarks/rust-core/recorders/record-setup-list-models.mjs --tree <dir>
import { join } from 'node:path';

const { FIXTURES_ROOT, importFrom, parseArgs, resolveTree, writeJson } = await import('./lib/common.mjs');
const tree = resolveTree(parseArgs());
const { createSetupToolExecutor } = await importFrom(tree, 'src/session-runtime/setup-tool/executor.mjs');

const ROWS = [
  { provider: 'openai', id: 'gpt-5', display: 'GPT-5', contextWindow: 400000, maxContextWindow: 1000000, outputTokens: 128000, supportsVision: true, supportsWebSearch: true, supportsReasoning: true,
    effortOptions: [{ value: 'low', label: 'Low', description: 'd' }, { value: 'high', label: 'High' }], defaultEffort: 'medium', fastCapable: true, fastEfforts: ['low'], defaultFast: false,
    serviceTiers: ['priority'], defaultServiceTier: '', additionalSpeedTiers: [], modelParameterOptions: { temperature: ['0', '1'] }, parameterVariants: [], defaultModelParameters: {}, supportsMaxMode: false,
    savedHidden: false, favorite: true },
  { provider: 'openai', id: 'gpt-5-mini', contextWindow: 128000, maxContextWindow: 128000, effortOptions: [], savedHidden: true },
  { provider: 'openai', id: 'o3', display: 'o3', contextWindow: null, maxContextWindow: '200000', effortOptions: [{ value: 'minimal' }], favorite: false },
  { provider: 'openai-oauth', id: 'gpt-5', display: 'GPT-5 (OAuth)', contextWindow: 272000, effortOptions: [{ value: 'low', label: 'Low' }], fastCapable: false, supportsVision: false },
  { provider: 'deepseek', id: 'deepseek-v4-pro', display: 'DeepSeek V4 Pro', contextWindow: 1000000, supportsReasoning: true },
  { provider: 'deepseek', id: 'deepseek-v4-flash', contextWindow: 64000 },
  { provider: 'xai', id: 'grok-4.5', display: 'Grok 4.5', contextWindow: 256000, maxContextWindow: 2000000, favorite: true },
  { provider: 'openrouter', id: 'openrouter/auto', contextWindow: 200000 },
  { provider: 'openrouter', id: 'a/b', display: 'A B', contextWindow: 8000, maxContextWindow: 'x' },
  { provider: 'groq', id: 'llama', contextWindow: 131072, modelParameterOptions: {}, parameterVariants: [{ id: 'v' }] },
];
const WEB_ROWS = ROWS.filter((row) => row.supportsWebSearch || row.provider === 'xai');

async function run(catalog, rows = ROWS, webRows = WEB_ROWS) {
  const calls = [];
  const facade = {
    listProviderModels: (...args) => (calls.push({ method: 'listProviderModels', args: JSON.parse(JSON.stringify(args)) }), JSON.parse(JSON.stringify(rows))),
    listWebSearchModels: (...args) => (calls.push({ method: 'listWebSearchModels', args: JSON.parse(JSON.stringify(args)) }), JSON.parse(JSON.stringify(webRows))),
  };
  const executor = createSetupToolExecutor({ getApi: () => facade, getConfig: () => ({}), getSessionId: () => 'sess_a' });
  const args = { action: 'list_models', ...(catalog === undefined ? {} : { catalog }) };
  try {
    return { args, rows, webRows, calls, result: JSON.parse(await executor.execute(args, {})) };
  } catch (error) {
    return { args, rows, webRows, calls, error: String(error?.message ?? error) };
  }
}

const cases = [];
const add = async (...input) => cases.push(await run(...input));
await add(undefined);
await add({});
await add({ refresh: true });
await add({ refresh: 'yes' });
await add({ webSearch: true });
await add({ webSearch: true, refresh: true });
await add({ webSearch: true, provider: 'xai' });
for (const provider of ['openai', 'deepseek', 'groq', 'nobody']) await add({ provider });
await add({ provider: 'openai', limit: 2 });
await add({ provider: 'openai', limit: 2, page: 2 });
await add({ provider: 'openai', limit: 2, page: 3 });
await add({ provider: 'openai', limit: 2, page: 9 });
await add({ provider: 'openai', limit: 1, page: 1 });
await add({ provider: 'openrouter', limit: 100 });
await add({ model: 'gpt-5' });
await add({ model: 'gpt-5', provider: 'openai' });
await add({ model: 'gpt-5', provider: 'openai-oauth' });
await add({ model: 'gpt-5-mini', provider: 'openai' });
await add({ model: 'o3' });
await add({ model: 'deepseek-v4-flash' });
await add({ model: 'grok-4.5' });
await add({ model: 'a/b' });
await add({ model: 'llama' });
await add({ model: 'ghost' });
await add({ model: 'ghost', provider: 'openai' });
await add({ model: 'gpt-5', provider: 'groq' });
await add({ model: 'gpt-5', webSearch: true });
await add({ model: 'grok-4.5', webSearch: true, provider: 'xai' });
await add({ model: 'gpt-5', provider: 'openai', limit: 1, page: 2 });
await add({}, []);
await add({ provider: 'openai' }, []);
await add({ model: 'x' }, []);

writeJson(join(FIXTURES_ROOT, 'desktop', 'settings', 'setup-list-models-twin.json'), {
  domain: 'setup-list-models-twin',
  recorder: 'benchmarks/rust-core/recorders/record-setup-list-models.mjs',
  cases,
});
console.log(`recorded ${cases.length} cases (${cases.filter((c) => c.error).length} errors)`);