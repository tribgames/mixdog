import { DESKTOP_CAPABILITIES, DESKTOP_READ_CAPABILITIES } from '../shared/contract-capabilities';

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
  'visualizePaneInline',
  // A phone's resume reads. As unknown-method barriers each one waited for
  // every in-flight read (a 3-6s usage sweep) and then ran one at a time,
  // holding the transcript's getSnapshot ~3s behind them.
  'readSettings',
  'readActivityRailPins',
  'readHostDisplayPreferences',
  'getUpdaterState',
  'viewerDevice',
  'getTaskWorkspace',
  'gitCliStatus',
  'libreOfficeStatus',
  // A control-session read (session-host-transport READ_CAPABILITIES). As an
  // unknown-method barrier it waited for a 3.7s catalog read and held the
  // thirteen resume reads queued after it.
  'getQuotaAutoResume',
]);

// The model catalog is 140 KB and takes seconds while a provider is slow or offline; in the general lane one boot-time load held 14 calls for 3.7s.
const CATALOG_READS = new Set(['listProviderModels']);

const SEARCH_READS = new Set(['searchProjectFiles']);

/** Read-only capabilities that sweep providers' quota APIs or the usage
 *  ledger (seconds per call): they ride the slow-read lane. */
const SLOW_READ_CAPABILITIES: ReadonlySet<string> = new Set([
  'getUsageDashboard',
  'getQuotaHistory',
  'getUsageStats',
  'getUsageRequests',
  // The agents panel's ledger read (3-6s per call, one per listed session):
  // in the general lane a burst of them took every slot and held the panel's
  // own listAgents / gitStatus reads ~2.5s behind them.
  'getSessionUsage',
]);
/** Lane key of a capability call naming one of {@link SLOW_READ_CAPABILITIES}. */
const SLOW_CAPABILITY_READ_CALL = 'readCapabilities:slow';

// A review row's own patch, keyed by capability at the dispatch site.
const REVIEW_FILE_PATCH_CALLS: ReadonlySet<string> = new Set([
  'invokeCapability:getSessionReviewFilePatch',
  'invokeCapability:getTurnReviewFilePatch',
]);

// Whole-Project index walks, text greps and document page renders take seconds, occasionally minutes.
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

// A transcription runs for seconds.
const VOICE_CALLS: ReadonlySet<string> = new Set([
  'invokeCapability:transcribeAudio',
  'invokeCapability:prepareTranscription',
]);

// A /btw side question waits on a whole model response and changes no state
// another call reads. As a general-lane barrier it would hold every later
// call — its own cancelSide included — so it runs in a lane of its own.
const SIDE_QUESTION_CALLS: ReadonlySet<string> = new Set(['invokeCapability:askSide']);
// Its cancel stays an ordinary general-lane call; queued under this key it
// also withdraws that session's side questions still waiting for a slot.
const SIDE_QUESTION_CANCEL_CALL = 'invokeCapability:cancelSide';

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

const supersedeWaiting = (waitingByKey: Map<string, Set<() => void>>, key: string): void => {
  const waiting = waitingByKey.get(key);
  waitingByKey.delete(key);
  for (const supersede of waiting || []) supersede();
};

