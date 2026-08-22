// Picker/panel factory wiring, extracted from App.jsx. Every create*Picker
// factory (theme/effort, resume, core memory, extensions, maintenance,
// onboarding, channels, provider setup, model, routes, settings) plus the
// slash dispatcher instantiate here in one scope, preserving the original
// order and the lazy-getter forward references between them.
import { createThemeEffortPickers, themeNotice } from './theme-effort-pickers.mjs';
import { clean, formatSessionMessageCount, formatSessionUpdatedAt, modelSwitchNotice, workflowDisplayName, workflowSwitchNotice } from './app-format.mjs';
import { createResumePicker } from './resume-picker.mjs';
import { createCoreMemoryPicker } from './core-memory-picker.mjs';
import { parseMemoryCommand, parseMemoryCoreRows } from './input-parsers.mjs';
import { createExtensionPickers } from './extension-pickers.mjs';
import { theme } from '../theme.mjs';
import { copyToClipboard } from './clipboard.mjs';
import { createMaintenancePickers } from './maintenance-pickers.mjs';
import { formatDuration } from '../time-format.mjs';
import { createOnboardingSteps } from './onboarding-steps.mjs';
import { createProviderSetupPicker } from './provider-setup-picker.mjs';
import { createModelPicker } from './model-picker.mjs';
import { createRoutePickers, outputStyleNotice } from './route-pickers.mjs';
import { agentModelParts, agentModelProfile, routeLabel, routeModelLabel } from './model-options.mjs';
import { createSettingsPicker } from './settings-picker.mjs';
import { displayModelName } from '../../ui/model-display.mjs';
import { createSlashDispatch } from './slash-dispatch.mjs';
import { normalizeSlashCommandName } from './slash-commands.mjs';
export function createAppPickers({
  state,
  store,
  surface,
  setProviderPrompt,
  setSettingsPrompt,
  setOnboardingActive,
  closeUsagePanel,
  oauthSubmitRef,
  clearModelCaches,
  onboardingRef,
  providerModelsCacheRef,
  webSearchModelsCacheRef,
  modelPickerRequestRef,
  onboardingPrefetchSeqRef,
  settingsHeavyCacheRef,
  settingsRequestRef,
  livePickerRef,
  disabledSkills,
  setDisabledSkills,
  enterProject,
  openProjectPicker,
  requestExit,
  openUsagePanel,
  openContextPicker,
}) {
  // Theme/effort picker cluster — same dep set as the project picker; the
  // destructured openers are used inside handlers defined later in the body.
  const { openThemePicker, openEffortPicker } = createThemeEffortPickers({
    state,
    store,
    surface,
    setProviderPrompt,
    setSettingsPrompt,
    closeUsagePanel,
    clean,
  });
  // Resume picker — independent (store + surface + two session formatters).
  const { openResumePicker } = createResumePicker({
    store,
    surface,
    formatSessionUpdatedAt,
    formatSessionMessageCount,
  });
  // Core-memory picker cluster. The Esc-return target is passed per entry
  // point ({ returnTo }): Settings threads openSettingsPicker, standalone
  // /memory passes null so Esc closes instead of surfacing Settings.
  // Only openMemoryCorePicker is called from the App body; the entry-action /
  // add / edit / delete openers are internal to the factory (reached through
  // the picker's own onSelect closures), so they stay unbound here.
  const { openMemoryCorePicker } = createCoreMemoryPicker({
    store,
    surface,
    setSettingsPrompt,
    parseMemoryCoreRows,
  });
  const {
    openMcpServersPicker,
    openMcpPicker,
    openProjectSkillsPicker,
    openSkillsPicker,
    openSkillDetailPicker,
    beginAddPlugin,
    openPluginDetailPicker,
    openInstalledPluginsPicker,
    openPluginsPicker,
    openHooksPicker,
  } = createExtensionPickers({
    store,
    theme,
    clean,
    copyToClipboard,
    surface,
    getPicker: () => livePickerRef.current,
    setProviderPrompt,
    setSettingsPrompt,
    getDisabledSkills: () => disabledSkills,
    setDisabledSkills,
  });
  const {
    openUpdatePicker,
    openAutoClearPicker,
    openProfilePicker,
  } = createMaintenancePickers({
    store,
    theme,
    formatDuration,
    surface,
    setProviderPrompt,
    setSettingsPrompt,
    closeUsagePanel,
  });
  // Onboarding wizard + channel setup picker factories. Instantiated here —
  // after the onboarding refs above (const-TDZ) — with later-defined openers
  // (openProviderSetupPicker/openOutputStylePicker) threaded as lazy getters
  // that resolve the live binding at call time.
  const { onboardingWarnReopen, openOnboardingAuthStep } = createOnboardingSteps({
    store,
    surface,
    setProviderPrompt,
    setSettingsPrompt,
    setOnboardingActive,
    onboardingRef,
    providerModelsCacheRef,
    onboardingPrefetchSeqRef,
    openProviderSetupPicker: (...a) => openProviderSetupPicker(...a),
    openThemePicker,
    openOutputStylePicker: (...a) => openOutputStylePicker(...a),
  });
  const { openProviderSetupPicker } = createProviderSetupPicker({
    store,
    surface,
    setProviderPrompt,
    setSettingsPrompt,
    closeUsagePanel,
    oauthSubmitRef,
    clearModelCaches,
  });
  const { openModelPicker } = createModelPicker({
    store,
    getState: () => state,
    surface,
    setProviderPrompt,
    setSettingsPrompt,
    providerModelsCacheRef,
    webSearchModelsCacheRef,
    modelPickerRequestRef,
    clearModelCaches,
    modelSwitchNotice,
    openProviderSetupPicker,
  });
  const {
    openWebSearchPicker,
    openAgentsPicker,
    openWorkflowPicker,
    openOutputStylePicker,
  } = createRoutePickers({
    store,
    state,
    surface,
    setProviderPrompt,
    setSettingsPrompt,
    closeUsagePanel,
    clean,
    routeLabel,
    agentModelParts,
    agentModelProfile,
    workflowSwitchNotice,
    openModelPicker: (...a) => openModelPicker(...a),
  });
  const { openSettingsPicker } = createSettingsPicker({
    store,
    state,
    surface,
    setProviderPrompt,
    setSettingsPrompt,
    settingsHeavyCacheRef,
    settingsRequestRef,
    formatDuration,
    displayModelName,
    routeModelLabel,
    workflowDisplayName,
    workflowSwitchNotice,
    themeNotice,
    openModelPicker: (...a) => openModelPicker(...a),
    openWebSearchPicker: (...a) => openWebSearchPicker(...a),
    openAgentsPicker: (...a) => openAgentsPicker(...a),
    openWorkflowPicker: (...a) => openWorkflowPicker(...a),
    openOutputStylePicker: (...a) => openOutputStylePicker(...a),
    openProviderSetupPicker: (...a) => openProviderSetupPicker(...a),
    openThemePicker: (...a) => openThemePicker(...a),
    openAutoClearPicker: (...a) => openAutoClearPicker(...a),
    openProfilePicker: (...a) => openProfilePicker(...a),
    openMcpPicker: (...a) => openMcpPicker(...a),
    openPluginsPicker: (...a) => openPluginsPicker(...a),
    openHooksPicker: (...a) => openHooksPicker(...a),
    openSkillsPicker: (...a) => openSkillsPicker(...a),
    openMemoryCorePicker: (...a) => openMemoryCorePicker(...a),
    openUpdatePicker: (...a) => openUpdatePicker(...a),
  });
  const { runSlashCommand } = createSlashDispatch({
    state,
    store,
    normalizeSlashCommandName,
    surface,
    closeUsagePanel,
    openModelPicker: (...a) => openModelPicker(...a),
    modelSwitchNotice,
    openWebSearchPicker: (...a) => openWebSearchPicker(...a),
    openAgentsPicker: (...a) => openAgentsPicker(...a),
    openWorkflowPicker: (...a) => openWorkflowPicker(...a),
    workflowSwitchNotice,
    openOutputStylePicker: (...a) => openOutputStylePicker(...a),
    outputStyleNotice,
    openThemePicker: (...a) => openThemePicker(...a),
    themeNotice,
    openEffortPicker: (...a) => openEffortPicker(...a),
    enterProject: (...a) => enterProject(...a),
    openProjectPicker: (...a) => openProjectPicker(...a),
    openMcpPicker: (...a) => openMcpPicker(...a),
    openSkillsPicker: (...a) => openSkillsPicker(...a),
    openPluginsPicker: (...a) => openPluginsPicker(...a),
    openHooksPicker: (...a) => openHooksPicker(...a),
    openProviderSetupPicker: (...a) => openProviderSetupPicker(...a),
    openMemoryCorePicker: (...a) => openMemoryCorePicker(...a),
    parseMemoryCommand,
    openSettingsPicker: (...a) => openSettingsPicker(...a),
    openAutoClearPicker: (...a) => openAutoClearPicker(...a),
    formatDuration,
    openResumePicker: (...a) => openResumePicker(...a),
    openUsagePanel: (...a) => openUsagePanel(...a),
    openContextPicker: (...a) => openContextPicker(...a),
    openProfilePicker: (...a) => openProfilePicker(...a),
    openUpdatePicker: (...a) => openUpdatePicker(...a),
    runDoctor: (...a) => store.runDoctor?.(...a),
    requestExit: (...a) => requestExit(...a),
  });

  return {
    openThemePicker,
    openEffortPicker,
    openResumePicker,
    openMemoryCorePicker,
    openMcpServersPicker,
    openMcpPicker,
    openProjectSkillsPicker,
    openSkillsPicker,
    openSkillDetailPicker,
    beginAddPlugin,
    openPluginDetailPicker,
    openInstalledPluginsPicker,
    openPluginsPicker,
    openHooksPicker,
    openUpdatePicker,
    openAutoClearPicker,
    openProfilePicker,
    onboardingWarnReopen,
    openOnboardingAuthStep,
    openProviderSetupPicker,
    openModelPicker,
    openWebSearchPicker,
    openAgentsPicker,
    openWorkflowPicker,
    openOutputStylePicker,
    openSettingsPicker,
    runSlashCommand,
  };
}
