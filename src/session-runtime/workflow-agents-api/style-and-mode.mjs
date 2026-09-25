import { findOutputStyle } from '../output-styles.mjs';
import { ORCHESTRATION_MODES, configuredOrchestrationMode } from '../../runtime/shared/orchestration.mjs';
import { configWithOutputStyle } from '../config-lifecycle/config-writers.mjs';

// Output style + orchestration mode: global configuration for future
// turns/sessions, never a reason to replace an addressed session.
export function createStyleAndModeApi(deps) {
  const {
    getConfig,
    getSession,
    adoptConfig,
    saveConfigAndAdopt,
    displayConfig,
    getOutputStyleStatusCached,
    seedOutputStyleStatusCache,
    scheduleOutputStyleSave,
    invalidateContextStatusCache,
  } = deps;

  async function setOutputStyle(value) {
    const before = getOutputStyleStatusCached({ fresh: true });
    const selected = findOutputStyle(value, before.styles);
    if (!selected) {
      const names = before.styles.map((style) => style.label || style.id).join(', ') || 'Default';
      throw new Error(`output style must be one of ${names}`);
    }
    // Adopt in-memory immediately so same-tick readers see the new style;
    // persist off the key-handler tick via the flushOutputStyleSave debounce.
    adoptConfig(configWithOutputStyle(getConfig(), selected.id));
    scheduleOutputStyleSave(selected.id);
    const freshStatus = { configured: selected.id, current: selected, styles: before.styles };
    seedOutputStyleStatusCache(freshStatus);
    const appliedToCurrentSession = !getSession()?.id;
    invalidateContextStatusCache();
    return { ...freshStatus, appliedToCurrentSession };
  }

  async function setOrchestrationMode(mode) {
    if (!ORCHESTRATION_MODES.includes(mode)) {
      throw new Error(`orchestration mode must be one of ${ORCHESTRATION_MODES.join(', ')}`);
    }
    saveConfigAndAdopt({ ...getConfig(), orchestrationMode: mode });
    const applied = await deps.refreshEmptySessionToolPolicy?.();
    deps.invalidatePreSessionToolSurface?.();
    invalidateContextStatusCache();
    return { mode, appliedToCurrentSession: applied?.appliedToCurrentSession !== false };
  }

  return {
    getOutputStyle: () => getOutputStyleStatusCached(),
    listOutputStyles: () => getOutputStyleStatusCached(),
    setOutputStyle,
    getOrchestrationMode: () => configuredOrchestrationMode(displayConfig()),
    setOrchestrationMode,
  };
}
