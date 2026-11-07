#!/usr/bin/env node
// Golden twin of `refreshStatuslineUsageSnapshot(route)` (session-runtime/provider-usage.mjs): which
// routes the route change refreshes the plan-usage reading for. Node's real `createProviderUsage` runs
// with a spy on `fetchOAuthUsageSnapshot` and a registry that holds only the providers a case names;
// a case holds the route and the registered providers, and what the spy was asked.
//
//   node benchmarks/rust-core/recorders/record-statusline-usage.mjs --tree <dir with node_modules> [--out <dir>]
import { join } from 'node:path';
import { FIXTURES_ROOT, importFrom, parseArgs, resolveTree, writeJson, writeSetManifest } from './lib/common.mjs';

const cli = parseArgs();
const tree = resolveTree(cli);
const outDir = cli.get('out') ?? join(FIXTURES_ROOT, 'statusline-usage');
const { createProviderUsage } = await importFrom(tree, 'src/session-runtime/provider-usage.mjs');

const ALL = ['openai-oauth', 'anthropic-oauth', 'grok-oauth', 'cursor-oauth', 'cursor-api', 'openai', 'anthropic', 'gemini', 'my-oauth-custom', 'Open-OAuth', ' openai-oauth '];
const routes = [
  { provider: 'openai-oauth', model: 'gpt-5' },
  { provider: ' anthropic-oauth ', model: ' claude-sonnet ' },
  { provider: 'grok-oauth', model: '' },
  { provider: 'grok-oauth' },
  { provider: 'cursor-oauth', model: 'auto' },
  { provider: 'cursor-api', model: 'auto' },
  { provider: 'openai', model: 'gpt-5' },
  { provider: 'gemini', model: 'g' },
  { provider: 'my-oauth-custom', model: 'm' },
  { provider: 'Open-OAuth', model: 'm' },
  { provider: 'OPENAI-OAUTH', model: 'm' },
  { provider: ' openai-oauth ', model: 'm' },
  { provider: '', model: 'm' },
  { model: 'm' },
  { provider: null, model: 'm' },
  { provider: 5, model: 'm' },
  { provider: 'openai-oauth', model: 7 },
  { provider: 'openai-oauth', model: null },
  { provider: 'openai-oauth', model: ['a', 'b'] },
  { provider: 'openai-oauth', model: { id: 'x' } },
  { provider: 'unregistered-oauth', model: 'm' },
  {},
];

const cases = [];
for (const route of routes) {
  for (const registered of [ALL, []]) {
    const calls = [];
    let asked = [];
    const usage = createProviderUsage({
      caches: {},
      getReg: () => ({ getProvider: (name) => { asked.push(name); return registered.includes(name) ? { name } : null; } }),
      displayConfig: () => ({}),
      providerSetup: async () => ({}),
      createUsageDashboard: async () => ({}),
      fetchOAuthUsageSnapshot: (routeInfo, providerObj, log) => {
        calls.push({ route: JSON.parse(JSON.stringify(routeInfo)), provider: providerObj?.name ?? null, logIsFunction: typeof log === 'function' });
        return Promise.resolve(null);
      },
      consumeOpenAICodexResetCredit: async () => ({}),
      isCloseRequested: () => false,
      getProviderSetupWarmupTimer: () => null,
      scheduleProviderSetupWarmup: () => {},
    });
    const returned = usage.refreshStatuslineUsageSnapshot(route);
    await new Promise((resolve) => setTimeout(resolve, 0));
    cases.push({ route, registered: registered.length > 0, returned: returned === undefined ? 'undefined' : 'value', asked, calls });
  }
}

writeJson(join(outDir, 'golden.json'), { domain: 'statusline-usage', recorder: 'benchmarks/rust-core/recorders/record-statusline-usage.mjs', registered: ALL, cases });
writeSetManifest(outDir, {
  set: 'statusline-usage',
  recorder: 'benchmarks/rust-core/recorders/record-statusline-usage.mjs',
  command: 'node benchmarks/rust-core/recorders/record-statusline-usage.mjs --tree <tree>',
  identityTree: tree,
});
console.log(`recorded ${cases.length} cases, ${cases.filter((c) => c.calls.length).length} refresh`);
for (const c of cases.filter((c) => c.calls.length).slice(0, 12)) console.log(JSON.stringify(c.route), '=>', JSON.stringify(c.calls[0].route));
