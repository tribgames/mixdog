// settings-picker/settings-toggles.mjs
// The ←/→ (and Enter-on-toggle) writes of the Settings rows: each one goes
// through the store, reports, and refreshes Settings through the deferred
// refresh bound to the keypress that started it.
import { outputStyleNotice } from '../route-pickers.mjs';
import { toggleVoice, isVoiceInstallBusy } from '../../lib/voice-setup.mjs';

/** Wrap-around step through `entries` from `currentIndex` (0 when unknown). */
const cycled = (entries, currentIndex, direction) =>
  entries[(Math.max(0, currentIndex) + direction + entries.length) % entries.length];

export function createSettingsToggles({
  store,
  view,
  formatDuration,
  workflowSwitchNotice,
  themeNotice,
  deferredSettingsRefresh,
  refreshSettings,
}) {
  const applyAutoClear = (patch = {}) => {
    void Promise.resolve(store.setAutoClear?.(patch))
      .then((next) => {
        if (!next) store.pushNotice('autoclear unavailable', 'warn');
        else
          store.pushNotice(
            next.enabled ? `Auto-clear on · idle ${formatDuration(next.idleMs)}` : 'Auto-clear off',
            'info'
          );
      })
      .catch((e) => store.pushNotice(`autoclear failed: ${e?.message || e}`, 'error'))
      .finally(deferredSettingsRefresh());
  };
  // On/Off toggle only — idle-window override lives in the Advanced picker
  // (openAutoClearPicker), opened via Enter on this row.
  const toggleAutoClear = () => applyAutoClear({ enabled: !view.autoClearEnabled });
  const toggleCompaction = () => {
    void Promise.resolve(store.setCompactionSettings?.({ auto: view.compaction.auto === false }))
      .then((next) => {
        if (!next) {
          store.pushNotice('compaction setting is busy', 'warn');
          return;
        }
        store.pushNotice(`Compaction ${next.auto !== false ? 'auto on' : 'auto off'}`, 'info');
      })
      .catch((e) => store.pushNotice(`compaction failed: ${e?.message || e}`, 'error'))
      .finally(deferredSettingsRefresh());
  };

  // Voice toggle: enabling installs the managed whisper/ffmpeg runtime first
  // time, then flips voice.enabled. toggleVoice owns all notices/progress.
  const applyVoice = () => {
    if (isVoiceInstallBusy()) {
      store.pushNotice('Voice install is already running', 'warn');
      return;
    }
    void Promise.resolve(toggleVoice({ pushNotice: store.pushNotice, setProgressHint: store.setProgressHint }))
      .catch((e) => store.pushNotice(`voice setup failed: ${e?.message || e}`, 'error'))
      .finally(deferredSettingsRefresh());
  };
  const applyToolModule = (label, setter, enabled) => {
    void Promise.resolve(setter?.(enabled))
      .then((next) => {
        if (!next) store.pushNotice(`${label} setting is busy`, 'warn');
        else store.pushNotice(`${label} ${enabled ? 'on' : 'off'} · new sessions`, 'info');
      })
      .catch((e) => store.pushNotice(`${label} setting failed: ${e?.message || e}`, 'error'))
      .finally(deferredSettingsRefresh());
  };
  const toggleWebSearch = () => applyToolModule('Web search', store.setWebSearchEnabled, !view.webSearchOn);
  const toggleMemory = () => applyToolModule('Memory', store.setMemoryToolsEnabled, !view.memoryToolsOn);

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
  const cycleTheme = (direction = 1) => {
    let themes = [];
    try {
      themes = store.listThemes?.() || [];
    } catch (e) {
      store.pushNotice(`could not list themes: ${e?.message || e}`, 'error');
      return;
    }
    if (!themes.length) {
      store.pushNotice('no themes available', 'warn');
      return;
    }
    const currentId = store.getTheme?.() || themes.find((t) => t.current)?.id || themes[0]?.id;
    const next = cycled(
      themes,
      themes.findIndex((t) => t.id === currentId),
      direction
    );
    try {
      const applied = store.setTheme?.(next.id, { persist: true });
      store.pushNotice(themeNotice(applied || next), 'info');
    } catch (e) {
      store.pushNotice(`Couldn’t set theme: ${e?.message || e}`, 'error');
    }
    refreshSettings();
  };

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
