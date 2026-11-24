import { remoteConnectionInterruptedError } from './remote-connection-state';
import { markPartialCatalog } from '../shared/session-catalog';

export type ThreadRow = Record<string, unknown>;

/** The part of `ProtocolClient` the roster reads. */
export interface RosterClient {
  call(method: string, params: unknown): Promise<unknown>;
  on(listener: (event: { type: string; notification?: { method: string; params?: unknown } }) => void): () => void;
  readonly store: {
    subscribe(listener: (change: { type: string; feedId?: string; state?: string }) => void): () => void;
  };
}

const PAGE_LIMIT = 1000; // the core's largest `thread/list` page (thread_list.rs MAX_PAGE_LIMIT)
const idOf = (row: ThreadRow): string => String(row.id ?? '');
// Node's catalog order: byActivityThenId (catalog-db/schema.mjs:122 at b6f10295a), activity `lastUsedAt || updatedAt || 0`, ties by id in
// code-unit order; the core's `activityAt` is that activity (thread_edges.rs place_of).
const activityOf = (row: ThreadRow): number => Number(row.activityAt) || Number(row.updatedAt) || 0;
const inCatalogOrder = (a: ThreadRow, b: ThreadRow): number => {
  const byActivity = activityOf(b) - activityOf(a);
  if (byActivity) return byActivity;
  const [idA, idB] = [idOf(a), idOf(b)];
  if (idA < idB) return -1;
  return idA > idB ? 1 : 0;
};

/** The catalog clock's timers (the real ones outside a replay). */
export interface RosterTimers {
  now(): number;
  setTimeout(run: () => void, ms: number): unknown;
}

// Node's catalog clock (session-host-catalog.ts:10-11, 170-180 scheduleCatalogRefresh at b6f10295a): a store change republished the
// catalog after a 400 ms debounce, no sooner than 2 s after the last such refresh; changes meanwhile joined the one pending refresh.
export const STORE_REFRESH_DEBOUNCE_MS = 400;
export const STORE_REFRESH_MIN_GAP_MS = 2_000;
const realTimers: RosterTimers = { now: () => Date.now(), setTimeout: (run, ms) => setTimeout(run, ms) };

