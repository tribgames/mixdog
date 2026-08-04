import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRoutePickers } from '../src/tui/app/route-pickers.mjs';

function createHarness() {
  let picker = null;
  const modelPickers = [];
  const workflowCalls = [];
  const agentRouteCalls = [];
  const notices = [];
  const store = {
    listAgents: () => [{
      id: 'reviewer',
      label: 'Reviewer',
      description: 'Reviews changes.',
      route: { provider: 'example', model: 'review-model' },
    }],
    listWorkflows: () => [
      { id: 'solo', name: 'Solo', active: true, description: 'Lead only.' },
      { id: 'squad', name: 'Squad', active: false, description: 'Uses agents.' },
    ],
    setWorkflow: async (id) => {
      workflowCalls.push(id);
      return { id, name: id === 'squad' ? 'Squad' : 'Solo' };
    },
    setAgentRoute: async (id, route) => {
      agentRouteCalls.push({ id, route });
      return route;
    },
    pushNotice: (message, tone) => notices.push({ message, tone }),
  };
  const pickers = createRoutePickers({
    store,
    state: {},
    setPicker: (value) => { picker = value; },
    setProviderPrompt: () => {},
    setChannelPrompt: () => {},
    setHookPrompt: () => {},
    setSettingsPrompt: () => {},
    setContextPanel: () => {},
    closeUsagePanel: () => {},
    clean: (value) => String(value || '').trim(),
    routeLabel: (route) => `${route.provider}/${route.model}`,
    agentModelParts: (route) => [route?.provider, route?.model].filter(Boolean),
    agentModelProfile: (route) => `${route.provider}/${route.model}`,
    workflowSwitchNotice: (workflow) => `Workflow set to ${workflow.name}`,
    openModelPicker: (options) => { modelPickers.push(options); },
  });
  return {
    pickers,
    modelPickers,
    workflowCalls,
    agentRouteCalls,
    notices,
    currentPicker: () => picker,
  };
}

test('/agents keeps model selection in the dedicated agent picker', async () => {
  const harness = createHarness();
  harness.pickers.openAgentsPicker();
  const agentsPicker = harness.currentPicker();

  assert.equal(agentsPicker.title, 'Agents');
  assert.match(agentsPicker.help, /Enter Set Model/);
  agentsPicker.onSelect('reviewer', agentsPicker.items[0]);

  assert.equal(harness.modelPickers.length, 1);
  assert.equal(harness.modelPickers[0].title, 'Reviewer Model');
  const route = { provider: 'example', model: 'next-review-model' };
  await harness.modelPickers[0].onSelectRoute(route);
  assert.deepEqual(harness.agentRouteCalls, [{ id: 'reviewer', route }]);
});

test('/workflow selection immediately activates the highlighted workflow', async () => {
  const harness = createHarness();
  harness.pickers.openWorkflowPicker();
  const workflowPicker = harness.currentPicker();

  assert.equal(workflowPicker.description, 'Select active workflow.');
  assert.match(workflowPicker.help, /Enter Choose/);
  workflowPicker.onSelect('squad', workflowPicker.items[1]);
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(harness.workflowCalls, ['squad']);
  assert.equal(harness.modelPickers.length, 0);
  assert.equal(harness.currentPicker(), null);
  assert.deepEqual(harness.notices.at(-1), {
    message: 'Workflow set to Squad',
    tone: 'info',
  });
});
