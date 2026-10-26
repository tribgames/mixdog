// Automation worker status, the system shell, self-update, Mixy's heartbeat
// and bots' reactions settings.
import {
  normalizeHeartbeatIntervalMinutes,
  requireHeartbeatIntervalMinutes,
} from '../runtime/shared/heartbeat-interval.mjs';

export function createSystemSettings({
  getConfig,
  saveConfigAndAdopt,
  normalizeSystemShellConfig,
  normalizeSystemShellCommand,
  setConfiguredShell,
  localPackageVersion,
  autoUpdateEnabled,
  getUpdateCheckState,
  getUpdateProcessState,
  channels,
  checkForUpdateInternal,
  runUpdateNowInternal,
}) {
  return {
    getChannelSettings(options = {}) {
      return options?.includeStatus === false ? {} : { status: channels.status() };
    },
    getSystemShell() {
      const config = getConfig();
      return normalizeSystemShellConfig(config.shell);
    },
    setSystemShell(input = {}) {
      const config = getConfig();
      const command = normalizeSystemShellCommand(typeof input === 'string' ? input : input?.command);
      saveConfigAndAdopt({
        ...config,
        shell: command ? { ...(config.shell || {}), command } : {},
      });
      setConfiguredShell(command);
      return normalizeSystemShellConfig(getConfig().shell);
    },
    getUpdateSettings() {
      const updateCheckState = getUpdateCheckState();
      return {
        autoUpdate: autoUpdateEnabled(),
        currentVersion: updateCheckState.currentVersion || localPackageVersion(),
        latestVersion: updateCheckState.latestVersion,
        updateAvailable: updateCheckState.updateAvailable,
        lastCheckedAt: updateCheckState.lastCheckedAt,
      };
    },
    setAutoUpdate(enabled) {
      const config = getConfig();
      saveConfigAndAdopt({
        ...config,
        update: { ...(config.update || {}), auto: enabled === true },
      });
      return this.getUpdateSettings();
    },
    getHeartbeatSettings() {
      return {
        heartbeat: getConfig()?.heartbeat !== false,
        intervalMinutes: normalizeHeartbeatIntervalMinutes(getConfig()?.heartbeatIntervalMinutes),
      };
    },
    setHeartbeatEnabled(enabled) {
      saveConfigAndAdopt({ ...getConfig(), heartbeat: enabled === true });
      return this.getHeartbeatSettings();
    },
    setHeartbeatInterval(minutes) {
      saveConfigAndAdopt({ ...getConfig(), heartbeatIntervalMinutes: requireHeartbeatIntervalMinutes(minutes) });
      return this.getHeartbeatSettings();
    },
    getReactionSettings() {
      return { reactions: getConfig()?.reactions !== false };
    },
    setReactionsEnabled(enabled) {
      saveConfigAndAdopt({ ...getConfig(), reactions: enabled === true });
      return this.getReactionSettings();
    },
    async checkForUpdate(options = {}) {
      await checkForUpdateInternal({ force: options?.force === true });
      return this.getUpdateSettings();
    },
    async runUpdateNow() {
      const state = await runUpdateNowInternal();
      return { ok: state.phase === 'installed', ...state };
    },
    getUpdateStatus() {
      return { ...getUpdateProcessState() };
    },
  };
}
