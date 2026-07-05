#!/usr/bin/env node
// Lead output-style verbosity bench (default >= simple >= minimal >= extreme-minimal).
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dir = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dir, '..');
const PLUGIN_ROOT = join(REPO_ROOT, 'src');
const STYLES = ['default', 'simple', 'minimal', 'extreme-minimal'];
const DEFAULT_PROMPT =
  'Reply in plain English only. What is 2+2? Give a short summary suitable for a status report (no tools, no file reads).';
const MODEL_ALIASES = {
  opus: { provider: 'anthropic-oauth', model: 'claude-opus-4-8' },
  sonnet: { provider: 'anthropic-oauth', model: 'claude-sonnet-5' },
  gpt: { provider: 'openai-oauth', model: 'gpt-5.5' },
  'gpt-5.5': { provider: 'openai-oauth', model: 'gpt-5.5' },
  grok: { provider: 'grok-oauth', model: 'grok-composer-2.5-fast' },
};
// Filenames verified in provider ensureAuth / token paths (resolvePluginData / getPluginData).
const AUTH_ARTIFACT_BY_PROVIDER = {
  'grok-oauth': ['grok-oauth.json', 'grok-oauth-models.json'],
  'anthropic-oauth': ['anthropic-oauth-credentials.json', 'anthropic-oauth-models.json'],
  'openai-oauth': ['openai-oauth.json', 'openai-oauth-models.json'],
};

