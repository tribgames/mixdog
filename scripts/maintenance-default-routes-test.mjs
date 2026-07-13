import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DEFAULT_MAINTENANCE } from '../src/runtime/agent/orchestrator/config.mjs';
import { resolveMaintenanceRoute } from '../src/runtime/agent/orchestrator/agent-runtime/agent-dispatch.mjs';
import { resolveAgentSpawnPreset } from '../src/standalone/agent-tool.mjs';
import { exploreResultCacheKey, resolveExploreRoute } from '../src/standalone/explore-tool.mjs';

const main = { id: 'main', name: 'MAIN', type: 'agent', provider: 'main-provider', model: 'main-model', tools: 'full' };
const configWithMain = (overrides = {}) => ({
  default: 'main',
  presets: [main],
  maintenance: { ...DEFAULT_MAINTENANCE },
  ...overrides,
});
const normalizedRoute = (route, provider = route.provider || 'anthropic-oauth') => ({
  provider,
  model: route.model,
  effort: undefined,
  fast: false,
});

test('empty Explore and Maintainer routes inherit Main in hidden and public dispatch', () => {
  assert.equal(DEFAULT_MAINTENANCE.explore, undefined);
  assert.equal(DEFAULT_MAINTENANCE.memory, undefined);
  assert.deepEqual(DEFAULT_MAINTENANCE.scheduler, DEFAULT_MAINTENANCE.webhook);
  assert.equal(DEFAULT_MAINTENANCE.scheduler.provider, 'anthropic-oauth');
  assert.match(DEFAULT_MAINTENANCE.scheduler.model, /haiku/i);

  const config = configWithMain();
  assert.equal(resolveMaintenanceRoute({ agent: 'explorer', config }), 'main');
  assert.equal(resolveMaintenanceRoute({ agent: 'cycle1-agent', config }), 'main');
  assert.equal(resolveMaintenanceRoute({ agent: 'scheduler-task', config }), DEFAULT_MAINTENANCE.scheduler);
  assert.equal(resolveAgentSpawnPreset(config, { agent: 'explore' }).preset, main);
  assert.equal(resolveAgentSpawnPreset(config, { agent: 'maintainer' }).preset, main);
});

test('public agent, workflow, and maintenance routes override Main inheritance', () => {
  const exploreAgent = { provider: 'agent-provider', model: 'agent-model' };
  const maintainerWorkflow = { provider: 'workflow-provider', model: 'workflow-model' };
  const exploreMaintenance = { provider: 'maintenance-provider', model: 'maintenance-model' };
  assert.deepEqual(
    resolveAgentSpawnPreset(configWithMain({ agents: { explore: exploreAgent } }), { agent: 'explore' }).preset,
    { id: 'agent-explore', name: 'AGENT EXPLORE', type: 'agent', ...exploreAgent, effort: undefined, fast: false, tools: 'full' },
  );
  assert.deepEqual(
    resolveAgentSpawnPreset(configWithMain({
      workflowRoutes: { memory: maintainerWorkflow },
      maintenance: { ...DEFAULT_MAINTENANCE, memory: { provider: 'ignored-provider', model: 'ignored-model' } },
    }), { agent: 'maintainer' }).preset,
    { id: 'agent-maintainer', name: 'AGENT MAINTAINER', type: 'agent', ...maintainerWorkflow, effort: undefined, fast: false, tools: 'full' },
  );
  const config = configWithMain({
    maintenance: {
      ...DEFAULT_MAINTENANCE,
      explore: exploreMaintenance,
    },
  });
  assert.deepEqual(resolveMaintenanceRoute({ agent: 'explorer', config }), normalizedRoute(exploreMaintenance));
  assert.deepEqual(
    resolveAgentSpawnPreset(config, { agent: 'explore' }).preset,
    { id: 'agent-explore', name: 'AGENT EXPLORE', type: 'agent', ...exploreMaintenance, effort: undefined, fast: false, tools: 'full' },
  );
});

