// Settings → Developer: the data-driven developer options
// (runtime/shared/developer-options.mjs). Values persist at agent config
// `developer.<optionId>`; an option's env var forces it on regardless.
import { developerOption, developerSettingsView } from '../runtime/shared/developer-options.mjs';

export function createDeveloperSettings({ getConfig, saveConfigAndAdopt, syncDeveloperOption }) {
  return {
    getDeveloperSettings() {
      // In-memory adopted config: current even while its debounced save is pending.
      return developerSettingsView(getConfig()?.developer);
    },
    async setDeveloperOption(id, enabled) {
      if (!developerOption(id)) throw new TypeError(`Unknown developer option "${id}".`);
      if (typeof enabled !== 'boolean') throw new TypeError('Developer option value must be a boolean.');
      const config = getConfig() || {};
      saveConfigAndAdopt({ ...config, developer: { ...(config.developer || {}), [id]: enabled } });
      // Flushes the save and applies live effects (e.g. the provider registry).
      await syncDeveloperOption?.(id);
      return this.getDeveloperSettings();
    },
  };
}
