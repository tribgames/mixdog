#!/usr/bin/env node
// Golden twin of the setup actions whose setting lives behind a runtime-facade call
// (`set_web_search_route`, `set_model_preferences`, `set_compaction`, `set_autoclear`,
// `set_network_proxy`): the real `createSetupToolExecutor` over a recording facade. A case keeps
// the receipt (or refusal text) Node answered and the facade calls it made, so Rust must hold the
// same executor argument rules, make the same calls (the facade methods are the domain methods
// the Settings UI also uses) and wrap the answers the same way.
//
//   node benchmarks/rust-core/recorders/record-setup-domain-settings.mjs --tree <dir>
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const sandbox = mkdtempSync(join(tmpdir(), 'setup-domain-'));
for (const name of ['MIXDOG_DATA_DIR', 'MIXDOG_HOME', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']) {
  process.env[name] = join(sandbox, name.toLowerCase());
  mkdirSync(process.env[name], { recursive: true });
}

const { FIXTURES_ROOT, importFrom, parseArgs, resolveTree, writeJson } = await import('./lib/common.mjs');
const tree = resolveTree(parseArgs());
const { createSetupToolExecutor } = await importFrom(tree, 'src/session-runtime/setup-tool/executor.mjs');

const plain = (v) => (v === undefined ? { absent: true } : JSON.parse(JSON.stringify(v)));

function facade(calls) {
  const record = (method) => (...args) => {
    calls.push({ method, args: plain(args) });
    return { answered: method };
  };
  return {
    setWebSearchRoute: record('setWebSearchRoute'),
    setModelPreferences: record('setModelPreferences'),
    setCompactionSettings: record('setCompactionSettings'),
    setAutoClear: record('setAutoClear'),
    setNetworkProxy: record('setNetworkProxy'),
    setWorkflow: record('setWorkflow'),
    setOrchestrationMode: record('setOrchestrationMode'),
    setLocalProviderContext: record('setLocalProviderContext'),
  };
}

async function outcome(args) {
  const calls = [];
  const executor = createSetupToolExecutor({ getApi: () => facade(calls), getConfig: () => ({}) });
  try {
    return { args, calls, receipt: JSON.parse(await executor.execute(args)) };
  } catch (error) {
    return { args, calls, error: String(error?.message ?? error) };
  }
}

const route = (extra = {}) => ({ provider: 'openai', model: 'gpt-5', ...extra });
const ARGS = [
  { action: 'set_web_search_route', route: route() },
  { action: 'set_web_search_route', route: route({ provider: ' xai ', model: ' grok ', effort: ' high ', fast: true, autoEffort: false }) },
  { action: 'set_web_search_route', route: { provider: '' } },
  { action: 'set_web_search_route', route: { model: 'm' } },
  { action: 'set_web_search_route', route: {} },
  { action: 'set_web_search_route', route: route({ fast: 'yes', autoEffort: 1, effort: '  ' }) },
  { action: 'set_web_search_route', route: route({ modelParameters: { temperature: 0.2 }, contextPercent: 40, contextTokens: 9000, disabled: true }) },
  { action: 'set_web_search_route', route: route({ modelParameters: null, contextPercent: null }) },
  { action: 'set_web_search_route', route: route({ fallbacks: [] }) },
  { action: 'set_web_search_route', route: route({ fallbacks: [{ provider: 'groq', model: ' llama ' }, { model: 'x' }, { provider: 'a', fallbacks: [{ provider: 'b' }] }] }) },
  { action: 'set_web_search_route', route: route({ fallbacks: [null] }) },
  { action: 'set_web_search_route', route: route({ fallbacks: 'x' }) },
  { action: 'set_web_search_route', route: route({ fallbacks: null }) },
  { action: 'set_web_search_route', route: route({ fallbacks: {} }) },
  { action: 'set_web_search_route' },
  { action: 'set_web_search_route', route: null },
  { action: 'set_web_search_route', route: 'openai' },
  { action: 'set_model_preferences', provider: 'openai', model: 'gpt-5', hidden: true },
  { action: 'set_model_preferences', provider: ' openai ', model: ' gpt-5 ', favorite: false, hidden: false },
  { action: 'set_model_preferences', provider: 'openai', model: 'gpt-5' },
  { action: 'set_model_preferences', provider: 'openai', hidden: true },
  { action: 'set_model_preferences', model: 'gpt-5', hidden: true },
  { action: 'set_model_preferences', provider: 'openai', model: 'gpt-5', hidden: 'yes' },
  { action: 'set_model_preferences', provider: 'openai', model: 'gpt-5', favorite: 1 },
  { action: 'set_model_preferences', provider: '  ', model: '  ', hidden: true },
  { action: 'set_model_preferences', model: 'm' },
  { action: 'set_compaction', enabled: true },
  { action: 'set_compaction', enabled: false },
  { action: 'set_compaction' },
  { action: 'set_compaction', compaction: {} },
  { action: 'set_compaction', compaction: { summaryMode: 'self' } },
  { action: 'set_compaction', compaction: { mainBufferTokens: 8000 }, enabled: true },
  { action: 'set_compaction', compaction: { mainBufferPercent: 10 } },
  { action: 'set_compaction', compaction: { mainBufferTokens: 8000, mainBufferPercent: 10 } },
  { action: 'set_compaction', compaction: { mainBufferTokens: null, mainBufferPercent: null } },
  { action: 'set_compaction', compaction: { auto: false }, enabled: true },
  { action: 'set_compaction', compaction: { zeta: 1, alpha: 2 }, enabled: false },
  { action: 'set_autoclear', autoclear: { enabled: true } },
  { action: 'set_autoclear', autoclear: { duration: '45m' } },
  { action: 'set_autoclear', autoclear: { provider: 'groq', duration: '90m' } },
  { action: 'set_autoclear', autoclear: { reset: true } },
  { action: 'set_autoclear', autoclear: { resetProvider: true, provider: 'groq' } },
  { action: 'set_autoclear', autoclear: { resetProvider: true } },
  { action: 'set_autoclear', autoclear: { resetProvider: true, provider: '  ' } },
  { action: 'set_autoclear', autoclear: { reset: true, provider: 'groq' } },
  { action: 'set_autoclear', autoclear: { reset: true, duration: '10m' } },
  { action: 'set_autoclear', autoclear: { resetProvider: true, provider: 'x', duration: '10m' } },
  { action: 'set_autoclear', autoclear: { reset: false, resetProvider: 0, duration: '10m' } },
  { action: 'set_autoclear', autoclear: {} },
  { action: 'set_autoclear' },
  { action: 'set_autoclear', autoclear: [] },
  { action: 'set_autoclear', autoclear: 'x' },
  { action: 'set_network_proxy', networkProxy: { mode: 'system' } },
  { action: 'set_network_proxy', networkProxy: { mode: 'manual', url: 'http://127.0.0.1:8080' } },
  { action: 'set_network_proxy', networkProxy: {} },
  { action: 'set_network_proxy' },
  { action: 'set_workflow', workflow: 'review' },
  { action: 'set_workflow', workflow: '  Review  ' },
  { action: 'set_workflow', workflow: '   ' },
  { action: 'set_workflow' },
  { action: 'set_orchestration_mode', mode: 'balanced' },
  { action: 'set_orchestration_mode', mode: 'none' },
  { action: 'set_orchestration_mode', mode: 'auto' },
  { action: 'set_orchestration_mode', mode: 'invalid' },
  { action: 'set_orchestration_mode' },
  { action: 'set_local_context', modelId: 'm1', localContextWindow: 16384 },
  { action: 'set_local_context', modelId: 'm1', localContextWindow: null },
  { action: 'set_local_context', modelId: 'm1' },
  { action: 'set_local_context', localContextWindow: 4096 },
];

const cases = [];
for (const args of ARGS) cases.push(await outcome(args));

writeJson(join(FIXTURES_ROOT, 'desktop', 'settings', 'setup-domain-settings-twin.json'), {
  domain: 'setup-domain-settings-twin',
  recorder: 'benchmarks/rust-core/recorders/record-setup-domain-settings.mjs',
  cases,
});
console.log(`recorded ${cases.length} cases (${cases.filter((c) => c.error).length} errors)`);