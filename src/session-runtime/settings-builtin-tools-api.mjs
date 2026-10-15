// Built-in tool modules: the enable/install toggles (web search, memory, git,
// office, tidy, local provider, auto effort), the recap switch and the Code
// Tidy card.
import {
  INSTALLABLE_BUILTIN_IDS,
  builtinFeatureActive,
  builtinInstalled,
  setBuiltinInstalledInConfig,
} from '../runtime/agent/orchestrator/runtime-core/builtin-features.mjs';
import { featureEnvOverride, moduleEnabled } from '../runtime/agent/orchestrator/runtime-core/config-helpers.mjs';
import { LOCAL_PROVIDER_ID } from '../runtime/local-provider/managed-runtime.mjs';
import {
  INSTRUCTION_FILES_MODES,
  normalizeInstructionFilesMode,
} from '../runtime/shared/instruction-files-mode.mjs';
import { getEmbeddingInfo } from '../runtime/memory/lib/embedding-provider.mjs';
import { onnxRuntimeSupported } from '../runtime/shared/onnx-runtime-support.mjs';
import {
  EFFORT_JUDGE_UNSUPPORTED,
  effortJudgeAvailable,
  effortJudgeInfo,
  effortJudgeInstalling,
  effortJudgeReady,
  shutdownEffortJudge,
} from '../runtime/effort-judge/judge-client.mjs';

const TOGGLEABLE_BUILTINS = ['git', 'office', 'tidy', 'localProvider', 'autoEffort', 'visualize'];

function setLocalProviderEnabledInConfig(configLike, enabled) {
  const next = { ...(configLike || {}) };
  next.providers = { ...(next.providers || {}) };
  next.providers[LOCAL_PROVIDER_ID] = {
    ...(next.providers[LOCAL_PROVIDER_ID] || {}),
    enabled: enabled !== false,
  };
  return next;
}