export function createRosterFeed<S>(options: {
  /** The sidebar projection of core rows (`summariesOfThreadRows`, main/protocol/thread-rows.ts). */
  summaries(rows: ThreadRow[]): S[];
  /** `ctx.sessionsCatalog`: what `subscribeSessions` listeners hear. */
  publish(rows: S[]): void;
  timers?: RosterTimers;
}) {
  const timers = options.timers ?? realTimers;
  let held = new Map<string, ThreadRow>();
  // What was last published (a refresh that changes nothing is not heard: remote-relay-catalog.ts:79-91 isNoListDelta).
  let shown = '';
  let refreshTimer: unknown = null;
  let refreshedAt = 0;
  const publishHeld = (): void => {
    if (retired || !known) return;
    const rows = project(held.values());
    const key = JSON.stringify(rows);
    if (key === shown) return;
    shown = key;
    options.publish(rows);
  };
  const scheduleRefresh = (): void => {
    if (refreshTimer) return;
    const delay = Math.max(STORE_REFRESH_DEBOUNCE_MS, STORE_REFRESH_MIN_GAP_MS - (timers.now() - refreshedAt));
    const mine = generation;
    refreshTimer = timers.setTimeout(() => {
      refreshTimer = null;
      if (mine !== generation && !known) return;
      refreshedAt = timers.now();
      publishHeld();
    }, delay);
  };
  let known = false;
  // Whether the page was ever handed a whole list by this feed: only before that does it have nothing to lose by a first page.
  let everKnown = false;
  let reading: Promise<S[]> | null = null;
  // The current read's first page (resolved only while the page has no list from this feed, and a later page is still to come).
  let firstPage: Promise<S[]> | null = null;
  // A first page was (or is about to be) handed to a caller: it is handed once, so every other read, a retry after a failed walk
  // included, is answered with a whole list or an error and never with page one again.
  let partialGiven = false;
  // Which listing is the current one: a snapshot (the core says changes were missed) or a reset (another pairing) ends the one before it.
  let generation = 0;
  let retired = false;
  // Edges since the read began (or, before any read, since the feed attached): they outrank the listing.
  const edges = new Map<string, ThreadRow | null>();
  // An archive change whose row the listing has not brought yet.
  const pendingArchive = new Map<string, boolean>();
  const project = (rows: Iterable<ThreadRow>): S[] => options.summaries([...rows].sort(inCatalogOrder));

  const apply = (target: Map<string, ThreadRow>, id: string, row: ThreadRow | null): void => {
    if (row) target.set(id, row);
    else target.delete(id);
  };

  /** `client` is the caller's own (a phone call's request carries that call's claim). */
  const list = (client: Pick<RosterClient, 'call'>, afresh = false): Promise<S[]> => {
    if (retired) return Promise.reject(remoteConnectionInterruptedError());
    if (reading && !afresh) return reading;
    if (afresh) {
      // What was seen before the gap is the new listing's to outrank, not to be laid over it.
      generation += 1;
      edges.clear();
      pendingArchive.clear();
    }
    const mine = generation;
    const superseded = (): Promise<S[]> => {
      if (retired) return Promise.reject(remoteConnectionInterruptedError());
      return (
        reading ??
        (known ? Promise.resolve(project(held.values())) : Promise.reject(remoteConnectionInterruptedError()))
      );
    };
    const first: { show?: (rows: S[]) => void; shown?: boolean } = {};
    firstPage = everKnown ? null : new Promise<S[]>((resolve) => (first.show = resolve));
    const read = (async () => {
      const listed = new Map<string, ThreadRow>();
      for (let cursor: string | undefined; ; ) {
        const page = (await client.call('thread/list', { limit: PAGE_LIMIT, ...(cursor ? { cursor } : {}) })) as {
          data?: ThreadRow[];
          nextCursor?: string;
        };
        if (mine !== generation) return superseded();
        for (const row of page.data ?? []) listed.set(idOf(row), row);
        if (!page.nextCursor) break;
        if (!cursor && first.show) {
          // The edges heard so far outrank the page, as they do the whole listing below.
          const early = new Map(listed);
          for (const [id, row] of edges) apply(early, id, row);
          for (const [id, flag] of pendingArchive) {
            const row = early.get(id);
            if (row && !edges.has(id)) early.set(id, { ...row, archived: flag });
          }
          first.show(project(early.values()));
          first.shown = true;
        }
        cursor = page.nextCursor;
      }
      // The read is over from here: a re-attachment announced after this point starts a read of its own, not this one's answer.
      reading = null;
      for (const [id, row] of edges) apply(listed, id, row);
      for (const [id, flag] of pendingArchive) {
        const row = listed.get(id);
        if (row && !edges.has(id)) listed.set(id, { ...row, archived: flag });
      }
      edges.clear();
      pendingArchive.clear();
      held = listed;
      known = true;
      everKnown = true;
      firstPage = null;
      const rows = project(held.values());
      shown = JSON.stringify(rows);
      options.publish(rows);
      return rows;
    })();
    reading = read;
    const done = (): void => {
      if (reading === read) reading = null;
    };
    read.then(done, () => {
      done();
      // A walk that failed before its first page was shown handed nothing out: the next read may still show one.
      if (!first.shown) partialGiven = false;
    });
    return read;
  };

  // The core announces an archive change by `thread/archived` / `thread/unarchived` alone (thread_edges.rs:12), never as a summary
  // edge, so it is a change of the one row's flag: laid over the held row, or over the row an earlier edge brought.
  const archiveOf =
    (archived: boolean) =>
    (was: ThreadRow | null | undefined): ThreadRow | null | undefined =>
      was ? { ...was, archived } : was;

  const onEdge = (method: string, params: Record<string, unknown>): void => {
    const thread = params.thread as ThreadRow | undefined;
    let flag: boolean | undefined;
    if (method === 'thread/archived') flag = true;
    else if (method === 'thread/unarchived') flag = false;
    const deleted = method === 'thread/deleted';
    let id = '';
    if (deleted || flag !== undefined) id = String(params.threadId ?? '');
    else if (thread) id = idOf(thread);
    if (!id) return;
    const row = deleted ? null : (thread ?? null);
    if (reading || !known) {
      if (flag === undefined) edges.set(id, row);
      else if (edges.has(id)) edges.set(id, archiveOf(flag)(edges.get(id)) ?? null);
      else pendingArchive.set(id, flag);
      return;
    }
    const was = held.get(id);
    const next = flag === undefined ? row : archiveOf(flag)(was);
    if (next === undefined || JSON.stringify(was) === JSON.stringify(next)) return; // CatalogChannel.publish skipped an unchanged roster
    apply(held, id, next);
    scheduleRefresh();
  };

  return {
    list,
    /** `list`, answered with the first page when the page has had no list from this feed yet and more pages follow: the page paints
     *  from it, and the whole list reaches it by `publish` when the read ends. Any other time (a refresh, a reconnect) the answer
     *  is the whole list, since the page treats a catalog it is handed as exact (a session missing from it was deleted). */
    listFirst(client: Pick<RosterClient, 'call'>): Promise<S[]> {
      const whole = list(client);
      if (!firstPage || partialGiven) return whole;
      partialGiven = true;
      // Marked, so the page takes it as rows to add and update and never as the list (shared/session-catalog.ts).
      return Promise.race([whole, firstPage.then(markPartialCatalog)]);
    },
    /** The list the roster holds while it is exact (a read is not under way and every attach has been read); undefined when it must be read. */
    current: (): S[] | undefined => (known && !reading ? project(held.values()) : undefined),
    /** The roster belongs to the client it is attached to: another pairing's client gets none of it. */
    retire(): void {
      retired = true;
      generation += 1;
      held = new Map();
      known = false;
      reading = null;
      firstPage = null;
      shown = '';
      edges.clear();
      pendingArchive.clear();
    },
    /** Node's host republished the catalog itself before answering these calls (session-host-lifecycle.ts:203, 231, 311, 336, 493,
     *  500, 576): the rows held now are published at once, the pending refresh still to come. */
    flush: publishHeld,
    /** Watches one connection's client; `listFor` is the read after its app feed is back (no caller's claim is involved). */
    attach(client: RosterClient): () => void {
      const offEvents = client.on((event) => {
        const n = event.notification;
        if (
          event.type === 'notification' &&
          n &&
          (n.method === 'thread/started' ||
            n.method === 'thread/summary/updated' ||
            n.method === 'thread/deleted' ||
            n.method === 'thread/archived' ||
            n.method === 'thread/unarchived')
        ) {
          onEdge(n.method, (n.params ?? {}) as Record<string, unknown>);
        }
      });
      const offStore = client.store.subscribe((change) => {
        // ppSnapshot names no feed (it is the app feed's own); a subscription change names it.
        if (change.type === 'subscription' && change.feedId !== 'app') return;
        if (change.type === 'subscription' && change.state === 'lost') {
          generation += 1;
          reading = null;
          known = false;
        }
        // A snapshot is the core's answer that it cannot continue the position the list stood at (a restart, a gap, a first attach):
        // the list is read, in pages, and what arrives meanwhile is laid over it. A replay is the changes since, and needs no read.
        else if (change.type === 'appSnapshot') {
          known = false;
          void list(client, true).catch(() => undefined); // a connection that ends mid-read is read again by the next reconnect
        } else if (change.type === 'subscription' && change.state === 'restored' && !known) {
          void list(client).catch(() => undefined);
        }
      });
      return () => {
        offEvents();
        offStore();
      };
    },
  };
}
