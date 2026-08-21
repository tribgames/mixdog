// "Not used" is a first-class agent state: the role must disappear from the
// Lead surface, refuse maintenance dispatch, and keep its stored model so
// switching it back on restores the user's pick. Web Search is the only route
// that still means "follow the Main Model" when left unset.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  canonicalizeAgentRouteStorage,
  disabledAgentIds,
  isAgentDisabled,
  withAgentDisabled,
} from '../runtime/shared/agent-route-config.mjs';
import {
  createWorkflowHelpers,
  isDefaultWebSearchRouteConfig,
  isWebSearchCapableProvider,
  normalizeWebSearchProviderId,
  normalizeWebSearchRouteConfig,
} from './workflow.mjs';
import { createNativeWebSearch } from './native-web-search.mjs';
import { resolveMaintenanceRoute } from '../runtime/agent/orchestrator/agent-runtime/maintenance-route.mjs';

function fixture(agentIds = ['worker', 'reviewer']) {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-agent-off-'));
  const data = join(root, 'data');
  mkdirSync(join(root, 'workflows', 'default'), { recursive: true });
  writeFileSync(join(root, 'workflows', 'default', 'WORKFLOW.md'), '# Default\n\nLead delegates.\n');
  for (const id of agentIds) {
    mkdirSync(join(root, 'agents', id), { recursive: true });
    writeFileSync(join(root, 'agents', id, 'AGENT.md'), `# ${id}\n\nDoes ${id} work.\n`);
  }
  mkdirSync(data, { recursive: true });
  const helpers = createWorkflowHelpers({
    rootDir: root,
    dataDir: data,
    readMarkdownDocument: (text) => ({ body: String(text || ''), frontmatter: {} }),
    normalizeAgentPermissionOrNone: () => null,
  });
  return { root, data, helpers };
}

test('disabled agents are stored apart from the route and survive canonicalization', () => {
  const config = { agents: { worker: { provider: 'anthropic-oauth', model: 'claude-opus-5' } } };
  const off = canonicalizeAgentRouteStorage(withAgentDisabled(config, 'worker', true));
  assert.deepEqual(disabledAgentIds(off), ['worker']);
  assert.equal(isAgentDisabled(off, 'worker'), true);
  // The pinned model is retained, so turning the agent back on restores it.
  assert.deepEqual(off.agents.worker, { provider: 'anthropic-oauth', model: 'claude-opus-5' });

  const on = canonicalizeAgentRouteStorage(withAgentDisabled(off, 'worker', false));
  assert.equal(isAgentDisabled(on, 'worker'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(on, 'disabledAgents'), false);
});

test('a disabled agent leaves the Lead prompt and the delegation surface', () => {
  const { data, helpers } = fixture(['worker', 'reviewer']);
  // The shipped fallback is Solo, so a delegating pack is selected explicitly.
  const cowork = (extra = {}) => ({ workflow: { active: 'default' }, ...extra });
  const enabled = helpers.activeWorkflowContext(cowork(), data);
  assert.match(enabled.context, /# Available Agents/);
  assert.match(enabled.context, /\(worker\)/);
  assert.equal(enabled.summary.delegatesAgents, true);

  const partial = helpers.activeWorkflowContext(cowork({ disabledAgents: ['worker'] }), data);
  assert.equal(partial.context.includes('(worker)'), false);
  assert.match(partial.context, /\(reviewer\)/);
  assert.equal(partial.summary.delegatesAgents, true);

  // Nobody left to delegate to: the agent tool drops exactly as it does for a
  // non-delegating pack.
  const none = helpers.activeWorkflowContext(cowork({ disabledAgents: ['worker', 'reviewer'] }), data);
  assert.equal(none.context.includes('# Available Agents'), false);
  assert.equal(none.summary.delegatesAgents, false);
  assert.deepEqual(helpers.delegatableAgentIds({ disabledAgents: ['worker'] }, data), ['reviewer']);
});

test('a disabled maintainer stops maintenance dispatch instead of falling back to Main', () => {
  const base = {
    default: { provider: 'anthropic-oauth', model: 'claude-opus-5' },
    agents: { maintainer: { provider: 'gemini', model: 'gemini-3-pro' } },
  };
  assert.deepEqual(
    resolveMaintenanceRoute({ agent: 'title-agent', config: base }),
    { provider: 'gemini', model: 'gemini-3-pro', effort: undefined, fast: false },
  );
  assert.equal(
    resolveMaintenanceRoute({ agent: 'title-agent', config: withAgentDisabled(base, 'maintainer', true) }),
    null,
  );
});

test('an unset web-search route resolves to the Main Model instead of failing', async () => {
  const route = { provider: 'anthropic-oauth', model: 'claude-opus-5', effort: 'xhigh' };
  let stored = null;
  const { nativeWebSearchRoutes } = createNativeWebSearch({
    getRoute: () => route,
    getWebSearchRoute: () => stored,
    setWebSearchRoute: (next) => { stored = next; },
    getConfig: () => ({}),
    getSession: () => null,
    getReg: () => ({}),
    ensureFullConfig: () => ({}),
    awaitKeychainPrewarm: async () => {},
    ensureProvidersReady: async () => {},
    ensureProviderEnabled: (config) => config,
    normalizeWebSearchProviderId,
    normalizeWebSearchRouteConfig,
    isDefaultWebSearchRouteConfig,
    isWebSearchCapableProvider,
    webSearchCapableFor: () => true,
  });

  const candidates = await nativeWebSearchRoutes();
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].source, 'default-web-search-route');
  assert.equal(candidates[0].provider, 'anthropic-oauth');
  assert.equal(candidates[0].model, 'claude-opus-5');
  assert.equal(isDefaultWebSearchRouteConfig(stored), true);
});