function argValue(name, fallback = null) {
  const idx = process.argv.indexOf(name);
  if (idx >= 0 && idx + 1 < process.argv.length) return process.argv[idx + 1];
  const pref = `${name}=`;
  const hit = process.argv.find((a) => a.startsWith(pref));
  return hit ? hit.slice(pref.length) : fallback;
}
function hasFlag(name) { return process.argv.includes(name); }
function resolveModelOpts(modelArg, providerArg) {
  const key = String(modelArg || '').trim().toLowerCase();
  if (MODEL_ALIASES[key] && !providerArg) return { ...MODEL_ALIASES[key] };
  return { provider: providerArg || null, model: modelArg || null };
}
function defaultUserDataDir() {
  return process.env.MIXDOG_DATA_DIR || join(process.env.MIXDOG_HOME || join(homedir(), '.mixdog'), 'data');
}
function readUnifiedConfig(dataDir) {
  try {
    const unified = JSON.parse(readFileSync(join(dataDir, 'mixdog-config.json'), 'utf8'));
    return unified && typeof unified === 'object' ? unified : {};
  } catch { return {}; }
}
function outputStyleBodyFromMeta(meta) {
  const marker = '# Output Style';
  const idx = String(meta || '').lastIndexOf(marker);
  return idx < 0 ? '' : String(meta).slice(idx).trim();
}
function measureOutputText(text) {
  const trimmed = String(text || '').trim();
  const lines = trimmed ? trimmed.split(/\r?\n/) : [];
  const bullets = lines.filter((l) => /^\s*[-*•]\s+/.test(l)).length;
  const withoutCode = trimmed.replace(/`[^`]*`/g, '');
  const sentenceMarks = withoutCode.match(/[.!?。！？]+(?=\s|$)/g) || [];
  return {
    chars: trimmed.length,
    lines: lines.length,
    bullets,
    sentences: sentenceMarks.length || (trimmed ? 1 : 0),
    text: trimmed,
  };
}
function runInjectionScaffold() {
  const rulesBuilder = createRequire(import.meta.url)(join(PLUGIN_ROOT, 'lib', 'rules-builder.cjs'));
  const baseDir = mkdtempSync(join(REPO_ROOT, '.tmp-output-style-bench-'));
  const templatePath = join(PLUGIN_ROOT, 'defaults', 'mixdog-config.template.json');
  const baseConfig = existsSync(templatePath)
    ? JSON.parse(readFileSync(templatePath, 'utf8'))
    : { outputStyle: 'default' };
  const markers = {
    default: 'most detailed style',
    simple: 'Practical concise',
    minimal: 'a very short summary',
    'extreme-minimal': 'exactly one sentence',
  };
  const snippets = {};
  try {
    for (const styleId of STYLES) {
      const dataDir = join(baseDir, styleId);
      mkdirSync(dataDir, { recursive: true });
      writeFileSync(join(dataDir, 'mixdog-config.json'), JSON.stringify({ ...baseConfig, outputStyle: styleId }, null, 2));
      snippets[styleId] = outputStyleBodyFromMeta(rulesBuilder.buildLeadMetaContent({ PLUGIN_ROOT, DATA_DIR: dataDir }));
      if (!snippets[styleId].includes(markers[styleId])) throw new Error(`${styleId} injection marker missing`);
    }
    if (new Set(STYLES.map((id) => snippets[id])).size !== STYLES.length) throw new Error('injection bodies not distinct');
    return { snippets };
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
}
function authArtifactNamesForSandbox(realDataDir, provider) {
  const names = new Set();
  for (const file of AUTH_ARTIFACT_BY_PROVIDER[provider] || []) names.add(file);
  try {
    for (const entry of readdirSync(realDataDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      if (/oauth/i.test(entry.name) || /credentials/i.test(entry.name)) names.add(entry.name);
    }
  } catch { /* missing real data dir */ }
  return [...names];
}
function copyAuthArtifacts(realDataDir, sandboxDataDir, provider) {
  const copied = [];
  const skipped = [];
  for (const name of authArtifactNamesForSandbox(realDataDir, provider)) {
    const src = join(realDataDir, name);
    const dest = join(sandboxDataDir, name);
    if (!existsSync(src)) {
      skipped.push(name);
      continue;
    }
    try {
      copyFileSync(src, dest);
      copied.push(name);
    } catch {
      skipped.push(name);
    }
  }
  return { copied, skipped };
}
function prepareStyleSandbox(baseSandbox, styleId, userUnified, realDataDir, provider) {
  const dataDir = join(baseSandbox, styleId);
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, 'mixdog-config.json'), JSON.stringify({ ...userUnified, outputStyle: styleId }, null, 2));
  copyAuthArtifacts(realDataDir, dataDir, provider);
  return dataDir;
}
function findPresetRoute(config, key) {
  const wanted = String(key || '').trim().toLowerCase();
  if (!wanted) return null;
  const presets = Array.isArray(config?.presets) ? config.presets : [];
  return presets.find((p) => {
    const id = String(p?.id || '').trim().toLowerCase();
    const name = String(p?.name || '').trim().toLowerCase();
    return id === wanted || name === wanted;
  }) || null;
}
function resolveLeadProviderModel(userUnified, cli) {
  if (cli.provider && cli.model) return { provider: cli.provider, model: cli.model };
  const leadPreset = findPresetRoute(userUnified, 'workflow-lead')
    || findPresetRoute(userUnified, userUnified.default)
    || findPresetRoute(userUnified, 'gpt-5.5');
  if (leadPreset?.provider && leadPreset?.model) return { provider: leadPreset.provider, model: leadPreset.model };
  const alias = MODEL_ALIASES.gpt;
  return { provider: cli.provider || alias.provider, model: cli.model || alias.model };
}
function runLiveLeadTurn({ dataDir, prompt, provider, model, cwd, effort, fast }) {
  const cfgUrl = pathToFileURL(join(PLUGIN_ROOT, 'runtime/agent/orchestrator/config.mjs')).href;
  const regUrl = pathToFileURL(join(PLUGIN_ROOT, 'runtime/agent/orchestrator/providers/registry.mjs')).href;
  const mgrUrl = pathToFileURL(join(PLUGIN_ROOT, 'runtime/agent/orchestrator/session/manager.mjs')).href;
  const driver = [
    `import * as cfgMod from ${JSON.stringify(cfgUrl)};`,
    `import * as reg from ${JSON.stringify(regUrl)};`,
    `import { createSession, askSession, closeSession } from ${JSON.stringify(mgrUrl)};`,
    `const config = cfgMod.loadConfig({ secrets: true });`,
    `await reg.initProviders(config.providers || {});`,
    `const sessionOpts = { provider: ${JSON.stringify(provider)}, model: ${JSON.stringify(model)},`,
    `  owner: 'cli', agent: 'lead', lane: 'cli', sourceType: 'lead', sourceName: 'output-style-bench',`,
    `  cwd: ${JSON.stringify(cwd)}, tools: 'full', fast: ${fast ? 'true' : 'false'} };`,
    effort ? `sessionOpts.effort = ${JSON.stringify(effort)};` : '',
    `const session = createSession(sessionOpts);`,
    `let result;`,
    `try { result = await askSession(session.id, ${JSON.stringify(prompt)}, null, null, ${JSON.stringify(cwd)}); }`,
    `finally { try { closeSession(session.id, 'output-style-bench'); } catch {} }`,
    // Pooled provider sockets (e.g. openai-oauth WS, 20-min idle TTL) keep the
    // child alive after the turn; flush JSON then force-exit so execFileSync
    // returns as soon as the turn completes.
    `const payload = JSON.stringify({ text: String(result?.text || result?.content || '').trim(), sessionId: session.id });`,
    `await new Promise((r) => process.stdout.write(payload, r));`,
    `process.exit(0);`,
  ].filter(Boolean).join('\n');
  const raw = execFileSync('node', ['--input-type=module', '-e', driver], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: Number(process.env.OUTPUT_STYLE_BENCH_TURN_TIMEOUT_MS || 10 * 60_000),
    killSignal: 'SIGKILL',
    env: { ...process.env, MIXDOG_ROOT: PLUGIN_ROOT, MIXDOG_DATA_DIR: dataDir },
  });
  const jsonStart = raw.lastIndexOf('{');
  if (jsonStart < 0) throw new Error(`live driver failed: ${raw.slice(0, 400)}`);
  return JSON.parse(raw.slice(jsonStart));
}
function styleCharCountsFromResults(results) {
  return Object.fromEntries(
    STYLES.map((id) => [id, results.find((r) => r.style === id)?.metrics.chars ?? 0]),
  );
}
function evaluateVerbosityOrdering(results) {
  const counts = STYLES.map((id) => results.find((r) => r.style === id)?.metrics.chars ?? 0);
  let orderingOk = true;
  for (let i = 1; i < counts.length; i += 1) {
    if (counts[i - 1] < counts[i]) orderingOk = false;
  }
  const chain = STYLES.map((id, i) => `${id}=${counts[i]}`).join(' ');
  const passLabel = STYLES.map((id) => `chars(${id})`).join(' >= ');
  const verdict = orderingOk
    ? `PASS ${passLabel}`
    : `WARN ordering violated: ${chain}`;
  return { orderingOk, verdict, counts: styleCharCountsFromResults(results) };
}
function printUsage() {
  process.stdout.write(`output-style-bench — Lead verbosity ladder (default >= simple >= minimal >= extreme-minimal).

Output style is Lead-only (buildLeadMetaContent when owner is not agent).
runHeadlessRole worker paths (owner=agent) do NOT inject outputStyle.

Usage:
  node scripts/output-style-bench.mjs [--json]
  node scripts/output-style-bench.mjs --run [--model gpt] [--provider P] [--effort E] [--fast] [--prompt "..."] [--json]

--run required for live calls. Temp MIXDOG_DATA_DIR: outputStyle override + read-only copy of OAuth/credential JSON from your real data dir.
`);
}
function main() {
  const jsonMode = hasFlag('--json');
  const doRun = hasFlag('--run');
  const prompt = argValue('--prompt', DEFAULT_PROMPT);
  const cli = resolveModelOpts(argValue('--model', null), argValue('--provider', null));
  const effort = argValue('--effort', null);
  const fast = hasFlag('--fast');
  const cwd = process.cwd();
  let scaffold;
  try { scaffold = runInjectionScaffold(); }
  catch (e) { process.stderr.write(`[output-style-bench] scaffold FAILED: ${e.message}\n`); process.exit(1); }
  if (!doRun) {
    printUsage();
    const charCounts = Object.fromEntries(STYLES.map((id) => [id, scaffold.snippets[id].length]));
    if (jsonMode) {
      console.log(JSON.stringify({ mode: 'scaffold', role: 'lead', owner: 'cli', charCounts, liveCommand: 'node scripts/output-style-bench.mjs --run --model gpt' }, null, 2));
    } else {
      process.stdout.write(`[output-style-bench] scaffold ok: ${STYLES.map((id) => `${id}=${charCounts[id]}`).join(', ')}\n`);
    }
    process.exit(0);
  }
  const realDataDir = defaultUserDataDir();
  const userUnified = readUnifiedConfig(realDataDir);
  const route = resolveLeadProviderModel(userUnified, cli);
  const baseSandbox = mkdtempSync(join(REPO_ROOT, '.tmp-output-style-bench-live-'));
  const results = [];
  try {
    for (const styleId of STYLES) {
      const dataDir = prepareStyleSandbox(baseSandbox, styleId, userUnified, realDataDir, route.provider);
      process.stderr.write(`[output-style-bench] style=${styleId} ${route.provider}/${route.model}\n`);
      try {
        const live = runLiveLeadTurn({ dataDir, prompt, ...route, cwd, effort, fast });
        const metrics = measureOutputText(live.text);
        results.push({ style: styleId, ok: true, sessionId: live.sessionId, metrics, raw: metrics.text });
      } catch (err) {
        results.push({
          style: styleId,
          ok: false,
          error: String(err.stdout || err.stderr || err.message).slice(0, 2000),
          metrics: measureOutputText(''),
        });
      }
    }
  } finally {
    rmSync(baseSandbox, { recursive: true, force: true });
  }
  const { orderingOk, verdict } = evaluateVerbosityOrdering(results);
  if (jsonMode) {
    console.log(JSON.stringify({ mode: 'live', role: 'lead', prompt, route, results, verdict, orderingOk }, null, 2));
  } else {
    console.log(`live role=lead ${route.provider}/${route.model}`);
    for (const r of results) {
      const m = r.metrics;
      console.log(`- ${r.style}: ${r.ok ? 'ok' : 'FAIL'} chars=${m.chars} lines=${m.lines} bullets=${m.bullets} sentences=${m.sentences}`);
      if (r.ok) console.log(`  ${m.text}`);
      else console.log(`  error: ${String(r.error || '').slice(0, 300)}`);
    }
    console.log(verdict);
  }
  process.exit(results.every((r) => r.ok) ? 0 : 1);
}
main();
