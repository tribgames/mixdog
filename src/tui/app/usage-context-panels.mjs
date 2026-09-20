import { buildContextPanelModel } from './usage-context-panels/context-model.mjs';
import { createUsagePanelOpener } from './usage-context-panels/usage-panel.mjs';

// /usage and /context panel builders. Follows the
// createRoutePickers factory pattern: called each render with the current
// store/state and the panel surface; opening either surface closes every other
// prompt/picker first so exactly one bottom surface owns the screen. The
// dashboard opener and the pure context derivation live under
// ./usage-context-panels/.
export function createUsageContextPanels({
  store,
  state,
  surface,
  setProviderPrompt,
  setSettingsPrompt,
  closeUsagePanel,
}) {
  const openUsagePanel = createUsagePanelOpener({
    store,
    surface,
    setProviderPrompt,
    setSettingsPrompt,
    closeUsagePanel,
  });

  // Async because a daemon-backed store answers every status getter over the
  // wire: read synchronously they resolved to promises and the panel rendered
  // all-zero rows.
  const openContextPicker = async () => {
    // Surface claim (panel-surface.mjs): five daemon reads run before the first
    // paint, so Esc during the pending open must leave the surface (picker AND
    // context panel) untouched.
    const own = surface.claim();
    const [toolsStatus, mcpStatus, skillsStatus, pluginsStatus, contextStatus] = await Promise.all([
      Promise.resolve(store.toolsStatus?.()).catch(() => null),
      Promise.resolve(store.mcpStatus?.()).catch(() => null),
      Promise.resolve(store.skillsStatus?.()).catch(() => null),
      Promise.resolve(store.pluginsStatus?.()).catch(() => null),
      Promise.resolve(store.contextStatus?.({ inspect: true })).catch(() => null),
    ]);
    const { rows, detail } = buildContextPanelModel({
      toolsStatus,
      mcpStatus,
      skillsStatus,
      pluginsStatus,
      contextStatus,
      state,
    });
    if (!own.owns()) return;
    setProviderPrompt(null);
    setSettingsPrompt(null);
    own.paint(null);
    own.context({
      kind: 'context',
      title: 'Context Usage',
      detail,
      onInspect: async (entryId, revision) => {
        const status = await store.contextStatus({ inspect: true, entryId, revision });
        return status?.inspection?.preview;
      },
      onRefresh: openContextPicker,
      rows,
    });
  };

  return { openUsagePanel, openContextPicker };
}
