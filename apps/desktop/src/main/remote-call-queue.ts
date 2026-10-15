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
  'listHostDirectories',
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
  // Agent visualize panel: the tab list and pane byte ranges.
  'visualizeState',
  'visualizePaneRange',
]);

// A review row's own patch, keyed by capability at the dispatch site.
export const REVIEW_FILE_PATCH_CALLS: ReadonlySet<string> = new Set([
  'invokeCapability:getSessionReviewFilePatch',
  'invokeCapability:getTurnReviewFilePatch',
]);

// Read-only operations that may walk a whole Project index, grep its text or
// render document pages (seconds, occasionally minutes). They get their own bounded lane so
// stat/read/capability/submit calls are never queued behind them. They still
// observe every mutation queued before them; later mutations need not wait
// for them, because a search or preview has nothing a write could overtake.
const SLOW_READS = new Set([
  'searchProjectFiles',
  'searchWorkspaceText',
  // Full-text scan of every stored conversation (session_search schema).
  'searchSessionContent',
  'previewDocumentPages',
  // A visualize Office pane converts the document before answering.
  'visualizePaneFile',
  // GitHub CLI reads (gh process + GitHub API round trip). Observed at 20s as
  // an unknown-method barrier, holding Settings reads ~10s behind it.
  'githubCliStatus',
  'githubCliAccount',
  'ghPrList',
  'ghPrView',
  'ghPrDiff',
  // Keyed by capability at the dispatch site: a worktree diff read, and a
  // turn's recorded changes (its patch text can be large).
  'invokeCapability:getTurnReviewDiff',
  'invokeCapability:getTurnChanges',
  // Review panel reads: each walks or diffs the worktree (a git process per
  // call, many per refresh), so a snapshot read must not wait behind them.
  'gitReview',
  'gitReviewDiff',
  'gitReviewDiffs',
  ...[...REVIEW_FILE_PATCH_CALLS],
]);

// Dictation (keyed by capability at the dispatch site). A transcription runs
// for seconds; as a general-lane barrier it waited for every in-flight read
// and then held every later call. Neither touches state another call reads,
// so they share their own lane and only observe mutations queued before them.
export const VOICE_CALLS: ReadonlySet<string> = new Set([
  'invokeCapability:transcribeAudio',
  'invokeCapability:prepareTranscription',
]);

// A /btw side question waits on a whole model response and changes no state
// another call reads. As a general-lane barrier it would hold every later
// call — its own cancelSide included — so it runs in a lane of its own.
export const SIDE_QUESTION_CALLS: ReadonlySet<string> = new Set(['invokeCapability:askSide']);
// Its cancel stays an ordinary general-lane call; queued under this key it
// also withdraws that session's side questions still waiting for a slot.
export const SIDE_QUESTION_CANCEL_CALL = 'invokeCapability:cancelSide';

/** The session a /btw call belongs to, and how a queued side question that a
 *  cancel or a newer side question of that session superseded before it
 *  started is answered (it never runs). */
export type SideQuestionCall = { sessionId: string; superseded?: () => Promise<void> };

const TERMINAL_METHODS = new Set(['termEnsure', 'termProfiles', 'termWrite', 'termResize', 'termDispose']);

export function createRemoteCallQueue(concurrency = 4, slowConcurrency = 2, voiceConcurrency = 2) {
  const general = createCallLane(concurrency);
  const slow = createCallLane(slowConcurrency);
  const voice = createCallLane(voiceConcurrency);
  const side = createCallLane(2);
  const terminal = createCallLane(1);
  // sessionId -> supersede hooks of that session's side questions not yet started.
  const waitingSide = new Map<string, Set<() => void>>();
  const supersedeSide = (sessionId: string): void => {
    const waiting = waitingSide.get(sessionId);
    waitingSide.delete(sessionId);
    for (const supersede of waiting || []) supersede();
  };
  // A side question of a known session: withdrawn while it waits, either for
  // a side slot or for the mutations queued before it.
  const runSideQuestion = (method: string, task: () => Promise<void>, call: SideQuestionCall): Promise<void> => {
    supersedeSide(call.sessionId);
    const writes = general.writesSettled();
    return new Promise<void>((resolve, reject) => {
      let state: 'waiting' | 'started' | 'superseded' = 'waiting';
      const supersede = (): void => {
        if (state !== 'waiting') return;
        state = 'superseded';
        Promise.resolve()
          .then(call.superseded)
          .then(() => resolve(), reject);
      };
      const waiting = waitingSide.get(call.sessionId) || new Set<() => void>();
      waiting.add(supersede);
      waitingSide.set(call.sessionId, waiting);
      side
        .run(method, async () => {
          await writes;
          if (state !== 'waiting') return;
          state = 'started';
          waiting.delete(supersede);
          if (!waiting.size && waitingSide.get(call.sessionId) === waiting) waitingSide.delete(call.sessionId);
          await task();
        })
        .then(
          () => {
            if (state === 'started') resolve();
          },
          (error: unknown) => {
            if (state === 'superseded') return;
            waiting.delete(supersede);
            reject(error);
          }
        );
    });
  };
  return {
    run(method: string, task: () => Promise<void>, sideCall?: SideQuestionCall): Promise<void> {
      if (TERMINAL_METHODS.has(method)) return terminal.run(method, task);
      if (sideCall?.sessionId) {
        if (method === SIDE_QUESTION_CANCEL_CALL) supersedeSide(sideCall.sessionId);
        else if (SIDE_QUESTION_CALLS.has(method)) return runSideQuestion(method, task, sideCall);
      }
      let lane: typeof general | null = null;
      if (SLOW_READS.has(method)) lane = slow;
      else if (VOICE_CALLS.has(method)) lane = voice;
      else if (SIDE_QUESTION_CALLS.has(method)) lane = side;
      if (!lane) return general.run(method, task);
      const writes = general.writesSettled();
      return lane.run(method, async () => {
        await writes;
        await task();
      });
    },
    close(): void {
      general.close();
      slow.close();
      voice.close();
      side.close();
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
      const read =
        PARALLEL_READS.has(method) ||
        SLOW_READS.has(method) ||
        VOICE_CALLS.has(method) ||
        SIDE_QUESTION_CALLS.has(method);
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
