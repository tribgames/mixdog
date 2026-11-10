// An agent's own context choice (config.agents.<id>.contextPercent/contextTokens)
// must size the session it spawns: spawn plan → child runtime route → session
// context meta, with no provider window known to the route layer (a model the
// provider roster cache does not list, the child runtime's bare-id metadata).
import assert from 'node:assert/strict';
import test from 'node:test';

import { createSpawnPreparer } from './spawn-flow/spawn-prep.mjs';
import { resolveAgentSpawnPreset } from './spawn-preset.mjs';
import { createRouteResolution } from '../../route-resolution.mjs';
import { resolveInitialConfigState } from '../../config-lifecycle.mjs';
import { makeResolveRoute } from '../../../runtime/agent/orchestrator/runtime-core/config-helpers.mjs';
import { resolveSessionContextMeta } from '../../../runtime/agent/orchestrator/session/manager/context-meta.mjs';

const PROVIDER = 'acme-test';
const MODEL = 'acme-test-1m';
const SERVED = 1_000_000;
const provider = { name: PROVIDER, getCachedModelInfo: () => ({ contextWindow: SERVED }) };

async function spawnedSessionContext(agentRoute) {
  const config = { default: 'none', presets: [], agents: { big: { provider: PROVIDER, model: MODEL, ...agentRoute } } };
  const { preset } = resolveAgentSpawnPreset(config, { agent: 'big' });
  const created = [];
  const sessionSurface = {
    canonical: true,
    createChild: async (child) => {
      created.push(child);
      return { session: {} };
    },
  };
  await createSpawnPreparer({ cfgMod: {}, ensureProvider: async () => {}, sessionSurface }).createSpawnedSession(
    { config, preset, prompt: 'x', tag: 't' },
    { preset },
    null
  );
  const { contextPercent, contextTokens, selectedContextWindow } = created[0].spec;
  // The child runtime boots from the spec, then resolves its route against provider metadata.
  const { route } = resolveInitialConfigState({
    initialConfig: config,
    resolveRoute: makeResolveRoute(() => PROVIDER),
    provider: PROVIDER,
    model: MODEL,
    contextPercent,
    contextTokens,
    selectedContextWindow,
  });
  const rt = { config, route };
  await createRouteResolution({
    rt,
    collectProviderModels: async () => [],
    ensureProvidersReady: async () => {},
    lookupModelMeta: async () => ({ id: MODEL, provider: PROVIDER }),
  }).refreshRouteEffort();
  return resolveSessionContextMeta(provider, MODEL, {
    selectedContextWindow: rt.route.selectedContextWindow,
    contextPercent: rt.route.contextPercent,
    contextTokens: rt.route.contextTokens,
  });
}

test('an agent set to the whole 1M window spawns a session with a 1M window and compaction boundary', async () => {
  const meta = await spawnedSessionContext({ contextPercent: 100 });
  assert.equal(meta.contextWindow, SERVED);
  assert.equal(meta.compactBoundaryTokens, SERVED);
});

test('an agent set to an exact 1M window spawns a session with a 1M window and compaction boundary', async () => {
  const meta = await spawnedSessionContext({ contextTokens: SERVED });
  assert.equal(meta.contextWindow, SERVED);
  assert.equal(meta.compactBoundaryTokens, SERVED);
});

test('an agent with no context choice keeps the model default window', async () => {
  const meta = await spawnedSessionContext({});
  assert.equal(meta.contextWindow, 500_000);
});

// Main's saved share for a model (modelSettings) belongs to the Main route
// alone; an agent on the same model without a choice of its own gets the default.
async function bootContext({ agentOwned }) {
  const config = { default: 'none', presets: [], modelSettings: { [`${PROVIDER}/${MODEL}`]: { contextPercent: 30 } } };
  const { route } = resolveInitialConfigState({
    initialConfig: config,
    resolveRoute: makeResolveRoute(() => PROVIDER),
    provider: PROVIDER,
    model: MODEL,
    agentOwned,
  });
  const rt = { config, route };
  await createRouteResolution({
    rt,
    collectProviderModels: async () => [],
    ensureProvidersReady: async () => {},
    lookupModelMeta: async () => ({ id: MODEL, provider: PROVIDER }),
  }).refreshRouteEffort();
  return {
    percent: rt.route.contextPercent,
    meta: resolveSessionContextMeta(provider, MODEL, {
      selectedContextWindow: rt.route.selectedContextWindow,
      contextPercent: rt.route.contextPercent,
      contextTokens: rt.route.contextTokens,
    }),
  };
}

test("an agent without its own context choice does not inherit Main's saved share for the model", async () => {
  const agent = await bootContext({ agentOwned: true });
  assert.equal(agent.percent, undefined);
  assert.equal(agent.meta.contextWindow, 500_000);
});

test('the Main route keeps its own saved share for the model', async () => {
  const main = await bootContext({ agentOwned: false });
  assert.equal(main.percent, 30);
});
