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
  // A phone's resume reads. As unknown-method barriers each one waited for
  // every in-flight read (a 3-6s usage sweep) and then ran one at a time,
  // holding the transcript's getSnapshot ~3s behind them.
  'readSettings',
  'readActivityRailPins',
  'readHostDisplayPreferences',
  'getUpdaterState',
  'viewerDevice',
  'gitCliStatus',
  'libreOfficeStatus',
  // A control-session read (session-host-transport READ_CAPABILITIES). As an
  // unknown-method barrier it waited for a 3.7s catalog read and held the
  // thirteen resume reads queued after it.
  'getQuotaAutoResume',
]);

// The model catalog (140 KB, seconds while a provider is slow or offline).
// As a general-lane read it fenced every mutation queued after it, and every
// read behind that mutation: one boot-time load held 14 calls for 3.7s. It
// observes mutations queued before it; later ones need not wait for it.
const CATALOG_READS = new Set(['listProviderModels']);

// Keystroke-driven file-name searches: their own lane, so a review or usage
// sweep in the slow lane never holds the newest query. A call queued with a
// `latest` key is withdrawn when a newer call under the same key arrives
// before it started (newest query wins).
const SEARCH_READS = new Set(['searchProjectFiles']);

/** Read-only capabilities that sweep providers' quota APIs or the usage
 *  ledger (seconds per call): they ride the slow-read lane. */
export const SLOW_READ_CAPABILITIES: ReadonlySet<string> = new Set([
  'getUsageDashboard',
  'getQuotaHistory',
  'getUsageStats',
]);
/** Lane key of a capability call naming one of {@link SLOW_READ_CAPABILITIES}. */
export const SLOW_CAPABILITY_READ_CALL = 'readCapabilities:slow';

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
  'searchWorkspaceText',
  // Full-text scan of every stored conversation (session_search schema).
  'searchSessionContent',
  'previewDocumentPages',
  // A visualize Office pane converts the document before answering.
  'visualizePaneFile',
  // Visualize page images (rasterized) and PNG/PDF exports (rendered in a
  // hidden window into a temp file; nothing in the project changes).
  'visualizePanePages',
  'visualizeExport',
  // GitHub CLI reads (gh process + GitHub API round trip). Observed at 20s as
  // an unknown-method barrier, holding Settings reads ~10s behind it.
  'githubCliStatus',
  'githubCliAccount',
  // Stats files (possibly on network shares) and may search transcripts for a
  // linking reply; its only effect is an in-memory file grant. Seen at 186s as
  // a barrier, holding submitToSession/readSettings behind it.
  'resolveLocalPaths',
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
  SLOW_CAPABILITY_READ_CALL,
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

/** A search call's identity for newest-wins: a queued call under the same key
 *  that has not started yet is answered by `superseded` and never runs. */
export type LatestCall = { latest: string; superseded?: () => Promise<void> };

const TERMINAL_METHODS = new Set([
  'termEnsure',
  'termAttach',
  'termProfiles',
  'termWrite',
  'termResize',
  'termDispose',
]);

type CallLane = ReturnType<typeof createCallLane>;

export function createRemoteCallQueue(
  concurrency = 4,
  slowConcurrency = 2,
  voiceConcurrency = 2,
  searchConcurrency = 2
) {
  const general = createCallLane(concurrency);
  const slow = createCallLane(slowConcurrency);
  const voice = createCallLane(voiceConcurrency);
  const side = createCallLane(2);
  const catalog = createCallLane(2);
  const search = createCallLane(searchConcurrency);
  const terminal = createCallLane(1);
  // key -> supersede hooks of the calls under that key not yet started: a
  // session's side questions, or one search scope's queries.
  const waitingSide = new Map<string, Set<() => void>>();
  const waitingSearch = new Map<string, Set<() => void>>();
  const supersedeWaiting = (waitingByKey: Map<string, Set<() => void>>, key: string): void => {
    const waiting = waitingByKey.get(key);
    waitingByKey.delete(key);
    for (const supersede of waiting || []) supersede();
  };
  // Withdrawn while it waits, either for a lane slot or for the mutations
  // queued before it; a newer call under its key (or a cancel) supersedes it.
  const runLatest = (
    lane: CallLane,
    waitingByKey: Map<string, Set<() => void>>,
    key: string,
    method: string,
    task: () => Promise<void>,
    superseded: (() => Promise<void>) | undefined
  ): Promise<void> => {
    supersedeWaiting(waitingByKey, key);
    const writes = general.writesSettled();
    return new Promise<void>((resolve, reject) => {
      let state: 'waiting' | 'started' | 'superseded' = 'waiting';
      const supersede = (): void => {
        if (state !== 'waiting') return;
        state = 'superseded';
        Promise.resolve()
          .then(superseded)
          .then(() => resolve(), reject);
      };
      const waiting = waitingByKey.get(key) || new Set<() => void>();
      waiting.add(supersede);
      waitingByKey.set(key, waiting);
      lane
        .run(method, async () => {
          await writes;
          if (state !== 'waiting') return;
          state = 'started';
          waiting.delete(supersede);
          if (!waiting.size && waitingByKey.get(key) === waiting) waitingByKey.delete(key);
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
    run(method: string, task: () => Promise<void>, call?: SideQuestionCall | LatestCall): Promise<void> {
      if (TERMINAL_METHODS.has(method)) return terminal.run(method, task);
      if (call && 'sessionId' in call && call.sessionId) {
        if (method === SIDE_QUESTION_CANCEL_CALL) supersedeWaiting(waitingSide, call.sessionId);
        else if (SIDE_QUESTION_CALLS.has(method))
          return runLatest(side, waitingSide, call.sessionId, method, task, call.superseded);
      }
      if (call && 'latest' in call && SEARCH_READS.has(method)) {
        return runLatest(search, waitingSearch, call.latest, method, task, call.superseded);
      }
      let lane: CallLane | null = null;
      if (SLOW_READS.has(method)) lane = slow;
      else if (VOICE_CALLS.has(method)) lane = voice;
      else if (SIDE_QUESTION_CALLS.has(method)) lane = side;
      else if (CATALOG_READS.has(method)) lane = catalog;
      else if (SEARCH_READS.has(method)) lane = search;
      if (!lane) return general.run(method, task);
      const writes = general.writesSettled();
      return lane.run(method, async () => {
        await writes;
        await task();
      });
    },
    /** Test/diagnostic seam: calls queued and running in every lane, and the
     *  newest-wins keys still holding waiting calls. */
    stats(): { queued: number; active: number; waitingKeys: number } {
      let queued = 0;
      let active = 0;
      for (const lane of [general, slow, voice, side, catalog, search, terminal]) {
        const counts = lane.stats();
        queued += counts.queued;
        active += counts.active;
      }
      return { queued, active, waitingKeys: waitingSide.size + waitingSearch.size };
    },
    close(): void {
      general.close();
      slow.close();
      voice.close();
      side.close();
      catalog.close();
      search.close();
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
        CATALOG_READS.has(method) ||
        SEARCH_READS.has(method) ||
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
    stats(): { queued: number; active: number } {
      return { queued: queued.length, active };
    },
    close(): void {
      closed = true;
      for (const entry of queued.splice(0)) entry.reject(new Error('Remote client disconnected.'));
    },
  };
}
