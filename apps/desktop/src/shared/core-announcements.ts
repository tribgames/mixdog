import { CONVERSATION_IMPORT_PROGRESS_EVENT } from './contract-import';
import { PROVIDER_MODELS_EVENT, readProviderModelsChange } from './provider-models';
import { readSettingsChange, SETTINGS_CHANGED_EVENT } from './settings-changed';

/** The desktop event Node raised for the core notification `method(params)`, or null for any other notification. */
export function announcedEvent(method: string, params: unknown): { name: string; value: unknown } | null {
  if (method === 'import/progress/updated') {
    const job = params && typeof params === 'object' && 'job' in params ? params.job : null;
    if (!job || typeof job !== 'object' || !('jobId' in job) || typeof job.jobId !== 'string') return null;
    if (!('seq' in job) || typeof job.seq !== 'number' || !('state' in job) || typeof job.state !== 'string')
      return null;
    if (!('results' in job) || !Array.isArray(job.results) || !('byProject' in job) || !Array.isArray(job.byProject)) {
      return null;
    }
    return { name: CONVERSATION_IMPORT_PROGRESS_EVENT, value: job };
  }
  if (method === 'ui/settings/changed') {
    const change = readSettingsChange(params);
    return change ? { name: SETTINGS_CHANGED_EVENT, value: change } : null;
  }
  if (method === 'ui/providerModels/changed') {
    const change = readProviderModelsChange(params);
    return change ? { name: PROVIDER_MODELS_EVENT, value: change } : null;
  }
  return null;
}
