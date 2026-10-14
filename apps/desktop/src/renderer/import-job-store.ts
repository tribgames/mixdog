// Outlives the import dialog: remembers the latest finished import job until the
// user dismisses it, and registers the projects a finished import brought in.
import type { DesktopApi } from '../shared/contract';
import { isConversationImportJobActive, type ConversationImportJob } from '../shared/contract-import';
import { IMPORT_CATALOGS_CHANGED_EVENT } from './import-conversation-events';
import { isKnownProject } from './settings/import-conversations-model';

type StoreApi = Partial<Pick<DesktopApi, 'subscribeConversationImportProgress' | 'listProjects' | 'addProject'>>;

export function createImportJobStore(getApi: () => StoreApi | undefined) {
  let finished: ConversationImportJob | null = null;
  const handled = new Set<string>();
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
    if (finished?.jobId === job.jobId && finished.seq > job.seq) return;
    finished = job;
    emit();
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
    get: () => finished,
    /** Drops the finished job (if it is that one) once the user has seen it. */
    acknowledge(jobId: string) {
      if (finished?.jobId !== jobId) return;
      finished = null;
      emit();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose() {
      unsubscribe?.();
      unsubscribe = undefined;
      finished = null;
      handled.clear();
    },
  };
}

export const importJobStore = createImportJobStore(() =>
  typeof window === 'undefined' ? undefined : (window as unknown as { mixdogDesktop?: StoreApi }).mixdogDesktop
);

export const startImportJobStore = () => importJobStore.start();
