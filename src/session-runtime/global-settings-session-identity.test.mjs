import assert from 'node:assert/strict';
import test from 'node:test';

import { createSessionTurnApi } from './session-turn-api.mjs';
import { createWorkflowAgentsApi } from './workflow-agents-api.mjs';

test('output-style changes never replace a materialized session', async () => {
  let config = {};
  let lifecycleCalls = 0;
  const style = { id: 'default', label: 'Default' };
  const api = createWorkflowAgentsApi({
    getConfig: () => config,
    getSession: () => ({ id: 'sess_daemon_control', messages: [] }),
    adoptConfig: (next) => { config = next; },
    getOutputStyleStatusCached: () => ({
      configured: 'default',
      current: style,
      styles: [style],
    }),
    seedOutputStyleStatusCache: () => {},
    scheduleOutputStyleSave: () => {},
    invalidateContextStatusCache: () => {},
    mgr: { closeSession: () => { lifecycleCalls += 1; } },
    recreateCurrentSessionIfReady: async () => { lifecycleCalls += 1; },
  });

  const result = await api.setOutputStyle('default');
  assert.equal(config.outputStyle, 'default');
  assert.equal(result.appliedToCurrentSession, false);
  assert.equal(lifecycleCalls, 0);
});

test('onboarding route completion updates configuration without replacing a session', async () => {
  let config = {};
  let route = {};
  let lifecycleCalls = 0;
  const api = createWorkflowAgentsApi({
    getConfig: () => config,
    getRoute: () => route,
    setRouteState: (next) => { route = next; },
    getSession: () => ({ id: 'sess_daemon_control', messages: [] }),
    saveConfigAndAdopt: (next) => { config = next; },
    resolveRoute: (_config, next) => next,
    invalidatePreSessionToolSurface: () => {},
    mgr: { closeSession: () => { lifecycleCalls += 1; } },
    recreateCurrentSessionIfReady: async () => { lifecycleCalls += 1; },
  });
  api.getOnboardingStatus = () => ({ completed: true });

  const result = await api.completeOnboarding({
    defaultRoute: { provider: 'test-provider', model: 'test-model' },
  });
  assert.equal(result.completed, true);
  assert.equal(route.provider, 'test-provider');
  assert.equal(route.model, 'test-model');
  assert.equal(lifecycleCalls, 0);
});

test('tool-mode changes refresh an empty session in place', async () => {
  let mode = 'full';
  let refreshes = 0;
  let lifecycleCalls = 0;
  const api = createSessionTurnApi({
    getSession: () => ({ id: 'sess_daemon_control', messages: [] }),
    setMode: (next) => { mode = next; },
    refreshEmptySessionToolPolicy: async () => { refreshes += 1; },
    invalidatePreSessionToolSurface: () => {},
    mgr: { closeSession: () => { lifecycleCalls += 1; } },
    recreateCurrentSessionIfReady: async () => { lifecycleCalls += 1; },
  });

  assert.equal(await api.setToolMode('readonly'), 'readonly');
  assert.equal(mode, 'readonly');
  assert.equal(refreshes, 1);
  assert.equal(lifecycleCalls, 0);
});