// Withdrawn while it waits, either for a lane slot or for the mutations
// queued before it (`general`'s writes); a newer call under its key (or a
// cancel) supersedes it.
const runLatest = (
  general: CallLane,
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
  return {
    run(method: string, task: () => Promise<void>, call?: SideQuestionCall | LatestCall): Promise<void> {
      if (TERMINAL_METHODS.has(method)) return terminal.run(method, task);
      if (call && 'sessionId' in call && call.sessionId) {
        if (method === SIDE_QUESTION_CANCEL_CALL) supersedeWaiting(waitingSide, call.sessionId);
        else if (SIDE_QUESTION_CALLS.has(method))
          return runLatest(general, side, waitingSide, call.sessionId, method, task, call.superseded);
      }
      if (call && 'latest' in call && SEARCH_READS.has(method)) {
        return runLatest(general, search, waitingSearch, call.latest, method, task, call.superseded);
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

/** Node's answer to a search a newer query replaced before it started (remote-relay-client-calls.ts `SEARCH_SUPERSEDED`). */
const SEARCH_SUPERSEDED = 'Search superseded by a newer query.';

const queues = new WeakMap<object, ReturnType<typeof createRemoteCallQueue>>();

/** The queue of one phone connection (`host.ctx`): created with the first call, shared by every adapter. */
function callQueueFor(connection: object): ReturnType<typeof createRemoteCallQueue> {
  let queue = queues.get(connection);
  if (!queue) {
    queue = createRemoteCallQueue();
    queues.set(connection, queue);
  }
  return queue;
}

/** Node's answer to a /btw side question its session's cancel (or a newer side question) overtook (remote-relay-client-calls.ts). */
const SIDE_QUESTION_CANCELED = 'Side question canceled.';

const KNOWN_CAPABILITIES: ReadonlySet<string> = new Set(DESKTOP_CAPABILITIES);
const READ_CAPABILITIES: ReadonlySet<string> = new Set(DESKTOP_READ_CAPABILITIES);

/** Names the capabilities behind a capability call (remote-relay-client-calls.ts `callCapabilities`): only allow-listed names, never args. */
function callCapabilities(method: string, params: unknown): string[] {
  if (method !== 'invokeCapability' && method !== 'readCapabilities') return [];
  const input = Array.isArray(params) ? params[0] : undefined;
  const requests = Array.isArray(input) ? input : [input];
  return requests.slice(0, 8).map((request) => {
    const name = (request as { capability?: unknown } | null)?.capability;
    return typeof name === 'string' && KNOWN_CAPABILITIES.has(name) ? name : 'unknown';
  });
}

/** The per-minute call summary key: the method, plus its capability names (`remoteCallStatName`). */
function remoteCallStatName(method: string, params: unknown): string {
  const capabilities = callCapabilities(method, params);
  if (!capabilities.length) return method;
  const name = `${method}:${capabilities.join('+')}`;
  if (name === 'invokeCapability:getTurnReviewDiff') {
    const args = (Array.isArray(params) ? (params[0] as { args?: unknown } | null)?.args : null) as unknown;
    const options = Array.isArray(args) ? (args[0] as { known?: unknown } | null) : null;
    if (typeof options?.known === 'string') return `${name}+tagged`;
  }
  return name;
}

/** The lane key of a call: its method, or for a capability call the capability name when that capability rides a slow-read, voice or
 *  side-question lane (`remoteCallQueueKey`). */
function remoteCallQueueKey(method: string, statName: string): string {
  if (statName.startsWith('invokeCapability:getTurnReviewDiff')) return 'invokeCapability:getTurnReviewDiff';
  if (
    statName === 'invokeCapability:getTurnChanges' ||
    REVIEW_FILE_PATCH_CALLS.has(statName) ||
    VOICE_CALLS.has(statName) ||
    SIDE_QUESTION_CALLS.has(statName) ||
    statName === SIDE_QUESTION_CANCEL_CALL
  ) {
    return statName;
  }
  if (method === 'invokeCapability' || method === 'readCapabilities') {
    const capabilities = statName.slice(method.length + 1).split('+');
    if (capabilities.every((name) => READ_CAPABILITIES.has(name))) {
      return capabilities.some((name) => SLOW_READ_CAPABILITIES.has(name))
        ? SLOW_CAPABILITY_READ_CALL
        : 'readCapabilities';
    }
  }
  return method;
}

/** A file-name search's newest-wins scope: the same root and the same result shape (`searchLatestCall`). */
function searchLatestKey(method: string, params: unknown[]): string | undefined {
  if (method !== 'searchProjectFiles') return undefined;
  const [root, , limit, includeIgnored, includeDirectories] = params;
  return typeof root === 'string'
    ? JSON.stringify([root, limit ?? null, includeIgnored === true, includeDirectories === true])
    : undefined;
}

/** The user's Retry of a transcript that did not arrive (`prefetchSession` with `retry`): it ends the attach that is out and
 *  opens the thread again, so it is the one call that waits for nothing that may itself be waiting for that attach. */
export const replacesAttach = (method: string, params: readonly unknown[]): boolean =>
  method === 'prefetchSession' && (params[3] as { retry?: unknown } | null | undefined)?.retry === true;

/**
 * The one entry of a phone connection's calls into its queue, as Node's dispatch was (`remote-relay-client-calls.ts`, `callQueue.run`):
 * the router (remote-shim-protocol.ts) sends EVERY call of EVERY adapter through here, so a later chat mutation cannot overtake an
 * unfinished file mutation. The call's lane, its newest-wins search scope and its side-question session are read off the call itself,
 * as Node read them; `task` is the whole handler, its argument checks included, which run in the call's slot as Node's did.
 * A search or side question a newer one replaced before it started rejects with Node's text.
 * The one exception is the Retry of a transcript (`replacesAttach`), which runs beside the queue: any call ahead of it, a read
 * or a mutation, may hold its slot until the attach the Retry replaces is answered. It changes nothing on the core but the
 * thread's subscription.
 */
export function runQueued<T>(
  connection: object,
  method: string,
  params: unknown[],
  task: () => T | Promise<T>
): Promise<T> {
  if (replacesAttach(method, params)) return Promise.resolve().then(task);
  return new Promise<T>((resolve, reject) => {
    const run = async (): Promise<void> => {
      try {
        resolve(await task());
      } catch (error) {
        reject(error);
      }
    };
    const sideSessionId = (params[0] as { sessionId?: unknown } | null | undefined)?.sessionId;
    const latest = searchLatestKey(method, params);
    let call: SideQuestionCall | LatestCall | undefined;
    if (typeof sideSessionId === 'string' && sideSessionId)
      call = { sessionId: sideSessionId, superseded: async () => reject(new Error(SIDE_QUESTION_CANCELED)) };
    else if (latest !== undefined) call = { latest, superseded: async () => reject(new Error(SEARCH_SUPERSEDED)) };
    callQueueFor(connection)
      .run(remoteCallQueueKey(method, remoteCallStatName(method, params)), run, call)
      .catch(reject);
  });
}
