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
  assert.equal(DEFAULT_MAINTENANCE.scheduler, undefined);
  assert.equal(DEFAULT_MAINTENANCE.webhook.provider, 'anthropic-oauth');
  assert.match(DEFAULT_MAINTENANCE.webhook.model, /haiku/i);

  const config = configWithMain();
  assert.equal(resolveMaintenanceRoute({ agent: 'explorer', config }), 'main');
  assert.equal(resolveMaintenanceRoute({ agent: 'cycle1-agent', config }), 'main');
  assert.equal(resolveAgentSpawnPreset(config, { agent: 'explore' }).preset, main);
  assert.equal(resolveAgentSpawnPreset(config, { agent: 'maintainer' }).preset, main);
  assert.equal(resolveAgentSpawnPreset(config, { agent: 'worker' }).preset, main);
  assert.equal(resolveAgentSpawnPreset(config, { agent: 'custom-agent' }).preset, main);
});

test('agents without an override or configured Main fail instead of using role defaults', () => {
  assert.throws(
    () => resolveAgentSpawnPreset({ presets: [] }, { agent: 'worker' }),
    /no Main model assignment/,
  );
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

test('providerless routes are not overrides and inherit Main', () => {
  const modelOnly = { model: 'model-only' };
  assert.equal(
    resolveMaintenanceRoute({ agent: 'explorer', config: configWithMain({ defaultProvider: 'openai', agents: { explore: modelOnly } }) }),
    'main',
  );
  assert.equal(
    resolveMaintenanceRoute({ agent: 'cycle1-agent', config: configWithMain({ defaultProvider: 'gemini', agents: { maintenance: modelOnly } }) }),
    'main',
  );
  assert.equal(
    resolveMaintenanceRoute({ agent: 'explorer', config: configWithMain({ defaultProvider: 'xai', workflowRoutes: { explorer: modelOnly } }) }),
    'main',
  );
  assert.equal(
    resolveMaintenanceRoute({ agent: 'cycle2-agent', config: configWithMain({ maintenance: { ...DEFAULT_MAINTENANCE, memory: modelOnly } }) }),
    'main',
  );
  assert.equal(
    resolveAgentSpawnPreset(configWithMain({ agents: { explore: modelOnly } }), { agent: 'explore' }).preset,
    main,
  );
});

test('loadConfig migrates fragmented Explore and Maintainer routes into canonical agents', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-maintenance-config-'));
  writeFileSync(join(dataDir, 'mixdog-config.json'), JSON.stringify({
    agent: {
      maintenance: {
        explore: { model: 'gpt-test' },
        memory: { model: 'gpt-maintainer-test' },
      },
      workflowRoutes: {
        explorer: { provider: 'openai', model: 'ignored-explorer' },
        memory: { provider: 'openai', model: 'ignored-memory' },
      },
      agents: {
        explore: { provider: 'grok-oauth', model: 'grok-4.5' },
        maintenance: { provider: 'openai', model: 'gpt-maintainer-canonical' },
      },
      searchRoute: { model: 'providerless-search' },
      presets: [
        { id: 'workflow-agent-explore', name: 'WORKFLOW AGENT-EXPLORE', type: 'agent', provider: 'openai', model: 'ignored', tools: 'full' },
        { id: 'keep-me', name: 'KEEP ME', type: 'agent', provider: 'openai', model: 'kept', tools: 'full' },
      ],
    },
  }));
  const runner = [
    "import { loadConfig } from './src/runtime/agent/orchestrator/config.mjs';",
    "const config = loadConfig({ secrets: false });",
    "console.log(JSON.stringify({ defaultProvider: config.defaultProvider, agents: config.agents, maintenance: config.maintenance, workflowRoutes: config.workflowRoutes, presets: config.presets, searchRoute: config.searchRoute }));",
  ].join(' ');
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', runner], {
    cwd: process.cwd(),
    env: { ...process.env, MIXDOG_DATA_DIR: dataDir },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  const migrated = JSON.parse(result.stdout);
  assert.deepEqual(migrated.agents.explore, { provider: 'grok-oauth', model: 'grok-4.5' });
  assert.deepEqual(migrated.agents.maintainer, { provider: 'openai', model: 'gpt-maintainer-canonical' });
  assert.equal(migrated.agents.maintenance, undefined);
  assert.equal(migrated.maintenance.explore, undefined);
  assert.equal(migrated.maintenance.memory, undefined);
  assert.equal(migrated.workflowRoutes, undefined);
  assert.deepEqual(migrated.presets.map((preset) => preset.id), ['keep-me']);
  assert.equal(migrated.defaultProvider, undefined);
  assert.equal(migrated.presets[0].provider, 'openai');
  assert.deepEqual(migrated.searchRoute, { provider: 'default', model: 'default' });
});

test('config maintenance migration has no standalone provider runtime dependency', () => {
  const source = readFileSync(new URL('../src/runtime/agent/orchestrator/config.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /standalone\/provider-admin/);
  assert.doesNotMatch(source, /DEFAULT_AGENT_PROVIDER|CONFIG_PROVIDER_IDS/);
});
