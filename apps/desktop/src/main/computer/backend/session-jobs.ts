/** Cancellation is acknowledged only by a job which proved its worker stopped. */
export function createSessionJobs(waitMs = 6_000) {
  interface Job {
    cancel(): void;
    settled: Promise<boolean>;
  }
  const sessions = new Map<string, Set<Job>>();
  // Per session: how many jobs finished without proving their worker stopped.
  const unconfirmed = new Map<string, number>();
  return {
    sessionIds(): string[] {
      return [...new Set([...sessions.keys(), ...unconfirmed.keys()])];
    },
    releaseUnconfirmed(): number {
      if (sessions.size) return 0;
      let released = 0;
      for (const count of unconfirmed.values()) released += count;
      unconfirmed.clear();
      return released;
    },
    assertClear(): void {
      if (unconfirmed.size) {
        throw new Error(
          'privileged_worker_cleanup_unconfirmed: new input is blocked until the elevated worker is stopped and the desktop host is restarted'
        );
      }
    },
    begin(sessionId: string, cancel: () => void) {
      let resolve!: (confirmed: boolean) => void;
      const job: Job = {
        cancel,
        settled: new Promise((done) => {
          resolve = done;
        }),
      };
      const jobs = sessions.get(sessionId) || new Set<Job>();
      jobs.add(job);
      sessions.set(sessionId, jobs);
      let finished = false;
      return {
        finish(confirmed: boolean): void {
          if (finished) return;
          finished = true;
          if (!confirmed) unconfirmed.set(sessionId, (unconfirmed.get(sessionId) ?? 0) + 1);
          resolve(confirmed);
          jobs.delete(job);
          if (!jobs.size) sessions.delete(sessionId);
        },
      };
    },
    async cancel(sessionId: string): Promise<boolean> {
      if (unconfirmed.has(sessionId)) return false;
      const jobs = [...(sessions.get(sessionId) || [])];
      let signalled = true;
      for (const job of jobs) {
        try {
          job.cancel();
        } catch {
          signalled = false;
        }
      }
      if (!signalled) return false;
      if (!jobs.length) return true;
      let timer: NodeJS.Timeout | undefined;
      try {
        return await Promise.race([
          Promise.all(jobs.map((job) => job.settled)).then((results) => results.every(Boolean)),
          new Promise<boolean>((resolve) => {
            timer = setTimeout(() => resolve(false), waitMs);
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
  };
}
