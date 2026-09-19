// settings-api.mjs — pure settings delegate methods of the runtime API
// object: the small config/settings members with NO heavy closure deps beyond
// the injected helpers. The returned object is SPREAD into the facade's API
// object so the external surface stays byte-identical. Methods that reference
// `this.*` resolve against the spread target, so cross-member calls (e.g.
// setProfile -> this.getProfile) keep working when spread into the facade.
//
// The members live in four topic modules: profile/onboarding/skills,
// compaction/auto-clear, built-in tool modules, and system (channels, shell,
// updates); the local provider's own methods come from
// local-provider-settings.mjs.
import { createLocalProviderSettings } from './local-provider-settings.mjs';
import { createProfileSettings } from './settings-profile-api.mjs';
import { createCompactionSettings } from './settings-compaction-api.mjs';
import { createBuiltinToolSettings } from './settings-builtin-tools-api.mjs';
import { createSystemSettings } from './settings-system-api.mjs';

export function createSettingsApi(deps) {
  // Optional: callers without a live local provider / gate fall back to the
  // config-only views.
  const { getLocalProviderStatus = () => ({}), localProviderEnabledFn = () => false } = deps;
  const shared = { ...deps, getLocalProviderStatus, localProviderEnabledFn };
  const localSettings = createLocalProviderSettings({
    getConfig: deps.getConfig,
    saveConfigAndAdopt: deps.saveConfigAndAdopt,
    getLocalProviderStatus,
    prepareLocalProviderModel: deps.prepareLocalProviderModel,
    refreshLocalProviderCatalog: deps.refreshLocalProviderCatalog,
    cancelLocalProviderInstallation: deps.cancelLocalProviderInstallation,
    configureLocalProviderIdleTtl: deps.configureLocalProviderIdleTtl,
  });
  return {
    ...localSettings.methods,
    ...createProfileSettings(shared),
    ...createCompactionSettings(shared),
    ...createBuiltinToolSettings(shared, localSettings),
    ...createSystemSettings(shared),
  };
}
