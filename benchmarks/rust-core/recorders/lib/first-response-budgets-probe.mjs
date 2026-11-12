// The first-response budgets Node's providers state, read in a process of its own: Node reads the environment variables
// (`STALL_TIMEOUT_S`, `MIXDOG_PROVIDER_FIRST_BYTE_TIMEOUT_MS`, `MIXDOG_GEMINI_FIRST_BYTE_TIMEOUT_MS`,
// `MIXDOG_ANTIGRAVITY_*`) once, when its modules load, so each environment is one process.
//   node first-response-budgets-probe.mjs <tree>      (the environment is the process's own; prints the JSON)
import { importFrom } from './common.mjs';

import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const tree = process.argv[2];
const P = 'src/runtime/agent/orchestrator/providers/';
// The real provider classes warm a connection to their host when they are constructed (`preconnect`): no connection leaves this process
// (a global dispatcher that is not undici's own Agent is one `preconnect` steps aside for, and it refuses a request).
const { Dispatcher, setGlobalDispatcher } = await import(pathToFileURL(join(tree, 'node_modules/undici/index.js')).href);
setGlobalDispatcher(new (class NoNetwork extends Dispatcher { dispatch() { throw new Error('the probe allows no network connection'); } })());
const { VertexAIProvider } = await importFrom(tree, `${P}vertex-ai.mjs`);
const { OpenAICompatProvider } = await importFrom(tree, `${P}openai-compat.mjs`);
const { MimoOAuthProvider } = await importFrom(tree, `${P}mimo-oauth.mjs`);
const { AntigravityOAuthProvider } = await importFrom(tree, `${P}antigravity-oauth.mjs`);
const { ANTIGRAVITY_MODELS } = await importFrom(tree, `${P}antigravity-oauth-tokens.mjs`);

const plain = (budget) => (budget === null || budget === undefined ? null : { transportMs: budget.transportMs, semanticMs: budget.semanticMs });

// Vertex AI: a Flex route only. The method reads no instance state.
const vertex = {};
for (const [name, args] of [
  ['noOptions', []], ['standard', [{ modelParameters: {} }]], ['flex', [{ modelParameters: { serviceTier: 'flex' } }]],
  ['flexUpperCase', [{ modelParameters: { serviceTier: 'FLEX' } }]], ['priority', [{ modelParameters: { serviceTier: 'priority' } }]],
  ['unknownTier', [{ modelParameters: { serviceTier: 'turbo' } }]],
]) vertex[name] = plain(VertexAIProvider.prototype.firstResponseBudget.call({}, 'gemini-3.6-flash', ...args));

// OpenAI-compatible providers: one with a chat profile of its own window (mimo) and the rest, on the shared window.
const compat = { 'mimo-oauth': plain(MimoOAuthProvider.prototype.firstResponseBudget.call({ name: 'mimo-oauth' })) };
for (const name of ['xai', 'deepseek', 'openrouter', 'command-code-oauth', 'muse-code-oauth', 'opencode-go-oauth']) {
  compat[name] = plain(OpenAICompatProvider.prototype.firstResponseBudget.call({ name, config: { chatProfile: {} } }));
}

// Antigravity: every curated model, the default (no model) and an id the catalog does not list.
const antigravity = {};
for (const model of ['', ...ANTIGRAVITY_MODELS.map((entry) => entry.id), 'not-a-listed-model']) {
  antigravity[model] = plain(AntigravityOAuthProvider.prototype.firstResponseBudget.call({}, model || undefined));
}
// The settings Node resolved from the environment, as its modules state them (each is a constant of its module, read as the module loads).
const { PROVIDER_MAX_BEFORE_WARN_MS, PROVIDER_FIRST_BYTE_TIMEOUT_MS } = await importFrom(tree, 'src/runtime/agent/orchestrator/stall-policy.mjs');
const { GEMINI_FIRST_BYTE_TIMEOUT_MS } = await importFrom(tree, `${P}gemini-stream.mjs`);
const { ANTIGRAVITY_FIRST_BYTE_TIMEOUT_MS, ANTIGRAVITY_FIRST_BYTE_RETRIES, ANTIGRAVITY_RETRY } = await importFrom(tree, `${P}antigravity-retry-policy.mjs`);
const settings = {
  maxBeforeWarnMs: PROVIDER_MAX_BEFORE_WARN_MS, providerMs: PROVIDER_FIRST_BYTE_TIMEOUT_MS, geminiMs: GEMINI_FIRST_BYTE_TIMEOUT_MS, antigravityProMs: ANTIGRAVITY_FIRST_BYTE_TIMEOUT_MS,
  antigravityAttempts: ANTIGRAVITY_RETRY.maxAttempts, antigravityBackoffMs: [...ANTIGRAVITY_RETRY.backoffMs], antigravityFirstByteRetries: ANTIGRAVITY_FIRST_BYTE_RETRIES,
};

