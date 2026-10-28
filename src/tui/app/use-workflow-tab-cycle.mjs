/*
 * app/use-workflow-tab-cycle.mjs — Tab-to-cycle-workflow handler for the prompt.
 */
import { useCallback, useRef } from 'react';
import { cycleWorkflowFromPrompt as cycleWorkflow } from './workflow-cycle.mjs';

export function useWorkflowTabCycle({
  store,
  state,
  slashPaletteOpen,
  toolApproval,
  picker,
  settingsPrompt,
  providerPrompt,
  contextPanel,
  usagePanel,
}) {
  // Holding Tab can generate key-repeat faster than a workflow switch can
  // settle. Without a prompt-local guard every repeat starts (or rejects) an
  // async switch and pushes a toast, producing a rapid bottom-layout repaint
  // storm that can visually tear the prompt box in Windows Terminal.
  const workflowTabCycleRef = useRef({ pending: false, lastAt: 0 });
  // The cycle reads only these two state fields.
  const { commandBusy, workflow } = state;
  return useCallback(() => {
    if (slashPaletteOpen || toolApproval || picker || settingsPrompt || providerPrompt || contextPanel || usagePanel)
      return true;
    return cycleWorkflow({ store, state: { commandBusy, workflow }, cycleGuard: workflowTabCycleRef.current });
  }, [
    slashPaletteOpen,
    toolApproval,
    picker,
    settingsPrompt,
    providerPrompt,
    contextPanel,
    usagePanel,
    commandBusy,
    workflow,
    store,
  ]);
}
