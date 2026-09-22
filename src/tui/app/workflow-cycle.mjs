/**
 * workflow-cycle.mjs — Tab at the prompt advances to the next workflow.
 *
 * Holding Tab can generate key-repeat faster than a workflow switch can
 * settle. Without a prompt-local guard every repeat starts (or rejects) an
 * async switch and pushes a toast, producing a rapid bottom-layout repaint
 * storm that can visually tear the prompt box in Windows Terminal.
 *
 * Called from App.jsx's cycleWorkflowFromPrompt useCallback, which owns the
 * guard ref and the surface-busy inputs; this module owns the cycle itself.
 */
import { workflowDisplayName, workflowSwitchNotice } from './app-format.mjs';

const REPEAT_GUARD_MS = 300;

/** Answers true either way: the key stays consumed by the prompt. */
export function cycleWorkflowFromPrompt({ store, state, cycleGuard }) {
  const now = Date.now();
  if (state.commandBusy || cycleGuard.pending || now - cycleGuard.lastAt < REPEAT_GUARD_MS) {
    cycleGuard.lastAt = now;
    return true;
  }
  cycleGuard.lastAt = now;
  cycleGuard.pending = true;
  // listWorkflows is a remote call on a daemon-backed store, so the whole
  // cycle runs off its resolution; the handler still answers `true` at once
  // so the key stays consumed.
  void Promise.resolve(store.listWorkflows?.())
    .then((list) => {
      const workflows = Array.isArray(list) ? list : [];
      if (!workflows.length) {
        store.pushNotice('no workflows available', 'warn');
        return null;
      }
      const workflow = state.workflow || {};
      if (workflows.length < 2) {
        store.pushNotice(`Workflow: ${workflowDisplayName(workflows[0] || workflow)}`, 'info');
        return null;
      }
      const activeIndex = workflows.findIndex((item) => item.active);
      const currentIndex =
        activeIndex >= 0
          ? activeIndex
          : Math.max(
              0,
              workflows.findIndex((item) => item.id === workflow.id)
            );
      const next = workflows[(currentIndex + 1 + workflows.length) % workflows.length];
      return store.setWorkflow?.(next.id);
    })
    .then((result) => {
      if (!result) {
        return;
      }
      store.pushNotice(workflowSwitchNotice(result), 'info', { ttlMs: 1200 });
    })
    .catch((e) => store.pushNotice(`Couldn’t switch workflow: ${e?.message || e}`, 'error'))
    .finally(() => {
      cycleGuard.pending = false;
      cycleGuard.lastAt = Date.now();
    });
  return true;
}