export function createBuiltinToolSettings(
  {
    getConfig,
    saveConfigAndAdopt,
    setRecapEnabledInConfig,
    setMemoryToolsEnabledInConfig,
    setModuleEnabledInConfig,
    prepareBuiltinFeature,
    tidyEngineStatus,
    tidyInstallStatus,
    getLocalProviderStatus,
    stopLocalProviderServer,
    syncLocalProviderRegistry,
    recapEnabledFn,
    memoryToolsEnabledFn,
    gitToolsEnabledFn,
    officeToolsEnabledFn,
    tidyToolEnabledFn,
    localProviderEnabledFn,
    webSearchEnabled,
    invalidateContextStatusCache,
    invalidatePreSessionToolSurface,
    refreshEmptySessionToolPolicy,
  },
  localSettings
) {
  return {
    // Recap toggle: user-facing switch that gates ONLY the background memory
    // cycles (1/2/3). The memory module (transcript watcher/ingest and
    // on-demand reads) is always-on. The memory runtime re-reads recap from the
    // agent config section each cycle tick, so toggling takes effect without a
    // restart.
    getRecapSettings() {
      return { enabled: recapEnabledFn() };
    },
    setRecapEnabled(enabled) {
      const config = getConfig();
      const nextConfig = setRecapEnabledInConfig({ ...config }, enabled !== false);
      saveConfigAndAdopt(nextConfig);
      invalidatePreSessionToolSurface();
      invalidateContextStatusCache();
      return this.getRecapSettings();
    },
    // Whether the model may title the session (session tool, action=rename).
    // Absent config means on; only the opt-out is stored.
    getSessionTitleSettings() {
      return { aiSessionTitles: getConfig()?.aiSessionTitles !== false };
    },
    setAiSessionTitles(enabled) {
      saveConfigAndAdopt({ ...getConfig(), aiSessionTitles: enabled !== false });
      return this.getSessionTitleSettings();
    },
    getToolModuleSettings() {
      const config = getConfig();
      const localProvider = getLocalProviderStatus?.() || {};
      const localProviderRuntimeInstalled = localProvider?.runtime?.installed === true;
      return {
        instructionFiles: normalizeInstructionFilesMode(config?.instructionFiles),
        webSearch: { enabled: webSearchEnabled() },
        memory: {
          enabled: memoryToolsEnabledFn(),
          installed: builtinInstalled(config, 'memory'),
          info: getEmbeddingInfo(),
          semanticSearchSupported: onnxRuntimeSupported(),
        },
        git: { enabled: gitToolsEnabledFn(), installed: builtinInstalled(config, 'git') },
        office: { enabled: officeToolsEnabledFn(), installed: builtinInstalled(config, 'office') },
        tidy: {
          enabled: tidyToolEnabledFn ? tidyToolEnabledFn() : builtinFeatureActive(config, 'tidy'),
          installed: builtinInstalled(config, 'tidy'),
        },
        // Ships with the runtime and needs no install; the toggle reflects the
        // module flag, not live bridge presence.
        visualize: {
          enabled: featureEnvOverride('MIXDOG_FEATURE_VISUALIZE') ?? moduleEnabled(config, 'visualize', true),
          installed: true,
        },
        localProvider: {
          ...localProvider,
          ...localSettings.status(),
          enabled: localProviderEnabledFn(),
          installed: builtinInstalled(config, 'localProvider') && localProviderRuntimeInstalled,
        },
        autoEffort: {
          supported: onnxRuntimeSupported(),
          enabled: builtinFeatureActive(config, 'autoEffort'),
          // On by default: "installed" means the judge model is on disk;
          // "installing" covers the boot download the settings did not start.
          installed: effortJudgeAvailable(),
          installing: effortJudgeInstalling(),
          ready: effortJudgeReady(),
          info: effortJudgeInfo(),
        },
      };
    },
    async setWebSearchEnabled(enabled) {
      const config = getConfig();
      saveConfigAndAdopt(setModuleEnabledInConfig({ ...config }, 'webSearch', enabled !== false));
      // Empty/reserved sessions rebuild now so session entry does not still
      // advertise web_search. A conversation keeps its frozen schema.
      await refreshEmptySessionToolPolicy?.();
      return this.getToolModuleSettings();
    },
    /** Which user instruction files (AGENTS.md / CLAUDE.md) new sessions load:
     *  'all' | 'agents' | 'claude' | 'off'. The empty session rebuilds now. */
    async setInstructionFiles(mode) {
      if (!INSTRUCTION_FILES_MODES.includes(mode)) {
        throw new TypeError(`Instruction files must be one of ${INSTRUCTION_FILES_MODES.join(', ')}.`);
      }
      saveConfigAndAdopt({ ...getConfig(), instructionFiles: mode });
      await refreshEmptySessionToolPolicy?.();
      return this.getToolModuleSettings();
    },
    async setMemoryToolsEnabled(enabled) {
      const config = getConfig();
      const memoryEnabled = enabled !== false;
      // General → Memory is the user-facing master: model tools, core-memory
      // injection, and background recap cycles move together.
      let nextConfig = setRecapEnabledInConfig(
        setMemoryToolsEnabledInConfig({ ...config }, memoryEnabled),
        memoryEnabled
      );
      // Enabling IS activation: an explicit enable marks the feature installed
      // so the install-first gate never fights a direct toggle (TUI path).
      if (memoryEnabled) nextConfig = setBuiltinInstalledInConfig(nextConfig, 'memory', true);
      saveConfigAndAdopt(nextConfig);
      invalidateContextStatusCache();
      await refreshEmptySessionToolPolicy?.();
      return this.getToolModuleSettings();
    },
    async setBuiltinToolEnabled(name, enabled) {
      if (!TOGGLEABLE_BUILTINS.includes(name)) {
        throw new TypeError('Built-in tool must be git, office, tidy, localProvider, autoEffort, or visualize.');
      }
      if (name === 'autoEffort' && enabled !== false && !onnxRuntimeSupported()) {
        throw new Error(EFFORT_JUDGE_UNSUPPORTED);
      }
      if (name === 'localProvider' && enabled !== false && getLocalProviderStatus?.()?.runtime?.installed !== true) {
        await prepareBuiltinFeature?.(name);
      }
      if (name === 'autoEffort' && enabled !== false) await prepareBuiltinFeature?.(name);
      const config = getConfig();
      let nextConfig = setModuleEnabledInConfig({ ...config }, name, enabled !== false);
      if (name === 'localProvider') {
        nextConfig = setLocalProviderEnabledInConfig(nextConfig, enabled);
      }
      // Enabling IS activation (see setMemoryToolsEnabled).
      if (enabled !== false) nextConfig = setBuiltinInstalledInConfig(nextConfig, name, true);
      saveConfigAndAdopt(nextConfig);
      if (name === 'localProvider' && enabled === false) {
        await stopLocalProviderServer?.();
      }
      if (name === 'localProvider') {
        await syncLocalProviderRegistry?.(enabled !== false);
      }
      // Turning Auto on loads nothing: the judge starts on its first turn.
      if (name === 'autoEffort' && enabled === false) await shutdownEffortJudge();
      await refreshEmptySessionToolPolicy?.();
      return this.getToolModuleSettings();
    },
    /** Extensions → Built-in Install: run the feature's preparation adapter
     *  (model pre-download, component verification), then mark it installed
     *  and enabled in one step. New sessions pick up the tool surface. */
    async installBuiltinFeature(name) {
      if (!INSTALLABLE_BUILTIN_IDS.includes(name)) {
        throw new TypeError('Built-in feature must be git, memory, office, tidy, localProvider, or autoEffort.');
      }
      if (name === 'autoEffort' && !onnxRuntimeSupported()) throw new Error(EFFORT_JUDGE_UNSUPPORTED);
      await prepareBuiltinFeature?.(name);
      const config = getConfig();
      let nextConfig = setBuiltinInstalledInConfig({ ...config }, name, true);
      nextConfig =
        name === 'memory'
          ? setRecapEnabledInConfig(setMemoryToolsEnabledInConfig(nextConfig, true), true)
          : setModuleEnabledInConfig(nextConfig, name, true);
      if (name === 'localProvider') {
        nextConfig = setLocalProviderEnabledInConfig(nextConfig, true);
      }
      saveConfigAndAdopt(nextConfig);
      if (name === 'localProvider') {
        await syncLocalProviderRegistry?.(true);
      }
      if (name === 'memory') invalidateContextStatusCache();
      await refreshEmptySessionToolPolicy?.();
      return this.getToolModuleSettings();
    },
    /** Extensions → Code Tidy: which engines exist, where each one comes from,
     *  and the in-flight install. Never downloads. */
    async getTidyEngineStatus() {
      return (await tidyEngineStatus?.()) || null;
    },
    /** Progress for an `installBuiltinFeature('tidy')` still in flight, the
     *  last finished job, or null when this runtime never installed. */
    async getTidyInstallStatus() {
      return (await tidyInstallStatus?.()) || null;
    },
  };
}
