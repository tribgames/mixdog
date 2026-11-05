// Records the Node golden for the Rust model-list sanitizer:
// sanitizeModelList (model-list-sanitize.mjs) over listed rows, with a
// models.dev catalog injected through its `_testCatalog` seam. Run from the
// repository root:
//   node native/core/crates/mixdog-ai/fixtures/sanitize/record.mjs
import { writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(process.argv[2] || process.cwd());
const { sanitizeModelList } = await import(
  pathToFileURL(join(root, 'src/runtime/agent/orchestrator/providers/model-list-sanitize.mjs')).href
);

const NOW = Date.UTC(2026, 5, 1);
Date.now = () => NOW;

const ids = [
  'gpt-5.5', 'gpt-5.5-2026-03-01', 'gpt-5.5-20260301', 'gpt-5.4-mini', 'gpt-4.1', 'gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo',
  'gpt-4', 'gpt-4-0613', 'gpt-3.5-turbo', 'o1', 'o1-mini', 'o1-pro', 'o3', 'o3-mini', 'davinci-002', 'text-davinci-003',
  'tts-1', 'tts-1-hd', 'whisper-1', 'dall-e-3', 'text-embedding-3-large', 'embedding-001', 'omni-moderation-latest',
  'gpt-image-1', 'chatgpt-image-latest', 'gpt-4o-mini-tts', 'gpt-audio', 'gpt-realtime-mini', 'gpt-4o-realtime-preview',
  'gpt-5-search-preview', 'gpt-4o-audio-preview', 'codex-auto-review', 'grok-build', 'grok-build-0.1', 'grok-4.20-0309',
  'grok-4.20', 'grok-4.20-beta', 'grok-3', 'grok-beta', 'grok-2-vision', 'claude-opus-4-7', 'claude-opus-4-7-20260101',
  'claude-sonnet-4-5-20250929', 'claude-sonnet-4-5', 'claude-3-5-sonnet-20241022', 'claude-instant-1.2', 'claude-haiku-4-5',
  'claude-opus-latest', 'gemini-3-pro', 'gemini-3-pro-preview', 'gemini-3-pro-preview-customtools', 'gemini-2.5-pro',
  'gemini-2.0-flash', 'gemini-1.5-pro', 'gemini-pro', 'gemini-2.5-computer-use-preview-10-2025',
  'gemini-2.5-flash-native-audio-preview', 'gemini-robotics-er-1.5-preview', 'deepseek-v4-flash', 'deepseek-v4-flash:batch',
  'foo-0123', 'foo', 'bar-0309', 'bar', 'bar-0420', 'baz-0309', 'imagen-4', 'veo-3', 'sora-2', 'foo/rerank-v1',
  'meta/llama-guard', 'a model with spaces', 'x-embed', 'x-embed-chat', '', 'UPPER-Case-Model', 'gpt-5.5-2026-02-01',
];
const modes = [undefined, 'chat', 'completion', 'responses', 'messages', 'embedding', ' Chat ', 'image_generation', ''];
const providers = [
  'openai', 'openai-oauth', 'openai-ws', 'anthropic', 'anthropic-oauth', 'gemini', 'xai', 'grok-oauth', 'deepseek',
  'groq', 'mistral', 'opencode-go', 'openrouter', 'azure', 'custom-x', 'mixdog-local', '', ' OpenAI ', 'cursor-oauth',
];

const catalog = {
  openai: {
    models: {
      'gpt-5.5': { family: 'gpt-5', release_date: '2026-03-01', tool_call: true, modalities: { output: ['text'] } },
      'gpt-5.5-2026-03-01': { family: 'gpt-5', release_date: '2026-03-01', tool_call: true },
      'gpt-5.4-mini': { family: 'gpt-mini', release_date: '2026-01', tool_call: true },
      'gpt-4.1': { family: 'gpt-4', release_date: '2025-04-14', tool_call: true },
      'gpt-5-search-preview': { family: 'gpt-5', release_date: '2025-03-11', tool_call: false },
      'gpt-4o-audio-preview': { family: 'gpt-4o', release_date: '2024-10-01', modalities: { output: ['audio'] } },
      'o3': { family: 'o', release_date: '2025-04-16', tool_call: true },
      'o4-mini': { family: 'o', release_date: '2026-02-01', tool_call: true },
      'gpt-6-latest': { family: 'gpt-5', release_date: '2027-01-01' },
      'gpt-5.6-preview': { family: 'gpt-5', release_date: '2026-05-20' },
      'gpt-5.5-exp': { family: 'gpt-5', release_date: '2026-04-01' },
      'gpt-4.1-mini': { family: 'gpt-4', release_date: '2024-04-14' },
      'o1-pro': { family: 'o-pro', release_date: '2024-12-17', tool_call: true },
      'deepseek-v4-flash': { family: 'deepseek', release_date: 'junk' },
      'foo': { family: ' Foo ', release_date: '2025-01-01' },
      'bar': { family: 'bar', release_date: '2020-01-01' },
    },
  },
  anthropic: {
    models: {
      'claude-opus-4-7': { family: 'claude-opus', release_date: '2026-01-15', tool_call: true },
      'claude-opus-4-7-20260101': { family: 'x', release_date: '2026-01-01' },
      'claude-sonnet-4-5': { family: 'claude-sonnet', release_date: '2025-09-29', tool_call: true },
      'claude-sonnet-4-5-20250929': { family: 'claude-sonnet', release_date: '2025-09-29' },
      'claude-sonnet-5': { family: 'claude-sonnet', release_date: '2026-04-01' },
      'claude-haiku-4-5': { family: 'claude-haiku', release_date: '2025-10-01', tool_call: true },
      'anthropic/claude-opus-5': { family: 'claude-opus', release_date: '2026-05-01' },
    },
  },
  google: {
    models: {
      'gemini-3-pro': { family: 'gemini-pro', release_date: '2026-02-01', tool_call: true },
      'gemini-3-pro-preview': { family: 'gemini-pro', release_date: '2025-11-18', modalities: { output: ['text', 'image'] } },
      'gemini-2.5-pro': { family: 'gemini-pro', release_date: '2025-03-25', tool_call: true },
      'gemini-3.5-pro-preview': { family: 'gemini-pro', release_date: '2026-05-25' },
    },
  },
  xai: {
    models: {
      'grok-4.20': { family: 'grok', release_date: '2026-02-01' },
      'grok-4.20-beta': { family: 'grok', release_date: '2025-12-01' },
      'grok-4.20-0309': { family: 'grok', release_date: '2026-03-09' },
    },
  },
};

const rowsFor = (variant) =>
  ids.map((id, i) => {
    const row = { id };
    if (variant >= 1 && modes[(i + variant) % modes.length] !== undefined) row.mode = modes[(i + variant) % modes.length];
    if (variant >= 1) {
      row.contextWindow = [0, 200000, 128000, 1000000, undefined][(i + variant) % 5];
      row.outputTokens = [0, 32000, 64000, undefined][(i * 3 + variant) % 4];
    }
    if (variant >= 2) row.created = [0, 1700000000, 1800000000, undefined, -5][(i + variant) % 5];
    return row;
  });

const cases = [];
const variants = [];
for (const variant of [0, 1, 2, 3]) {
  const models = rowsFor(variant);
  variants.push(models);
  for (const provider of providers) {
    for (const [cold, months] of [[true, null], [false, null], [false, '0'], [false, '1'], [false, '600'], [false, 'x']]) {
      if (months === null) delete process.env.MIXDOG_MODEL_STALE_MONTHS;
      else process.env.MIXDOG_MODEL_STALE_MONTHS = months;
      const kept = sanitizeModelList(models, { provider, ...(cold ? {} : { _testCatalog: catalog }) });
      cases.push({ variant, provider, cold, months, kept: kept.map((row) => models.indexOf(row)) });
    }
  }
}
writeFileSync(
  join(here, 'golden.json'),
  `${JSON.stringify({ now: NOW, catalog, variants, cases })}\n`
);
console.log(`cases ${cases.length}`);
