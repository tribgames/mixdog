import assert from 'node:assert/strict';
import test from 'node:test';
import { createPanelSurface } from '../panel-surface.mjs';
import { createWorkflowPicker } from './workflow-picker.mjs';

test('Workflow help returns to Back standalone and Settings when a caller is provided', async () => {
  const noop = () => {};
  const cases = [
    [{}, '↑/↓ Select · Enter Choose · Esc Back'],
    [{ returnTo: noop }, '↑/↓ Select · Enter Choose · Esc Settings'],
  ];
  for (const [options, help] of cases) {
    let panel;
    const { openWorkflowPicker } = createWorkflowPicker({
      store: { listWorkflows: async () => [{ id: 'solo', name: 'Solo' }] },
      surface: createPanelSurface({
        setPicker: (next) => {
          panel = next;
        },
      }),
      setProviderPrompt: noop,
      setSettingsPrompt: noop,
      closeUsagePanel: noop,
      workflowSwitchNotice: noop,
    });
    await openWorkflowPicker(options);
    assert.equal(panel.help, help);
  }
});
