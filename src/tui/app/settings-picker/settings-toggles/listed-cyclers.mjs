// settings-picker/settings-toggles/listed-cyclers.mjs
// The two Settings rows whose ←/→ has to LIST before it can write (output
// style, workflow). Both capture the deferred refresh on the keypress, before
// the preflight await, so the refresh belongs to that keypress and not to the
// surface the user moved to while the list was in flight.
import { outputStyleNotice } from '../../route-pickers.mjs';
import { cycled } from './cycled.mjs';

export function createListedCyclers({ store, view, workflowSwitchNotice, deferredSettingsRefresh }) {
  const cycleOutputStyle = async (direction = 1) => {
    // Epoch captured on the KEYPRESS, BEFORE the listOutputStyles preflight:
    // taking it after that await would bind to whatever surface the user
    // moved to meanwhile, and the refresh would re-open Settings over it.
    const settled = deferredSettingsRefresh();
    let status = null;
    try {
      status = (await store.listOutputStyles?.()) || null;
    } catch (e) {
      store.pushNotice(`could not list output styles: ${e?.message || e}`, 'error');
      return;
    }
    const styles = Array.isArray(status?.styles) ? status.styles : [];
    if (!styles.length) {
      store.pushNotice('no output styles available', 'warn');
      return;
    }
    const currentId = status?.current?.id || 'default';
    const next = cycled(
      styles,
      styles.findIndex((style) => style.id === currentId),
      direction
    );
    void store
      .setOutputStyle?.(next.id)
      .then((result) => {
        if (!result) {
          store.pushNotice('Output style switch is already running.', 'warn');
          return;
        }
        store.pushNotice(outputStyleNotice(result), 'info');
      })
      .catch((e) => store.pushNotice(`Couldn’t switch output style: ${e?.message || e}`, 'error'))
      .finally(settled);
  };
  const cycleWorkflow = async (direction = 1) => {
    // Same as cycleOutputStyle: the epoch belongs to the keypress, not to the
    // listWorkflows ack that lands after the user may have closed Settings.
    const settled = deferredSettingsRefresh();
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
    const activeIndex = workflows.findIndex((item) => item.active);
    const currentIndex = activeIndex >= 0 ? activeIndex : workflows.findIndex((item) => item.id === view.workflow.id);
    const next = cycled(workflows, currentIndex, direction);
    void store
      .setWorkflow?.(next.id)
      .then((result) => {
        if (!result) {
          store.pushNotice('Workflow switch is already running.', 'warn');
          return;
        }
        store.pushNotice(workflowSwitchNotice(result), 'info');
      })
      .catch((e) => store.pushNotice(`Couldn’t switch workflow: ${e?.message || e}`, 'error'))
      .finally(settled);
  };

  return { cycleOutputStyle, cycleWorkflow };
}
