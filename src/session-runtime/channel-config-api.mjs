import {
  channelSetup,
  deleteSchedule,
  deleteWebhook,
  getWebhookSecret,
  setChannelAsync,
  saveSchedule,
  saveWebhook,
  setScheduleEnabled,
  setWebhookEnabled,
  setWebhookConfigAsync,
} from '../standalone/channel-admin.mjs';
import { getSchedule } from '../runtime/shared/schedules-db.mjs';
import { runScheduleSession } from '../runtime/shared/schedule-session-run.mjs';

// Channel/webhook/schedule config surface. Extracted verbatim from the runtime
// API object; the mutating admin helpers are imported directly here and the
// runtime injects only the closure-owned callbacks (backend flush, channel
// worker handle, soft reload).
export function createChannelConfigApi({ flushBackendSave, channels, reloadChannelsSoon, ensureAutomationRuntime = () => {} }) {
  return {
    async getChannelSetup() {
      // Flush a pending debounced backend switch first so setup readers
      // (Settings → Channel Setting, remote toggles) never observe the
      // previous backend during the 150ms debounce window.
      try { await flushBackendSave(); } catch {}
      return channelSetup();
    },
    getChannelWorkerStatus() {
      return channels.status();
    },
    async setChannel(entry) {
      const result = await setChannelAsync(entry);
      reloadChannelsSoon();
      return result;
    },
    async setWebhookConfig(patch) {
      const result = await setWebhookConfigAsync(patch);
      reloadChannelsSoon();
      return result;
    },
    async saveSchedule(entry) {
      const result = await saveSchedule(entry);
      reloadChannelsSoon();
      // First automation created while the app is already running: the boot-
      // time autostart check has passed, so kick the worker start path now
      // (no-op when it is already up).
      ensureAutomationRuntime();
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
      if (enabled !== false) ensureAutomationRuntime();
      return result;
    },
    async saveWebhook(entry) {
      const result = await saveWebhook(entry);
      reloadChannelsSoon();
      ensureAutomationRuntime();
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
      if (enabled !== false) ensureAutomationRuntime();
      return result;
    },
    // Read-only secret fetch for the webhook editor; no worker reload.
    async getWebhookSecret(name) {
      return getWebhookSecret(name);
    },
    async runScheduleNow(name) {
      const id = String(name || '').trim();
      const schedule = await getSchedule(id);
      if (!schedule) throw new Error(`schedule "${id}" does not exist`);
      // Runs in the engine process as a VISIBLE schedule session, so it works
      // even while the channels worker is off and the run lands in Recent.
      const { sessionId, result } = await runScheduleSession(schedule);
      return { name: schedule.name, ok: true, sessionId, result };
    },
  };
}
