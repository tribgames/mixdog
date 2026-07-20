import {
  channelSetup,
  deleteSchedule,
  deleteWebhook,
  setChannelAsync,
  saveSchedule,
  saveWebhook,
  setScheduleEnabled,
  setWebhookEnabled,
  setWebhookConfigAsync,
} from '../standalone/channel-admin.mjs';
import { getSchedule } from '../runtime/shared/schedules-db.mjs';
import { parseScheduleModelRef } from '../runtime/shared/schedule-model-ref.mjs';
import { makeAgentDispatch } from '../runtime/agent/orchestrator/agent-runtime/agent-dispatch.mjs';

// Run-now shares the scheduler's dispatch identity (scheduler-task) but runs
// in the engine process, so it works even while the channels worker is off.
// The result returns to the caller (desktop Schedules page) instead of being
// relayed to the channel.
let _runNowDispatch = null;
function runNowDispatch() {
  _runNowDispatch ||= makeAgentDispatch({ taskType: 'scheduler-task', agent: 'scheduler-task', sourceType: 'scheduler' });
  return _runNowDispatch;
}

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
    async runScheduleNow(name) {
      const id = String(name || '').trim();
      const schedule = await getSchedule(id);
      if (!schedule) throw new Error(`schedule "${id}" does not exist`);
      if (!schedule.prompt) throw new Error(`schedule "${id}" has no instructions`);
      if (!schedule.model) throw new Error(`schedule "${id}" has no model configured — edit it and choose a model first`);
      const result = await runNowDispatch()({
        prompt: schedule.prompt,
        preset: parseScheduleModelRef(schedule.model),
        sourceName: schedule.name,
        ...(schedule.cwd ? { cwd: schedule.cwd } : {}),
      });
      return { name: schedule.name, ok: true, result: String(result || '') };
    },
  };
}
