import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorkflowAgentsApi } from './workflow-agents-api.mjs';

// The runtime Main route is what a conditional backfill (setRoute onlyIfEmpty)
// checks: onboarding must move it whenever it writes the Lead route.
function onboardingApi(initialRoute) {
  const state = { config: {}, route: initialRoute };
  const api = createWorkflowAgentsApi({
    getConfig: () => state.config,
    getRoute: () => state.route,
    setRouteState: (next) => {
      state.route = next;
    },
    getSession: () => ({ id: 'sess_daemon_control', messages: [] }),
    saveConfigAndAdopt: (next) => {
      state.config = next;
    },
    resolveRoute: (_config, next) => next,
    invalidatePreSessionToolSurface: () => {},
  });
  api.getOnboardingStatus = () => ({ completed: true });
  return { api, state };
}

const LEAD = { provider: 'test-provider', model: 'test-lead' };

test('a Lead route written through workflowRoutes.lead alone also moves the runtime Main route', async () => {
  const { api, state } = onboardingApi({ provider: '', model: '' });
  await api.completeOnboarding({ workflowRoutes: { lead: LEAD } });
  assert.equal(state.config.presets.find((preset) => preset.id === 'workflow-lead').model, 'test-lead');
  assert.equal(state.config.default, 'workflow-lead');
  assert.equal(state.route.model, 'test-lead');
});

test('workflowRoutes.lead wins over defaultRoute for the runtime Main route, as it does in config', async () => {
  const { api, state } = onboardingApi({ provider: '', model: '' });
  await api.completeOnboarding({
    defaultRoute: { provider: 'test-provider', model: 'test-default' },
    workflowRoutes: { lead: LEAD },
  });
  assert.equal(state.config.presets.find((preset) => preset.id === 'workflow-lead').model, 'test-lead');
  assert.equal(state.route.model, 'test-lead');
});

test('an onboarding save that writes no Lead route leaves the runtime route alone', async () => {
  const { api, state } = onboardingApi({ provider: '', model: '' });
  await api.completeOnboarding({ workflowRoutes: { agent: LEAD } });
  assert.equal(state.route.model, '');
  assert.equal(state.config.default, undefined);
});