test('hidden Explore and Maintainer routes use public precedence, including the legacy maintainer alias', () => {
  const agentRoute = { provider: 'agent-provider', model: 'agent-model' };
  const workflowRoute = { provider: 'workflow-provider', model: 'workflow-model' };
  const maintenanceRoute = { provider: 'maintenance-provider', model: 'maintenance-model' };
  assert.deepEqual(resolveMaintenanceRoute({
    agent: 'explorer',
    config: configWithMain({
      agents: { explore: agentRoute },
      workflowRoutes: { explorer: workflowRoute },
      maintenance: { ...DEFAULT_MAINTENANCE, explore: maintenanceRoute },
    }),
  }), normalizedRoute(agentRoute));
  assert.deepEqual(resolveMaintenanceRoute({
    agent: 'cycle1-agent',
    config: configWithMain({
      workflowRoutes: { memory: workflowRoute },
      maintenance: { ...DEFAULT_MAINTENANCE, memory: maintenanceRoute },
    }),
  }), normalizedRoute(workflowRoute));
  assert.deepEqual(resolveMaintenanceRoute({
    agent: 'cycle2-agent',
    config: configWithMain({
      maintenance: { ...DEFAULT_MAINTENANCE, memory: maintenanceRoute },
    }),
  }), normalizedRoute(maintenanceRoute));
  assert.deepEqual(resolveMaintenanceRoute({
    agent: 'cycle3-agent',
    config: configWithMain({ agents: { maintenance: agentRoute } }),
  }), normalizedRoute(agentRoute));
});

test('Explore cache identity follows the effective route when Main changes', () => {
  const first = configWithMain();
  const secondMain = { ...main, model: 'replacement-main-model' };
  const second = configWithMain({ presets: [secondMain] });
  const query = 'locate the route';
  const cwd = '/tmp/project';
  assert.deepEqual(resolveExploreRoute(first), main);
  assert.deepEqual(resolveExploreRoute(second), secondMain);
  assert.notEqual(
    exploreResultCacheKey({ cwd, route: resolveExploreRoute(first), query }),
    exploreResultCacheKey({ cwd, route: resolveExploreRoute(second), query }),
  );
});

test('hidden precedence normalizes model-only routes with the public provider fallback', () => {
  const modelOnly = { model: 'model-only' };
  assert.deepEqual(
    resolveMaintenanceRoute({ agent: 'explorer', config: configWithMain({ defaultProvider: 'openai', agents: { explore: modelOnly } }) }),
    normalizedRoute(modelOnly, 'openai'),
  );
  assert.deepEqual(
    resolveMaintenanceRoute({ agent: 'cycle1-agent', config: configWithMain({ defaultProvider: 'gemini', agents: { maintenance: modelOnly } }) }),
    normalizedRoute(modelOnly, 'gemini'),
  );
  assert.deepEqual(
    resolveMaintenanceRoute({ agent: 'explorer', config: configWithMain({ defaultProvider: 'xai', workflowRoutes: { explorer: modelOnly } }) }),
    normalizedRoute(modelOnly, 'xai'),
  );
  assert.deepEqual(
    resolveMaintenanceRoute({ agent: 'cycle2-agent', config: configWithMain({ maintenance: { ...DEFAULT_MAINTENANCE, memory: modelOnly } }) }),
    normalizedRoute(modelOnly),
  );
});

test('loadConfig preserves persisted model-only Explore and Maintainer routes with the configured provider', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-maintenance-config-'));
  writeFileSync(join(dataDir, 'mixdog-config.json'), JSON.stringify({
    agent: {
      defaultProvider: 'openai',
      maintenance: {
        explore: { model: 'gpt-test' },
        memory: { model: 'gpt-maintainer-test' },
      },
    },
  }));
  const runner = [
    "import { loadConfig } from './src/runtime/agent/orchestrator/config.mjs';",
    "console.log(JSON.stringify(loadConfig({ secrets: false }).maintenance));",
  ].join(' ');
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', runner], {
    cwd: process.cwd(),
    env: { ...process.env, MIXDOG_DATA_DIR: dataDir },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  const maintenance = JSON.parse(result.stdout);
  assert.deepEqual(maintenance.explore, { provider: 'openai', model: 'gpt-test' });
  assert.deepEqual(maintenance.memory, { provider: 'openai', model: 'gpt-maintainer-test' });
});

test('config maintenance migration has no standalone provider runtime dependency', () => {
  const source = readFileSync(new URL('../src/runtime/agent/orchestrator/config.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /standalone\/provider-admin/);
  assert.match(source, /CONFIG_PROVIDER_IDS/);
});
