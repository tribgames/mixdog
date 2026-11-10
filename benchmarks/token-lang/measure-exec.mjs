// Per-language input-token inflation vs English, measured through the Rust core: the K1 replacement of
// measure.mjs, which loaded the Node core's config and provider registry to send bare requests. Each text is one
// `mixdogd exec --json --usage-log` run (the exec adds the same system prompt and tools to every run, which cancels
// out in the "." baseline exactly as the bare request's preamble did); the count is the provider-reported input
// tokens of the run's first model request, read from the `model.request.completed` event. Subscription routes
// ask at low effort, as before.
// Usage: node benchmarks/token-lang/measure-exec.mjs --mixdogd <bin> [--n 200] [--models a,b] [--render]
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA = join(HERE, 'data', 'flores200_dataset', 'devtest');
const OUT = join(HERE, 'results');

export const LANGS = [
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

// [display name, provider, model, effort]. Anthropic's inputTokens excludes cache read/write, OpenAI's already
// includes cached tokens; the other routes report their own total.
export const MODELS = [
  ['GPT 6.1', 'openai-oauth', 'gpt-6.1-sol', 'low'],
  ['Opus 5.5', 'anthropic-oauth', 'claude-opus-5-5', 'low'],
  ['Gemini 3.8 Flash', 'gemini', 'gemini-3.8-flash'],
  ['DeepSeek V4.1 Flash', 'opencode-go', 'deepseek-v4.1-flash'],
  ['Kimi K3', 'opencode-go', 'kimi-k3'],
  ['GLM 5.3 Flash', 'opencode-go', 'glm-5.3-flash'],
  ['Qwen 3.8 Flash', 'opencode-go', 'qwen3.8-flash'],
  ['Muse Spark 1.3', 'opencode-go', 'muse-spark-1.3-contributor'],
  ['Grok 4.7', 'opencode-go', 'grok-4.7'],
];

/** The prompt-side token total of the first model request in `mixdogd exec --json` output. */
export function inputTokensOfFirstRequest(stdout, provider) {
  for (const line of String(stdout).split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event?.type !== 'model.request.completed') continue;
    const usage = event.usage ?? {};
    const cache = provider === 'anthropic-oauth' ? (usage.cached_input_tokens || 0) + (usage.cache_write_input_tokens || 0) : 0;
    return (usage.input_tokens || 0) + cache;
  }
  throw new Error('the exec reported no completed model request');
}

/** `--usage-log` document of a run: the totals, for a run that made exactly the one request. */
export function usageLogInput(document, provider) {
  const totals = document?.totals ?? {};
  const cache = provider === 'anthropic-oauth' ? (totals.cacheTokens || 0) + (totals.cacheWriteTokens || 0) : 0;
  return (totals.inputTokens || 0) + cache;
}

const WINDOWS_ARGUMENT_LIMIT = 30_000;

