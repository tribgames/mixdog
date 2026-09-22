// settings-picker/settings-toggles.mjs
// The ←/→ (and Enter-on-toggle) writes of the Settings rows: each one goes
// through the store, reports, and refreshes Settings through the deferred
// refresh bound to the keypress that started it.
//
// This file owns the two dispatch tables at the bottom; the writes behind them
// live in settings-toggles/ — the boolean rows (store-toggles), the two rows
// that must list before they write (listed-cyclers) and the synchronous theme
// cycler (theme-cycler).
import { createListedCyclers } from './settings-toggles/listed-cyclers.mjs';
import { createStoreToggles } from './settings-toggles/store-toggles.mjs';
import { createThemeCycler } from './settings-toggles/theme-cycler.mjs';

export function createSettingsToggles({
  store,
  view,
  formatDuration,
  workflowSwitchNotice,
  themeNotice,
  deferredSettingsRefresh,
  refreshSettings,
}) {
  const { toggleAutoClear, toggleCompaction, applyVoice, toggleWebSearch, toggleMemory } = createStoreToggles({
    store,
    view,
    formatDuration,
    deferredSettingsRefresh,
  });
  const { cycleOutputStyle, cycleWorkflow } = createListedCyclers({
    store,
    view,
    workflowSwitchNotice,
    deferredSettingsRefresh,
  });
  const { cycleTheme } = createThemeCycler({ store, themeNotice, refreshSettings });

  /** ←/→ on a row: toggles flip, cyclers step in `direction`. */
  const cycleRow = (item, direction) => {
    const action = item?._action;
    if (action === 'autoclear') toggleAutoClear();
    else if (action === 'autocompact') toggleCompaction();
    else if (action === 'web-search-enabled') toggleWebSearch();
    else if (action === 'memory-enabled') toggleMemory();
    else if (action === 'voice') applyVoice();
    else if (action === 'output-style') cycleOutputStyle(direction);
    else if (action === 'theme') cycleTheme(direction);
    else if (action === 'workflow') cycleWorkflow(direction);
  };

  /** Enter on a toggle row flips it; false when the row is not a toggle. */
  const toggleRow = (item) => {
    const action = item?._action;
    if (action === 'autocompact') toggleCompaction();
    else if (action === 'web-search-enabled') toggleWebSearch();
    else if (action === 'memory-enabled') toggleMemory();
    else if (action === 'voice') applyVoice();
    else return false;
    return true;
  };

  return { cycleRow, toggleRow };
}
