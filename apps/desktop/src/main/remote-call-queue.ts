// Only explicitly read-only operations may overlap. Unknown methods and all
// mutations are barriers: reads after a write observe that write, and writes
// never overtake an earlier operation or replay on recovery.
const PARALLEL_READS = new Set([
  'getSnapshot', 'listProjects', 'listSessions', 'listAgentPool',
  'listProjectDir', 'readProjectFile', 'statProjectFile', 'searchProjectFiles',
  'previewDocumentPages',
  'gitStatus', 'gitDiff', 'gitLog', 'gitBranches', 'gitShow', 'gitShowDiff',
]);

export function createRemoteCallQueue(concurrency = 4) {
  type Entry = {
    read: boolean;
    run: () => Promise<void>;
    resolve: () => void;
    reject: (error: unknown) => void;
  };
  const queued: Entry[] = [];
  let active = 0;
  let writing = false;
  let closed = false;
  const pump = (): void => {
    if (closed || writing) return;
    while (queued.length && active < concurrency) {
      const next = queued[0];
      if (!next.read && active > 0) return;
      queued.shift();
      active += 1;
      writing = !next.read;
      void Promise.resolve().then(next.run).then(next.resolve, next.reject).finally(() => {
        active -= 1;
        writing = false;
        pump();
      });
      if (writing) return;
    }
  };
  return {
    run(method: string, task: () => Promise<void>): Promise<void> {
      if (closed) return Promise.reject(new Error('Remote client disconnected.'));
      const result = new Promise<void>((resolve, reject) => {
        queued.push({ read: PARALLEL_READS.has(method), run: task, resolve, reject });
      });
      pump();
      return result;
    },
    close(): void {
      closed = true;
      for (const entry of queued.splice(0)) entry.reject(new Error('Remote client disconnected.'));
    },
  };
}