// Every provider the registry builds (registry.mjs PROVIDER_MODULES and the compat preset `xai`), as the registry constructs it, asked for its budget on
// every route: each model below with no tier, the Flex tier and the Priority tier (`provider.firstResponseBudget?.(model, { modelParameters })`,
// spawn-prep.mjs:81). A provider that states none answers null on every route.
const MODULES = {
  anthropic: ['anthropic.mjs', 'AnthropicProvider'], gemini: ['gemini.mjs', 'GeminiProvider'], 'vertex-ai': ['vertex-ai.mjs', 'VertexAIProvider'],
  'openai-oauth': ['openai-oauth.mjs', 'OpenAIOAuthProvider'], 'anthropic-oauth': ['anthropic-oauth.mjs', 'AnthropicOAuthProvider'], 'grok-oauth': ['grok-oauth.mjs', 'GrokOAuthProvider'],
  'muse-code-oauth': ['muse-code-oauth.mjs', 'MuseCodeOAuthProvider'], 'command-code-oauth': ['command-code-oauth.mjs', 'CommandCodeOAuthProvider'], 'mimo-oauth': ['mimo-oauth.mjs', 'MimoOAuthProvider'],
  'cursor-oauth': ['cursor.mjs', 'CursorOAuthProvider'], 'devin-oauth': ['devin.mjs', 'DevinOAuthProvider'], 'antigravity-oauth': ['antigravity-oauth.mjs', 'AntigravityOAuthProvider'],
  'cursor-api': ['cursor.mjs', 'CursorApiProvider'], openai: ['openai-ws.mjs', 'OpenAIDirectProvider'], 'mixdog-local': ['mixdog-local.mjs', 'MixdogLocalProvider'],
  'opencode-go-oauth': ['opencode-go-oauth.mjs', 'OpenCodeGoOAuthProvider'], openrouter: ['openrouter.mjs', 'OpenRouterProvider'], deepseek: ['deepseek.mjs', 'DeepSeekProvider'],
};
const ROUTE_MODELS = ['', 'gemini-3.6-flash', 'gemini-3.8-flash', 'gemini-3.1-pro', 'gemini-4-argon', 'claude-sonnet-4-6', 'gpt-oss-120b', 'not-a-listed-model'];
const ROUTE_TIERS = [undefined, 'flex', 'priority'];
// The entry every provider is built with (the replay builds the same).
const ENTRY = { enabled: true, apiKey: 'k' };
const table = {};
for (const name of [...Object.keys(MODULES), 'xai']) {
  let instance;
  if (name === 'xai') instance = new OpenAICompatProvider(name, ENTRY);
  else { const [file, exported] = MODULES[name]; instance = new (await importFrom(tree, `${P}${file}`))[exported](ENTRY); }
  table[name] = {};
  for (const model of ROUTE_MODELS) {
    for (const tier of ROUTE_TIERS) table[name][`${model}|${tier ?? ''}`] = plain(instance.firstResponseBudget?.(model || undefined, { modelParameters: tier ? { serviceTier: tier } : undefined }));
  }
}

// With `--registry-routes`: every model Node's registries list (Vertex AI's `VERTEX_MODELS`, Antigravity's `ANTIGRAVITY_MODELS`)
// on every tier, for every provider, so the replay compares the route set with what the core's registries enumerate, both ways.
let registryRoutes;
if (process.argv.includes('--registry-routes')) {
  const { VERTEX_MODELS } = await importFrom(tree, `${P}vertex-ai-models.mjs`);
  const models = [...new Set([...VERTEX_MODELS.map((entry) => entry.id), ...ANTIGRAVITY_MODELS.map((entry) => entry.id)])].sort();
  registryRoutes = { models: { vertex: VERTEX_MODELS.map((entry) => entry.id), antigravity: ANTIGRAVITY_MODELS.map((entry) => entry.id) }, tiers: ROUTE_TIERS.map((tier) => tier ?? ''), table: {} };
  for (const name of [...Object.keys(MODULES), 'xai']) {
    let instance;
    if (name === 'xai') instance = new OpenAICompatProvider(name, ENTRY);
    else { const [file, exported] = MODULES[name]; instance = new (await importFrom(tree, `${P}${file}`))[exported](ENTRY); }
    registryRoutes.table[name] = {};
    for (const model of models) {
      for (const tier of ROUTE_TIERS) registryRoutes.table[name][`${model}|${tier ?? ''}`] = plain(instance.firstResponseBudget?.(model, { modelParameters: tier ? { serviceTier: tier } : undefined }));
    }
  }
}

// What the environment's later change does: nothing, the budgets were fixed as the modules loaded.
const changedTo = { STALL_TIMEOUT_S: '100', MIXDOG_PROVIDER_FIRST_BYTE_TIMEOUT_MS: '45000', MIXDOG_GEMINI_FIRST_BYTE_TIMEOUT_MS: '90000', MIXDOG_ANTIGRAVITY_RETRY_MAX_ATTEMPTS: '2', MIXDOG_ANTIGRAVITY_RETRY_BACKOFF_MS: '9,9', MIXDOG_ANTIGRAVITY_FIRST_BYTE_RETRIES: '0', MIXDOG_ANTIGRAVITY_FIRST_BYTE_TIMEOUT_MS: '31000' };
for (const [name, value] of Object.entries(changedTo)) process.env[name] = value;
const afterEnvironmentChange = {};
for (const model of ['', ...ANTIGRAVITY_MODELS.map((entry) => entry.id), 'not-a-listed-model']) afterEnvironmentChange[model] = plain(AntigravityOAuthProvider.prototype.firstResponseBudget.call({}, model || undefined));
process.stdout.write(JSON.stringify({ vertex, compat, antigravity, settings, table, registryRoutes, changedTo, afterEnvironmentChange }));
