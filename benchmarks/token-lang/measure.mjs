// Per-language input-token inflation vs English, measured with a bare request:
// one user message, no system prompt, no tools. Keys come from the mixdog config.
// Usage: node benchmarks/token-lang/measure.mjs [--n 200] [--models a,b]
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../../src/runtime/agent/orchestrator/config.mjs';
import { initProviders, getProvider } from '../../src/runtime/agent/orchestrator/providers/registry.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA = join(HERE, 'data', 'flores200_dataset', 'devtest');
const OUT = join(HERE, 'results');

const args = process.argv.slice(2);
const argOf = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const N = Number(argOf('--n') || 200);

const LANGS = [
  ['English', 'eng_Latn'],
  ['Chinese', 'zho_Hans'],
  ['Japanese', 'jpn_Jpan'],
  ['Korean', 'kor_Hang'],
  ['Spanish', 'spa_Latn'],
  ['French', 'fra_Latn'],
  ['German', 'deu_Latn'],
  ['Russian', 'rus_Cyrl'],
  ['Arabic', 'arb_Arab'],
  ['Hindi', 'hin_Deva'],
];

const P = loadConfig().providers;
const GO = 'https://opencode.ai/zen/go';

async function post(url, headers, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

// Each counter returns the prompt-side token total for a single bare user message.

// Subscription (OAuth) routes go through mixdog's provider with only the user
// message and no tools; the server's mandatory preamble is constant per request
// and cancels out in the "." baseline. Anthropic's inputTokens excludes cache
// read/write, OpenAI's already includes cached tokens.
let registryReady;
const counters = {
  subscription: (providerName, model) => async (text) => {
    registryReady ??= initProviders(P);
    await registryReady;
    const { usage = {} } = await getProvider(providerName).send([{ role: 'user', content: text }], model, [], {
      effort: 'low',
    });
    const cache = providerName === 'anthropic-oauth' ? (usage.cachedTokens || 0) + (usage.cacheWriteTokens || 0) : 0;
    return (usage.inputTokens || 0) + cache;
  },
  geminiCount: (model) => async (text) =>
    (
      await post(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:countTokens`,
        { 'x-goog-api-key': P.gemini.apiKey },
        { contents: [{ role: 'user', parts: [{ text }] }] }
      )
    ).totalTokens,
  responses: (base, headers, model) => async (text) =>
    (
      await post(`${base}/responses`, headers, {
        model,
        input: [{ role: 'user', content: text }],
        max_output_tokens: 16,
        store: false,
      })
    ).usage.input_tokens,
  chat: (base, headers, model) => async (text) =>
    (
      await post(`${base}/chat/completions`, headers, {
        model,
        messages: [{ role: 'user', content: text }],
        max_tokens: 16,
      })
    ).usage.prompt_tokens,
};

// OpenCode Go refuses requests without a session id; the header carries no prompt content.
const goKey = P['opencode-go'].apiKey;
const goHeaders = { Authorization: `Bearer ${goKey}`, 'x-api-key': goKey, 'x-opencode-session': randomUUID() };
const MODELS = [
  ['GPT 6.1', counters.subscription('openai-oauth', 'gpt-6.1-sol')],
  ['Opus 5.5', counters.subscription('anthropic-oauth', 'claude-opus-5-5')],
  ['Gemini 3.8 Flash', counters.geminiCount('gemini-3.8-flash')],
  ['DeepSeek V4.1 Flash', counters.chat(`${GO}/v1`, goHeaders, 'deepseek-v4.1-flash')],
  ['Kimi K3', counters.chat(`${GO}/v1`, goHeaders, 'kimi-k3')],
  ['GLM 5.3 Flash', counters.chat(`${GO}/v1`, goHeaders, 'glm-5.3-flash')],
  ['Qwen 3.8 Flash', counters.chat(`${GO}/v1`, goHeaders, 'qwen3.8-flash')],
  ['Muse Spark 1.3', counters.responses(`${GO}/v1`, goHeaders, 'muse-spark-1.3-contributor')],
  ['Grok 4.7', counters.responses(`${GO}/v1`, goHeaders, 'grok-4.7')],
];
// --render redraws the table/heatmap from results.json without measuring.
const renderOnly = args.includes('--render');
const only = argOf('--models')?.split(',').map((s) => s.trim().toLowerCase());
const selected = renderOnly
  ? []
  : only
    ? MODELS.filter(([name]) => only.some((o) => name.toLowerCase().includes(o)))
    : MODELS;

const corpus = Object.fromEntries(
  LANGS.map(([lang, code]) => [
    lang,
    readFileSync(join(DATA, `${code}.devtest`), 'utf8').split(/\r?\n/).filter(Boolean).slice(0, N).join('\n'),
  ])
);

// Baseline "." isolates the fixed per-request wrapper (chat template, any
// server-side preamble) so only the content tokens are compared.
async function measureModel([name, count]) {
  const base = await count('.');
  const raw = {};
  for (const [lang] of LANGS) raw[lang] = await count(corpus[lang]);
  const net = Object.fromEntries(LANGS.map(([lang]) => [lang, raw[lang] - base]));
  console.error(`done: ${name} (baseline ${base}, English ${net.English})`);
  return { name, baseline: base, raw, net };
}

// A --models rerun merges into the previous results.json instead of replacing it.
const RESULTS_JSON = join(OUT, 'results.json');
const byName = new Map(
  (only || renderOnly) && existsSync(RESULTS_JSON)
    ? JSON.parse(readFileSync(RESULTS_JSON, 'utf8')).results.map(({ ratio, ...r }) => [r.name, r])
    : []
);
const settled = await Promise.allSettled(selected.map(measureModel));
settled.forEach((s, i) => {
  if (s.status === 'fulfilled') byName.set(s.value.name, s.value);
  else console.error(`FAILED: ${selected[i][0]}: ${s.reason?.message || s.reason}`);
});
const results = MODELS.map(([name]) => byName.get(name)).filter(Boolean);
if (results.length === 0) process.exit(1);

// Rows show English (1.00x reference) first; averages cover the non-English languages.
const rowLangs = LANGS.map(([lang]) => lang);
const langs = rowLangs.slice(1);
const avg = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const fmt = (x) => `${x.toFixed(2)}x`;
const ratioOf = (r, lang) => r.net[lang] / r.net.English;
const rowAvg = (lang) => avg(results.map((r) => ratioOf(r, lang)));
const colAvg = (r) => avg(langs.map((lang) => ratioOf(r, lang)));

const header = `| | ${results.map((r) => r.name).join(' | ')} | Avg |`;
const sep = `|---|${results.map(() => '---').join('|')}|---|`;
const rows = rowLangs.map(
  (lang) => `| ${lang} | ${results.map((r) => fmt(ratioOf(r, lang))).join(' | ')} | ${fmt(rowAvg(lang))} |`
);
const avgRow = `| **Avg** | ${results.map((r) => `**${fmt(colAvg(r))}**`).join(' | ')} | **${fmt(avg(results.map(colAvg)))}** |`;
const table = [header, sep, ...rows, avgRow].join('\n');

// Figures (cards + heatmap) are rendered from results.json by chart.mjs.
mkdirSync(OUT, { recursive: true });
writeFileSync(RESULTS_JSON, JSON.stringify({ sentences: N, results }, null, 2));
writeFileSync(join(OUT, 'table.md'), `${table}\n`);
console.log(table);
