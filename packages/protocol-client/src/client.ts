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
import { isKnownNotification, isOfferedRequest, isScopedMethod, isSectionMethod, methodInfo } from './method-table.ts';
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
  return (
    typeof b === 'object' &&
    b !== null &&
    typeof b.digest === 'string' &&
    typeof b.bytes === 'number' &&
    typeof b.mediaType === 'string'
  );
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

let failureText: ((detail: ClientErrorDetail) => string | undefined) | undefined;
/** The sentence a person is shown for a failure, in the host's language: installed once per realm by the host that displays failures.
 *  `undefined` keeps the library's own message; without it a failure other than `rpc` and `requestTimeout` says its kind. */
export function setClientFailureText(text: (detail: ClientErrorDetail) => string | undefined): void {
  failureText = text;
}

export class ClientFailure extends Error implements ClientError {
  readonly detail: ClientErrorDetail;
  constructor(detail: ClientErrorDetail) {
    super(
      failureText?.(detail) ??
        (detail.kind === 'rpc'
          ? `${detail.code} ${detail.reason ?? ''} ${detail.message}${refusedArgument(detail.data)}`
          : detail.kind === 'requestTimeout'
            ? `The core did not answer ${detail.method} in time.`
            : detail.kind)
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
  return fields?.reason === 'invalidParams' && typeof fields.expected === 'string' && fields.expected
    ? `: ${fields.expected}`
    : '';
}
const rpcFailure = (e: JsonRpcErrorBody): ClientFailure => {
  const data = e.data as ErrorData | undefined;
  return fail({ kind: 'rpc', code: e.code, reason: data?.reason, message: e.message, data });
};
const detailOf = (e: unknown): ClientErrorDetail =>
  e instanceof ClientFailure ? e.detail : { kind: 'protocolViolation', what: String(e) };
const isConnectionEnd = (d: ClientErrorDetail): boolean => d.kind === 'connectionLost' || d.kind === 'clientClosed';

function blobError(e: unknown): unknown {
  const d = detailOf(e);
  if (d.kind === 'rpc' && d.data?.reason === 'blobNotFound')
    return fail({ kind: 'blobNotFound', digest: d.data.digest });
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
function* changesOf(
  old: Map<string, Map<string, SectionEntry>>,
  staged: Map<string, Map<string, SectionEntry>>
): Generator<SectionEntry | null, void, void> {
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
const FEED_GONE: ReadonlySet<string> = new Set([
  'threadNotFound',
  'storeDamaged',
  'permissionDenied',
  'capabilityUnavailable',
  'methodNotFound',
  'invalidParams',
]);
/** What one call's time limit knows of the call (`Engine.bounded`). */
interface CallLimit {
  readonly method: string;
  /** The limit passed and the caller was told. */
  expired: boolean;
  /** Its request is out (written, not refused). */
  sent: boolean;
  /** Rejects when the work the request belongs to ended: `run` then leaves whatever it waits in (readiness, backpressure). */
  readonly ended?: Promise<never>;
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
/** The one attach of a thread: its `thread/resume` from the moment it is queued to its answer, and the snapshot request a
 *  legacy replay needs after it. It belongs to the thread, not to a caller or a window. */
interface Attach {
  readonly window: ResumeWindow;
  readonly sent: Promise<void>;
  /** How it ends, for everyone who waits on it; no waiter's own bound is part of it. */
  readonly outcome: Promise<ThreadResumeResponse>;
  /** What `run` holds of it: an attach that ended is not written, or written again. */
  readonly limit: CallLimit;
  token?: number;
  /** Its answer promised a snapshot that is not folded yet: receiving the snapshot is not having it. */
  owes: boolean;
  /** It has its outcome. One that succeeded stays listed while its snapshot is owed. */
  done: boolean;
  /** Ended without an answer (`end`): its answer, when it comes, changes nothing. */
  ended: boolean;
  /** The callers waiting on it now. */
  waiters: number;
  /** The caller that started it stopped waiting. */
  ownerLeft(cause: ClientErrorDetail): void;
  /** Ends it with `detail` for every waiter: the thread's loss, or nobody left waiting for a request not written yet. */
  end(detail: ClientErrorDetail): void;
}
const validFeed = (f: unknown): boolean =>
  f === undefined ||
  (isObj(f) &&
    typeof f.id === 'string' &&
    typeof f.epoch === 'string' &&
    typeof f.seq === 'number' &&
    (f.from === undefined || (typeof f.from === 'number' && f.from <= f.seq)));
/** The first position a frame stands for: a coalesced frame (`feed.from`, announced with `feedRanges`) covers `from..=seq`. */
const firstOf = (f: FeedStamp): number => f.from ?? f.seq;
/** A frame of a positioned subscription stamped with the feed position it stands at (`thread/window/changed`, and
 *  `thread/transcript/changed` that carries a unit), which it does not advance. */
const standsAtFeed = (n: JsonRpcNotification): boolean =>
  n.method === 'thread/window/changed' ||
  (n.method === 'thread/transcript/changed' && isObj(n.params) && n.params.change !== undefined);
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

/** The page's own macrotask queue: a message port's task runs in the next loop turn in a hidden page too, where a timer
 *  waits a second or more and what the core sends meanwhile would be held unfolded. */
let turnPort: { post(callback: () => void): void } | undefined;
function pageMacrotask(callback: () => void): void {
  if (!turnPort) {
    const waiting: Array<() => void> = [];
    // The DOM's and Node's ports share these members; the types in scope name only one of the two.
    const channel = new MessageChannel() as unknown as {
      port1: { onmessage: (() => void) | null; unref?: () => void };
      port2: { postMessage(value: unknown): void };
    };
    channel.port1.onmessage = () => waiting.shift()?.();
    // Under Node (no setImmediate only when a test removes it) an open port would hold the process.
    channel.port1.unref?.();
    turnPort = {
      post(next) {
        waiting.push(next);
        channel.port2.postMessage(0);
      },
    };
  }
  turnPort.post(callback);
}

function nextMacrotask(callback: () => void): void {
  // Read at call time: the renderer's program has no Node globals, and a page has no setImmediate.
  const immediate = (globalThis as { setImmediate?: (callback: () => void) => unknown }).setImmediate;
  if (typeof immediate === 'function') immediate(callback);
  else if (typeof MessageChannel === 'function') pageMacrotask(callback);
  else setTimeout(callback, 0);
}

/** A fold waiting for the next loop turn. */
interface Waiter {
  resume: () => void;
  fail: (error: unknown) => void;
}

/** A fold's pace (`Engine.pace`): nothing when its next unit may run now, else the wait for the next loop turn. */
type Pace = () => Promise<void> | undefined;

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
  private readonly resuming = new Map<string, Attach>();
  /** The id of the core subscription each feed is delivered on, as its attach answered it. An answer naming the same id
   *  carries that lane on: nothing of the feed's position changes. */
  private readonly subId = new Map<string, string>();
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
  /** A replay answered at or before the position already received (`attached`): the core's new subscription repeats `next..=through`,
   *  which the subscription it replaced delivered before the answer (or, `resumeFrom` being the folded position, before the request).
   *  Those frames are dropped in order, never folded twice; the first frame outside the range ends it. */
  private readonly repeated = new Map<string, { next: number; through: number }>();
  /** Orders connection-scoped notifications. */
  private chain: Promise<void> = Promise.resolve();
  /** Orders the folds of one feed. */
  private readonly feedChains = new Map<string, Promise<void>>();
  /** Told each thread `unsubscribeThread` lets go: the waits for its transcript (`whenThreadSettled`). */
  private readonly unsubscribed = new Set<(threadId: string) => void>();
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
    this.yieldTurn = options.turn?.yieldTurn ?? (() => new Promise<void>((r) => nextMacrotask(r)));
  }

  /** Whether the turn's budget is spent. The first to ask in a turn is told it is not, so every turn runs a unit
   *  whatever the budget. */
  private overBudget(): boolean {
    if (this.turnFresh) {
      this.turnFresh = false;
      return false;
    }
    return this.now() - this.turnStart > this.budgetMs;
  }
  private turnFresh = false;
  /** The turn whose budget `turnStart` measures, while it lasts: frames arriving later in the same loop turn share that budget
   *  instead of each starting one. It ends at the next macrotask. */
  private turnOpen = 0;
  private turnSeq = 0;
  private readonly inbox: Array<{ conn: number; text: string | null }> = [];
  private draining = false;
  private startTurn(): void {
    this.turnStart = this.now();
    this.turnFresh = false;
    const turn = ++this.turnSeq;
    this.turnOpen = turn;
    nextMacrotask(() => {
      if (this.turnOpen === turn) this.turnOpen = 0;
    });
  }
  private openTurn(): void {
    if (this.turnOpen === 0) this.startTurn();
  }
  /** Folds waiting for the next loop turn: the ones that ran no unit since they last waited, and the ones that did. */
  private readonly unserved: Waiter[] = [];
  private readonly served: Waiter[] = [];
  private pace(): Pace {
    let ran = false;
    return () => {
      if (!this.overBudget()) {
        ran = true;
        return undefined;
      }
      const waiting = new Promise<void>((resume, fail) => {
        const owed = this.unserved.length + this.served.length > 0;
        (ran ? this.served : this.unserved).push({ resume, fail });
        // The yield is owed once per turn, by the first to wait.
        if (owed) return;
        const all = () => [...this.unserved.splice(0), ...this.served.splice(0)];
        new Promise<void>((yielded) => yielded(this.yieldTurn())).then(
          () => {
            this.startTurn();
            this.turnFresh = true;
            for (const fold of all()) fold.resume();
          },
          (error: unknown) => {
            for (const fold of all()) fold.fail(error);
          }
        );
      });
      ran = false;
      return waiting;
    };
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
        if (
          detailOf(e).kind === 'versionRefused' ||
          (!this.o.keepTryingFirstConnect && (until === undefined || Date.now() + delay >= until))
        )
          throw e;
        await this.o.clock.sleep(delay);
      }
    }
    this.everReady = true;
    this.readyAt = Date.now();
    this.setStatus({ state: 'ready', serverInstanceId: this.server.serverInstanceId });
    this.diag('link-open', { linkSeq: this.connSeq });
  }

  private async establish(ms: number | undefined): Promise<void> {
    await this.openTransport();
    const attempt = this.handshake();
    if (ms === undefined) return attempt;
    attempt.catch(() => {});
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => {
          this.connSeq++;
          const w = this.writer;
          this.writer = null;
          w?.close(1000, 'connect timed out');
          for (const p of drain(this.pending)) p.reject(fail({ kind: 'connectionLost' }));
          reject(fail({ kind: 'requestTimeout', method: 'initialize', sent: true }));
        },
        Math.max(0, ms)
      );
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
        if (conn === this.connSeq) this.arrive(conn, t);
      },
      progress: () => {
        if (conn === this.connSeq) this.health.progress();
      },
      closed: (code, reason) => {
        if (conn !== this.connSeq) return;
        if (this.writer === null) early = { code, reason };
        // Frames that arrived before the close are handled before it.
        else if (this.inbox.length > 0) this.inbox.push({ conn, text: null });
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
        throw fail({
          kind: 'versionRefused',
          reason: d.data.reason,
          serverVersion: d.data.serverVersion,
          clientVersion: d.data.clientVersion,
        });
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
    this.repeated.clear();
    this.awaitingSnapshot.clear();
    this.replayThrough.clear();
    this.resuming.clear();
    this.subId.clear();
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
      this.diag('link-reconnected', {
        linkSeq: this.connSeq,
        attempts: attempt + 1,
        downMs: Date.now() - this.downAt,
        threadsToRestore: this.subs.size,
        appToRestore: this.appSubscribed,
      });
      // The connection is usable now. Each subscription and each scope's reconciliation proceeds independently.
      // The connection this restore belongs to is fixed now: a later reconnect advances `connSeq` before this settles.
      const restoring = this.connSeq;
      void this.restoreSubscriptions().then((outcome) =>
        this.diag('link-restore-settled', { linkSeq: restoring, ...outcome })
      );
      this.reconcileOps();
      return;
    }
  }

  private restoreSubscriptions(): Promise<{
    threadsRestored: number;
    threadsLost: number;
    threadsFailed: number;
    appRestored: boolean;
  }> {
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
  private async restoreRun(
    feedId: string,
    resume: () => Promise<unknown>,
    held: () => boolean
  ): Promise<'done' | 'ended' | ClientErrorDetail> {
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
    // The thread was lost while this restore was out (`loseThread` ended its registration): that loss was its end, and
    // whatever the thread is now belongs to a later open, which this restore reports nothing of.
    const owned = this.restoring.get(threadId) === mine;
    settled();
    if (!owned) return generation === this.generation ? 'lost' : 'failed';
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

  /** The one end of a thread that is not followed, reported once. It ends the ownership of whatever attach or restore of the
   *  thread is out (its waiters are rejected with the loss, its request is not written or written again, and its answer, when
   *  it comes, changes nothing), invalidates the folds under way, and keeps the window that was wanted but no cursor: the
   *  next resume is a new request for a snapshot. */
  private loseThread(threadId: string, window: ResumeWindow, outcome: ClientErrorDetail): void {
    this.resuming.get(threadId)?.end(outcome);
    this.resuming.delete(threadId);
    this.restoring.delete(threadId);
    this.subId.delete(threadId);
    this.awaitingSnapshot.delete(threadId);
    this.recv.delete(threadId);
    this.lostWindows.set(threadId, window);
    this.subs.delete(threadId);
    this.subToken.delete(threadId);
    this.repeated.delete(threadId);
    this.replayThrough.delete(threadId);
    this.store.threads.delete(threadId);
    this.foldedWindow.delete(threadId);
    // A fold of the lost subscription may wait on a read that is never answered: the next open does not queue behind it.
    this.feedChains.delete(threadId);
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
   *  subscribed on the current connection (`threadSubscription(id).held`). Rejects when the client is closed, and with `requestTimeout`
   *  when the bound the caller gave ends first: the wait is part of the call that needs the thread. Without one it has no limit. */
  whenHeldSettled(threadId: string, options?: Pick<CallOptions, 'timeoutMs'>): Promise<void> {
    const settled = async (limit?: CallLimit): Promise<void> => {
      for (;;) {
        await this.whenReady();
        const restoring = this.heldRestoring.get(threadId);
        if (!restoring || limit?.expired) return;
        await restoring.done;
      }
    };
    return options?.timeoutMs === undefined
      ? settled()
      : this.bounded('thread/resume', options.timeoutMs, null, settled);
  }
  private async restoreApp(): Promise<boolean> {
    const outcome = await this.restoreRun(
      WIRE.appFeedId,
      () =>
        this.bounded('app/subscribe', undefined, null, (limit) =>
          this.run(
            'app/subscribe',
            this.appParams(),
            INTERNAL,
            (r) => {
              this.attached(WIRE.appFeedId, r);
              this.completeAnnouncements();
            },
            true,
            undefined,
            limit
          )
        ),
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
      if (bytes > limit)
        throw fail({
          kind: 'protocolViolation',
          what: `frame of ${bytes} bytes is over maxInboundFrameBytes ${limit}`,
        });
    }
    w.send(text, sent);
  }

  private rpc(
    method: string,
    params: Json | undefined,
    cls?: RequestClass,
    sync?: (v: Json) => void,
    sent?: SentClaim
  ): Promise<Json> {
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

  /** `category` and `detail` are what the host's log gets: fixed names, kinds and numbers, never `what`, which may carry feed ids or
   *  exception text. */
  private violation(
    code: number,
    what: string,
    category = what,
    detail?: Record<string, string | number | boolean>
  ): void {
    this.emit({ type: 'protocolViolation', what });
    this.diag('link-violation', { linkSeq: this.connSeq, code, category, ...detail });
    this.dropLink(code, what);
  }

  /** A frame of `f`'s feed that does not continue the position received: which kind of feed and notification, and the positions. */
  private feedGap(n: JsonRpcNotification, f: FeedStamp, feedKind: 'app' | 'thread' | 'control' | 'scoped'): void {
    const cur = this.recv.get(f.id);
    this.violation(1002, `feed gap on ${f.id}`, 'feed gap', {
      feedKind,
      // A method the table does not list is the peer's text: logged as `unknown`.
      method: isKnownNotification(n.method) ? n.method : 'unknown',
      hadPosition: cur !== undefined,
      ...(cur ? { epochChanged: cur.epoch !== f.epoch, expectedSeq: cur.seq + 1 } : {}),
      receivedSeq: firstOf(f),
      ...(f.from !== undefined ? { receivedThroughSeq: f.seq } : {}),
    });
  }

  /** Whether `f` (not a snapshot) is the next frame of its feed's repeated range (`repeated`): it is dropped and the range advances. */
  private repeats(f: FeedStamp): boolean {
    const range = this.repeated.get(f.id);
    if (!range) return false;
    const cur = this.recv.get(f.id);
    if (cur?.epoch === f.epoch && firstOf(f) === range.next && f.seq <= range.through) {
      range.next = f.seq + 1;
      if (range.next > range.through) this.repeated.delete(f.id);
      return true;
    }
    this.repeated.delete(f.id);
    return false;
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

  private readonly health: LinkHealth;

  /** Whether the core is alive: a fresh probe and observation window begin now, and the answer is the health machine's verdict,
   *  which drops the link when the window passes with no progress from the core (a link that died unseen, as after a machine's
   *  sleep). Whatever state an earlier cycle held is void. False when there was no ready connection. */
  checkLink(): Promise<boolean> {
    return this.health.check();
  }

  /** A frame from the transport. It is handled at once while the turn's budget lasts; after that it waits, in arrival order, for
   *  a later turn, as a fold does: a socket read that delivers many frames cannot hold the thread for all of them. */
  private arrive(conn: number, text: string): void {
    this.health.progress();
    // The frame that opens a turn is its first unit, which every turn runs whatever the budget.
    const opens = this.turnOpen === 0;
    this.openTurn();
    if (this.inbox.length === 0 && (opens || this.now() - this.turnStart <= this.budgetMs)) {
      this.onFrame(text);
      return;
    }
    this.inbox.push({ conn, text });
    if (!this.draining) void this.drainInbox();
  }

  private async drainInbox(): Promise<void> {
    this.draining = true;
    const pace = this.pace();
    let loop = true;
    try {
      while (this.inbox.length > 0) {
        if (loop) {
          try {
            for (let wait = pace(); wait; wait = pace()) await wait;
          } catch {
            // No turn can be had: what arrived is handled now rather than never.
            loop = false;
          }
        }
        const next = this.inbox.shift()!;
        if (next.conn !== this.connSeq) continue;
        if (next.text === null) this.onClosed();
        else this.onFrame(next.text);
      }
    } finally {
      this.draining = false;
    }
  }

  private onFrame(text: string): void {
    // RFC 6455: 1007 for a payload that does not decode, 1002 for a sequence violation.
    let m: Record<string, unknown>;
    try {
      m = JSON.parse(text) as Record<string, unknown>;
    } catch {
      this.violation(1007, 'invalid json');
      return;
    }
    if (typeof m !== 'object' || m === null || Array.isArray(m)) {
      this.violation(1007, 'frame is not an object');
      return;
    }
    if (typeof m.method === 'string') {
      if ('id' in m) {
        this.onServerRequest({
          id: m.id as RequestId,
          method: m.method,
          params: m.params ?? null,
        } as ServerRequest);
        return;
      }
      if (!validFeed(m.feed)) {
        this.violation(1007, 'bad notification');
        return;
      }
      this.onNotification(m as unknown as JsonRpcNotification);
      return;
    }
    const p = this.pending.get(m.id as RequestId);
    if (!p) {
      this.violation(1002, 'response to unknown request');
      return;
    }
    if ('error' in m && !validErrorBody(m.error)) {
      // stays pending: the close settles it
      this.violation(1007, 'bad error body');
      return;
    }
    this.pending.delete(m.id as RequestId);
    this.health.requestsChanged();
    if ('error' in m) {
      const err = m.error as JsonRpcErrorBody;
      if (err.code !== -32001) this.countResponse(p.cls);
      p.reject(rpcFailure(err));
      return;
    }
    this.countResponse(p.cls);
    try {
      p.sync?.(m.result as Json);
    } catch (e) {
      p.reject(e as ClientFailure);
      return;
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
    if (data.byteLength > this.server.limits.maxMediaFrameBytes + 16)
      throw fail({ kind: 'protocolViolation', what: 'media frame over maxMediaFrameBytes' });
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
    if (isScopedMethod(n.method) && f.id !== WIRE.appFeedId && !this.subs.has(f.id)) {
      this.onScoped(n, f, gen);
      return;
    }
    this.feedEvents++;
    this.threadLastEvent.set(f.id, this.feedEvents);
    this.pulse();
    const tracked = f.id === WIRE.appFeedId ? this.appSubscribed : this.subs.has(f.id);
    if (!tracked && !this.held.has(f.id)) return;
    const snapshot = n.method === WIRE.threadSnapshot || n.method === WIRE.appSnapshot;
    const cur = this.recv.get(f.id);
    // A positioned window's change stands at the position the feed has reached and takes no seq of its own.
    const fenced = !snapshot && cur?.epoch === f.epoch && f.seq === cur.seq && f.from === undefined && standsAtFeed(n);
    if (snapshot) this.repeated.delete(f.id);
    else if (!fenced && this.repeats(f)) return;
    if (!snapshot && !fenced && (!cur || cur.epoch !== f.epoch || firstOf(f) !== cur.seq + 1)) {
      this.feedGap(n, f, f.id === WIRE.appFeedId ? 'app' : tracked ? 'thread' : 'control');
      return;
    }
    const order = this.received(f.id, f.epoch, f.seq);
    if (snapshot) this.awaitingSnapshot.delete(f.id);
    if (!tracked) return; // Held control threads participate in continuity but do not need a fold.
    const tok = this.subToken.get(f.id);
    this.feedChains.set(
      f.id,
      (this.feedChains.get(f.id) ?? Promise.resolve()).then(() => this.fold(n, f, snapshot, gen, tok, order))
    );
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
    if (n.method === 'feed/snapshot') this.repeated.delete(f.id);
    else if (this.repeats(f)) return;
    const cur = this.recv.get(f.id);
    if (n.method !== 'feed/snapshot' && cur && (cur.epoch !== f.epoch || firstOf(f) !== cur.seq + 1)) {
      this.feedGap(n, f, 'scoped');
      return;
    }
    this.received(f.id, f.epoch, f.seq);
    if (n.method === 'feed/snapshot') this.awaitingSnapshot.delete(f.id);
    this.feedChains.set(
      f.id,
      (this.feedChains.get(f.id) ?? Promise.resolve()).then(async () => {
        const failed: ClientErrorDetail[] = [];
        let resolved: Json;
        try {
          resolved = await this.resolveBlobs(n.params ?? null, failed, this.pace());
        } catch {
          return; // the connection ended; the next generation re-attaches
        }
        if (gen !== this.generation) return;
        for (const error of failed) this.emit({ type: 'blobUnavailable', feed: f, error });
        this.emit({ type: 'notification', notification: { ...n, params: resolved } });
      })
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

  private async fold(
    n: JsonRpcNotification,
    f: FeedStamp,
    snapshot: boolean,
    gen: number,
    tok: number | undefined,
    order: number
  ): Promise<void> {
    if (snapshot && f.id === WIRE.appFeedId) return this.foldAppSnapshot(n, f, gen, tok);
    const failed: ClientErrorDetail[] = [];
    let resolved: JsonRpcNotification;
    try {
      resolved = { ...n, params: await this.resolveBlobs(n.params ?? null, failed, this.pace()) };
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
    const attach = this.resuming.get(f.id);
    if (snapshot && attach && attach.token === tok) {
      attach.owes = false;
      this.resuming.delete(f.id);
    }
    const boundary = this.replayThrough.get(f.id);
    const replayComplete = typeof boundary === 'number' && f.seq >= boundary;
    if (replayComplete) this.replayThrough.delete(f.id);
    this.store.emit({ type: 'thread', threadId: f.id, ...(replayComplete ? { replayComplete: true } : {}) });
  }

  /** `reducer.initial(params)`, stepped when the reducer can (see `ThreadReducer.initialSteps`); null when the connection ended meanwhile. */
  private async initialState(
    params: Json,
    feedId: string,
    gen: number,
    tok: number | undefined
  ): Promise<{ state: Json } | null> {
    const reducer = this.reducer;
    if (!reducer) return { state: params };
    if (!reducer.initialSteps) return { state: reducer.initial(params) };
    const steps = reducer.initialSteps(params);
    const pace = this.pace();
    for (;;) {
      for (let wait = pace(); wait; wait = pace()) {
        await wait;
        if (!this.current(feedId, gen, tok)) return null;
      }
      const r = steps.next();
      if (r.done) return this.current(feedId, gen, tok) ? { state: r.value } : null;
    }
  }

  private foldApp(n: JsonRpcNotification, f: FeedStamp): void {
    this.store.app = f;
    if (isSectionMethod(n.method)) this.store.applySection(n.params as unknown as SectionUpdate);
    else this.emit({ type: 'notification', notification: n });
  }

  private async foldAppSnapshot(
    n: JsonRpcNotification,
    f: FeedStamp,
    gen: number,
    tok: number | undefined
  ): Promise<void> {
    const failed: ClientErrorDetail[] = [];
    const staged = new Map<string, Map<string, SectionEntry>>();
    const pace = this.pace();
    try {
      for (const u of (n.params as unknown as AppSnapshotParams).sections) {
        for (let wait = pace(); wait; wait = pace()) await wait;
        const value = u.value === undefined ? undefined : await this.resolveBlobs(u.value, failed, pace);
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
    this.store.owed ??= [];
    this.store.owed.push(changesOf(old, staged));
    await this.announce(gen, tok, pace);
  }

  private async announce(gen: number, tok: number | undefined, pace: Pace = this.pace()): Promise<void> {
    const owed = this.store.owed;
    if (!owed) return;
    while (owed.length) {
      for (let wait = pace(); wait; wait = pace()) {
        await wait;
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
    this.feedChains.set(
      WIRE.appFeedId,
      (this.feedChains.get(WIRE.appFeedId) ?? Promise.resolve()).then(() => this.announce(gen, tok))
    );
  }

  /** Replaces every text stub by its content, in place: the parsed frame is the client's own, so there is no second copy beside it.
   * A stub that cannot be read stays a stub and its error is appended to `failed`; only the end of the connection aborts the whole
   * resolution. Every child visited is a unit of the turn's budget. */
  private async resolveBlobs(v: Json, failed: ClientErrorDetail[], pace: Pace): Promise<Json> {
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
      if ((++this.visited & 63) === 0) for (let wait = pace(); wait; wait = pace()) await wait;
      const child = holder[k] as Json;
      if (typeof child !== 'object' || child === null) continue;
      const resolved = await this.resolveBlobs(child, failed, pace);
      if (resolved !== child)
        Object.defineProperty(holder, k, { value: resolved, writable: true, enumerable: true, configurable: true });
    }
    return v;
  }

  private resumeParams(threadId: string, window: ResumeWindow, snapshot: boolean): Json {
    const prev = snapshot ? undefined : this.store.threads.get(threadId);
    const prevWindow = this.foldedWindow.get(threadId);
    const resumeFrom =
      prev && prevWindow && !this.cursorReset.has(threadId)
        ? { epoch: prev.feed.epoch, seq: prev.feed.seq, window: prevWindow }
        : undefined;
    const positioned = this.o.positionedTranscripts === true && isObj(window) && 'lastItems' in window;
    return {
      threadId,
      window,
      ...(resumeFrom ? { resumeFrom } : {}),
      ...(positioned ? { positionedWindow: true } : {}),
    } as unknown as Json;
  }
  private appParams(): Json {
    const a = this.cursorReset.has(WIRE.appFeedId) ? undefined : this.store.app;
    return (a ? { resumeFrom: { epoch: a.epoch, seq: a.seq } } : {}) as unknown as Json;
  }
  private attached(feedId: string, r: Json, window?: ResumeWindow): void {
    const s = (r as unknown as ThreadResumeResponse).subscription;
    // The core kept the subscription this feed is delivered on (it names the same one): the lane runs on. What was received
    // and what is being folded stand, and nothing is delivered twice. Only the id says so, never a position.
    if (s.id !== undefined && this.subId.get(feedId) === s.id) return;
    if (s.id === undefined) this.subId.delete(feedId);
    else this.subId.set(feedId, s.id);
    // A reply that arrives after its feed already ran past the position it names is a stale read: it resets nothing, so the
    // events already received stay in order (the transcript is the feed's, not the reply's). A replay then repeats them: the core
    // replaced the subscription that delivered them, and the new one starts at `startSeq` (`repeated`). A snapshot resets the position.
    this.repeated.delete(feedId);
    const ahead = this.recv.get(feedId);
    if (ahead && ahead.epoch === s.epoch && ahead.seq >= s.startSeq) {
      if (s.mode === 'replay') this.repeated.set(feedId, { next: s.startSeq, through: ahead.seq });
      return;
    }
    if (window) {
      const boundary = s.liveSeq - 1;
      const folded = this.store.threads.get(feedId)?.feed;
      if (s.mode === 'replay' && !Number.isSafeInteger(s.liveSeq)) {
        this.replayThrough.set(feedId, null);
      } else if (
        s.mode === 'replay' &&
        boundary >= s.startSeq &&
        (folded?.epoch !== s.epoch || folded.seq < boundary)
      ) {
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

  private requestResume(
    threadId: string,
    window: ResumeWindow,
    options?: ResumeOptions,
    restoring = false
  ): Promise<ThreadResumeResponse> {
    const current = this.resuming.get(threadId);
    if (!restoring) {
      const requested =
        current?.window ?? this.subs.get(threadId) ?? this.lostWindows.get(threadId) ?? this.foldedWindow.get(threadId);
      if (options?.follow && requested && !('none' in requested) && !windowCovers(window, requested))
        window = requested;
      window = retainWindow(window, this.lostWindows.get(threadId));
      window = retainWindow(window, this.foldedWindow.get(threadId));
      window = retainWindow(window, this.subs.get(threadId));
      window = retainWindow(window, current?.window);
    }
    if (current && !current.done) {
      // One attach of a thread is out at a time, whoever asks and for whatever window: a caller it answers waits for it.
      if (windowCovers(current.window, window)) return this.awaitAttach(current, options, false);
      // A join never yields less than was asked: more than the attach in flight brings is asked once that one has ended,
      // never beside it.
      const asked = window;
      return this.bounded(
        'thread/resume',
        options?.timeoutMs,
        null,
        async (limit, abandoned) => {
          await current.outcome.catch(() => undefined);
          if (limit.expired) throw fail({ kind: 'requestTimeout', method: 'thread/resume', sent: false });
          const left = new AbortController();
          void abandoned.then(() => left.abort());
          return this.requestResume(threadId, asked, { ...options, timeoutMs: undefined, signal: left.signal }, restoring);
        },
        options?.signal,
        current.limit
      );
    }
    // Answered, its snapshot not folded yet: a caller that only needs the thread followed sends nothing.
    const answered = options?.force ? undefined : current;
    if (answered && windowCovers(answered.window, window) && (options?.join || windowCovers(window, answered.window)))
      return this.awaitAttach(answered, options, false);

    const params = this.resumeParams(
      threadId,
      window,
      options?.force === true && this.awaitingSnapshot.has(threadId)
    );
    let departed!: (sent: Promise<void>) => void;
    const sent = new Promise<void>((resolve) => (departed = resolve));
    void sent.catch(() => undefined);
    let quit!: (error: ClientFailure) => void;
    const ended = new Promise<never>((_, reject) => (quit = reject));
    ended.catch(() => undefined);
    let ownerLeft!: (cause: ClientErrorDetail) => void;
    const abandoned = new Promise<ClientErrorDetail>((resolve) => (ownerLeft = resolve));
    const limit: CallLimit = { method: 'thread/resume', expired: false, sent: false, ended };
    const generation = this.generation;
    const work = async (): Promise<ThreadResumeResponse> => {
      // Register the attach before any transport can answer it.
      await Promise.resolve();
      if (restoring && generation !== this.generation) throw fail({ kind: 'connectionLost' });
      const r = (await this.run(
        'thread/resume',
        params,
        INTERNAL,
        (v) => {
          // The thread was lost while the request was out: its answer cannot revive it.
          if (attach.ended) return;
          this.answered(threadId, attach, v);
          if (!restoring) {
            this.subs.set(threadId, retainWindow(window, this.subs.get(threadId)));
            this.lostWindows.delete(threadId);
          }
        },
        restoring,
        (frame) => {
          departed(frame);
          options?.sent?.(frame);
        },
        limit
      )) as unknown as ThreadResumeResponse;
      // A replay an older core could not bound is resolved before the attach is: a phase of this attach, not another one.
      if (
        r.subscription.mode === 'replay' &&
        !Number.isSafeInteger(r.subscription.liveSeq) &&
        this.subs.has(threadId) &&
        this.replayThrough.get(threadId) === null
      ) {
        await this.resolveLegacyReplay(threadId, attach, r.subscription, generation, abandoned);
      }
      return r;
    };
    const attach: Attach = {
      window,
      sent,
      limit,
      outcome: Promise.race([work(), ended]),
      owes: false,
      done: false,
      ended: false,
      waiters: 0,
      ownerLeft,
      end(detail) {
        if (attach.done || attach.ended) return;
        attach.ended = true;
        limit.expired = true;
        quit(fail(detail));
      },
    };
    this.resuming.set(threadId, attach);
    const settled = (answered: boolean): void => {
      attach.done = true;
      // What stays of an answered attach is the snapshot it owes, until that is folded. A held control thread is never
      // folded: nothing later ends its entry.
      const owes = answered && attach.owes && !this.held.has(threadId);
      if (!owes && this.resuming.get(threadId) === attach) this.resuming.delete(threadId);
    };
    attach.outcome.then(
      () => settled(true),
      () => settled(false)
    );
    return this.awaitAttach(attach, options, true);
  }

  /** An attach's answer applied: the subscription it names, and whether a snapshot of that subscription is now owed. */
  private answered(threadId: string, attach: Attach, r: Json): void {
    const before = this.subToken.get(threadId);
    this.attached(threadId, r, attach.window);
    const token = this.subToken.get(threadId);
    if (token !== undefined) attach.token = token;
    attach.owes = token !== before && (r as unknown as ThreadResumeResponse).subscription.mode === 'snapshot';
  }

  /** One caller's wait for an attach: its own bound or signal ends that wait and nothing else, except that a request nobody
   *  waits for any more is not written (or written again), and that the caller who started the attach owns the resolution of
   *  a legacy replay (`resolveLegacyReplay`). */
  private awaitAttach(attach: Attach, options: ResumeOptions | undefined, own: boolean): Promise<ThreadResumeResponse> {
    // A joiner's frame is the one in flight: it has left when that one has.
    if (!own) options?.sent?.(attach.sent);
    attach.waiters += 1;
    return this.bounded(
      'thread/resume',
      options?.timeoutMs,
      null,
      (_limit, abandoned) => {
        void abandoned.then((cause) => {
          attach.waiters -= 1;
          if (own) attach.ownerLeft(cause);
          if (attach.waiters === 0 && !attach.limit.sent)
            attach.end({ kind: 'requestTimeout', method: 'thread/resume', sent: false });
        });
        return attach.outcome;
      },
      options?.signal,
      attach.limit
    );
  }

  /** The second phase of an attach an older core answered with a replay that names no live boundary: the head is asked
   *  (`feed/heads`), and an unusable one is replaced by a snapshot of the thread, requested under the same attach. Throws as
   *  that phase failed: the attach is then not a followed thread. */
  private async resolveLegacyReplay(
    threadId: string,
    attach: Attach,
    subscription: ThreadResumeResponse['subscription'],
    generation: number,
    abandoned: Promise<ClientErrorDetail>
  ): Promise<void> {
    const { window } = attach;
    const pending = () =>
      !attach.ended &&
      this.current(threadId, generation, attach.token) &&
      this.subs.has(threadId) &&
      this.replayThrough.get(threadId) === null;
    let quit: ClientErrorDetail | undefined;
    const givenUp = abandoned.then((detail) => {
      quit = detail;
      throw fail(detail);
    });
    givenUp.catch(() => undefined);
    let head: FeedHeadsResponse['positions'][number] | undefined;
    try {
      const reply = (await Promise.race([
        this.bounded('feed/heads', undefined, null, (limit) =>
          this.run('feed/heads', { feedIds: [threadId] }, INTERNAL, undefined, true, undefined, limit)
        ),
        givenUp,
      ])) as unknown as FeedHeadsResponse;
      [head] = reply.positions;
    } catch (error) {
      if (quit) {
        if (pending()) this.loseThread(threadId, window, quit);
        throw error;
      }
      const detail = detailOf(error);
      if (
        detail.kind !== 'rpc' ||
        (detail.code !== -32601 && detail.code !== -32603 && detail.reason !== 'methodNotFound')
      )
        return;
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

    // Read the bounded tail as a fresh snapshot of this already-followed thread. Outside a reconnect restore it is registered
    // as one, so unsubscribe convergence also accounts for a recovery that was in flight when the view left.
    const mine = {};
    const registered = !this.restoring.has(threadId);
    if (registered) {
      this.restoring.set(threadId, mine);
      this.restoreStarts++;
    }
    let failure: { error: unknown } | undefined;
    try {
      await Promise.race([
        this.run(
          'thread/resume',
          this.resumeParams(threadId, window, true),
          INTERNAL,
          (v) => {
            if (!attach.ended) this.answered(threadId, attach, v);
          },
          true,
          undefined,
          attach.limit
        ),
        givenUp,
      ]);
    } catch (error) {
      failure = { error };
    }
    // Keep the requested window for Retry, but never offer the unconfirmed cursor again.
    const lost = failure !== undefined && pending();
    // A lost thread's restore registration ended with it: what was registered here reports only its own end.
    const reports = registered && this.restoring.get(threadId) === mine;
    if (reports) this.restoring.delete(threadId);
    if (lost) this.loseThread(threadId, window, detailOf(failure?.error));
    else if (reports && generation === this.generation) {
      this.store.emit({
        type: 'subscription',
        feedId: threadId,
        state: this.subs.has(threadId) ? 'restored' : 'cancelled',
      });
    }
    // The attach ends as its fallback did: an unresolved replay is never a followed thread.
    if (failure) throw failure.error;
  }
  /** `ProtocolClient.reopenThread`. */
  reopenThread(threadId: string, window: ResumeWindow, options?: ResumeOptions): Promise<ThreadResumeResponse> {
    const out = this.resuming.get(threadId);
    const desired = this.subs.get(threadId) ?? out?.window;
    if (desired)
      this.loseThread(threadId, desired, {
        kind: 'requestTimeout',
        method: 'thread/resume',
        sent: out ? out.limit.sent : true,
      });
    return this.requestResume(threadId, window, options);
  }
  /** `ProtocolClient.whenThreadSettled`. */
  async whenThreadSettled(threadId: string): Promise<boolean> {
    // An unsubscribe produces no fold, loss or connection change: it ends the wait itself.
    let gone = false;
    let leave = (): void => undefined;
    const left = new Promise<void>((resolve) => (leave = resolve));
    const onLeft = (id: string): void => {
      if (id !== threadId) return;
      gone = true;
      leave();
    };
    this.unsubscribed.add(onLeft);
    try {
      for (;;) {
        if (gone) return false;
        const attach = this.resuming.get(threadId);
        if (attach && !attach.done) {
          await Promise.race([attach.outcome, left]);
          continue;
        }
        if (!attach && !this.awaitingSnapshot.has(threadId) && !this.replayThrough.has(threadId)) return true;
        // Owed by an answered attach: the fold that brings it, the thread's loss or the end of the connection is next.
        await new Promise<void>((resolve, reject) => {
          const settle = (error?: ClientFailure): void => {
            offStore();
            offEvents();
            if (error) reject(error);
            else resolve();
          };
          const offStore = this.store.subscribe((change) => {
            if (change.type === 'thread' && change.threadId === threadId) settle();
            else if (change.type === 'subscription' && change.feedId === threadId && change.state === 'lost')
              settle(fail(change.error ?? { kind: 'connectionLost' }));
          });
          const offEvents = this.on((event) => {
            if (event.type === 'status' && event.status.state !== 'ready') settle(fail({ kind: 'connectionLost' }));
          });
          void left.then(() => settle());
        });
      }
    } finally {
      this.unsubscribed.delete(onLeft);
    }
  }
  async confirmFeeds(feedIds: readonly string[]): Promise<boolean> {
    const generation = this.generation;
    // Positions received while the request was out count too. A relay pong says nothing about these heads.
    const { feedIds: active, positions } = (await this.bounded('feed/heads', undefined, null, (limit) =>
      this.run('feed/heads', {}, INTERNAL, undefined, true, undefined, limit)
    )) as unknown as FeedHeadsResponse;
    if (generation !== this.generation || !active || active.length !== positions.length) return false;
    const live = new Set(active);
    return (
      feedIds.every((id) => live.has(id)) &&
      positions.every((head, i) => {
        const id = active[i]!;
        const received = this.recv.get(id);
        return (
          head !== null && !this.awaitingSnapshot.has(id) && received?.epoch === head.epoch && received.seq >= head.seq
        );
      })
    );
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
      ...(this.subId.has(threadId) ? { subscriptionId: this.subId.get(threadId) } : {}),
    };
  }
  async unsubscribeThread(threadId: string, options?: Pick<CallOptions, 'sent'>): Promise<void> {
    this.subs.delete(threadId);
    this.lostWindows.delete(threadId);
    this.releaseHeld(threadId);
    this.subToken.delete(threadId);
    this.recv.delete(threadId);
    this.repeated.delete(threadId);
    this.awaitingSnapshot.delete(threadId);
    this.replayThrough.delete(threadId);
    this.resuming.delete(threadId);
    this.subId.delete(threadId);
    this.store.threads.delete(threadId);
    this.foldedWindow.delete(threadId);
    this.feedChains.delete(threadId);
    for (const told of [...this.unsubscribed]) told(threadId);
    await this.run('thread/unsubscribe', { threadId }, INTERNAL, undefined, false, options?.sent);
  }
  async subscribeApp(options?: Pick<CallOptions, 'sent'>): Promise<void> {
    await this.run(
      'app/subscribe',
      this.appParams(),
      INTERNAL,
      (v) => {
        this.attached(WIRE.appFeedId, v);
        this.appSubscribed = true;
      },
      false,
      options?.sent
    );
  }

  // ── calls ──

  call(method: string, params: unknown, options?: CallOptions): Promise<never> {
    const info = methodInfo(method);
    if (!info) return Promise.reject(fail({ kind: 'unknownMethod', method }));
    let p = params as Json;
    if (info.mutation) {
      const given = (p as { opId?: string } | null)?.opId;
      p = {
        ...(p as object),
        opId: options?.opId ?? given ?? (this.o.newOpId ?? (() => uuidv7(Date.now())))(),
      } as Json;
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
              this.repeated.delete(feedId);
              this.awaitingSnapshot.delete(feedId);
              this.subToken.delete(feedId);
              this.subId.delete(feedId);
            }
          : undefined;
    return this.bounded(method, options?.timeoutMs, opId, (limit) =>
      this.run(method, p, info, sync, false, options?.sent, limit)
    ) as Promise<never>;
  }

  private bounded<T>(
    method: string,
    timeoutMs: number | undefined,
    opId: string | null,
    start: (limit: CallLimit, abandoned: Promise<ClientErrorDetail>) => Promise<T>,
    signal?: AbortSignal,
    /** The request this wait is for, when it is not the caller's own (a shared attach): whether it is out is read there. */
    of?: CallLimit
  ): Promise<T> {
    const limit: CallLimit = { method, expired: false, sent: false };
    const out = (): boolean => (of ?? limit).sent;
    const explicit = timeoutMs !== undefined;
    const ms = timeoutMs ?? this.o.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    let abandon!: (cause: ClientErrorDetail) => void;
    // Resolves when the caller stops waiting (its bound, or its signal), so work owed to that wait can end with it.
    const abandoned = new Promise<ClientErrorDetail>((resolve) => (abandon = resolve));
    return new Promise<T>((resolve, reject) => {
      const end = (): void => {
        if (limit.expired) return;
        limit.expired = true;
        const cause: ClientErrorDetail = { kind: 'requestTimeout', method, sent: out() };
        abandon(cause);
        reject(
          fail(opId !== null && out() ? { kind: 'opOutcomeUnknown', opId, state: 'statusFailed', cause } : cause)
        );
      };
      const timer = setTimeout(() => {
        if (out() && !explicit) return;
        end();
      }, ms);
      const settle = (): void => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', end);
      };
      signal?.addEventListener('abort', end, { once: true });
      if (signal?.aborted) end();
      start(limit, abandoned).then(
        (value) => {
          settle();
          resolve(value);
        },
        (error) => {
          settle();
          reject(error);
        }
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
  private async run(
    method: string,
    params: Json,
    info: MethodInfo,
    sync?: (v: Json) => void,
    stay = false,
    onSent?: SentClaim,
    limit?: CallLimit
  ): Promise<Json> {
    const generation = this.generation;
    // Work that ended leaves the wait it is in at once; it is never written after that.
    const unlessEnded = <T>(wait: Promise<T>): Promise<T> => (limit?.ended ? Promise.race([wait, limit.ended]) : wait);
    for (;;) {
      if (stay) {
        if (this.status.state !== 'ready' || generation !== this.generation) throw fail({ kind: 'connectionLost' });
      } else {
        await unlessEnded(this.whenReady());
        // A request naming a held control thread leaves only once that thread is subscribed again on this connection. A resume the
        // core refused (the thread is gone) never lets the request go on naming it: it fails here, nothing sent.
        const naming = (params as { threadId?: unknown } | null)?.threadId;
        const restoring =
          typeof naming === 'string' && method !== 'thread/resume' ? this.heldRestoring.get(naming) : undefined;
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
          await unlessEnded(this.awaitRetryTrigger(d, sent));
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
    if (scope === undefined)
      return Promise.reject(fail({ kind: 'protocolViolation', what: `${method}: op scope field missing` }));
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
        if (startsControlThread(u.method, u.params))
          return void this.holdStarted((e.result ?? null) as Json, false).then(u.resolve, u.reject);
        u.resolve(e.result ?? null);
        return;
      case 'rejected':
        u.reject(rpcFailure(e.error as unknown as JsonRpcErrorBody));
        return;
      case 'inProgress':
        // Same opId and payload: the core attaches the request to the running execution (protocol.md §9.3).
        this.run(u.method, u.params, u.info)
          .then((r) => (startsControlThread(u.method, u.params) ? this.holdStarted(r, false) : r))
          .then(u.resolve, u.reject);
        return;
      case 'notApplied':
        u.reject(fail({ kind: 'opNotApplied', opId: e.opId }));
        return;
      default:
        u.reject(fail({ kind: 'opOutcomeUnknown', opId: e.opId, state: e.state }));
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
          : await this.bounded('blob/read', undefined, null, (limit) =>
              this.run('blob/read', params, READ_C1, undefined, false, first, limit)
            );
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

  async putBlob(
    bytes: Uint8Array,
    mediaType: string,
    options?: Pick<CallOptions, 'sent'> & { onChunkAccepted?(): void }
  ): Promise<BlobRef> {
    const digest = `sha256:${[...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as DigestInput))].map((x) => x.toString(16).padStart(2, '0')).join('')}`;
    const chunk = this.server.limits.maxBlobPutChunkBytes;
    const budget = this.server.limits.maxUploadInFlightBytes;
    const window = Number.isSafeInteger(budget) && budget > 0 ? budget : 0;
    const cost = (offset: number): number => 4 * Math.ceil(Math.min(chunk, bytes.length - offset) / 3);
    let claimed = false;
    const put = async (offset: number): Promise<number> => {
      const end = Math.min(offset + chunk, bytes.length);
      // The upload is one message: it has left when its last chunk has (Node sends a large message as one application frame split into records,
      // and the call's send completes after the last record, shared/remote-transport.ts splitRemoteTransportPayload / remote-shim-calls.ts:148).
      const claim = end >= bytes.length && !claimed ? options?.sent : undefined;
      if (end >= bytes.length) claimed = true;
      const chunkParams = { digest, offset, bytesB64: toB64(bytes.subarray(offset, end)) };
      await this.bounded('blob/put', undefined, null, (limit) =>
        this.run('blob/put', chunkParams, READ_C1, undefined, false, claim, limit)
      );
      return end;
    };
    // The core holds a chunk only at the next byte after those it has, so an acknowledged chunk proves every byte before it is held.
    let stored = 0;
    let failure = undefined as { error: unknown } | undefined;
    let reordered = false as boolean;
    const accepted = (end: number): void => {
      stored = Math.max(stored, end);
      try {
        options?.onChunkAccepted?.();
      } catch (e) {
        failure ??= { error: e };
      }
    };
    // Chunks go out in order with up to `maxUploadInFlightBytes` of base64 unanswered; a core that states none is served one at a time.
    // A chunk the core refuses as out of its order (a retried `inflightLimit` landing behind its successors, or a dispatch that did not
    // keep arrival order) leaves the blob as it was, so the put goes on one chunk at a time from the bytes known held.
    const open = new Set<Promise<void>>();
    let inFlight = 0;
    let next = 0;
    let more = true;
    for (;;) {
      while (more && !failure && !reordered && (open.size === 0 || (window > 0 && inFlight + cost(next) <= window))) {
        const offset = next;
        const size = cost(offset);
        inFlight += size;
        const settled: Promise<void> = put(offset)
          .then(accepted, (e) => {
            const d = detailOf(e);
            if (d.kind === 'rpc' && d.reason === 'invalidParams' && (d.data as { path?: unknown } | undefined)?.path === 'offset') {
              reordered = true;
            } else failure ??= { error: e };
          })
          .then(() => {
            inFlight -= size;
            open.delete(settled);
          });
        open.add(settled);
        next += chunk;
        more = next < bytes.length;
      }
      if (open.size === 0) break;
      await Promise.race(open);
    }
    const early = failure as { error: unknown } | undefined;
    if (early) throw early.error;
    for (let offset = reordered ? stored : bytes.length; offset < bytes.length; ) {
      const end = await put(offset);
      accepted(end);
      const late = failure as { error: unknown } | undefined;
      if (late) throw late.error;
      offset = end;
    }
    return { blob: { digest, bytes: bytes.length, mediaType } };
  }
}

export const connect: Connect = async <S>(options: ConnectOptions<S>) => {
  const engine = new Engine(options as unknown as ConnectOptions<Json>);
  await engine.start();
  return engine as unknown as ProtocolClient<S>;
};
