// Production client for the frozen API (api.ts); the shared conformance suite (conformance/*.json) runs against it.
// Each feed folds on its own promise chain, so a slow blob read on one thread never delays another thread or the app feed.
import type {
  AppSnapshotParams,
  BlobDescriptor,
  BlobRef,
  CallOptions,
  ClientError,
  ClientErrorDetail,
  ClientEvent,
  Connect,
  ConnectOptions,
  ConnectionStatus,
  ErrorData,
  FeedStamp,
  FoldStore,
  InitializeResponse,
  Json,
  JsonRpcErrorBody,
  JsonRpcNotification,
  LadderConfig,
  MethodInfo,
  ProtocolClient,
  RequestClass,
  RequestId,
  ResumeOptions,
  ResumeWindow,
  SectionEntry,
  SectionUpdate,
  ServerRequest,
  ServerRequestAnswer,
  ServerRequestResolvedParams,
  StoreChange,
  ThreadFold,
  ThreadReducer,
  ThreadResumeResponse,
  ThreadSubscription,
  TransportSink,
  TransportWriter,
  SentClaim,
  StreamPosition,
} from './api.ts';
import type { FeedHeadsResponse, OpStatusEntry } from '@mixdog/protocol';
import { DEFAULT_LADDER, WIRE } from './api.ts';
import { isOfferedRequest, isScopedMethod, isSectionMethod, methodInfo } from './method-table.ts';
import { createLinkLog } from './link-log.mjs';
import { DEFAULT_REQUEST_TIMEOUT_MS } from './request-limits.ts';
import { LinkHealth } from './health.ts';
import { isObj } from './obj.ts';

// ───────────────────────────── pure helpers ─────────────────────────────

/** Full jitter: uniform in [0, min(cap, base·2^attempt)). `unit` is uniform in [0, 1). */
export function ladderDelay(attempt: number, unit: number, cfg: LadderConfig = DEFAULT_LADDER): number {
  return Math.floor(unit * Math.min(cfg.capMs, cfg.baseMs * 2 ** attempt));
}

export function uuidv7(nowMs: number): string {
  const b = crypto.getRandomValues(new Uint8Array(16));
  let t = nowMs;
  for (let i = 5; i >= 0; i--) {
    b[i] = t % 256;
    t = Math.floor(t / 256);
  }
  b[6] = (b[6]! & 0x0f) | 0x70;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** `{"blob":{…}}` with no sibling members. */
export function isBlobStub(v: unknown): v is BlobRef {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const keys = Object.keys(v);
  if (keys.length !== 1 || keys[0] !== 'blob') return false;
  const b = (v as { blob: Record<string, unknown> }).blob;
  return typeof b === 'object' && b !== null && typeof b.digest === 'string' && typeof b.bytes === 'number' && typeof b.mediaType === 'string';
}

/** Text blobs replace their stub with the decoded string; other media stay stubs and are read on demand with `readBlob`. */
export function isTextMedia(mediaType: string): boolean {
  return mediaType.startsWith('text/') || mediaType === 'application/json';
}

/** `BufferSource` as the environment's own `crypto.subtle` declares it (the DOM lib is absent in some tsconfigs, and newer
 * lib versions reject a `Uint8Array<ArrayBufferLike>` there). */
type DigestInput = Parameters<typeof crypto.subtle.digest>[1];

const fromB64 = (s: string): Uint8Array => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const toB64 = (b: Uint8Array): string => {
  let s = '';
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s);
};

// ───────────────────────────── errors ─────────────────────────────

export class ClientFailure extends Error implements ClientError {
  readonly detail: ClientErrorDetail;
  constructor(detail: ClientErrorDetail) {
    super(
      detail.kind === 'rpc'
        ? `${detail.code} ${detail.reason ?? ''} ${detail.message}${refusedArgument(detail.data)}`
        : detail.kind === 'requestTimeout'
          ? `The core did not answer ${detail.method} in time.`
          : detail.kind
    );
    this.name = 'ClientError';
    this.detail = detail;
  }
}
const fail = (detail: ClientErrorDetail): ClientFailure => new ClientFailure(detail);

/** A refused argument's sentence, for the message a person sees: the core's `expected` names what the field had to hold (for a
 *  lone surrogate, the field itself). */
function refusedArgument(data: ErrorData | undefined): string {
  const fields = data as { reason?: unknown; expected?: unknown } | undefined;
  return fields?.reason === 'invalidParams' && typeof fields.expected === 'string' && fields.expected ? `: ${fields.expected}` : '';
}
const rpcFailure = (e: JsonRpcErrorBody): ClientFailure => {
  const data = e.data as ErrorData | undefined;
  return fail({ kind: 'rpc', code: e.code, reason: data?.reason, message: e.message, data });
};
const detailOf = (e: unknown): ClientErrorDetail => (e instanceof ClientFailure ? e.detail : { kind: 'protocolViolation', what: String(e) });
const isConnectionEnd = (d: ClientErrorDetail): boolean => d.kind === 'connectionLost' || d.kind === 'clientClosed';

function blobError(e: unknown): unknown {
  const d = detailOf(e);
  if (d.kind === 'rpc' && d.data?.reason === 'blobNotFound') return fail({ kind: 'blobNotFound', digest: d.data.digest });
  if (d.kind === 'rpc' && d.data?.reason === 'blobCorrupt') return fail({ kind: 'blobCorrupt', digest: d.data.digest });
  return e;
}

// ───────────────────────────── store ─────────────────────────────

class Store implements FoldStore<Json> {
  readonly threads = new Map<string, ThreadFold<Json>>();
  sectionMap = new Map<string, Map<string, SectionEntry>>();
  app: FeedStamp | undefined;
  /** Announcements the committed store still owes its listeners (a snapshot swapped in, its changes not all emitted yet); in order. */
  owed: Array<Iterator<SectionEntry | null>> | null = null;
  /** The current app subscription's first live seq (its `liveSeq`; `startSeq` from a core that predates it). */
  liveSeq: number | undefined;
  private readonly listeners = new Set<(c: StoreChange) => void>();

  thread(threadId: string): ThreadFold<Json> | undefined {
    return this.threads.get(threadId);
  }
  section(section: string, key: string | null = null): SectionEntry | undefined {
    return this.sectionMap.get(section)?.get(key ?? '');
  }
  sections(section: string): readonly SectionEntry[] {
    return [...(this.sectionMap.get(section)?.values() ?? [])];
  }
  appFeed(): FeedStamp | undefined {
    return this.app;
  }
  appLive(): boolean {
    return this.app !== undefined && this.liveSeq !== undefined && this.app.seq >= this.liveSeq;
  }
  subscribe(listener: (c: StoreChange) => void): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }
  emit(c: StoreChange): void {
    isolated(this.listeners, c);
  }
  applySection(u: SectionUpdate): void {
    if (putSection(this.sectionMap, u)) this.emit({ type: 'section', section: u.section, key: u.key ?? null });
  }
}

function* indices(n: number): Generator<string, void, void> {
  for (let i = 0; i < n; i++) yield String(i);
}
/** `for...in` as an iterable: no array of the keys is built. */
function* ownKeys(o: object): Generator<string, void, void> {
  for (const k in o) yield k;
}

/** The section changes a swap owes its listeners, one unit per step: `null` is an old entry looked at that needs no announcement,
 * otherwise the sections the new snapshot removed, then every section it holds. Lazy, so neither the scan nor the list is built in one go. */
function* changesOf(old: Map<string, Map<string, SectionEntry>>, staged: Map<string, Map<string, SectionEntry>>): Generator<SectionEntry | null, void, void> {
  for (const [section, bucket] of old) {
    for (const [k, entry] of bucket) yield staged.get(section)?.has(k) ? null : entry;
  }
  for (const bucket of staged.values()) yield* bucket.values();
}

/** `store[section][key] = value` iff `revision > stored.revision`; `removed` deletes. True when the update applied. */
function putSection(sections: Map<string, Map<string, SectionEntry>>, u: SectionUpdate): boolean {
  const bucket = sections.get(u.section) ?? new Map<string, SectionEntry>();
  sections.set(u.section, bucket);
  const k = u.key ?? '';
  const cur = bucket.get(k);
  if (cur && cur.revision >= u.revision) return false;
  if (u.removed === true) bucket.delete(k);
  else bucket.set(k, { section: u.section, key: u.key ?? null, revision: u.revision, value: u.value ?? null });
  return true;
}

// ───────────────────────────── engine ─────────────────────────────

interface Pending {
  readonly cls: RequestClass | undefined;
  readonly resolve: (v: Json) => void;
  readonly reject: (e: ClientFailure) => void;
  /** Runs inside frame handling, before the next frame is processed. */
  readonly sync?: (v: Json) => void;
}
interface Unanswered {
  readonly method: string;
  readonly params: Json;
  readonly info: MethodInfo;
  readonly scope: string;
  readonly resolve: (v: Json) => void;
  readonly reject: (e: ClientFailure) => void;
}
/** The refusals of a restore that mean the feed itself is gone (a retry cannot change them). */
const FEED_GONE: ReadonlySet<string> = new Set(['threadNotFound', 'storeDamaged', 'permissionDenied', 'capabilityUnavailable', 'methodNotFound', 'invalidParams']);
/** What one call's time limit knows of the call (`Engine.bounded`). */
interface CallLimit {
  readonly method: string;
  /** The limit passed and the caller was told. */
  expired: boolean;
  /** Its request is out (written, not refused). */
  sent: boolean;
}
/** A `thread/start` of a control thread: the client keeps the subscription its reply gave. */
const startsControlThread = (method: string, params: unknown): boolean =>
  method === 'thread/start' && (params as { kind?: unknown } | null)?.kind === 'control';
