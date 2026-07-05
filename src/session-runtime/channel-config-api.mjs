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
    getChannelSetup() {
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
    saveSchedule(entry) {
      const result = saveSchedule(entry);
      reloadChannelsSoon();
      return result;
    },
    deleteSchedule(name) {
      const result = deleteSchedule(name);
      reloadChannelsSoon();
      return result;
    },
    setScheduleEnabled(name, enabled) {
      const result = setScheduleEnabled(name, enabled);
      reloadChannelsSoon();
      return result;
    },
    saveWebhook(entry) {
      const result = saveWebhook(entry);
      reloadChannelsSoon();
      return result;
    },
    deleteWebhook(name) {
      const result = deleteWebhook(name);
      reloadChannelsSoon();
      return result;
    },
    setWebhookEnabled(name, enabled) {
      const result = setWebhookEnabled(name, enabled);
      reloadChannelsSoon();
      return result;
    },
  };
}
