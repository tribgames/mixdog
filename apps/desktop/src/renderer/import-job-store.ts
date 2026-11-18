// Outlives the dialog: keeps each finished import until dismissed, newest first on reopen.
import type { DesktopApi } from '../shared/contract';
import { isConversationImportJobActive, type ConversationImportJob } from '../shared/contract-import';
import { IMPORT_CATALOGS_CHANGED_EVENT } from './import-conversation-events';
import { isKnownProject } from './settings/import-conversations-model';

type StoreApi = Partial<Pick<DesktopApi, 'subscribeConversationImportProgress' | 'listProjects' | 'addProject'>>;

function createImportJobStore(getApi: () => StoreApi | undefined) {
  const finished = new Map<string, ConversationImportJob>();
  const handled = new Set<string>();
  const acknowledged = new Set<string>();
  const listeners = new Set<() => void>();
  let unsubscribe: (() => void) | undefined;
  const emit = () => {
    for (const listener of listeners) listener();
  };

  async function registerProjects(api: StoreApi, job: ConversationImportJob) {
    const paths = [
      ...new Set(
        job.byProject
          .filter((entry) => entry.imported > 0 && entry.projectPath)
          .map((entry) => entry.projectPath as string)
      ),
    ];
    if (!paths.length || !api.listProjects || !api.addProject) return;
    try {
      const known = await api.listProjects();
      for (const path of paths) {
        if (!isKnownProject(known, path)) await api.addProject(path);
      }
    } catch {
      /* a missing folder still leaves the sessions under their recorded path */
    }
    if (typeof window !== 'undefined') window.dispatchEvent(new Event(IMPORT_CATALOGS_CHANGED_EVENT));
  }

  function observe(api: StoreApi, job: ConversationImportJob) {
    if (isConversationImportJobActive(job)) return;
    const previous = finished.get(job.jobId);
    if (previous && previous.seq >= job.seq) return;
    if (!acknowledged.has(job.jobId)) {
      finished.delete(job.jobId);
      finished.set(job.jobId, job);
      emit();
    }
    if (handled.has(job.jobId)) return;
    handled.add(job.jobId);
    void registerProjects(api, job);
  }

  return {
    /** Subscribes to progress once; safe to call repeatedly. */
    start() {
      const api = getApi();
      if (unsubscribe || !api?.subscribeConversationImportProgress) return;
      unsubscribe = api.subscribeConversationImportProgress((job) => observe(api, job));
    },
    observe,
    get: () => Array.from(finished.values()).pop() ?? null,
    /** Drops only the outcome the user has seen. */
    acknowledge(jobId: string) {
      // The start response or a reread may have delivered the outcome before the app feed.
      acknowledged.add(jobId);
      if (finished.delete(jobId)) emit();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose() {
      unsubscribe?.();
      unsubscribe = undefined;
      finished.clear();
      handled.clear();
      acknowledged.clear();
    },
  };
}

export const importJobStore = createImportJobStore(() =>
  typeof window === 'undefined' ? undefined : (window as unknown as { mixdogDesktop?: StoreApi }).mixdogDesktop
);

export const startImportJobStore = () => importJobStore.start();
