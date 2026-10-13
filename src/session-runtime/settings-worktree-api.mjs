// Settings → Worktrees: defaults for Lead-session git worktrees
// (runtime/shared/worktrees/settings.mjs). Values persist at agent config
// `worktree.<key>`; defaults are not stored.
import { applyWorktreeSettingsPatch, normalizeWorktreeSettings } from '../runtime/shared/worktrees/settings.mjs';

export function createWorktreeSettings({ getConfig, saveConfigAndAdopt }) {
  return {
    getWorktreeSettings() {
      return normalizeWorktreeSettings(getConfig()?.worktree);
    },
    setWorktreeSettings(patch) {
      const config = getConfig() || {};
      saveConfigAndAdopt({ ...config, worktree: applyWorktreeSettingsPatch(config.worktree, patch) });
      return this.getWorktreeSettings();
    },
  };
}
