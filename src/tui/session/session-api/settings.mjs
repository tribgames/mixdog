/**
 * settings.mjs — the session object's settings surface: route (model /
 * effort / fast / tool mode), auto-clear, updates, profile, compaction and
 * recap, tool modules, builtin features, the local provider, and channels.
 */
import { toolErrorDisplay } from '../tool-result-text.mjs';
import { createApiHelpers } from './shared.mjs';

export function createSessionSettingsApi(bag) {
  const {
    runtime,
    getState,
    set,
    flushEmitImmediate,
    pushNotice,
    autoClearState,
    routeState,
    syncContextStats,
    resetStatsAndSyncContext,
  } = bag;
  const { withCommandLock } = createApiHelpers({ getState, set, resetStatsAndSyncContext, routeState });
  const publishRoute = () => set({ ...routeState(), stats: { ...getState().stats } });
  // Context-stats recompute (transcript scan + per-message JSON stringify) is
  // the secondary hitch source on a settings toggle; defer it off the
  // key-handler tick so Ink repaints the setting change first. Stats become
  // eventually consistent on the next tick/repaint.
  const deferStatsRefresh = () =>
    setTimeout(() => {
      syncContextStats({ allowEstimated: true });
      set({ stats: { ...getState().stats } });
    }, 0);
  const lockedRuntimeCall = (call) => withCommandLock(async (...args) => await call(...args));

  return {
    // Model changes apply to the NEXT session only (default setRoute behavior)
    // — never rewrite the live session's provider/model, which would force a
    // full prompt-cache rewrite mid-conversation. RPC replies read the
    // published snapshot, not the mutable draft: commit before the caller can
    // acknowledge an older route.
    setModel: withCommandLock(
      async (m) => {
        await runtime.setRoute({ model: m });
        publishRoute();
        return true;
      },
      { busyResult: false, onRelease: flushEmitImmediate }
    ),
    setEffort: withCommandLock(
      async (value) => {
        await runtime.setEffort(value);
        set({ ...routeState() });
        return runtime.effort || 'auto';
      },
      { busyResult: false, onRelease: flushEmitImmediate }
    ),
    setFast: withCommandLock(async (value) => {
      const enabled = await runtime.setFast(value);
      set({ ...routeState() });
      return enabled;
    }),
    toggleFast: withCommandLock(async () => {
      const enabled = await runtime.toggleFast();
      set({ ...routeState() });
      return enabled;
    }),
    setToolMode: (m) => {
      void runtime
        .setToolMode(m)
        .then(() => {
          resetStatsAndSyncContext();
          set({ ...routeState(), toolMode: runtime.toolMode, stats: { ...getState().stats } });
        })
        .catch((error) => pushNotice(toolErrorDisplay(error, 'tool'), 'error'));
    },
    getAutoClear: () => autoClearState(),
    setAutoClear: (input = {}) => {
      const next = runtime.setAutoClear?.(input) || autoClearState();
      set({ autoClear: next });
      return next;
    },
    getUpdateSettings: () => runtime.getUpdateSettings?.() || null,
    setAutoUpdate: (enabled) => runtime.setAutoUpdate?.(enabled),
    checkForUpdate: (input = {}) => runtime.checkForUpdate?.(input),
    runUpdateNow: () => runtime.runUpdateNow?.(),
    getUpdateStatus: () => runtime.getUpdateStatus?.() || { phase: 'idle' },
    getProfile: () =>
      runtime.getProfile?.() || {
        title: '',
        language: 'system',
        languages: [],
        experienceLevel: '',
        experienceLevels: [],
      },
    setProfile: (input = {}) => {
      const next = runtime.setProfile?.(input) || runtime.getProfile?.() || null;
      return next;
    },
    getCompactionSettings: () => {
      return runtime.getCompactionSettings?.() || {};
    },
    setCompactionSettings: withCommandLock(async (input = {}) => {
      const next = runtime.setCompactionSettings?.(input) || {};
      publishRoute();
      deferStatsRefresh();
      return next;
    }),
    getRecapSettings: () => {
      return runtime.getRecapSettings?.() || { enabled: true };
    },
    setRecapEnabled: withCommandLock(async (enabled) => {
      const next = await runtime.setRecapEnabled?.(enabled);
      publishRoute();
      deferStatsRefresh();
      return next;
    }),
    getToolModuleSettings: () => {
      return (
        runtime.getToolModuleSettings?.() || {
          webSearch: { enabled: true },
          memory: { enabled: true },
        }
      );
    },
    // Code Tidy card reads. Advertised session actions, so the daemon resolves
    // them by name on this surface (session-protocol.mjs).
    getTidyEngineStatus: () => runtime.getTidyEngineStatus?.(),
    getTidyInstallStatus: () => runtime.getTidyInstallStatus?.(),
    getDeveloperSettings: () => runtime.getDeveloperSettings?.(),
    setDeveloperOption: lockedRuntimeCall((id, enabled) => runtime.setDeveloperOption?.(id, enabled)),
    setWebSearchEnabled: lockedRuntimeCall((enabled) => runtime.setWebSearchEnabled?.(enabled)),
    setMemoryToolsEnabled: lockedRuntimeCall((enabled) => runtime.setMemoryToolsEnabled?.(enabled)),
    setBuiltinToolEnabled: lockedRuntimeCall((name, enabled) => runtime.setBuiltinToolEnabled?.(name, enabled)),
    installBuiltinFeature: lockedRuntimeCall((name) => runtime.installBuiltinFeature?.(name)),
    installLocalProviderModel: lockedRuntimeCall((modelId) => runtime.installLocalProviderModel?.(modelId)),
    // Background installs return promptly; cancellation must remain usable
    // even while a legacy blocking install owns commandBusy.
    startLocalProviderInstallation: (phase, modelId) => runtime.startLocalProviderInstallation(phase, modelId),
    cancelLocalProviderInstallation: (jobId) => runtime.cancelLocalProviderInstallation(jobId),
    setLocalProviderIdleTtl: (seconds) => runtime.setLocalProviderIdleTtl(seconds),
    setLocalProviderContext: (modelId, tokens) => runtime.setLocalProviderContext(modelId, tokens),
    getLocalProviderModelDetails: (modelId) => runtime.getLocalProviderModelDetails(modelId),
    startLocalProviderModelMaintenance: (modelId, operation) =>
      runtime.startLocalProviderModelMaintenance(modelId, operation),
    deleteLocalProviderModel: (token) => runtime.deleteLocalProviderModel(token),
    // Catalog reads and registration are advertised session actions; the
    // daemon resolves them by name on this surface (session-protocol.mjs).
    searchLocalProviderModels: (query) => runtime.searchLocalProviderModels(query),
    inspectHuggingFaceModel: (options) => runtime.inspectHuggingFaceModel(options),
    registerHuggingFaceModel: (previewId, licenseAccepted) =>
      runtime.registerHuggingFaceModel(previewId, licenseAccepted),
    getChannelSettings: (options = {}) => {
      return (
        runtime.getChannelSettings?.(options) || {
          enabled: true,
          ...(options?.includeStatus === false ? {} : { status: runtime.getChannelWorkerStatus?.() }),
        }
      );
    },
    setChannelsEnabled: withCommandLock(async (enabled) => {
      const next = await runtime.setChannelsEnabled?.(enabled);
      publishRoute();
      return next;
    }),
  };
}
