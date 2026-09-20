// route-pickers/workflow-picker.mjs
// The Workflow list: Enter switches the active workflow and hands the surface
// back to the caller once the switch acks.
import { theme } from '../../theme.mjs';

export function createWorkflowPicker({
  store,
  surface,
  setProviderPrompt,
  setSettingsPrompt,
  closeUsagePanel,
  workflowSwitchNotice,
}) {
  const openWorkflowPicker = async (options = {}) => {
    const returnTo = typeof options.returnTo === 'function' ? options.returnTo : null;
    const handoffPanel = options.handoffPanel && typeof options.handoffPanel === 'object' ? options.handoffPanel : null;
    const own = surface.claim();
    let workflows = [];
    try {
      workflows = (await store.listWorkflows?.()) || [];
    } catch (e) {
      store.pushNotice(`could not list workflows: ${e?.message || e}`, 'error');
      return;
    }
    if (!workflows.length) {
      store.pushNotice('no workflows available', 'warn');
      return;
    }
    const items = workflows.map((workflow) => ({
      value: workflow.id,
      label: workflow.name,
      marker: workflow.active ? '✓' : '',
      markerColor: theme.success,
      description: workflow.description || `${workflow.source || 'workflow'} workflow`,
      _workflow: workflow,
    }));
    if (!own.owns()) return;
    setProviderPrompt(null);
    setSettingsPrompt(null);
    own.context(null);
    closeUsagePanel();
    own.paint({
      title: 'Workflow',
      description: 'Select active workflow.',
      help: returnTo ? '↑/↓ Select · Enter Choose · Esc Settings' : '↑/↓ Select · Enter Choose · Esc Back',
      labelWidth: 18,
      items,
      onSelect: (_value, item) => {
        const workflow = item?._workflow;
        if (!workflow) return;
        // Clear-and-continue: the flow keeps the surface it just emptied, so
        // the post-ack hop below is bound to THIS keypress. An Esc before the
        // switch acks cancels the hop instead of re-opening Settings.
        own.paint(handoffPanel);
        const returnAfterSwitch = own.defer(() => {
          if (returnTo) returnTo();
        });
        void store
          .setWorkflow?.(workflow.id)
          .then((result) => {
            if (!result) {
              store.pushNotice('Workflow switch is already running.', 'warn');
              if (handoffPanel) returnAfterSwitch();
              return;
            }
            store.pushNotice(workflowSwitchNotice(result), 'info');
            returnAfterSwitch();
          })
          .catch((e) => {
            store.pushNotice(`Couldn’t switch workflow: ${e?.message || e}`, 'error');
            if (handoffPanel) returnAfterSwitch();
          });
      },
      onCancel: () => {
        if (handoffPanel) own.paint(handoffPanel);
        else own.close();
        if (returnTo) returnTo();
      },
    });
  };

  return { openWorkflowPicker };
}