/** One run: `<bin> exec --json ... <text>`, answering the input tokens of its first request. */
export function execInputTokens({ bin, provider, model, effort, text, cwd, spawnImpl = spawn }) {
  if (process.platform === 'win32' && text.length > WINDOWS_ARGUMENT_LIMIT) {
    throw new Error(`a text of ${text.length} characters does not fit a Windows command line; use a smaller --n`);
  }
  const scratch = mkdtempSync(join(tmpdir(), 'token-lang-'));
  const usageLog = join(scratch, 'usage.json');
  const args = ['exec', '--json', '--provider', provider, '--model', model, ...(effort ? ['--effort', effort] : []), '--cwd', cwd, '--usage-log', usageLog, text];
  return new Promise((resolveCount, reject) => {
    const child = spawnImpl(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.once('error', reject);
    child.once('close', (code) => {
      try {
        if (code !== 0) throw new Error(`mixdogd exec exited ${code}: ${stderr.trim().slice(0, 300)}`);
        resolveCount(inputTokensOfFirstRequest(stdout, provider));
      } catch (error) {
        reject(error);
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
    });
  });
}

const avg = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const fmt = (x) => `${x.toFixed(2)}x`;

/** The markdown table of `results` (`[{ name, net }]`): English is the 1.00x reference, the averages cover the other languages. */
export function renderTable(results) {
  const rowLangs = LANGS.map(([lang]) => lang);
  const langs = rowLangs.slice(1);
  const ratioOf = (r, lang) => r.net[lang] / r.net.English;
  const rowAvg = (lang) => avg(results.map((r) => ratioOf(r, lang)));
  const colAvg = (r) => avg(langs.map((lang) => ratioOf(r, lang)));
  const header = `| | ${results.map((r) => r.name).join(' | ')} | Avg |`;
  const sep = `|---|${results.map(() => '---').join('|')}|---|`;
  const rows = rowLangs.map((lang) => `| ${lang} | ${results.map((r) => fmt(ratioOf(r, lang))).join(' | ')} | ${fmt(rowAvg(lang))} |`);
  const avgRow = `| **Avg** | ${results.map((r) => `**${fmt(colAvg(r))}**`).join(' | ')} | **${fmt(avg(results.map(colAvg)))}** |`;
  return [header, sep, ...rows, avgRow].join('\n');
}

/** Baseline "." isolates the fixed per-request wrapper (system prompt, tools, chat template) so only the content tokens are compared. */
export async function measureModel(count, corpus) {
  const base = await count('.');
  const raw = {};
  for (const [lang] of LANGS) raw[lang] = await count(corpus[lang]);
  const net = Object.fromEntries(LANGS.map(([lang]) => [lang, raw[lang] - base]));
  return { baseline: base, raw, net };
}

function argOf(args, name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main(args) {
  const N = Number(argOf(args, '--n') || 200);
  const renderOnly = args.includes('--render');
  const only = argOf(args, '--models')?.split(',').map((s) => s.trim().toLowerCase());
  const bin = argOf(args, '--mixdogd') || process.env.MIXDOGD_BIN;
  if (!renderOnly && !bin) throw new Error('pass --mixdogd <path to the mixdogd binary> or set MIXDOGD_BIN');
  const selected = renderOnly ? [] : only ? MODELS.filter(([name]) => only.some((o) => name.toLowerCase().includes(o))) : MODELS;
  const corpus = renderOnly
    ? {}
    : Object.fromEntries(LANGS.map(([lang, code]) => [lang, readFileSync(join(DATA, `${code}.devtest`), 'utf8').split(/\r?\n/).filter(Boolean).slice(0, N).join('\n')]));
  const RESULTS_JSON = join(OUT, 'results.json');
  // A --models rerun merges into the previous results.json instead of replacing it.
  const byName = new Map((only || renderOnly) && existsSync(RESULTS_JSON) ? JSON.parse(readFileSync(RESULTS_JSON, 'utf8')).results.map(({ ratio, ...r }) => [r.name, r]) : []);
  const cwd = mkdtempSync(join(tmpdir(), 'token-lang-cwd-'));
  try {
    const settled = await Promise.allSettled(
      selected.map(async ([name, provider, model, effort]) => {
        const measured = await measureModel((text) => execInputTokens({ bin: resolve(bin), provider, model, effort, text, cwd }), corpus);
        console.error(`done: ${name} (baseline ${measured.baseline}, English ${measured.net.English})`);
        return { name, ...measured };
      }),
    );
    settled.forEach((s, i) => {
      if (s.status === 'fulfilled') byName.set(s.value.name, s.value);
      else console.error(`FAILED: ${selected[i][0]}: ${s.reason?.message || s.reason}`);
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
  const results = MODELS.map(([name]) => byName.get(name)).filter(Boolean);
  if (results.length === 0) process.exit(1);
  const table = renderTable(results);
  // Figures (cards + heatmap) are rendered from results.json by chart.mjs.
  mkdirSync(OUT, { recursive: true });
  writeFileSync(RESULTS_JSON, JSON.stringify({ sentences: N, results }, null, 2));
  writeFileSync(join(OUT, 'table.md'), `${table}\n`);
  console.log(table);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main(process.argv.slice(2));