interface SentAt {
  readonly all: number;
  readonly byClass: Record<RequestClass, number>;
  readonly feed: number;
}

const INTERNAL: MethodInfo = { class: 'C0', mutation: false, opScope: () => undefined };
const READ_C1: MethodInfo = { class: 'C1', mutation: false, opScope: () => undefined };
const classes = (): Record<RequestClass, number> => ({ C0: 0, C1: 0, C2: 0, C3: 0 });
const jsonKey = (id: RequestId): string => JSON.stringify(id);
/** The order of feed epochs as this realm first received them, across every client it makes (`StreamPosition.order`). */
let feedEpochOrder = 0;
/** Whether a resume in `held` shows everything one in `asked` would. */
const windowCovers = (held: ResumeWindow, asked: ResumeWindow): boolean => {
  if ('none' in asked) return true;
  if ('lastItems' in held && 'lastItems' in asked) return held.lastItems >= asked.lastItems;
  if ('lastTurns' in held && 'lastTurns' in asked) return held.lastTurns >= asked.lastTurns;
  return false;
};
const retainWindow = (asked: ResumeWindow, held: ResumeWindow | undefined): ResumeWindow =>
  held && windowCovers(held, asked) ? held : asked;
const FEED_REQUEST_DEADLINE_MS = 10_000;
const validFeed = (f: unknown): boolean =>
  f === undefined ||
  (isObj(f) && typeof f.id === 'string' && typeof f.epoch === 'string' && typeof f.seq === 'number' &&
    (f.from === undefined || (typeof f.from === 'number' && f.from <= f.seq)));
/** The first position a frame stands for: a coalesced frame (`feed.from`, announced with `feedRanges`) covers `from..=seq`. */
const firstOf = (f: FeedStamp): number => f.from ?? f.seq;
const validErrorBody = (e: unknown): boolean => isObj(e) && typeof e.code === 'number' && typeof e.message === 'string';
/** Delivers `value` to every listener: one that throws is reported and the others still hear it (a listener owns its failure). */
function isolated<T>(listeners: ReadonlySet<(value: T) => void>, value: T): void {
  for (const listener of [...listeners]) {
    try {
      listener(value);
    } catch (error) {
      console.error('A listener of the core connection threw:', error);
    }
  }
}
function drain<V>(m: Map<unknown, V>): V[] {
  const all = [...m.values()];
  m.clear();
  return all;
}

class Engine implements ProtocolClient<Json> {
  readonly store = new Store();
  server!: InitializeResponse;
  status: ConnectionStatus = { state: 'reconnecting', attempt: 0 };

  private writer: TransportWriter | null = null;
  private connSeq = 0;
  private nextRequestId = 1;
  private readonly pending = new Map<RequestId, Pending>();
  private generation = 0;
  /** How many pending requests are the health machine's own probes. */
  private probesOut = 0;
  private readonly listeners = new Set<(e: ClientEvent) => void>();
  private readonly subs = new Map<string, ResumeWindow>();
  /** A refused restore can drop the subscription without dropping the reader's requested window. */
  private readonly lostWindows = new Map<string, ResumeWindow>();
  /** Threads this client started as `kind: "control"` (the reply to `thread/start` subscribed this connection to them): resumed
   *  after each reconnect like `subs`, but never folded (their frames are not tracked), until `unsubscribeThread` or lost. */
  private readonly held = new Map<string, ResumeWindow>();
  /** The resume of each held thread after the latest reconnect, while it is in flight: a request naming the thread waits for it. */
  private readonly heldRestoring = new Map<string, { done: Promise<ClientErrorDetail | undefined>; end(): void }>();
  /** The threads whose resume after a reconnect (`restoreThread`) is in flight; each entry is that restore's own token. */
  private readonly restoring = new Map<string, object>();
  /** The number of restores (`restoreThread`) started on this client, of any thread. */
  private restoreStarts = 0;
  private appSubscribed = false;
  /** The latest `thread/resume` this client sent of each thread whose snapshot is not folded yet (a replay's reply folds nothing, so
   *  it leaves no entry): a caller that only needs the thread followed joins it instead of sending a second resume, which would replace
   *  the first subscription and have the core encode the whole snapshot again. */
  private readonly resuming = new Map<string, { reply: Promise<ThreadResumeResponse>; window: ResumeWindow; sent: Promise<void>; token?: number }>();
  private readonly awaitingSnapshot = new Set<string>();
  /** A null boundary is a legacy replay whose authoritative head is not known yet. */
  private readonly replayThrough = new Map<string, number | null>();
  /** The window each thread's folded state (the one in `store.threads`) was built from. A reply that acknowledges a larger window
   *  is not that state until its snapshot is folded, so a resume after a disconnect claims this window, never the acknowledged one. */
  private readonly foldedWindow = new Map<string, ResumeWindow>();
  /** The window a subscription token's snapshot will fold in. */
  private readonly tokenWindow = new Map<number, ResumeWindow>();
  /** The feeds whose resume cursor the core refused (`cursorInvalidated`): attached whole until one is answered. */
  private readonly cursorReset = new Set<string>();
  private readonly serverRequests = new Map<string, ServerRequest>();
  private readonly recv = new Map<string, { epoch: string; seq: number; order: number }>();
  /** Orders connection-scoped notifications. */
  private chain: Promise<void> = Promise.resolve();
  /** Orders the folds of one feed. */
  private readonly feedChains = new Map<string, Promise<void>>();
  private responses = 0;
  private classResponses = classes();
  private feedEvents = 0;
  private readonly threadLastEvent = new Map<string, number>();
  private wake: Array<() => void> = [];
  private readyWaiters: Array<{ ok: () => void; err: (e: ClientFailure) => void }> = [];
  private readonly unanswered = new Map<string, Unanswered>();
  private looping = false;
  private everReady = false;
  /** When this client's link last became ready, and when it last went down (wall clock, for the host's link log). */
  private readyAt = 0;
  private downAt = 0;
  private terminal: ClientErrorDetail | undefined;
  private readonly reducer: ThreadReducer<Json> | undefined;
  private readonly o: ConnectOptions<Json>;
  private readonly budgetMs: number;
  private readonly now: () => number;
  private readonly yieldTurn: () => Promise<void>;
  private turnStart = 0;
  private visited = 0;
  /** Identity of the current subscription of each feed: a fold that began under another one never commits. */
  private readonly subToken = new Map<string, number>();
  private tokenSeq = 0;

  /** Link life-cycle lines for the host's log (`link-log.mjs`): counts, ids and times only; it cannot throw into the link. */
  private readonly diag: (event: string, fields?: Record<string, unknown>) => void;

  constructor(options: ConnectOptions<Json>) {
    this.o = options;
    this.diag = createLinkLog(options.onDiagnostic);
    this.health = new LinkHealth(
      {
        ready: () => this.status.state === 'ready' && this.writer !== null,
        pending: () => this.pending.size - this.probesOut,
        connection: () => this.connSeq,
        probe: (sent) => this.probe(sent),
        // The transport's own receive chain: authentication and assembly already accepted.
        settle: async () => {
          await this.writer?.settled?.();
        },
        drop: (reason) => this.dropLink(1000, reason),
        diag: (event, fields) => this.diag(event, { linkSeq: this.connSeq, ...fields }),
      },
      this.o.health
    );
    this.reducer = options.threadReducer;
    this.budgetMs = options.turn?.budgetMs ?? 8;
    this.now = options.turn?.now ?? (() => performance.now());
    this.yieldTurn = options.turn?.yieldTurn ?? (() => new Promise<void>((r) => {
      // Read at call time: the renderer's program has no Node globals, and a page has no setImmediate.
      const immediate = (globalThis as { setImmediate?: (callback: () => void) => unknown }).setImmediate;
      if (typeof immediate === 'function') immediate(r);
      else setTimeout(r, 0);
    }));
  }

  /** The turn's budget is spent. */
  private overBudget(): boolean {
    return this.now() - this.turnStart > this.budgetMs;
  }
  private async nextTurn(): Promise<void> {
    await this.yieldTurn();
    this.turnStart = this.now();
  }

  // ── lifecycle ──

  async start(): Promise<void> {
    // The ladder's own steps and delays, before the first ready connection: a refusal that only a new version fixes ends it.
    const until = this.o.firstConnectDeadlineMs === undefined ? undefined : Date.now() + this.o.firstConnectDeadlineMs;
    for (let attempt = 0; ; attempt++) {
      try {
        await this.establish(this.o.firstConnectDeadlineMs);
        break;
      } catch (e) {
        this.writer?.close(1000, 'handshake failed');
        this.writer = null;
        const delay = ladderDelay(attempt, this.o.random(), this.o.ladder);
        if (detailOf(e).kind === 'versionRefused' ||
            (!this.o.keepTryingFirstConnect && (until === undefined || Date.now() + delay >= until))) throw e;
        await this.o.clock.sleep(delay);
      }
    }
    this.everReady = true;
    this.readyAt = Date.now();
    this.setStatus({ state: 'ready', serverInstanceId: this.server.serverInstanceId });
    this.diag('link-open', { linkSeq: this.connSeq });
  }

