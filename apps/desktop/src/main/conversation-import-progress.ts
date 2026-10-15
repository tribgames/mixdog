// While a conversation-import job is active, polls the runtime's job list at a
// bounded interval and publishes each changed snapshot as a desktop event.
import {
  CONVERSATION_IMPORT_PROGRESS_EVENT,
  isConversationImportJobActive,
  type ConversationImportJob,
} from '../shared/contract-import';

export const CONVERSATION_IMPORT_POLL_MS = 750;

interface Options {
  fetchJobs(): Promise<ConversationImportJob[]>;
  publish(name: string, job: ConversationImportJob): void;
  intervalMs?: number;
}

const isJob = (value: unknown): value is ConversationImportJob =>
  Boolean(value) && typeof value === 'object' && typeof (value as ConversationImportJob).jobId === 'string';

export function createConversationImportProgress({
  fetchJobs,
  publish,
  intervalMs = CONVERSATION_IMPORT_POLL_MS,
}: Options) {
  const published = new Map<string, string>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let polling = false;
  let disposed = false;

  const emit = (job: ConversationImportJob): boolean => {
    const stamp = `${job.seq}:${job.state}:${job.processed}`;
    if (published.get(job.jobId) !== stamp) {
      published.set(job.jobId, stamp);
      publish(CONVERSATION_IMPORT_PROGRESS_EVENT, job);
    }
    return isConversationImportJobActive(job);
  };

  const schedule = (): void => {
    if (timer || disposed) return;
    timer = setTimeout(() => {
      timer = null;
      void poll();
    }, intervalMs);
    timer.unref?.();
  };

  const poll = async (): Promise<void> => {
    if (polling || disposed) return;
    polling = true;
    try {
      const jobs = await fetchJobs();
      // Every job is published (a finished one once, with its final state).
      const active = jobs.map(emit).some(Boolean);
      if (active) schedule();
    } catch {
      // A failed read retries on the next tick while a job was being followed.
      schedule();
    } finally {
      polling = false;
    }
  };

  return {
    /** Sees the result of a capability call; a job in it starts or keeps the poll. */
    observe(capability: string, value: unknown): void {
      if (disposed) return;
      let jobs: unknown[] = [];
      if (capability === 'startConversationImport' || capability === 'cancelConversationImport') jobs = [value];
      else if (capability === 'getConversationImportJobs') {
        jobs = Array.isArray((value as { jobs?: unknown } | null)?.jobs) ? (value as { jobs: unknown[] }).jobs : [];
      } else return;
      const active = jobs.filter(isJob).map(emit).some(Boolean);
      if (active) schedule();
    },
    dispose(): void {
      disposed = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}
