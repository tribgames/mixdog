// The core's announcements of Node's desktop events between UI peers: Node's desktop service broadcast `settings-changed` and
// `provider-models-changed` to its windows (ipc-state-bridge.ts:113-114) and to every paired device (remote-relay-push-lanes.ts
// :53-54); the core publishes them on the app feed to every client, which turns each into the same event here (the desktop's
// windows: protocol/desktop-operation-route.ts `watchAnnouncements`; a phone's page: renderer/remote-protocol-settings.ts).
import { CONVERSATION_IMPORT_PROGRESS_EVENT } from './contract-import';
import { PROVIDER_MODELS_EVENT, readProviderModelsChange } from './provider-models';
import { readSettingsChange, SETTINGS_CHANGED_EVENT } from './settings-changed';

/** The desktop event Node raised for the core notification `method(params)`, or null for any other notification. */
export function announcedEvent(method: string, params: unknown): { name: string; value: unknown } | null {
  if (method === 'import/progress/updated') {
    const job = params && typeof params === 'object' && 'job' in params ? params.job : null;
    if (!job || typeof job !== 'object' || !('jobId' in job) || typeof job.jobId !== 'string') return null;
    if (!('seq' in job) || typeof job.seq !== 'number' || !('state' in job) || typeof job.state !== 'string') return null;
    if (!('results' in job) || !Array.isArray(job.results) || !('byProject' in job) || !Array.isArray(job.byProject)) {
      return null;
    }
    return { name: CONVERSATION_IMPORT_PROGRESS_EVENT, value: job };
  }
  const change =
    method === 'ui/settings/changed'
      ? readSettingsChange(params)
      : method === 'ui/providerModels/changed'
        ? readProviderModelsChange(params)
        : null;
  if (!change) return null;
  return { name: method === 'ui/settings/changed' ? SETTINGS_CHANGED_EVENT : PROVIDER_MODELS_EVENT, value: change };
}
