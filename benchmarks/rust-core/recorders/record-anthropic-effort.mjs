#!/usr/bin/env node
// Anthropic mid-conversation effort control messages (WP-AI-ANTHROPIC): the REAL
// Node request builders are called directly with scripted histories, the way the
// provider recorders call the pure builders. No server, no credential.
//
//   node benchmarks/rust-core/recorders/record-anthropic-effort.mjs [--tree <dir>]
//
// Output: native/core/fixtures/providers/anthropic-effort/cases.json. Each case
// stores its input (route, model, options, history) and the builder's output:
// the lowered `messages`, the effort fields, and the anthropic-beta names.
// The set lives inside `providers/`, so record-providers.mjs (which clears that
// directory) must run this recorder's `recordAnthropicEffort` after it and
// before its manifest write. Run standalone it leaves the manifest alone.
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { FIXTURES_ROOT, importFrom, parseArgs, resolveTree, writeJson } from './lib/common.mjs';

const P = 'src/runtime/agent/orchestrator/providers';
const TOOLS = [{ name: 'lookup', description: 'Read a value', inputSchema: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] } }];
const DEFERRED_TOOL = { name: 'archive_search', description: 'Search the archive', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } };
const OFFICIAL ='https://api.anthropic.com/v1';

// The snapshot model is the session's normalized model key (effort-configuration.mjs modelKey).
const modelKey = (model) =>
  String(model).trim().toLowerCase().replace(/-\d{4}-\d{2}-\d{2}$/, '').replace(/-\d{8}$/, '').replace(/\./g, '-');
const snap = (route, model, initialEffort, effort) => ({
  effortConfiguration: { version: 1, provider: route, model: modelKey(model), mode: 'anthropic', initialEffort, effort },
});

const SYSTEM = { role: 'system', content: 'You are a fixture assistant.' };
const call = { id: 'call_fx1', name: 'lookup', arguments: { key: 'answer' } };

/** Scripted histories, built per route and model so their snapshots validate. */
const HISTORIES = {
  'update-before-user': (r, m) => [
    SYSTEM,
    { role: 'user', content: 'First question.', meta: snap(r, m, 'low', 'low') },
    { role: 'assistant', content: 'First answer.' },
    { role: 'user', content: 'Second question.', meta: snap(r, m, 'low', 'high') },
  ],
  'update-after-tool-batch': (r, m) => [
    SYSTEM,
    { role: 'user', content: 'Look up the answer.', meta: snap(r, m, 'low', 'low') },
    { role: 'assistant', content: '', toolCalls: [call] },
    { role: 'tool', toolCallId: 'call_fx1', content: '42', meta: snap(r, m, 'low', 'high') },
  ],
  // The batch update directly followed by a user message that carries its own update: the batch's is dropped.
  'batch-update-superseded-by-user': (r, m) => [
    SYSTEM,
    { role: 'user', content: 'Look up the answer.', meta: snap(r, m, 'low', 'low') },
    { role: 'assistant', content: '', toolCalls: [call] },
    { role: 'tool', toolCallId: 'call_fx1', content: '42', meta: snap(r, m, 'low', 'high') },
    { role: 'user', content: 'Now think harder.', meta: snap(r, m, 'low', 'max') },
  ],
  // The user message keeps the batch's effort: the batch update is emitted before it.
  'batch-update-then-user-same': (r, m) => [
    SYSTEM,
    { role: 'user', content: 'Look up the answer.', meta: snap(r, m, 'low', 'low') },
    { role: 'assistant', content: '', toolCalls: [call] },
    { role: 'tool', toolCallId: 'call_fx1', content: '42', meta: snap(r, m, 'low', 'high') },
    { role: 'user', content: 'Thanks.', meta: snap(r, m, 'low', 'high') },
  ],
  'no-change': (r, m) => [
    SYSTEM,
    { role: 'user', content: 'Hello.', meta: snap(r, m, 'medium', 'medium') },
    { role: 'assistant', content: 'Hi.' },
    { role: 'user', content: 'Again.', meta: snap(r, m, 'medium', 'medium') },
  ],
};

const SUPPORTED = 'claude-sonnet-5-5';
const cases = [];
const add = (id, route, model, history, options = {}, extra = {}) => cases.push({ id, route, model, history, options, ...extra });

