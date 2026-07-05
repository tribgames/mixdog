#!/usr/bin/env node
import { loadConfig } from '../src/runtime/agent/orchestrator/config.mjs';
import { initProviders, getAllProviders } from '../src/runtime/agent/orchestrator/providers/registry.mjs';
import {
  loadModelsDevCatalog,
  warmModelMetadataCatalogs,
} from '../src/runtime/agent/orchestrator/providers/model-catalog.mjs';
import { QUICK_SEARCH_MODELS } from '../src/session-runtime/quick-search-models.mjs';

const args = new Set(process.argv.slice(2));
const json = args.has('--json');
const allRows = args.has('--all');
const refresh = !args.has('--no-refresh');

const PROVIDER_ALIAS = Object.freeze({
  'openai-oauth': 'openai',
  openai: 'openai',
  'grok-oauth': 'xai',
  xai: 'xai',
  gemini: 'google',
  google: 'google',
  'anthropic-oauth': 'anthropic',
  anthropic: 'anthropic',
});

const LIT_PREFIXES = Object.freeze({
  openai: ['openai/'],
  xai: ['xai/'],
  google: ['gemini/', 'google/'],
  anthropic: ['anthropic/'],
  deepseek: ['deepseek/'],
});

function n(value) {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? Math.floor(num) : null;
}

function contextLabel(value) {
  const v = n(value);
  if (!v) return '-';
  if (v >= 1_000_000) {
    const m = v / 1_000_000;
    const label = Number.isInteger(m)
      ? m.toFixed(0)
      : m.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
    return `${label}M`;
  }
  return `${Math.round(v / 1000)}k`;
}

function isInteresting(id) {
  const s = String(id || '').toLowerCase();
  return /^(gpt-5|gpt-4\.1|claude-|gemini-|grok-|deepseek-v4|glm-|qwen|minimax|kimi)/.test(s);
}

function litellmRow(litellm, provider, id) {
  const p = PROVIDER_ALIAS[provider] || provider;
  const keys = [id, ...(LIT_PREFIXES[p] || []).map(prefix => prefix + id)];
  if (p === 'anthropic') keys.push(`anthropic.${id}-v1:0`, `bedrock/anthropic.${id}-v1:0`);
  for (const key of keys) {
    if (litellm?.[key]) return { key, row: litellm[key] };
  }
  return null;
}

function externalMeta(modelsDev, litellm, provider, id) {
  const p = PROVIDER_ALIAS[provider] || provider;
  const md = modelsDev?.[p]?.models?.[id] || null;
  const lit = litellmRow(litellm, provider, id);
  return {
    modelsDevContext: n(md?.limit?.context),
    modelsDevOutput: n(md?.limit?.output),
    litellmContext: n(lit?.row?.max_input_tokens ?? lit?.row?.max_tokens),
    litellmOutput: n(lit?.row?.max_output_tokens),
    externalName: md?.name || null,
    litellmKey: lit?.key || null,
  };
}

function classifyOneMillion(value) {
  const v = n(value);
  if (!v) return 'unknown';
  if (v === 1_000_000) return 'exact-1M';
  if (v > 900_000 && v < 1_100_000) return 'near-1M-not-exact';
  return 'not-1M';
}

async function listProviderModels(name, provider) {
  let models = null;
  let refreshed = false;
  let error = null;
  try {
    if (refresh && typeof provider?._refreshModelCache === 'function') {
      models = await provider._refreshModelCache();
      refreshed = true;
    }
    if (!Array.isArray(models) && typeof provider?.listModels === 'function') {
      models = await provider.listModels();
    }
  } catch (err) {
    error = err?.message || String(err);
  }
  return { provider: name, refreshed, error, models: Array.isArray(models) ? models : [] };
}

const cfg = loadConfig();
try {
  await initProviders(cfg.providers || {});
} catch (err) {
  if (!json) console.error(`[model-audit] init failed: ${err?.message || err}`);
}

const [modelsDev, litellm] = await Promise.all([
  loadModelsDevCatalog().catch(() => ({})),
  warmModelMetadataCatalogs().catch(() => ({})),
]);

