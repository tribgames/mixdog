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
  const { withCommandLock, publishRoute, deferStatsRefresh } = createApiHelpers({
    getState,
    set,
    resetStatsAndSyncContext,
    routeState,
    syncContextStats,
  });
  const lockedRuntimeCall = (call) => withCommandLock(async (...args) => await call(...args));

  return {
    // A model selector (/model, a preset) is the user's model choice like any
    // picker selection: the route surface switches an established
    // conversation in place (pre-compaction, busy refusal, divider). False
    // while another command holds the lock.
    setModel: async (m) => (await bag.setSessionRoute({ model: m })) !== false,
    setEffort: withCommandLock(
      async (value) => {
        await runtime.setEffort(value);
        set({ ...routeState() });
        return runtime.effort || 'auto';
      },
      { busyResult: false, onRelease: flushEmitImmediate }
    ),
    setFast: withCommandLock(
      async (value) => {
        const enabled = await runtime.setFast(value);
        set({ ...routeState() });
        return enabled;
      },
      { onRelease: flushEmitImmediate }
    ),
    toggleFast: withCommandLock(
      async () => {
        const enabled = await runtime.toggleFast();
        set({ ...routeState() });
        return enabled;
      },
      { onRelease: flushEmitImmediate }
    ),
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
      return runtime.setProfile?.(input) || runtime.getProfile?.() || null;
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
    getSessionTitleSettings: () => {
      return runtime.getSessionTitleSettings?.() || { aiSessionTitles: true };
    },
    setAiSessionTitles: withCommandLock(async (enabled) => {
      return await runtime.setAiSessionTitles?.(enabled);
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
    getWorktreeSettings: () => runtime.getWorktreeSettings(),
    setWorktreeSettings: lockedRuntimeCall((patch) => runtime.setWorktreeSettings(patch)),
    setWebSearchEnabled: lockedRuntimeCall((enabled) => runtime.setWebSearchEnabled?.(enabled)),
    setInstructionFiles: lockedRuntimeCall((mode) => runtime.setInstructionFiles?.(mode)),
    setMemoryToolsEnabled: lockedRuntimeCall((enabled) => runtime.setMemoryToolsEnabled?.(enabled)),
    setBuiltinToolEnabled: lockedRuntimeCall((name, enabled) => runtime.setBuiltinToolEnabled?.(name, enabled)),
    installBuiltinFeature: lockedRuntimeCall((name) => runtime.installBuiltinFeature?.(name)),
    installLocalProviderModel: lockedRuntimeCall((modelId) => runtime.installLocalProviderModel?.(modelId)),
    // Background installs return promptly; cancellation must remain usable
    // even while a legacy blocking install owns commandBusy.
    startLocalProviderInstallation: (phase, modelId) => runtime.startLocalProviderInstallation(phase, modelId),
    cancelLocalProviderInstallation: (jobId) => runtime.cancelLocalProviderInstallation(jobId),
    discardLocalProviderInstallation: (phase, modelId) => runtime.discardLocalProviderInstallation(phase, modelId),
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
    // Conversation import (advertised session actions; one object argument).
    // Background jobs, so never behind commandBusy.
    listImportableConversations: (params) => runtime.listImportableConversations(params),
    getConversationImportJobs: (params) => runtime.getConversationImportJobs(params),
    registerConversationImportFile: (params) => runtime.registerConversationImportFile(params),
    startConversationImport: (params) => runtime.startConversationImport(params),
    cancelConversationImport: (params) => runtime.cancelConversationImport(params),
    getChannelSettings: (options = {}) => {
      return (
        runtime.getChannelSettings?.(options) || {
          ...(options?.includeStatus === false ? {} : { status: runtime.getChannelWorkerStatus?.() }),
        }
      );
    },
  };
}