for (const route of ['anthropic-oauth', 'anthropic']) {
  const suffix = route === 'anthropic-oauth' ? 'oauth' : 'api';
  for (const name of Object.keys(HISTORIES)) add(`${name}.${suffix}`, route, SUPPORTED, name);
  // Version floors, by family (the table is `ANTHROPIC_MIN_VERSION`).
  for (const model of [
    'claude-opus-4-8', 'claude-opus-5-0', 'claude-opus-5-5',
    'claude-sonnet-5-4', 'claude-sonnet-5-5', 'claude-sonnet-5-5-20260101', 'claude-sonnet-6-0',
    'claude-haiku-5-4', 'claude-haiku-5-5',
    'claude-fable-5-0', 'claude-fable-5-1', 'claude-mythos-5-0', 'claude-mythos-5-1',
    'claude-foo-4-9', 'claude-foo-5-0', 'claude-foo-6-2', 'claude-sonnet-5', 'not-a-claude-model',
  ]) add(`floor.${model}.${suffix}`, route, model, 'update-before-user');
  // The other gate conditions.
  add(`gate.official-url.${suffix}`, route, SUPPORTED, 'update-before-user', { baseURL: OFFICIAL });
  add(`gate.gateway-url.${suffix}`, route, SUPPORTED, 'update-before-user', { baseURL: 'https://gateway.example/v1' });
  add(`gate.manual-budget.${suffix}`, route, SUPPORTED, 'update-before-user', { thinkingBudgetTokens: 4096 });
  add(`gate.disabled.${suffix}`, route, SUPPORTED, 'update-before-user', { effortConfigurationEnabled: false });
  add(`gate.beta-headers-off.${suffix}`, route, SUPPORTED, 'update-before-user', { disableBetaHeaders: true });
}
// No marked message: the session snapshot in the options seeds the update.
// Deferred (tool-search) tools: `defer_loading` on the tool and the tool-search beta, both routes.
for (const route of ['anthropic-oauth', 'anthropic']) {
  const suffix = route === 'anthropic-oauth' ? 'oauth' : 'api';
  add(`deferred-tools.${suffix}`, route, SUPPORTED, 'update-before-user', {}, { deferTools: true });
  add(`deferred-tools.no-updates.${suffix}`, route, 'claude-sonnet-5-4', 'no-change', {}, { deferTools: true });
}
add('seed-from-options.oauth', 'anthropic-oauth', SUPPORTED, 'unmarked', {
  effortConfiguration: 'seed',
});

function historyFor(spec, route, model) {
  if (spec === 'unmarked') {
    return [SYSTEM, { role: 'user', content: 'Hello.' }, { role: 'assistant', content: 'Hi.' }, { role: 'user', content: 'Again.' }];
  }
  return HISTORIES[spec](route, model);
}

export async function recordAnthropicEffort(tree, outFile) {
  const oauth = await importFrom(tree, `${P}/anthropic-oauth.mjs`);
  const api = await importFrom(tree, `${P}/anthropic-api-request.mjs`);
  const config = await importFrom(tree, `${P}/effort-configuration.mjs`);
  const out = [];
  for (const c of cases) {
    const history = historyFor(c.history, c.route, c.model);
    const tools = c.deferTools ? [...TOOLS, { ...DEFERRED_TOOL, deferLoading: true }] : TOOLS;
    c.tools = tools;
    const options = { ...c.options };
    if (options.effortConfiguration === 'seed') options.effortConfiguration = snap(c.route, c.model, 'low', 'high').effortConfiguration;
    // The gate decision itself, independent of what the body builder does next.
    c.options = options;
    const mode = config.effortConfigurationMode(c.route, c.model, options);
    let body;
    let betas;
    try {
      if (c.route === 'anthropic-oauth') {
        body = oauth._buildRequestBodyForCacheSmoke(history, c.model, tools, { effort: 'low', ...options });
        betas = oauth._test.buildOAuthBetaHeaders(body, { toolSearch: body.tools.some((t) => t?.defer_loading === true), model: c.model, opts: { effort: 'low', ...options } }).split(',');
      } else {
        const { disableBetaHeaders, ...opts } = options;
        const built = await api.buildAnthropicApiRequest({
          name: 'anthropic',
          config: { disableBetaHeaders },
          messages: history,
          useModel: c.model,
          tools,
          opts: { effort: 'low', ...opts },
          fastModeLatched: false,
        });
        body = built.params;
        betas = built.betas;
      }
    } catch (error) {
      // A builder refusal is a recorded outcome (the manual budget on an adaptive-only model).
      out.push({ id: c.id, route: c.route, model: c.model, options: c.options, history, mode, error: String(error.message) });
      continue;
    }
    const controls = body.messages.filter((m) => m.role === 'system');
    out.push({
      id: c.id,
      route: c.route,
      model: c.model,
      options: c.options,
      tools,
      history,
      mode,
      expected: {
        body,
        betaHeader: betas.join(','),
        messages: body.messages,
        outputConfig: body.output_config ?? null,
        thinking: body.thinking ?? null,
        betas,
        controlEfforts: controls.map((m) => m.output_config.effort),
        // The mid-conversation mode is on exactly when the beta is sent.
        midConversation: betas.includes('mid-conversation-output-config-2026-07-01'),
      },
    });
  }
  writeJson(outFile, { recorder: 'benchmarks/rust-core/recorders/record-anthropic-effort.mjs', cases: out });
  return out.length;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = parseArgs();
  const tree = resolveTree(args);
  const setDir = join(FIXTURES_ROOT, 'providers');
  const count = await recordAnthropicEffort(tree, join(setDir, 'anthropic-effort', 'cases.json'));
  console.log(`recorded ${count} anthropic effort cases; providers/MANIFEST.json is regenerated by P0-BENCH`);
}
