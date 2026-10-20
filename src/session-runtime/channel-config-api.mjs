import {
  channelSetup,
  deleteSchedule,
  deleteWebhook,
  getWebhookSecret,
  saveSchedule,
  saveWebhook,
  setScheduleEnabled,
  setWebhookEnabled,
  setWebhookConfigAsync,
  testWebhook,
} from './services/channel-admin.mjs';
import { getSchedule, markScheduleFailure, markScheduleSuccess } from '../runtime/channels/lib/schedules-db.mjs';
import { loadEndpointConfig, readEndpointLastPayload } from '../runtime/channels/lib/webhooks-db.mjs';
import { webhookEventSummary, webhookRunPrompt } from '../runtime/channels/lib/webhook/session-dispatch.mjs';
import { runScheduleSession } from './schedule-session-run.mjs';
import { runWebhookSession } from './webhook-session-run.mjs';
import { retryRoutineDelivery } from './owned-automation-run.mjs';

/** Why a "Run now" did not run: its owner bot is missing, or a run is going. */
function skippedRunMessage(name, outcome) {
  if (outcome.reason === 'owner') return `"${name}" is paused: ${outcome.message}`;
  return `"${name}" is still running; this run was skipped`;
}

// Webhook/schedule config surface. The mutating admin helpers are imported
// directly here and the runtime injects only the closure-owned callbacks
// (channel worker handle, soft reload).
export function createChannelConfigApi({ channels, reloadChannelsSoon, ensureAutomationRuntime = () => {} }) {
  return {
    async getChannelSetup() {
      return channelSetup();
    },
    getChannelWorkerStatus() {
      return channels.status();
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
    // Signed test request to the public URL; no dispatch, no worker reload.
    async testWebhook(name) {
      return testWebhook(name);
    },
    async runScheduleNow(name) {
      const id = String(name || '').trim();
      const schedule = await getSchedule(id);
      if (!schedule) throw new Error(`schedule "${id}" does not exist`);
      // Runs in the engine process as a turn in the owner bot's chat, so it
      // works even while the channels worker is off.
      let outcome;
      try {
        // Asked for by a person: no failure backoff.
        outcome = await runScheduleSession(schedule, { attended: true });
      } catch (error) {
        await markScheduleFailure(schedule.name, new Date()).catch(() => {});
        throw error;
      }
      if (outcome.skipped) throw new Error(skippedRunMessage(schedule.name, outcome));
      // The run's outcome shows as the schedule's last run, like a timed fire.
      await markScheduleSuccess(schedule.name, new Date()).catch(() => {});
      return { name: schedule.name, ok: true, sessionId: outcome.sessionId, result: outcome.result };
    },
    // Re-runs the endpoint on its latest received payload, with its current
    // instructions, behind the same untrusted-data fence as a live delivery.
    async runWebhookNow(name) {
      const id = String(name || '').trim();
      const endpoint = await loadEndpointConfig(id);
      if (!endpoint) throw new Error(`webhook "${id}" does not exist`);
      const payload = await readEndpointLastPayload(id);
      if (!payload) throw new Error(`webhook "${id}" has not received a payload yet`);
      const run = webhookRunPrompt(endpoint.instructions, payload.body ?? {}, payload.headers ?? {});
      const outcome = await runWebhookSession(
        {
          name: endpoint.name,
          ownerAgentId: endpoint.ownerAgentId,
          cwd: endpoint.cwd || null,
          attachments: endpoint.attachments || null,
          event: webhookEventSummary(payload.headers ?? {}, payload.body ?? {}),
          prompt: run.prompt,
          skillSelection: run.skillSelection,
        },
        { attended: true }
      );
      if (outcome.skipped) throw new Error(skippedRunMessage(endpoint.name, outcome));
      return { name: endpoint.name, ok: true, sessionId: outcome.sessionId, result: outcome.result };
    },
    // Queues again the result a finished run could not deliver; never reruns it.
    async retryRoutineDelivery(kind, name) {
      return retryRoutineDelivery(kind, String(name || '').trim());
    },
  };
}