const providerResults = [];
for (const [name, provider] of getAllProviders()) {
  if (typeof provider?.listModels !== 'function') continue;
  const listed = await listProviderModels(name, provider);
  const rows = listed.models
    .filter(row => row?.id && (allRows || isInteresting(row.id)))
    .map(row => {
      const liveContext = n(row.contextWindow ?? row.maxContextWindow);
      const liveOutput = n(row.outputTokens);
      const external = externalMeta(modelsDev, litellm, name, row.id);
      const externalContext = external.modelsDevContext ?? external.litellmContext;
      const externalOutput = external.modelsDevOutput ?? external.litellmOutput;
      return {
        provider: name,
        id: row.id,
        display: row.display || row.name || null,
        liveContext,
        liveContextLabel: contextLabel(liveContext),
        liveOutput,
        externalContext,
        externalContextLabel: contextLabel(externalContext),
        externalOutput,
        contextVerdict: classifyOneMillion(liveContext),
        contextMismatch: liveContext != null && externalContext != null && liveContext !== externalContext,
        outputMismatch: liveOutput != null && externalOutput != null && liveOutput !== externalOutput,
        source: listed.refreshed ? 'live-refresh' : 'live-list',
        ...external,
      };
    });
  providerResults.push({
    provider: name,
    refreshed: listed.refreshed,
    error: listed.error,
    count: listed.models.length,
    rows,
  });
}

const quickRows = [];
for (const [provider, models] of Object.entries(QUICK_SEARCH_MODELS)) {
  for (const model of models) {
    if (model?.contextWindow == null) continue;
    const external = externalMeta(modelsDev, litellm, provider, model.id);
    const externalContext = external.modelsDevContext ?? external.litellmContext;
    quickRows.push({
      provider,
      id: model.id,
      staticContext: n(model.contextWindow),
      externalContext,
      mismatch: n(model.contextWindow) != null && externalContext != null && n(model.contextWindow) !== externalContext,
    });
  }
}

const mismatches = providerResults.flatMap(p => p.rows.filter(r => r.contextMismatch || r.outputMismatch));
const exactOneM = providerResults.flatMap(p => p.rows.filter(r => r.liveContext === 1_000_000));
const nearOneM = providerResults.flatMap(p => p.rows.filter(r => r.contextVerdict === 'near-1M-not-exact'));

const report = {
  generatedAt: new Date().toISOString(),
  enabledProviders: Object.entries(cfg.providers || {}).filter(([, v]) => v?.enabled).map(([k]) => k),
  providerResults,
  mismatches,
  exactOneM,
  nearOneM,
  quickStaticContextRows: quickRows,
};

if (json) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`model catalog audit @ ${report.generatedAt}`);
  console.log(`enabled providers: ${report.enabledProviders.join(', ') || '-'}`);
  for (const p of providerResults) {
    console.log(`\n[${p.provider}] count=${p.count} refreshed=${p.refreshed}${p.error ? ` error=${p.error}` : ''}`);
    for (const r of p.rows) {
      const flags = [
        r.contextMismatch ? `context ${r.liveContextLabel} != external ${r.externalContextLabel}` : '',
        r.outputMismatch ? `output ${r.liveOutput} != external ${r.externalOutput}` : '',
      ].filter(Boolean).join('; ');
      console.log(`  ${r.id}: ${r.liveContextLabel} ctx, out=${r.liveOutput ?? '-'}${flags ? `  [${flags}]` : ''}`);
    }
  }
  console.log(`\nsummary: mismatches=${mismatches.length}, exact1M=${exactOneM.length}, near1MNotExact=${nearOneM.length}, staticContextRows=${quickRows.length}`);
  if (mismatches.length) {
    console.log('mismatches:');
    for (const r of mismatches.slice(0, 50)) {
      console.log(`  ${r.provider}/${r.id}: live=${r.liveContextLabel}/${r.liveOutput ?? '-'} external=${r.externalContextLabel}/${r.externalOutput ?? '-'}`);
    }
  }
}