  /** One attempt at a connection: the dial, then the handshake inside `ms` when it is given (a transport that is accepted
   *  but never answers `initialize` ends the attempt, not the wait). The dial has no limit here: it ends by its connector,
   *  which is what knows why a dial is slow (a launcher waits for a core that says it is starting, and fails when that core
   *  ends or is blocked), so a core that takes long to start is not reported as one that did not answer. The abandoned
   *  attempt can no longer deliver anything. */
  private async establish(ms: number | undefined): Promise<void> {
    await this.openTransport();
    const attempt = this.handshake();
    if (ms === undefined) return attempt;
    attempt.catch(() => {});
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        this.connSeq++;
        const w = this.writer;
        this.writer = null;
        w?.close(1000, 'connect timed out');
        for (const p of drain(this.pending)) p.reject(fail({ kind: 'connectionLost' }));
        reject(fail({ kind: 'requestTimeout', method: 'initialize', sent: true }));
      }, Math.max(0, ms));
    });
    try {
      await Promise.race([attempt, expired]);
    } finally {
      clearTimeout(timer);
    }
  }

  private async openTransport(): Promise<void> {
    const conn = ++this.connSeq;
    let early: { code: number; reason: string } | undefined;
    const sink: TransportSink = {
      frame: (t) => {
        if (conn === this.connSeq) this.onFrame(t);
      },
      progress: () => {
        if (conn === this.connSeq) this.health.progress();
      },
      closed: (code, reason) => {
        if (conn !== this.connSeq) return;
        if (this.writer === null) early = { code, reason };
        else this.onClosed();
      },
    };
    const w = await this.o.connector.open(this.o.target, sink);
    if (conn !== this.connSeq) {
      // The attempt was abandoned while the dial was still out: its late socket is closed, never adopted.
      w.close(1000, 'abandoned');
      throw fail({ kind: 'connectionLost' });
    }
    if (early) throw fail({ kind: 'connectionLost' });
    this.writer = w;
  }

  private async handshake(): Promise<void> {
    let result: Json;
    try {
      result = await this.rpc('initialize', { clientInfo: this.o.clientInfo, capabilities: this.o.capabilities });
    } catch (e) {
      const d = detailOf(e);
      if (d.kind === 'rpc' && (d.data?.reason === 'clientOutdated' || d.data?.reason === 'serverOutdated')) {
        throw fail({ kind: 'versionRefused', reason: d.data.reason, serverVersion: d.data.serverVersion, clientVersion: d.data.clientVersion });
      }
      throw e;
    }
    this.server = result as unknown as InitializeResponse;
    this.send({ method: 'initialized' });
  }

  private setStatus(status: ConnectionStatus): void {
    this.status = status;
    if (status.state === 'ready') {
      for (const w of this.readyWaiters.splice(0)) w.ok();
    }
    this.emit({ type: 'status', status });
  }

  private onClosed(): void {
    this.writer = null;
    this.health.stop();
    this.generation++;
    this.recv.clear();
    this.awaitingSnapshot.clear();
    this.replayThrough.clear();
    this.resuming.clear();
    this.tokenWindow.clear();
    const dropped = [...this.serverRequests.values()];
    this.serverRequests.clear();
    for (const r of dropped) this.touchSurface(r);
    const lost = drain(this.pending);
    // A thread attached without a `thread/resume` (`thread/start`) is in the store but not in `subs`: the ladder cannot restore it.
    this.diag('link-down', {
      linkSeq: this.connSeq,
      openMs: this.readyAt ? Date.now() - this.readyAt : 0,
      ownerClosed: Boolean(this.terminal),
      threadsFollowed: this.subs.size,
      threadsNotRestorable: [...this.store.threads.keys()].filter((id) => !this.subs.has(id)).length,
      appSubscribed: this.appSubscribed,
      requestsFailed: lost.length,
      serverRequestsDropped: dropped.length,
    });
    this.downAt = Date.now();
    for (const p of lost) p.reject(fail({ kind: 'connectionLost' }));
    this.pulse();
    if (this.terminal || !this.everReady || this.looping) return;
    this.looping = true;
    void this.reconnectLoop();
  }

  private async reconnectLoop(): Promise<void> {
    let attempt = 0;
    while (!this.terminal) {
      this.setStatus({ state: 'reconnecting', attempt });
      await this.o.clock.sleep(ladderDelay(attempt, this.o.random(), this.o.ladder));
      if (this.terminal) return;
      try {
        await this.openTransport();
        await this.handshake();
      } catch (e) {
        const d = detailOf(e);
        if (d.kind === 'versionRefused') {
          this.writer?.close(1000, 'version refused');
          this.writer = null;
          this.looping = false;
          this.terminate(d);
          return;
        }
        this.writer?.close(1000, 'attempt failed');
        this.writer = null;
        attempt++;
        continue;
      }
      this.looping = false;
      this.readyAt = Date.now();
      this.setStatus({ state: 'ready', serverInstanceId: this.server.serverInstanceId });
      this.diag('link-reconnected', { linkSeq: this.connSeq, attempts: attempt + 1, downMs: Date.now() - this.downAt, threadsToRestore: this.subs.size, appToRestore: this.appSubscribed });
      // The connection is usable now. Each subscription and each scope's reconciliation proceeds independently.
      // The connection this restore belongs to is fixed now: a later reconnect advances `connSeq` before this settles.
      const restoring = this.connSeq;
      void this.restoreSubscriptions().then((outcome) => this.diag('link-restore-settled', { linkSeq: restoring, ...outcome }));
      this.reconcileOps();
      return;
    }
  }

  private restoreSubscriptions(): Promise<{ threadsRestored: number; threadsLost: number; threadsFailed: number; appRestored: boolean }> {
    // Started in the same turn as the status change to ready, so a request waiting for readiness finds the restore registered.
    for (const [threadId, window] of [...this.held]) this.restoreHeld(threadId, window);
    const threads = [...this.subs].map(([threadId, window]) => this.restoreThread(threadId, window));
    const app = this.appSubscribed ? this.restoreApp() : Promise.resolve(false);
    return Promise.all([Promise.all(threads), app]).then(([done, appRestored]) => ({
      threadsRestored: done.filter((o) => o === 'restored').length,
      threadsLost: done.filter((o) => o === 'lost').length,
      threadsFailed: done.filter((o) => o === 'failed').length,
      appRestored,
    }));
  }

  /** A subscription's restore after a reconnect, until the core answers it. Only a refusal that says the feed is gone ends it
   *  (the returned detail); the end of the connection is the ladder's business (`'ended'`). A cursor the core no longer honours
   *  is dropped and the feed is attached whole. Transient refusals are retried on this leg before recycling it. */
  private async restoreRun(feedId: string, resume: () => Promise<unknown>, held: () => boolean): Promise<'done' | 'ended' | ClientErrorDetail> {
    const generation = this.generation;
    for (let attempt = 0; generation === this.generation && !this.terminal && held(); attempt++) {
      try {
        await resume();
        if (generation !== this.generation) return 'ended';
        this.cursorReset.delete(feedId);
        return 'done';
      } catch (e) {
        const d = detailOf(e);
        if (generation !== this.generation || !held()) return 'ended';
        if (d.kind !== 'rpc') {
          // The peer may still attach a request whose answer we never saw. Do not race it with another attach on this link.
          if (!isConnectionEnd(d)) this.dropLink(1000, 'feed restore failed');
          return 'ended';
        }
        if (d.reason !== undefined && FEED_GONE.has(d.reason)) return d;
        if (d.reason === 'cursorInvalidated' && !this.cursorReset.has(feedId)) this.cursorReset.add(feedId);
        else if (attempt >= 2) {
          this.dropLink(1000, 'feed restore refused');
          return 'ended';
        }
        await this.o.clock.sleep(ladderDelay(attempt, this.o.random(), this.o.ladder));
      }
    }
    return 'ended';
  }

  private async restoreThread(threadId: string, window: ResumeWindow): Promise<'restored' | 'lost' | 'failed'> {
    const generation = this.generation;
    const mine = {};
    this.restoring.set(threadId, mine);
    this.restoreStarts += 1;
    const settled = (): void => {
      if (this.restoring.get(threadId) === mine) this.restoring.delete(threadId);
    };
    const outcome = await this.restoreRun(
      threadId,
      () => this.requestResume(threadId, window, undefined, true),
      () => this.subs.get(threadId) === window
    );
    settled();
    const followed = this.subs.get(threadId);
    if (generation === this.generation && followed && (outcome === 'done' || followed !== window)) {
      this.store.emit({ type: 'subscription', feedId: threadId, state: 'restored' });
      return 'restored';
    }
    if (generation === this.generation && !followed) {
      this.store.emit({ type: 'subscription', feedId: threadId, state: 'cancelled' });
    }
    if (typeof outcome === 'string' || generation !== this.generation || followed !== window) return 'failed';
    this.loseThread(threadId, window, outcome);
    return 'lost';
  }

  private loseThread(threadId: string, window: ResumeWindow, outcome: ClientErrorDetail): void {
    this.lostWindows.set(threadId, window);
    this.subs.delete(threadId);
    this.subToken.delete(threadId);
    this.replayThrough.delete(threadId);
    this.store.threads.delete(threadId);
    this.foldedWindow.delete(threadId);
    this.emit({ type: 'subscriptionLost', threadId, error: outcome });
    this.store.emit({ type: 'subscription', feedId: threadId, state: 'lost', error: outcome });
  }
  /** A control thread the core no longer has (restarted, or swept during a long disconnect) is dropped from `held`; the end of the
   *  connection leaves it held for the next reconnect. */
  private restoreHeld(threadId: string, window: ResumeWindow): Promise<ClientErrorDetail | undefined> {
    let end = (): void => undefined;
    const ended = new Promise<undefined>((resolve) => (end = () => resolve(undefined)));
    const entry = { done: undefined as unknown as Promise<ClientErrorDetail | undefined>, end };
    const resume = (async (): Promise<ClientErrorDetail | undefined> => {
      try {
        const outcome = await this.restoreRun(
          threadId,
          () => this.requestResume(threadId, window, undefined, true),
          () => this.held.get(threadId) === window
        );
        if (outcome === 'done' || outcome === 'ended' || this.held.get(threadId) !== window) return undefined;
        this.held.delete(threadId);
        return outcome;
      } finally {
        if (this.heldRestoring.get(threadId) === entry) this.heldRestoring.delete(threadId);
      }
    })();
    // A waiter ends with the resume, or when the hold is dropped (`unsubscribeThread`) or the client closes, whichever is first.
    // The resume itself ends as any request does: with its answer, or with the connection.
    entry.done = Promise.race([resume, ended]);
    this.heldRestoring.set(threadId, entry);
    return entry.done;
  }
  /** Resolves once this client is ready and no resume of `threadId` is in flight: the point from which a held thread is, or is not,
   *  subscribed on the current connection (`threadSubscription(id).held`). Rejects when the client is closed. */
  async whenHeldSettled(threadId: string): Promise<void> {
    for (;;) {
      await this.whenReady();
      const restoring = this.heldRestoring.get(threadId);
      if (!restoring) return;
      await restoring.done;
    }
  }
  private async restoreApp(): Promise<boolean> {
    const outcome = await this.restoreRun(
      WIRE.appFeedId,
      () =>
        this.bounded('app/subscribe', FEED_REQUEST_DEADLINE_MS, null, (limit) =>
          this.run('app/subscribe', this.appParams(), INTERNAL, (r) => {
            this.attached(WIRE.appFeedId, r);
            this.completeAnnouncements();
          }, true, undefined, limit)),
      () => this.appSubscribed
    );
    if (outcome === 'done') {
      this.store.emit({ type: 'subscription', feedId: WIRE.appFeedId, state: 'restored' });
      return true;
    }
    if (outcome === 'ended') return false;
    this.appSubscribed = false;
    this.subToken.delete(WIRE.appFeedId);
    this.emit({ type: 'subscriptionLost', threadId: WIRE.appFeedId, error: outcome });
    this.store.emit({ type: 'subscription', feedId: WIRE.appFeedId, state: 'lost', error: outcome });
    return false;
  }

  private terminate(detail: ClientErrorDetail): void {
    this.terminal = detail;
    this.health.stop();
    for (const p of drain(this.pending)) p.reject(fail(detail));
    for (const u of [...this.unanswered.values()]) u.reject(fail(detail));
    this.unanswered.clear();
    for (const threadId of [...this.held.keys(), ...this.heldRestoring.keys()]) this.releaseHeld(threadId);
    for (const w of this.readyWaiters.splice(0)) w.err(fail(detail));
    this.pulse();
    this.setStatus({ state: 'closed', reason: detail });
  }

  async close(): Promise<void> {
    if (this.terminal) return;
    const w = this.writer;
    this.terminate({ kind: 'clientClosed' });
    this.writer = null;
    w?.close(1000, 'client closed');
  }

  // ── wire ──

  private send(frame: Record<string, unknown>, sent?: SentClaim): void {
    const w = this.writer;
    if (!w) throw fail({ kind: 'connectionLost' });
    const text = JSON.stringify(frame);
    // The peer closes the connection (1009) on a text frame over its inbound limit, dropping every subscription and
    // everything the host holds; a frame it would refuse is never put on the wire. `server` is unset for `initialize` itself.
    const limit = this.server?.limits?.maxInboundFrameBytes;
    // A UTF-8 character is at most 3 bytes per UTF-16 unit, so a short enough text needs no encoding to be measured.
    if (limit !== undefined && text.length * 3 > limit) {
      const bytes = new TextEncoder().encode(text).byteLength;
      if (bytes > limit) throw fail({ kind: 'protocolViolation', what: `frame of ${bytes} bytes is over maxInboundFrameBytes ${limit}` });
    }
    w.send(text, sent);
  }

  private rpc(method: string, params: Json | undefined, cls?: RequestClass, sync?: (v: Json) => void, sent?: SentClaim): Promise<Json> {
    return new Promise<Json>((resolve, reject) => {
      const id = this.nextRequestId++;
      try {
        this.pending.set(id, { cls, resolve, reject, ...(sync ? { sync } : {}) });
        this.send(params === undefined ? { id, method } : { id, method, params }, sent);
        this.health.requestsChanged();
      } catch (e) {
        this.pending.delete(id);
        reject(e);
      }
    });
  }

  private emit(e: ClientEvent): void {
    isolated(this.listeners, e);
  }
  on(listener: (e: ClientEvent) => void): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  /** `category` is what the host's log gets: a fixed name, never `what`, which may carry feed ids or exception text. */
  private violation(code: number, what: string, category = what): void {
    this.emit({ type: 'protocolViolation', what });
    this.diag('link-violation', { linkSeq: this.connSeq, code, category });
    this.dropLink(code, what);
  }

  /** Ends this connection from this side and goes on to the ladder. A transport that closes the socket when asked need not report
   *  it back (a window's port does not), so the end is taken here; the transport's own report, if one comes, is of the old
   *  connection and is ignored. */
  private dropLink(code: number, reason: string): void {
    const w = this.writer;
    if (!w) return;
    this.connSeq++;
    w.close(code, reason);
    this.onClosed();
  }

  /** The question the core answers at once: any answer, an error included, is progress from it. */
  private probe(sent: SentClaim): void {
    this.probesOut++;
    this.rpc('thread/unsubscribe', { threadId: 'link-check' } as unknown as Json, 'C0', undefined, sent)
      .catch(() => {})
      .finally(() => this.probesOut--);
  }

  /** THE RULE of a sent request: once sent it stays pending for as long as the connection is demonstrably alive; its age never fails
   *  it. What fails it is the connection, and `health.ts` is the one machine that decides a silent one is dead (see its header for
   *  the cycle, what counts as proof of life, and the limit of the rule). Its drop rejects the pending requests as `connectionLost`
   *  (`onClosed`) and sends mutations through the reconciliation (`run`, `settle`), so a reconnect never runs one again. */
  private readonly health: LinkHealth;

  /** Whether the core is alive: a fresh probe and observation window begin now, and the answer is the health machine's verdict,
   *  which drops the link when the window passes with no progress from the core (a link that died unseen, as after a machine's
   *  sleep). Whatever state an earlier cycle held is void. False when there was no ready connection. */
  checkLink(): Promise<boolean> {
    return this.health.check();
  }

  private onFrame(text: string): void {
    this.turnStart = this.now();
    this.health.progress();
    // RFC 6455: 1007 for a payload that does not decode, 1002 for a sequence violation.
    let m: Record<string, unknown>;
    try {
      m = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return this.violation(1007, 'invalid json');
    }
    if (typeof m !== 'object' || m === null || Array.isArray(m)) return this.violation(1007, 'frame is not an object');
    if (typeof m.method === 'string') {
      if ('id' in m) return this.onServerRequest({ id: m.id as RequestId, method: m.method, params: m.params ?? null } as ServerRequest);
      if (!validFeed(m.feed)) return this.violation(1007, 'bad notification');
      return this.onNotification(m as unknown as JsonRpcNotification);
    }
    const p = this.pending.get(m.id as RequestId);
    if (!p) return this.violation(1002, 'response to unknown request');
    if ('error' in m && !validErrorBody(m.error)) return this.violation(1007, 'bad error body'); // stays pending: the close settles it
    this.pending.delete(m.id as RequestId);
    this.health.requestsChanged();
    if ('error' in m) {
      const err = m.error as JsonRpcErrorBody;
      if (err.code !== -32001) this.countResponse(p.cls);
      return p.reject(rpcFailure(err));
    }
    this.countResponse(p.cls);
    try {
      p.sync?.(m.result as Json);
    } catch (e) {
      return p.reject(e as ClientFailure);
    }
    p.resolve(m.result as Json);
  }

  private countResponse(cls: RequestClass | undefined): void {
    this.responses++;
    if (cls) this.classResponses[cls]++;
    this.pulse();
  }

  private pulse(): void {
    for (const w of this.wake.splice(0)) w();
  }
  private async waitUntil(done: () => boolean): Promise<void> {
    while (!done() && this.writer !== null && !this.terminal) await new Promise<void>((r) => this.wake.push(r));
  }

  private onServerRequest(r: ServerRequest): void {
    // Only what the core offers every eligible connection, and resolves itself, is held; a capability holder's request is its
    // handler's to end, and a method the table does not list is not held (`isOfferedRequest`).
    if (isOfferedRequest(r.method)) {
      this.serverRequests.set(jsonKey(r.id), r);
      this.touchSurface(r);
    }
    this.emit({ type: 'serverRequest', request: r });
  }
  pendingServerRequests(): readonly ServerRequest[] {
    return [...this.serverRequests.values()];
  }
  feedPosition(feedId: string): StreamPosition | undefined {
    const position = this.recv.get(feedId);
    return position ? { epoch: position.epoch, seq: position.seq, order: position.order } : undefined;
  }
  respond(id: RequestId, answer: ServerRequestAnswer): void {
    this.send({ id, ...answer });
  }
  notify(method: string, params: Json): void {
    this.send({ method, params });
  }
  sendBinary(data: Uint8Array): void {
    const w = this.writer;
    if (!w) throw fail({ kind: 'connectionLost' });
    if (!w.sendBinary) throw fail({ kind: 'protocolViolation', what: 'transport has no binary lane' });
    if (data.byteLength > this.server.limits.maxMediaFrameBytes + 16) throw fail({ kind: 'protocolViolation', what: 'media frame over maxMediaFrameBytes' });
    w.sendBinary(data);
  }

  // ── feeds ──

  private onNotification(n: JsonRpcNotification): void {
    const gen = this.generation;
    const f = n.feed;
    if (!f) {
      this.chain = this.chain.then(() => this.deliverConnectionScoped(n, gen));
      return;
    }
    if (isScopedMethod(n.method) && f.id !== WIRE.appFeedId && !this.subs.has(f.id)) return this.onScoped(n, f, gen);
    this.feedEvents++;
    this.threadLastEvent.set(f.id, this.feedEvents);
    this.pulse();
    const tracked = f.id === WIRE.appFeedId ? this.appSubscribed : this.subs.has(f.id);
    if (!tracked && !this.held.has(f.id)) return;
    const snapshot = n.method === WIRE.threadSnapshot || n.method === WIRE.appSnapshot;
    const cur = this.recv.get(f.id);
    if (!snapshot && (!cur || cur.epoch !== f.epoch || firstOf(f) !== cur.seq + 1)) {
      return this.violation(1002, `feed gap on ${f.id}`, 'feed gap');
    }
    const order = this.received(f.id, f.epoch, f.seq);
    if (snapshot) this.awaitingSnapshot.delete(f.id);
    if (!tracked) return; // Held control threads participate in continuity but do not need a fold.
    const tok = this.subToken.get(f.id);
    this.feedChains.set(f.id, (this.feedChains.get(f.id) ?? Promise.resolve()).then(() => this.fold(n, f, snapshot, gen, tok, order)));
  }

  /** Records the position received on `feedId`; its epoch's order is a new one the first time the epoch is seen. */
  private received(feedId: string, epoch: string, seq: number): number {
    const cur = this.recv.get(feedId);
    const order = cur?.epoch === epoch ? cur.order : ++feedEpochOrder;
    this.recv.set(feedId, { epoch, seq, order });
    return order;
  }

  /** A scoped feed has no store: its notifications are events. The first one seen (or `feed/snapshot`) sets the position; after that
   * the feed must run on without a gap, as a thread feed does. */
  private onScoped(n: JsonRpcNotification, f: FeedStamp, gen: number): void {
    const cur = this.recv.get(f.id);
    if (n.method !== 'feed/snapshot' && cur && (cur.epoch !== f.epoch || firstOf(f) !== cur.seq + 1)) {
      return this.violation(1002, `feed gap on ${f.id}`, 'feed gap');
    }
    this.received(f.id, f.epoch, f.seq);
    if (n.method === 'feed/snapshot') this.awaitingSnapshot.delete(f.id);
    this.feedChains.set(
      f.id,
      (this.feedChains.get(f.id) ?? Promise.resolve()).then(async () => {
        const failed: ClientErrorDetail[] = [];
        let resolved: Json;
        try {
          resolved = await this.resolveBlobs(n.params ?? null, failed);
        } catch {
          return; // the connection ended; the next generation re-attaches
        }
        if (gen !== this.generation) return;
        for (const error of failed) this.emit({ type: 'blobUnavailable', feed: f, error });
        this.emit({ type: 'notification', notification: { ...n, params: resolved } });
      }),
    );
  }

  /** The approval card of a thread derives from pending server requests, so their changes notify that thread's store listeners. */
  private touchSurface(r: ServerRequest): void {
    const p = r.params as { threadId: string; surfaceThreadId?: string };
    const threadId = p.surfaceThreadId ?? p.threadId;
    if (this.store.threads.has(threadId)) this.store.emit({ type: 'thread', threadId });
  }

  private deliverConnectionScoped(n: JsonRpcNotification, gen: number): void {
    if (gen !== this.generation) return;
    if (n.method === WIRE.serverRequestResolved) {
      const p = n.params as ServerRequestResolvedParams;
      const gone = this.serverRequests.get(jsonKey(p.requestId));
      this.serverRequests.delete(jsonKey(p.requestId));
      if (gone) this.touchSurface(gone);
      this.emit({ type: 'serverRequestResolved', params: p });
    } else this.emit({ type: 'notification', notification: n });
  }

  /** The connection and the subscription a fold began under are still the current ones. */
  private current(feedId: string, gen: number, tok: number | undefined): boolean {
    return gen === this.generation && this.subToken.get(feedId) === tok;
  }

  private async fold(n: JsonRpcNotification, f: FeedStamp, snapshot: boolean, gen: number, tok: number | undefined, order: number): Promise<void> {
    if (snapshot && f.id === WIRE.appFeedId) return this.foldAppSnapshot(n, f, gen, tok);
    const failed: ClientErrorDetail[] = [];
    let resolved: JsonRpcNotification;
    try {
      resolved = { ...n, params: await this.resolveBlobs(n.params ?? null, failed) };
    } catch {
      return; // the connection ended; the next generation re-attaches
    }
    if (!this.current(f.id, gen, tok)) return;
    for (const error of failed) this.emit({ type: 'blobUnavailable', feed: f, error });
    if (f.id === WIRE.appFeedId) return this.foldApp(resolved, f);
    const prev = this.store.threads.get(f.id);
    const params = resolved.params ?? null;
    let state: Json;
    try {
      if (snapshot) {
        // Folded in budgeted steps; `prev` stays in the store, whole, until the swap below.
        const folded = await this.initialState(params, f.id, gen, tok);
        if (!folded) return; // the connection ended, or the subscription was replaced or dropped, meanwhile
        state = folded.state;
      } else if (!prev) return;
      else state = this.reducer ? this.reducer.apply(prev.state, resolved) : prev.state;
    } catch (e) {
      // A reducer that throws leaves the fold unknown: drop the connection so the ladder re-attaches from a snapshot.
      return this.violation(1002, `reducer failed on ${f.id}: ${String(e)}`, 'reducer failed');
    }
    // The awaits above leave microtask gaps in which an unsubscribe or a resubscribe can run: the identity is checked again here,
    // in the same synchronous block as the swap, so an abandoned fold can never commit.
    if (!this.current(f.id, gen, tok)) return;
    this.store.threads.set(f.id, { feed: f, order, state });
    if (snapshot) {
      const built = tok === undefined ? undefined : this.tokenWindow.get(tok);
      if (built) this.foldedWindow.set(f.id, built);
      else this.foldedWindow.delete(f.id);
      if (tok !== undefined) this.tokenWindow.delete(tok);
    }
    if (snapshot && this.resuming.get(f.id)?.token === tok) this.resuming.delete(f.id);
    const boundary = this.replayThrough.get(f.id);
    const replayComplete = typeof boundary === 'number' && f.seq >= boundary;
    if (replayComplete) this.replayThrough.delete(f.id);
    this.store.emit({ type: 'thread', threadId: f.id, ...(replayComplete ? { replayComplete: true } : {}) });
  }

  /** `reducer.initial(params)`, stepped when the reducer can (see `ThreadReducer.initialSteps`); null when the connection ended meanwhile. */
  private async initialState(params: Json, feedId: string, gen: number, tok: number | undefined): Promise<{ state: Json } | null> {
    const reducer = this.reducer;
    if (!reducer) return { state: params };
    if (!reducer.initialSteps) return { state: reducer.initial(params) };
    const steps = reducer.initialSteps(params);
    for (;;) {
      const r = steps.next();
      if (r.done) return this.current(feedId, gen, tok) ? { state: r.value } : null;
      if (this.overBudget()) {
        await this.nextTurn();
        if (!this.current(feedId, gen, tok)) return null;
      }
    }
  }

  private foldApp(n: JsonRpcNotification, f: FeedStamp): void {
    this.store.app = f;
    if (isSectionMethod(n.method)) this.store.applySection(n.params as unknown as SectionUpdate);
    else this.emit({ type: 'notification', notification: n });
  }

  /**
   * Stages the snapshot section by section, giving the thread back whenever the turn's budget is spent, and swaps the finished
   * staging into the store at once: the store holds the previous app state, whole, until then. The changes are announced the same
   * way (budgeted), `appSnapshot` last. A connection that ends mid-fold discards the staging; the next generation re-attaches.
   * Later notifications of the app feed wait behind this fold on the feed's chain.
   */
  private async foldAppSnapshot(n: JsonRpcNotification, f: FeedStamp, gen: number, tok: number | undefined): Promise<void> {
    const failed: ClientErrorDetail[] = [];
    const staged = new Map<string, Map<string, SectionEntry>>();
    try {
      for (const u of (n.params as unknown as AppSnapshotParams).sections) {
        if (this.overBudget()) await this.nextTurn();
        const value = u.value === undefined ? undefined : await this.resolveBlobs(u.value, failed);
        if (!this.current(f.id, gen, tok)) return;
        putSection(staged, value === undefined ? u : { ...u, value });
      }
    } catch {
      return; // the connection ended; the next generation re-attaches
    }
    if (!this.current(f.id, gen, tok)) return;
    for (const error of failed) this.emit({ type: 'blobUnavailable', feed: f, error });
    // Committed at once: the content and the resume cursor are the snapshot's. What listeners are owed for it is the store's, and
    // survives a disconnect (see announce).
    const old = this.store.sectionMap;
    this.store.sectionMap = staged;
    this.store.app = f;
    (this.store.owed ??= []).push(changesOf(old, staged));
    await this.announce(gen, tok);
  }

  /**
   * Emits what the committed store owes its listeners, in budgeted steps: a `section` change for each section the snapshot removed
   * and each it holds, then `appSnapshot`. A fold abandoned midway (the connection ended) leaves the rest owed; it is completed,
   * ahead of anything newer on the feed, when the subscription is restored (completeAnnouncements), or folded into the owed set of
   * the next snapshot. So listeners always receive a complete set for the state they hold.
   */
  private async announce(gen: number, tok: number | undefined): Promise<void> {
    const owed = this.store.owed;
    if (!owed) return;
    while (owed.length) {
      if (this.overBudget()) {
        await this.nextTurn();
        if (!this.current(WIRE.appFeedId, gen, tok)) return;
      }
      const r = owed[0]!.next();
      if (r.done) owed.shift();
      else if (r.value) this.store.emit({ type: 'section', section: r.value.section, key: r.value.key });
    }
    this.store.owed = null;
    this.store.emit({ type: 'appSnapshot' });
  }

  /** After the app subscription is restored: finish the announcements a lost connection left owed, before any newer notification. */
  private completeAnnouncements(): void {
    if (!this.store.owed) return;
    const gen = this.generation;
    const tok = this.subToken.get(WIRE.appFeedId);
    this.feedChains.set(WIRE.appFeedId, (this.feedChains.get(WIRE.appFeedId) ?? Promise.resolve()).then(() => this.announce(gen, tok)));
  }

  /** Replaces every text stub by its content, in place: the parsed frame is the client's own, so there is no second copy beside it.
   * A stub that cannot be read stays a stub and its error is appended to `failed`; only the end of the connection aborts the whole
   * resolution. Every child visited is a unit of the turn's budget. */
  private async resolveBlobs(v: Json, failed: ClientErrorDetail[]): Promise<Json> {
    if (typeof v !== 'object' || v === null) return v;
    if (isBlobStub(v)) {
      if (!isTextMedia(v.blob.mediaType)) return v as unknown as Json;
      try {
        return new TextDecoder().decode(await this.readPages(v.blob, true));
      } catch (e) {
        const d = detailOf(e);
        if (isConnectionEnd(d)) throw e;
        failed.push(d);
        return v as unknown as Json;
      }
    }
    const holder = v as Record<string, Json>;
    for (const k of Array.isArray(v) ? indices(v.length) : ownKeys(holder)) {
      if ((++this.visited & 63) === 0 && this.overBudget()) await this.nextTurn();
      const child = holder[k] as Json;
      if (typeof child !== 'object' || child === null) continue;
      const resolved = await this.resolveBlobs(child, failed);
      if (resolved !== child) Object.defineProperty(holder, k, { value: resolved, writable: true, enumerable: true, configurable: true });
    }
    return v;
  }

  private resumeParams(threadId: string, window: ResumeWindow, snapshot: boolean): Json {
    const prev = snapshot ? undefined : this.store.threads.get(threadId);
    const prevWindow = this.foldedWindow.get(threadId);
    const resumeFrom = prev && prevWindow && !this.cursorReset.has(threadId) ? { epoch: prev.feed.epoch, seq: prev.feed.seq, window: prevWindow } : undefined;
    return { threadId, window, ...(resumeFrom ? { resumeFrom } : {}) } as unknown as Json;
  }
  private appParams(): Json {
    const a = this.cursorReset.has(WIRE.appFeedId) ? undefined : this.store.app;
    return (a ? { resumeFrom: { epoch: a.epoch, seq: a.seq } } : {}) as unknown as Json;
  }
  private attached(feedId: string, r: Json, window?: ResumeWindow): void {
    const s = (r as unknown as ThreadResumeResponse).subscription;
    // A reply that arrives after its feed already ran past the position it names is a stale read: it resets nothing, so the
    // events already folded stay in order and no gap is seen (the transcript is the feed's, not the reply's).
    const ahead = this.recv.get(feedId);
    if (ahead && ahead.epoch === s.epoch && ahead.seq >= s.startSeq) return;
    if (window) {
      const boundary = s.liveSeq - 1;
      const folded = this.store.threads.get(feedId)?.feed;
      if (s.mode === 'replay' && !Number.isSafeInteger(s.liveSeq)) {
        this.replayThrough.set(feedId, null);
      } else if (s.mode === 'replay' && boundary >= s.startSeq && (folded?.epoch !== s.epoch || folded.seq < boundary)) {
        this.replayThrough.set(feedId, boundary);
      } else this.replayThrough.delete(feedId);
    }
    this.received(feedId, s.epoch, s.startSeq - 1);
    if (s.mode === 'snapshot') this.awaitingSnapshot.add(feedId);
    else this.awaitingSnapshot.delete(feedId);
    if (feedId === WIRE.appFeedId) this.store.liveSeq = s.liveSeq ?? s.startSeq;
    const token = ++this.tokenSeq;
    this.subToken.set(feedId, token);
    if (window) this.tokenWindow.set(token, window);
  }

  resumeThread(threadId: string, window: ResumeWindow, options?: ResumeOptions): Promise<ThreadResumeResponse> {
    return this.requestResume(threadId, window, options);
  }

  private requestResume(threadId: string, window: ResumeWindow, options?: ResumeOptions, restoring = false, requireSnapshot = false): Promise<ThreadResumeResponse> {
    const current = this.resuming.get(threadId);
    if (!restoring) {
      const requested = current?.window ?? this.subs.get(threadId) ?? this.lostWindows.get(threadId) ?? this.foldedWindow.get(threadId);
      if (options?.follow && requested && !('none' in requested) && !windowCovers(window, requested)) window = requested;
      window = retainWindow(window, this.lostWindows.get(threadId));
      window = retainWindow(window, this.foldedWindow.get(threadId));
      window = retainWindow(window, this.subs.get(threadId));
      window = retainWindow(window, current?.window);
    }
    const pending = options?.force ? undefined : current;
    // A join never yields less than was asked: only a resume whose window holds the asked one answers it.
    if (pending && windowCovers(pending.window, window) && (options?.join || windowCovers(window, pending.window))) {
      // The joiner's frame is the one in flight: it has left when that one has.
      options?.sent?.(pending.sent);
      return pending.reply;
    }
    const params = this.resumeParams(threadId, window, requireSnapshot || (options?.force === true && this.awaitingSnapshot.has(threadId)));
    let departed!: (sent: Promise<void>) => void;
    const sent = new Promise<void>((resolve) => (departed = resolve));
    void sent.catch(() => undefined);
    const generation = this.generation;
    const start = async (limit?: CallLimit): Promise<ThreadResumeResponse> => {
      // Register the shared request before any transport can answer it.
      await Promise.resolve();
      if (restoring && generation !== this.generation) throw fail({ kind: 'connectionLost' });
      return await this.run('thread/resume', params, INTERNAL, (v) => {
        this.attached(threadId, v, window);
        if (!restoring) {
          this.subs.set(threadId, retainWindow(window, this.subs.get(threadId)));
          this.lostWindows.delete(threadId);
        }
        const token = this.subToken.get(threadId);
        if (token !== undefined) entry.token = token;
      }, restoring, (frame) => {
        departed(frame);
        options?.sent?.(frame);
      }, limit) as unknown as ThreadResumeResponse;
    };
    const reply = this.bounded('thread/resume', restoring ? FEED_REQUEST_DEADLINE_MS : options?.timeoutMs, null, start);
    const entry: { reply: Promise<ThreadResumeResponse>; window: ResumeWindow; sent: Promise<void>; token?: number } = { reply, window, sent };
    this.resuming.set(threadId, entry);
    const settled = (folds: boolean): void => {
      // A held control thread is never folded: nothing later ends its entry but its reply.
      if ((!folds || this.held.has(threadId)) && this.resuming.get(threadId) === entry) this.resuming.delete(threadId);
    };
    reply.then((r) => {
      settled(r.subscription.mode === 'snapshot');
      if (!requireSnapshot && r.subscription.mode === 'replay' && !Number.isSafeInteger(r.subscription.liveSeq) &&
          this.subs.has(threadId) && this.replayThrough.get(threadId) === null) {
        void this.resolveLegacyReplay(threadId, window, r.subscription, generation, entry.token);
      }
    }, () => settled(false));
    return reply;
  }

  private async resolveLegacyReplay(
    threadId: string, window: ResumeWindow, subscription: ThreadResumeResponse['subscription'], generation: number, token: number | undefined
  ): Promise<void> {
    const pending = () => this.current(threadId, generation, token) && this.subs.has(threadId) &&
      this.replayThrough.get(threadId) === null;
    let head: FeedHeadsResponse['positions'][number] | undefined;
    try {
      const reply = await this.bounded('feed/heads', FEED_REQUEST_DEADLINE_MS, null, (limit) =>
        this.run('feed/heads', { feedIds: [threadId] }, INTERNAL, undefined, true, undefined, limit)) as unknown as FeedHeadsResponse;
      [head] = reply.positions;
    } catch (error) {
      const detail = detailOf(error);
      if (detail.kind !== 'rpc' || (detail.code !== -32601 && detail.code !== -32603 && detail.reason !== 'methodNotFound')) return;
    }
    if (!pending()) return;
    if (head?.epoch === subscription.epoch && Number.isSafeInteger(head.seq) && head.seq >= subscription.startSeq - 1) {
      const fold = this.store.threads.get(threadId)?.feed;
      if (fold?.epoch === head.epoch && fold.seq >= head.seq) {
        this.replayThrough.delete(threadId);
        this.store.emit({ type: 'thread', threadId, replayComplete: true });
      } else {
        this.replayThrough.set(threadId, head.seq);
      }
      return;
    }

    // Read the bounded tail as a fresh snapshot of this already-followed thread. Register it as a restore
    // so unsubscribe convergence also accounts for a recovery that was in flight when the view left.
    const mine = {};
    this.restoring.set(threadId, mine);
    this.restoreStarts++;
    let failure: ClientErrorDetail | undefined;
    try {
      await this.requestResume(threadId, window, { force: true }, true, true);
    } catch (error) {
      failure = detailOf(error);
    } finally {
      if (this.restoring.get(threadId) === mine) {
        this.restoring.delete(threadId);
        if (failure && pending()) {
          // Keep the requested window for Retry, but never offer the unconfirmed cursor again.
          this.loseThread(threadId, window, failure);
        } else if (generation === this.generation) {
          this.store.emit({ type: 'subscription', feedId: threadId, state: this.subs.has(threadId) ? 'restored' : 'cancelled' });
        }
      }
    }
  }
  async confirmFeeds(feedIds: readonly string[]): Promise<boolean> {
    const generation = this.generation;
    // Positions received while the request was out count too. A relay pong says nothing about these heads.
    const { feedIds: active, positions } = await this.bounded('feed/heads', FEED_REQUEST_DEADLINE_MS, null, (limit) =>
      this.run('feed/heads', {}, INTERNAL, undefined, true, undefined, limit)) as unknown as FeedHeadsResponse;
    if (generation !== this.generation || !active || active.length !== positions.length) return false;
    const live = new Set(active);
    return feedIds.every((id) => live.has(id)) && positions.every((head, i) => {
      const id = active[i]!;
      const received = this.recv.get(id);
      return head !== null && !this.awaitingSnapshot.has(id) && received?.epoch === head.epoch && received.seq >= head.seq;
    });
  }
  /** Whether this client follows `threadId` (a `thread/resume` it sent was answered; it resumes the thread again after each
   *  reconnect, until `unsubscribeThread` or `subscriptionLost`); whether its resume of the thread after a reconnect is in
   *  flight (it ends with the `subscription` store change, restored or lost, or with the connection; until then the core may
   *  attach the thread after an unsubscribe it already answered); `restoresStarted`, the client's count of restores started
   *  of any thread (so a restore of this thread that was in flight at any point between two reads shows as `restoring` in
   *  the first or as a changed count, however it ended; a restore of another thread may show too, which only costs a
   *  redundant request, and nothing is kept per thread once it is neither followed nor restoring); and the number of its
   *  current transport connection: the core's subscriptions of a connection end with that connection. A fold in the store
   *  is no such proof. */
  threadSubscription(threadId: string): ThreadSubscription {
    return {
      followed: this.subs.has(threadId),
      held: this.held.has(threadId),
      restoring: this.restoring.has(threadId),
      snapshotPending: this.resuming.has(threadId) || this.awaitingSnapshot.has(threadId),
      replayPending: this.replayThrough.has(threadId),
      restoresStarted: this.restoreStarts,
      connection: this.generation,
    };
  }
  async unsubscribeThread(threadId: string, options?: Pick<CallOptions, 'sent'>): Promise<void> {
    this.subs.delete(threadId);
    this.lostWindows.delete(threadId);
    this.releaseHeld(threadId);
    this.subToken.delete(threadId);
    this.recv.delete(threadId);
    this.awaitingSnapshot.delete(threadId);
    this.replayThrough.delete(threadId);
    this.resuming.delete(threadId);
    this.store.threads.delete(threadId);
    this.foldedWindow.delete(threadId);
    this.feedChains.delete(threadId);
    await this.run('thread/unsubscribe', { threadId }, INTERNAL, undefined, false, options?.sent);
  }
  async subscribeApp(options?: Pick<CallOptions, 'sent'>): Promise<void> {
    await this.run('app/subscribe', this.appParams(), INTERNAL, (v) => {
      this.attached(WIRE.appFeedId, v);
      this.appSubscribed = true;
    }, false, options?.sent);
  }

  // ── calls ──

  call(method: string, params: unknown, options?: CallOptions): Promise<never> {
    const info = methodInfo(method);
    if (!info) return Promise.reject(fail({ kind: 'unknownMethod', method }));
    let p = params as Json;
    if (info.mutation) {
      const given = (p as { opId?: string } | null)?.opId;
      p = { ...(p as object), opId: options?.opId ?? given ?? (this.o.newOpId ?? (() => uuidv7(Date.now())))() } as Json;
    }
    const opId = info.mutation ? (p as { opId: string }).opId : null;
    const feedId = (p as { feedId?: string } | null)?.feedId;
    const sync = startsControlThread(method, p)
      ? (v: Json) => void this.holdStarted(v, true)
      : method === 'feed/subscribe' && feedId
        ? (v: Json) => this.attached(feedId, v)
        : method === 'feed/unsubscribe' && feedId
          ? () => {
              this.recv.delete(feedId);
              this.awaitingSnapshot.delete(feedId);
              this.subToken.delete(feedId);
            }
          : undefined;
    return this.bounded(method, options?.timeoutMs, opId, (limit) => this.run(method, p, info, sync, false, options?.sent, limit)) as Promise<never>;
  }

  /** The time a call may take before it is sent (the wait for a ready connection, for a held thread's resume): `requestTimeoutMs`,
   *  120 s by default. A call that expires before it is sent fails and is never sent afterwards. Once sent, a request is bounded by
   *  the connection's health, not by its age (`health.ts`): the default limit stops at the send. Only a deadline the caller passes
   *  on purpose (`CallOptions.timeoutMs`) also bounds a sent request; the request stays pending then, so a late answer still does
   *  what it carries (a resume attaches its feed), and a mutation that was out may have run: it fails as `opOutcomeUnknown`. */
  private bounded<T>(method: string, timeoutMs: number | undefined, opId: string | null, start: (limit: CallLimit) => Promise<T>): Promise<T> {
    const limit: CallLimit = { method, expired: false, sent: false };
    const explicit = timeoutMs !== undefined;
    const ms = timeoutMs ?? this.o.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (limit.sent && !explicit) return;
        limit.expired = true;
        const cause: ClientErrorDetail = { kind: 'requestTimeout', method, sent: limit.sent };
        reject(fail(opId !== null && limit.sent ? { kind: 'opOutcomeUnknown', opId, state: 'statusFailed', cause } : cause));
      }, ms);
      start(limit).then(
        (value) => (clearTimeout(timer), resolve(value)),
        (error) => (clearTimeout(timer), reject(error))
      );
    });
  }

  /** The one way a control thread becomes held, whichever way its start was confirmed. `subscribed`: the reply itself subscribed this
   *  connection (the direct answer); otherwise (`op/status` confirmed a start made on a connection that is gone) it is resumed here,
   *  and the caller has the thread only once that is answered. Ended by `releaseHeld`. */
  private holdStarted(reply: Json, subscribed: boolean): Promise<Json> {
    const id = (reply as { thread?: { id?: unknown } } | null)?.thread?.id;
    if (typeof id !== 'string') return Promise.resolve(reply);
    const window: ResumeWindow = { none: true };
    this.held.set(id, window);
    if (subscribed) this.attached(id, reply);
    return subscribed ? Promise.resolve(reply) : this.restoreHeld(id, window).then(() => reply);
  }

  /** The one way a hold ends (unsubscribed, or the client closed; an unrestorable thread ends in `restoreHeld` the same way): what
   *  waits on the thread's resume is let go. */
  private releaseHeld(threadId: string): void {
    this.held.delete(threadId);
    this.heldRestoring.get(threadId)?.end();
    this.heldRestoring.delete(threadId);
  }
  /** `stay` calls (stub resolution inside the fold) never wait for a reconnect: they reject `connectionLost` instead. */
  private async run(method: string, params: Json, info: MethodInfo, sync?: (v: Json) => void, stay = false, onSent?: SentClaim, limit?: CallLimit): Promise<Json> {
    const generation = this.generation;
    for (;;) {
      if (stay) {
        if (this.status.state !== 'ready' || generation !== this.generation) throw fail({ kind: 'connectionLost' });
      } else {
        await this.whenReady();
        // A request naming a held control thread leaves only once that thread is subscribed again on this connection. A resume the
        // core refused (the thread is gone) never lets the request go on naming it: it fails here, nothing sent.
        const naming = (params as { threadId?: unknown } | null)?.threadId;
        const restoring = typeof naming === 'string' && method !== 'thread/resume' ? this.heldRestoring.get(naming) : undefined;
        if (restoring) {
          const lost = await restoring.done;
          if (lost) throw fail(lost);
          continue;
        }
      }
      // The caller was told it failed: a request that never left does not leave now.
      if (limit?.expired) throw fail({ kind: 'requestTimeout', method, sent: false });
      const sentGeneration = this.generation;
      const sent: SentAt = { all: this.responses, byClass: { ...this.classResponses }, feed: this.feedEvents };
      try {
        if (limit) limit.sent = true;
        return await this.rpc(method, params, info.class, sync, onSent);
      } catch (e) {
        const d = detailOf(e);
        if (d.kind === 'rpc' && d.code === -32001) {
          // Refused before it ran: it has not been out.
          if (limit) limit.sent = false;
          await this.awaitRetryTrigger(d, sent);
          if (sentGeneration !== this.generation && (method === 'feed/subscribe' || method === 'feed/unsubscribe')) {
            throw fail({ kind: 'connectionLost' });
          }
          continue;
        }
        if (d.kind === 'connectionLost' && info.mutation) return this.awaitReconcile(method, params, info);
        throw e;
      }
    }
  }

  private whenReady(): Promise<void> {
    if (this.status.state === 'ready') return Promise.resolve();
    if (this.terminal) return Promise.reject(fail(this.terminal));
    return new Promise((ok, err) => this.readyWaiters.push({ ok, err }));
  }

  /** SPEC R7: every trigger is a fact that arrives while the scope progresses; none is a timer. */
  private async awaitRetryTrigger(d: Extract<ClientErrorDetail, { kind: 'rpc' }>, sent: SentAt): Promise<void> {
    const data = d.data;
    switch (data?.reason) {
      case 'inflightLimit': {
        const cls = data.class;
        return this.waitUntil(() => this.classResponses[cls] > sent.byClass[cls]);
      }
      case 'queueFull':
        return this.waitUntil(() => this.responses > sent.all);
      case 'windowFull': {
        const t = data.threadId;
        return this.waitUntil(() => (this.threadLastEvent.get(t) ?? 0) > sent.feed);
      }
      default:
        throw fail(d);
    }
  }

  // ── op bookkeeping (protocol.md §9) ──

  private awaitReconcile(method: string, params: Json, info: MethodInfo): Promise<Json> {
    if (this.terminal) return Promise.reject(fail(this.terminal));
    const opId = (params as { opId: string }).opId;
    const scope = info.opScope(params);
    if (scope === undefined) return Promise.reject(fail({ kind: 'protocolViolation', what: `${method}: op scope field missing` }));
    return new Promise((resolve, reject) => {
      this.unanswered.set(opId, { method, params, info, scope, resolve, reject });
    });
  }

  /** One independent `op/status` per scope: a slow scope never holds back another. */
  private reconcileOps(): void {
    const byScope = new Map<string, string[]>();
    for (const [opId, u] of this.unanswered) byScope.set(u.scope, [...(byScope.get(u.scope) ?? []), opId]);
    for (const [scope, opIds] of byScope) void this.reconcileScope(scope, opIds);
  }

  /** `op/status` is an ordinary call (ready wait, `-32001` retry). The end of the connection leaves the scope parked for the
   * next reconnect's reconciliation; any other failure ends the scope's parked calls with `opOutcomeUnknown`. */
  private async reconcileScope(scope: string, opIds: string[]): Promise<void> {
    let entries: OpStatusEntry[];
    try {
      const reply = await this.run('op/status', { scope, opIds, fence: true }, methodInfo('op/status') ?? INTERNAL);
      entries = (reply as unknown as { ops: OpStatusEntry[] }).ops;
      if (!Array.isArray(entries)) throw fail({ kind: 'protocolViolation', what: 'op/status without ops' });
    } catch (e) {
      const cause = detailOf(e);
      if (isConnectionEnd(cause)) return;
      for (const opId of opIds) {
        const u = this.unanswered.get(opId);
        if (!u) continue;
        this.unanswered.delete(opId);
        u.reject(fail({ kind: 'opOutcomeUnknown', opId, state: 'statusFailed', cause }));
      }
      return;
    }
    for (const opId of opIds) {
      const u = this.unanswered.get(opId);
      if (!u) continue;
      this.unanswered.delete(opId);
      const e = entries.find((x) => x.opId === opId);
      if (!e) u.reject(fail({ kind: 'protocolViolation', what: `op/status omitted ${opId}` }));
      else this.settle(u, e);
    }
  }

  private settle(u: Unanswered, e: OpStatusEntry): void {
    switch (e.state) {
      case 'applied':
        if (startsControlThread(u.method, u.params)) return void this.holdStarted((e.result ?? null) as Json, false).then(u.resolve, u.reject);
        return u.resolve(e.result ?? null);
      case 'rejected':
        return u.reject(rpcFailure(e.error as unknown as JsonRpcErrorBody));
      case 'inProgress':
        // Same opId and payload: the core attaches the request to the running execution (protocol.md §9.3).
        this.run(u.method, u.params, u.info)
          .then((r) => (startsControlThread(u.method, u.params) ? this.holdStarted(r, false) : r))
          .then(u.resolve, u.reject);
        return;
      case 'notApplied':
        return u.reject(fail({ kind: 'opNotApplied', opId: e.opId }));
      default:
        return u.reject(fail({ kind: 'opOutcomeUnknown', opId: e.opId, state: e.state }));
    }
  }

  // ── blobs ──

  /** `sent` is the first page's frame: the call's own request. */
  private async readPages(blob: BlobDescriptor, stay: boolean, sent?: SentClaim): Promise<Uint8Array> {
    const page = this.server.limits.maxBlobPageBytes;
    const parts: Uint8Array[] = [];
    let offset = 0;
    while (offset < blob.bytes) {
      const params = { digest: blob.digest, offset, length: Math.min(page, blob.bytes - offset) };
      let r: Json;
      try {
        const first = offset === 0 ? sent : undefined;
        r = stay
          ? await this.run('blob/read', params, READ_C1, undefined, true, first)
          : await this.bounded('blob/read', undefined, null, (limit) => this.run('blob/read', params, READ_C1, undefined, false, first, limit));
      } catch (e) {
        throw blobError(e);
      }
      const bytes = fromB64((r as unknown as { bytesB64: string }).bytesB64);
      if (bytes.length === 0) throw fail({ kind: 'protocolViolation', what: 'empty blob page' });
      parts.push(bytes);
      offset += bytes.length;
    }
    const out = new Uint8Array(offset);
    let at = 0;
    for (const p of parts) {
      out.set(p, at);
      at += p.length;
    }
    return out;
  }
  readBlob(ref: BlobRef, options?: Pick<CallOptions, 'sent'>): Promise<Uint8Array> {
    return this.readPages(ref.blob, false, options?.sent);
  }

  async putBlob(bytes: Uint8Array, mediaType: string, options?: Pick<CallOptions, 'sent'> & { onChunkAccepted?(): void }): Promise<BlobRef> {
    const digest = `sha256:${[...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as DigestInput))].map((x) => x.toString(16).padStart(2, '0')).join('')}`;
    const chunk = this.server.limits.maxBlobPutChunkBytes;
    let offset = 0;
    do {
      // The upload is one message: it has left when its last chunk has (Node sends a large message as one application frame split into records,
      // and the call's send completes after the last record, shared/remote-transport.ts splitRemoteTransportPayload / remote-shim-calls.ts:148).
      const last = offset + chunk >= bytes.length;
      const chunkParams = { digest, offset, bytesB64: toB64(bytes.subarray(offset, offset + chunk)) };
      await this.bounded('blob/put', undefined, null, (limit) => this.run('blob/put', chunkParams, READ_C1, undefined, false, last ? options?.sent : undefined, limit));
      options?.onChunkAccepted?.();
      offset += chunk;
    } while (offset < bytes.length);
    return { blob: { digest, bytes: bytes.length, mediaType } };
  }
}

export const connect: Connect = async <S>(options: ConnectOptions<S>) => {
  const engine = new Engine(options as unknown as ConnectOptions<Json>);
  await engine.start();
  return engine as unknown as ProtocolClient<S>;
};
