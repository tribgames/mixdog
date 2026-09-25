/**
 * maintenance-pickers.mjs — Update / Auto-clear / Profile / Developer picker cluster.
 *
 * A dependency-injection factory composing the four panels in
 * maintenance-pickers/. These openers drive the panel surface +
 * setSettingsPrompt and read live store state, so they can't be pure.
 */
import { createAutoClearPicker } from './maintenance-pickers/auto-clear-picker.mjs';
import { createProfilePicker } from './maintenance-pickers/profile-picker.mjs';
import { createUpdatePicker } from './maintenance-pickers/update-picker.mjs';
import { createDeveloperPicker } from './maintenance-pickers/developer-picker.mjs';

export function createMaintenancePickers({
  store,
  theme,
  formatDuration,
  surface,
  setProviderPrompt,
  setSettingsPrompt,
  closeUsagePanel,
}) {
  return {
    ...createUpdatePicker({ store, surface, setProviderPrompt, setSettingsPrompt }),
    ...createAutoClearPicker({
      store,
      theme,
      formatDuration,
      surface,
      setProviderPrompt,
      setSettingsPrompt,
      closeUsagePanel,
    }),
    ...createProfilePicker({ store, surface, setProviderPrompt, setSettingsPrompt, closeUsagePanel }),
    ...createDeveloperPicker({ store, surface, setProviderPrompt, setSettingsPrompt, closeUsagePanel }),
  };
}
