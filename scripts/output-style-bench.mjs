#!/usr/bin/env node
// Lead output-style composition and depth bench.
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
import { findOutputStyle, listOutputStyleCatalog } from '../src/session-runtime/output-styles.mjs';

const __dir = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dir, '..');
const PLUGIN_ROOT = join(REPO_ROOT, 'src');
const STYLES = ['detailed', 'simple', 'minimal', 'extreme-minimal'];
const LIVE_RESULT_SENTINEL = '__OUTPUT_STYLE_BENCH_RESULT__';
const DEFAULT_PROMPT = `Reply in English. The output-style alias resolver in
src/lib/rules-builder.cjs now maps canonical names, built-in aliases, and custom
aliases to the same style, and duplicate instructions were removed. Regression
coverage was added, all 24 checks passed, and deployment was not run. Tell the
user what changed and whether the work is ready. Do not use tools.`;
const MODEL_ALIASES = {
  opus: { provider: 'anthropic-oauth', model: 'claude-opus-4-8' },
  sonnet: { provider: 'anthropic-oauth', model: 'claude-sonnet-5' },
  gpt: { provider: 'openai-oauth', model: 'gpt-5.6-sol' },
  'gpt-5.6-sol': { provider: 'openai-oauth', model: 'gpt-5.6-sol' },
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
  const text = String(meta || '');
  const idx = text.lastIndexOf('# Output Style: ');
  return idx < 0 ? '' : text.slice(idx).trim();
}
function measureOutputText(text) {
  const trimmed = String(text || '').trim();
  const lines = trimmed ? trimmed.split(/\r?\n/) : [];
  const bullets = lines.filter((l) => /^\s*[-*•]\s+/.test(l)).length;
  const numberedItems = lines.filter((l) => /^\s*\d+[.)]\s+/.test(l)).length;
  const listItems = lines.filter((l) => /^\s*(?:[-*•]|\d+[.)])\s+/.test(l)).length;
  const nestedListItems = lines.filter((l) => /^\s{2,}(?:[-*•]|\d+[.)])\s+/.test(l)).length;
  const headings = lines.filter((l) => /^\s*#{1,6}\s+/.test(l)).length;
  const sectionLabels = lines.filter((l) => /^\s*\*\*[^*]+\*\*\s*$/.test(l)).length;
  const tableRows = lines.filter((l) => /^\s*\|.*\|\s*$/.test(l)).length;
  const paragraphs = trimmed ? trimmed.split(/\r?\n\s*\r?\n/).filter((part) => part.trim()).length : 0;
  const withoutCode = trimmed.replace(/`[^`]*`/g, '');
  const sentenceText = withoutCode.replace(/[*_~]+/g, '');
  const sentenceMarks = sentenceText.match(/[.!?。！？]+(?=\s|$)/g) || [];
  const semicolons = (withoutCode.match(/[;；]/g) || []).length;
  const shape = tableRows >= 2 ? 'table'
    : numberedItems > 0 ? 'steps'
      : bullets > 0 && (headings > 0 || sectionLabels > 0) ? 'sections+bullets'
        : bullets > 0 ? 'bullets'
          : paragraphs > 1 ? 'paragraphs'
            : 'prose';
  return {
    chars: trimmed.length,
    lines: lines.length,
    bullets,
    numberedItems,
    listItems,
    nestedListItems,
    headings,
    sectionLabels,
    tableRows,
    paragraphs,
    sentences: sentenceMarks.length || (trimmed ? 1 : 0),
    semicolons,
    shape,
    text: trimmed,
  };
}
function runInjectionScaffold() {
  const rulesBuilder = createRequire(import.meta.url)(join(PLUGIN_ROOT, 'lib', 'rules-builder.cjs'));
  const baseDir = mkdtempSync(join(REPO_ROOT, '.tmp-output-style-bench-'));
  const templatePath = join(PLUGIN_ROOT, 'defaults', 'mixdog-config.template.json');
  const baseConfig = existsSync(templatePath)
    ? JSON.parse(readFileSync(templatePath, 'utf8'))
    : { outputStyle: 'simple' };
  const sharedMarker = 'Lead with the answer or action';
  const sharedFormatMarkers = [
    'Choose the presentation from the content',
    'no response shape is the default',
    'Never produce an essay-shaped wall of text',
    'Use tables only for short enumerable',
    'Do not restate the request',
  ];
  const markers = {
    detailed: 'concrete explanation',
    simple: 'concise summary',
    minimal: 'conclusion and core cause',
    'extreme-minimal': 'final decision or answer',
  };
  const snippets = {};
  const aliasChecks = [];
  try {
    for (const styleId of STYLES) {
      const dataDir = join(baseDir, styleId);
      mkdirSync(dataDir, { recursive: true });
      writeFileSync(join(dataDir, 'mixdog-config.json'), JSON.stringify({ ...baseConfig, outputStyle: styleId }, null, 2));
      snippets[styleId] = outputStyleBodyFromMeta(rulesBuilder.buildLeadMetaContent({ PLUGIN_ROOT, DATA_DIR: dataDir }));
      if (!snippets[styleId].startsWith(`# Output Style: `)) throw new Error(`${styleId} injection missing output-style header`);
      if (!snippets[styleId].includes(markers[styleId])) throw new Error(`${styleId} injection marker missing`);
      if (!snippets[styleId].includes(sharedMarker)) throw new Error(`${styleId} shared philosophy missing`);
      for (const marker of sharedFormatMarkers) {
        if (!snippets[styleId].includes(marker)) throw new Error(`${styleId} shared format marker missing: ${marker}`);
      }
      if (snippets[styleId].split(sharedMarker).length !== 2) throw new Error(`${styleId} shared philosophy duplicated`);
    }
    if (new Set(STYLES.map((id) => snippets[id])).size !== STYLES.length) throw new Error('injection bodies not distinct');
    const sharedBlocks = STYLES.map((id) => snippets[id].slice(
      snippets[id].indexOf(sharedMarker),
      snippets[id].indexOf('\n\n## Depth Variation'),
    ));
    if (sharedBlocks.some((block) => !block) || new Set(sharedBlocks).size !== 1) {
      throw new Error('built-in styles do not share the same core philosophy');
    }
    const builtinCatalog = listOutputStyleCatalog(PLUGIN_ROOT, baseDir, { fresh: true });
    if (builtinCatalog.some((style) => style.id === 'common')) {
      throw new Error('common partial leaked into selectable output styles');
    }
    for (const [alias, canonical] of [
      ['default', 'simple'],
      ['concise', 'simple'],
      ['verbose', 'detailed'],
      ['extreme', 'extreme-minimal'],
    ]) {
      const dataDir = join(baseDir, `alias-${alias}`);
      mkdirSync(dataDir, { recursive: true });
      writeFileSync(join(dataDir, 'mixdog-config.json'), JSON.stringify({ ...baseConfig, outputStyle: alias }, null, 2));
      const injected = outputStyleBodyFromMeta(rulesBuilder.buildLeadMetaContent({ PLUGIN_ROOT, DATA_DIR: dataDir }));
      const selected = findOutputStyle(alias, listOutputStyleCatalog(PLUGIN_ROOT, dataDir, { fresh: true }));
      if (selected?.id !== canonical) throw new Error(`${alias} runtime alias did not resolve to ${canonical}`);
      if (injected !== snippets[canonical]) throw new Error(`${alias} injection differs from ${canonical}`);
      aliasChecks.push(`${alias}=${canonical}`);
    }
    const customDir = join(baseDir, 'custom-alias');
    mkdirSync(join(customDir, 'output-styles'), { recursive: true });
    writeFileSync(join(customDir, 'output-styles', 'bespoke.md'), `---
name: audit-note
title: Audit Note
description: Custom alias fixture
aliases: audit, review-note
---

## Depth Variation

Audit note — custom alias sentinel.`);
    writeFileSync(join(customDir, 'mixdog-config.json'), JSON.stringify({ ...baseConfig, outputStyle: 'audit-note' }, null, 2));
    const customCanonical = outputStyleBodyFromMeta(rulesBuilder.buildLeadMetaContent({ PLUGIN_ROOT, DATA_DIR: customDir }));
    writeFileSync(join(customDir, 'mixdog-config.json'), JSON.stringify({ ...baseConfig, outputStyle: 'review-note' }, null, 2));
    const customAlias = outputStyleBodyFromMeta(rulesBuilder.buildLeadMetaContent({ PLUGIN_ROOT, DATA_DIR: customDir }));
    const customSelected = findOutputStyle('review-note', listOutputStyleCatalog(PLUGIN_ROOT, customDir, { fresh: true }));
    if (customSelected?.id !== 'audit-note') throw new Error('custom frontmatter alias did not resolve to audit-note');
    if (!customCanonical.includes('custom alias sentinel') || customAlias !== customCanonical) {
      throw new Error('custom alias injection differs from canonical style');
    }
    if (!customCanonical.startsWith('# Output Style: Audit Note')) {
      throw new Error('custom style injection missing output-style header');
    }
    if (!customCanonical.includes(sharedMarker)) {
      throw new Error('custom style did not inherit the shared format partial');
    }
    aliasChecks.push('review-note=audit-note');

    // keep-shared-format: false — a standalone style that replaces the shared
    // format policy instead of extending it.
    const standaloneDir = join(baseDir, 'custom-standalone');
    mkdirSync(join(standaloneDir, 'output-styles'), { recursive: true });
    writeFileSync(join(standaloneDir, 'output-styles', 'standalone.md'), `---
name: standalone-note
title: Standalone Note
description: Custom opt-out fixture
keep-shared-format: false
---

## Depth Variation

Standalone note — shared-format opt-out sentinel.`);
    writeFileSync(join(standaloneDir, 'mixdog-config.json'), JSON.stringify({ ...baseConfig, outputStyle: 'standalone-note' }, null, 2));
    const standalone = outputStyleBodyFromMeta(rulesBuilder.buildLeadMetaContent({ PLUGIN_ROOT, DATA_DIR: standaloneDir }));
    if (!standalone.startsWith('# Output Style: Standalone Note')) {
      throw new Error('opt-out style injection missing output-style header');
    }
    if (!standalone.includes('opt-out sentinel')) throw new Error('opt-out style body missing');
    if (standalone.includes(sharedMarker)) {
      throw new Error('keep-shared-format: false still inherited the shared format partial');
    }
    return {
      snippets,
      aliasChecks,
      compositionChecks: [
        'output-style header + shared format + selected depth variant',
        'custom styles inherit the shared format unless keep-shared-format: false',
        'adaptive structure without a forced response shape',
      ],
    };
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
    `const payload = ${JSON.stringify(LIVE_RESULT_SENTINEL)} + JSON.stringify({ text: String(result?.text || result?.content || '').trim(), sessionId: session.id });`,
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
  const sentinelStart = raw.lastIndexOf(LIVE_RESULT_SENTINEL);
  if (sentinelStart < 0) throw new Error(`live driver failed: ${raw.slice(0, 400)}`);
  return JSON.parse(raw.slice(sentinelStart + LIVE_RESULT_SENTINEL.length).trim());
}
function outputSizesFromResults(results) {
  return Object.fromEntries(results.map((result) => [result.style, result.metrics.chars]));
}
function summarizeOutputSizes(results) {
  const failed = results.filter((result) => !result.ok).map((result) => result.style);
  const sizes = outputSizesFromResults(results);
  if (failed.length) {
    return {
      verdict: `Output sizes unavailable: live call failed (${failed.join(', ')})`,
      sizes,
    };
  }
  const summary = results.map((result) => `${result.style}=${sizes[result.style]}`).join(' ');
  return { verdict: `Output sizes (diagnostic only): ${summary}`, sizes };
}
function printUsage() {
  process.stdout.write(`output-style-bench — Lead composition and depth variants.

Output style is Lead-only (buildLeadMetaContent when owner is not agent).
runHeadlessRole worker paths (owner=agent) do NOT inject outputStyle.

Usage:
  node scripts/output-style-bench.mjs [--json]
  node scripts/output-style-bench.mjs --run [--style ID] [--model gpt] [--provider P] [--effort E] [--fast] [--prompt "..."] [--json]

Scaffold mode checks canonical, built-in alias, and custom frontmatter alias injection.
--run records live text and numeric metrics for manual review; it does not grade writing quality.
Temp MIXDOG_DATA_DIR: outputStyle override + read-only copy of OAuth/credential JSON from your real data dir.
`);
}
function main() {
  const jsonMode = hasFlag('--json');
  const doRun = hasFlag('--run');
  const prompt = argValue('--prompt', DEFAULT_PROMPT);
  const cli = resolveModelOpts(argValue('--model', null), argValue('--provider', null));
  const effort = argValue('--effort', null);
  const fast = hasFlag('--fast');
  const styleArg = argValue('--style', null);
  const liveStyles = styleArg ? [String(styleArg).trim().toLowerCase()] : STYLES;
  if (liveStyles.some((style) => !STYLES.includes(style))) {
    process.stderr.write(`[output-style-bench] --style must be one of ${STYLES.join(', ')}\n`);
    process.exit(1);
  }
  const cwd = process.cwd();
  let scaffold;
  try { scaffold = runInjectionScaffold(); }
  catch (e) { process.stderr.write(`[output-style-bench] scaffold FAILED: ${e.message}\n`); process.exit(1); }
  if (!doRun) {
    if (!jsonMode) printUsage();
    const injectionChars = Object.fromEntries(STYLES.map((id) => [id, scaffold.snippets[id].length]));
    if (jsonMode) {
      console.log(JSON.stringify({ mode: 'scaffold', role: 'lead', owner: 'cli', injectionChars,
        aliasChecks: scaffold.aliasChecks, compositionChecks: scaffold.compositionChecks,
        liveCommand: 'node scripts/output-style-bench.mjs --run --model gpt' }, null, 2));
    } else {
      process.stdout.write(`[output-style-bench] scaffold ok: ${STYLES.length} canonical styles injected\n`);
      process.stdout.write(`[output-style-bench] aliases ok: ${scaffold.aliasChecks.join(', ')}\n`);
      process.stdout.write(`[output-style-bench] composition ok: ${scaffold.compositionChecks.join(', ')}\n`);
    }
    process.exit(0);
  }
  const realDataDir = defaultUserDataDir();
  const userUnified = readUnifiedConfig(realDataDir);
  const route = resolveLeadProviderModel(userUnified, cli);
  const baseSandbox = mkdtempSync(join(REPO_ROOT, '.tmp-output-style-bench-live-'));
  const results = [];
  try {
    for (const styleId of liveStyles) {
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
  const outputSizes = summarizeOutputSizes(results);
  if (jsonMode) {
    console.log(JSON.stringify({ mode: 'live', role: 'lead', prompt, route, results, outputSizes }, null, 2));
  } else {
    console.log(`live role=lead ${route.provider}/${route.model}`);
    for (const r of results) {
      const m = r.metrics;
      console.log(`- ${r.style}: ${r.ok ? 'ok' : 'FAIL'} shape=${m.shape} chars=${m.chars} lines=${m.lines} sentences=${m.sentences}`);
      if (r.ok) console.log(`  ${m.text}`);
      else console.log(`  error: ${String(r.error || '').slice(0, 300)}`);
    }
    console.log(outputSizes.verdict);
  }
  process.exit(results.every((r) => r.ok) ? 0 : 1);
}
main();
