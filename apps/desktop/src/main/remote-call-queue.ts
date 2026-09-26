// Only explicitly read-only operations may overlap within the general lane.
// Terminal lifecycle/input operations have their own ordered lane so unrelated
// filesystem, voice, or session work cannot hold a keystroke behind it.
// Unknown methods and all other
// mutations are barriers: reads after a write observe that write, and writes
// never overtake an earlier operation or replay on recovery.
const PARALLEL_READS = new Set([
  'getSnapshot',
  'listProjects',
  'listSessions',
  'listAgentPool',
  // The catalog read is 140 KB and takes seconds while a turn runs; as a
  // barrier it held the transcript's getSnapshot behind it.
  'listProviderModels',
  'listProjectDir',
  'readProjectFile',
  'statProjectFile',
  // Validated to read-only capabilities (ipc-validation) and served by the
  // control session's read path, so it need not fence later calls.
  'readCapabilities',
  'gitStatus',
  'gitDiff',
  'gitLog',
  'gitBranches',
  'gitShow',
  'gitShowDiff',
]);

// Read-only operations that may walk a whole Project index, grep its text or
// render document pages (seconds, occasionally minutes). They get their own bounded lane so
// stat/read/capability/submit calls are never queued behind them. They still
// observe every mutation queued before them; later mutations need not wait
// for them, because a search or preview has nothing a write could overtake.
const SLOW_READS = new Set(['searchProjectFiles', 'searchWorkspaceText', 'previewDocumentPages']);

const TERMINAL_METHODS = new Set(['termEnsure', 'termProfiles', 'termWrite', 'termResize', 'termDispose']);

export function createRemoteCallQueue(concurrency = 4, slowConcurrency = 2) {
  const general = createCallLane(concurrency);
  const slow = createCallLane(slowConcurrency);
  const terminal = createCallLane(1);
  return {
    run(method: string, task: () => Promise<void>): Promise<void> {
      if (TERMINAL_METHODS.has(method)) return terminal.run(method, task);
      if (!SLOW_READS.has(method)) return general.run(method, task);
      const writes = general.writesSettled();
      return slow.run(method, async () => {
        await writes;
        await task();
      });
    },
    close(): void {
      general.close();
      slow.close();
      terminal.close();
    },
  };
}

function createCallLane(concurrency: number) {
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
  // Settles once every mutation queued so far has finished or been dropped.
  let lastWrite: Promise<void> = Promise.resolve();
  const pump = (): void => {
    if (closed || writing) return;
    while (queued.length && active < concurrency) {
      const next = queued[0];
      if (!next.read && active > 0) return;
      queued.shift();
      active += 1;
      writing = !next.read;
      void Promise.resolve()
        .then(next.run)
        .then(next.resolve, next.reject)
        .finally(() => {
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
      const read = PARALLEL_READS.has(method) || SLOW_READS.has(method);
      const result = new Promise<void>((resolve, reject) => {
        queued.push({ read, run: task, resolve, reject });
      });
      if (!read) {
        lastWrite = result.then(
          () => undefined,
          () => undefined
        );
      }
      pump();
      return result;
    },
    writesSettled(): Promise<void> {
      return lastWrite;
    },
    close(): void {
      closed = true;
      for (const entry of queued.splice(0)) entry.reject(new Error('Remote client disconnected.'));
    },
  };
}
