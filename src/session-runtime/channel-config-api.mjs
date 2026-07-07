import {
  channelSetup,
  deleteSchedule,
  deleteWebhook,
  setChannel,
  saveSchedule,
  saveWebhook,
  setScheduleEnabled,
  setWebhookEnabled,
  setWebhookConfig,
} from '../standalone/channel-admin.mjs';

// Channel/webhook/schedule config surface. Extracted verbatim from the runtime
// API object; the mutating admin helpers are imported directly here and the
// runtime injects only the closure-owned callbacks (backend flush, channel
// worker handle, soft reload).
export function createChannelConfigApi({ flushBackendSave, channels, reloadChannelsSoon }) {
  return {
    async getChannelSetup() {
      // Flush a pending debounced backend switch first so setup readers
      // (Settings → Channel Setting, remote toggles) never observe the
      // previous backend during the 150ms debounce window.
      try { flushBackendSave(); } catch {}
      return channelSetup();
    },
    getChannelWorkerStatus() {
      return channels.status();
    },
    setChannel(entry) {
      const result = setChannel(entry);
      reloadChannelsSoon();
      return result;
    },
    setWebhookConfig(patch) {
      const result = setWebhookConfig(patch);
      reloadChannelsSoon();
      return result;
    },
    async saveSchedule(entry) {
      const result = await saveSchedule(entry);
      reloadChannelsSoon();
      return result;
    },
    async deleteSchedule(name) {
      const result = await deleteSchedule(name);
      reloadChannelsSoon();
      return result;
    },
    async setScheduleEnabled(name, enabled) {
      const result = await setScheduleEnabled(name, enabled);
      reloadChannelsSoon();
      return result;
    },
    async saveWebhook(entry) {
      const result = await saveWebhook(entry);
      reloadChannelsSoon();
      return result;
    },
    async deleteWebhook(name) {
      const result = await deleteWebhook(name);
      reloadChannelsSoon();
      return result;
    },
    async setWebhookEnabled(name, enabled) {
      const result = await setWebhookEnabled(name, enabled);
      reloadChannelsSoon();
      return result;
    },
  };
}
