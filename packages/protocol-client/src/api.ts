// Frozen client-library API (P0-CLIENT). Spec: protocol.md §2.5, §3, §4.4, §6, §7.3, §8, §9; SPEC R1, R2, R6, R7, R12, R14;
// desktop-services.md §2.3. Mirrors native/core/crates/mixdog-app-server-client/src/api.rs.
//
// Every wire type is `@mixdog/protocol`'s own (generated from mixdog-app-protocol); this module defines only client behaviour.
// Per-method facts (`class`, mutation, op scope) come from the golden `method_table.json` through `method-table.ts`.
import type {
  AppSnapshotParams,
  BlobDescriptor,
  BlobRef,
  ClientInfo,
  ClientMethods,
  ErrorData,
  FeedStamp,
  InitializeCapabilities,
  InitializeResponse,
  JsonRpcErrorBody,
  JsonRpcNotification,
  JsonValue,
  OpId,
  RequestClass,
  RequestId,
  ResumeWindow,
  SectionName,
  SectionUpdate,
  ServerRequestMethods,
  ServerRequestResolvedParams,
  ThreadResumeResponse,
} from '@mixdog/protocol';
import type { HealthOptions } from './health.ts';

export type {
  AppSnapshotParams,
  BlobDescriptor,
  BlobRef,
  ClientInfo,
  ClientMethods,
  ErrorData,
  FeedStamp,
  InitializeCapabilities,
  InitializeResponse,
  JsonRpcErrorBody,
  JsonRpcNotification,
  JsonValue,
  OpId,
  RequestClass,
  RequestId,
  ResumeWindow,
  SectionName,
  SectionUpdate,
  ServerRequestResolvedParams,
  ThreadResumeResponse,
};

export type Json = JsonValue;
/** Where the durable op record lives (protocol.md §9.2): `thread:<id>` or a domain name such as `config`. */
export type OpScope = string;

// ───────────────────────────── method info, derived from the generated table ─────────────────────────────

export interface MethodInfo {
  readonly class: RequestClass;
  /** Mutations carry `params.opId` (protocol.md §9.1). */
  readonly mutation: boolean;
  /** The `op/status` scope of a mutation: `thread:<params[field]>` when present, else the domain. `undefined` for non-mutations. */
  readonly opScope: (params: Json) => OpScope | undefined;
}
/** `undefined` for a method not in the table. Implemented over `method_table.json` in `method-table.ts`. */
export type MethodLookup = (method: string) => MethodInfo | undefined;

// ───────────────────────────── transport (mock-able seam) ─────────────────────────────

/** Opaque to the client; the connector resolves it (local discovery, an SSH tunnel endpoint, the relay). One ladder per target. */
export interface Target {
  readonly id: string;
}
/** Inbound half. `closed` is called at most once and is the only reconnect trigger (SPEC H17). */
export interface TransportSink {
  frame(text: string): void;
  /** New authenticated receive progress from the core on THIS connection, before the message it belongs to is complete: called
   *  once for each newly authenticated record (or, where the transport owns the socket, once per batch of bytes newly received from
   *  the core's own socket) that has not yet made a complete message. Never for the transport's own keepalive (a relay's pong), an
   *  acknowledgement, bytes that did not authenticate, a replayed or repeated record, or a record a held fragment is retried with;
   *  never after `closed`. A completed `frame` is progress too and needs no call. Optional: a transport that cannot see receive
   *  progress before a message is whole omits it, and for it silence is an assumption, not proof. The client holds the policy. */
  progress?(): void;
  closed(code: number, reason: string): void;
}
/** Receives the completion of one request frame. It resolves only when this frame completed LOCAL transport departure: the local write
 *  finished (a socket's send callback, a carrier that reports nothing of it still buffered). Not queue admission, not receipt by the
 *  core, not the far end's acknowledgement (which a dead link never gives). It rejects when the write failed, and never resolves for
 *  a frame that did not leave (a connection that ended first may reject it or leave it unsettled). This is the one source of a probe's departure: the health machine
 *  (`health.ts`) opens its observation window on it and on nothing else, and a transport that cannot give it is ineligible for a silence
 *  verdict (it may still report an explicit loss). */
export type SentClaim = (sent: Promise<void>) => void;
/** Outbound half. One JSON message per text frame. */
export interface TransportWriter {
  /** `sent`, when given, receives the departure receipt of this frame (see `SentClaim`); a transport that cannot tell never calls it. */
  send(text: string, sent?: SentClaim): void;
  /** One binary frame (X17 host media). Absent on transports that cannot carry one. */
  sendBinary?(data: Uint8Array): void;
  close(code: number, reason: string): void;
  /** Settles when the receive work the transport has already accepted (authentication, assembly: its own promise chain) has been
   *  processed and delivered to the sink. A transport that delivers synchronously has nothing to wait for and omits it. */
  settled?(): Promise<void>;
}
export interface Connector {
  /** Re-resolves credentials on every call (discovery token may have changed). Rejects if no socket could be opened. */
  open(target: Target, sink: TransportSink): Promise<TransportWriter>;
}
export interface Clock {
  sleep(ms: number): Promise<void>;
}

export interface LadderConfig {
  readonly baseMs: number;
  readonly capMs: number;
}
/** SPEC H17: 250 ms → 5 s, full jitter. */
export const DEFAULT_LADDER: LadderConfig = { baseMs: 250, capMs: 5000 };

// ───────────────────────────── errors ─────────────────────────────

export type ClientErrorDetail =
  /** A JSON-RPC error. Branch on `code` + `reason`; `data` is the typed form when the core sent a known reason. */
  | {
      readonly kind: 'rpc';
      readonly code: number;
      readonly reason: string | undefined;
      readonly message: string;
      readonly data: ErrorData | undefined;
    }
  /** Non-mutation request in flight when the socket closed. Never retried by the library. */
  | { readonly kind: 'connectionLost' }
  | { readonly kind: 'clientClosed' }
  /** initialize refused by the version gate; terminal, no ladder (protocol.md §4.4). */
  | {
      readonly kind: 'versionRefused';
      readonly reason: 'clientOutdated' | 'serverOutdated';
      readonly serverVersion: string;
      readonly clientVersion: string;
    }
  | { readonly kind: 'unknownMethod'; readonly method: string }
  /** The call's pre-send bound (`requestTimeoutMs`) or an explicit CallOptions.timeoutMs passed with no answer. sent: its request had been
   * written, so a mutation may have run (a mutation fails as `opOutcomeUnknown` with this as `cause`); not sent: it never left. */
  | { readonly kind: 'requestTimeout'; readonly method: string; readonly sent: boolean }
  /** `op/status` said the mutation never ran and now never will (fenced). The caller decides whether to issue a new op. */
  | { readonly kind: 'opNotApplied'; readonly opId: string }
  /** The outcome cannot be known: `expired` or `externalUnknown` (protocol.md §9.4, §9.6), or `statusFailed` when the
   * `op/status` call itself failed for good (`cause`). */
  | {
      readonly kind: 'opOutcomeUnknown';
      readonly opId: string;
      readonly state: 'expired' | 'externalUnknown' | 'statusFailed';
      readonly cause?: ClientErrorDetail;
    }
  /** The blob is permanently unavailable (`blobNotFound`). Fails only the one read or stub resolution. */
  | { readonly kind: 'blobNotFound'; readonly digest: string }
  /** The stored bytes failed verification (`blobCorrupt`). Fails only the one read or stub resolution. */
  | { readonly kind: 'blobCorrupt'; readonly digest: string }
  | { readonly kind: 'protocolViolation'; readonly what: string };

export interface ClientError extends Error {
  readonly detail: ClientErrorDetail;
}

// ───────────────────────────── feeds, store, fold ─────────────────────────────

/** The folded view of one thread feed. `S` is the reducer's state (the DesktopSessionState projection, WP-CLIENT-TS). */
export interface ThreadFold<S = Json> {
  /** Position of the last notification folded in. */
  readonly feed: FeedStamp;
  /** The order of `feed.epoch` among the epochs this realm received (`StreamPosition.order`). */
  readonly order: number;
  readonly state: S;
}

/** A position in one feed, totally ordered within this realm: by `order` (a later-received epoch has a higher one), then by `seq`
 *  within the epoch. Received positions (`feedPosition`) and folded ones (`ThreadFold`) are measured alike. */
export interface StreamPosition {
  readonly epoch: string;
  readonly seq: number;
  readonly order: number;
}

/** Whether `shown` is at or past `mark`. */
export const streamPositionReached = (shown: StreamPosition, mark: StreamPosition): boolean =>
  shown.order > mark.order || (shown.order === mark.order && shown.seq >= mark.seq);
/**
 * Pure fold. `snapshot` is the `thread/snapshot` params; `notification` has every text blob stub already resolved.
 * Called in feed order, never concurrently, never for a notification the cursor rejected.
 */
export interface ThreadReducer<S = Json> {
  initial(snapshot: Json): S;
  /**
   * `initial` in steps, for a snapshot too large to fold in one turn: the client runs the generator and, whenever the turn's
   * budget is spent, gives the thread back before it resumes it (`yield` where the work divides, e.g. every few items). The
   * return value is the state, equal to `initial(snapshot)`. Without it the client calls `initial` in one piece.
   */
  initialSteps?(snapshot: Json): Generator<void, S, void>;
  apply(state: S, notification: JsonRpcNotification): S;
}

/** One entry of the section store (desktop-services.md §2.1, §2.3). A stubbed section keeps `value = null`. */
export interface SectionEntry {
  readonly section: SectionName;
  readonly key: string | null;
  readonly revision: number;
  readonly value: Json;
}

export type StoreChange =
  /** `replayComplete` marks the fold of the last missed event, not the attach acknowledgement. */
  | { readonly type: 'thread'; readonly threadId: string; readonly replayComplete?: true }
  | { readonly type: 'section'; readonly section: SectionName; readonly key: string | null }
  /**
   * A whole `app/snapshot` is folded. Until then the store still holds the previous app state, whole and consistent: the
   * snapshot is staged section by section across turns and swapped in at once. Before this change, `section` changes announce
   * every section of the new snapshot and every section it removed.
   */
  | { readonly type: 'appSnapshot' }
  /** A subscription was re-attached after a reconnect. `feedId` is the thread id, or `app`. Its snapshot (or the missed notifications) follows as ordinary changes. */
  | { readonly type: 'subscription'; readonly feedId: string; readonly state: 'restored' }
  /** The restore settled after the caller withdrew the subscription; a concurrent unsubscribe may still need reconciliation. */
  | { readonly type: 'subscription'; readonly feedId: string; readonly state: 'cancelled' }
  /** Re-attaching failed with a typed error (the `subscriptionLost` client event); the subscription is dropped and a thread's fold is gone. */
  | {
      readonly type: 'subscription';
      readonly feedId: string;
      readonly state: 'lost';
      readonly error: ClientErrorDetail;
    };

export interface FoldStore<S = Json> {
  thread(threadId: string): ThreadFold<S> | undefined;
  /** `store[section][key] = value` iff `revision > stored.revision`; `removed` deletes (desktop-services.md §2.3). */
  section(section: SectionName, key?: string | null): SectionEntry | undefined;
  sections(section: SectionName): readonly SectionEntry[];
  /** App-feed position, once subscribed. */
  appFeed(): FeedStamp | undefined;
  /** The app-feed change being folded was published while the current app subscription was attached: not a snapshot's, and not one a
   *  resumed subscription replays from the time the connection was away (below the subscription's `liveSeq`). */
  appLive(): boolean;
  /** Called after each fold, in order. */
  subscribe(listener: (change: StoreChange) => void): () => void;
}

// ───────────────────────────── server requests (protocol.md §8) ─────────────────────────────

export type ServerRequest = {
  [K in keyof ServerRequestMethods]: {
    readonly id: RequestId;
    readonly method: K;
    readonly params: ServerRequestMethods[K]['params'];
  };
}[keyof ServerRequestMethods];
export type ServerRequestAnswer =
  | { readonly result: Json }
  | { readonly error: { readonly code: number; readonly message: string; readonly data?: Json } };

// ───────────────────────────── client ─────────────────────────────

export type ConnectionStatus =
  | { readonly state: 'ready'; readonly serverInstanceId: string }
  /** Socket closed; `attempt` counts ladder rounds since the last successful initialize. */
  | { readonly state: 'reconnecting'; readonly attempt: number }
  /** Terminal: `close()` or a version refusal. */
  | { readonly state: 'closed'; readonly reason: ClientErrorDetail };

export type ClientEvent =
  | { readonly type: 'status'; readonly status: ConnectionStatus }
  /** Delivered in order. One offered to every eligible connection (an approval, P §8.3) is held in `pendingServerRequests` until
   * `serverRequest/resolved` arrives or the socket closes (the core re-delivers). One addressed to a capability this client declared
   * (`host/*`, `model/proxy/execute`) is not held: the answer of its handler ends it. Nor is a method the method table does not
   * list (a newer core's): see `isOfferedRequest`. */
  | { readonly type: 'serverRequest'; readonly request: ServerRequest }
  /** The core resolved a held request, or stopped waiting for a `host/*` one it got no answer to (its handler stops; a
   * `model/proxy/execute` one is given up with the `model/proxy/cancel` notification instead). */
  | { readonly type: 'serverRequestResolved'; readonly params: ServerRequestResolvedParams }
  /** Connection-scoped notifications (no `feed`) other than `serverRequest/resolved`; app-feed notifications that are not sections;
   * and every notification of a scoped feed (`fs/changed`, `system/ports/updated`, `search/updated`, ...), in feed order with text
   * blob stubs resolved. Scoped-feed notifications keep their `feed` stamp (`fs:<watchId>`, `ports`); a gap or epoch change inside
   * one closes the connection with 1002 as for a thread. `feed/snapshot` re-bases the feed and is delivered too. */
  | { readonly type: 'notification'; readonly notification: JsonRpcNotification }
  /** Restoring a subscription after reconnect failed with a typed error (e.g. `threadNotFound`); the subscription is dropped. */
  | { readonly type: 'subscriptionLost'; readonly threadId: string; readonly error: ClientErrorDetail }
  /** A blob stub inside a feed notification could not be resolved. The stub stays in the folded notification, the feed continues and the connection stays open. */
  | { readonly type: 'blobUnavailable'; readonly feed: FeedStamp; readonly error: ClientErrorDetail }
  /** The library closed the socket with 1002/1007 because the peer broke an invariant (a feed gap, bad JSON); the ladder follows. */
  | { readonly type: 'protocolViolation'; readonly what: string };

export interface CallOptions {
  /** Mutations only: reuse an existing op id (default: a fresh UUIDv7). */
  readonly opId?: OpId;
  /** Receives the completion of this call's own request frame (the transport's `send(text, sent)`): it settles once the frame has left, and never if it was dropped first. Every method that writes a request takes it and forwards it, wherever the method waits before writing. */
  readonly sent?: SentClaim;
  /** A deadline for this call, from the call to its answer, passed on purpose: it also bounds a request already sent. Without it a sent request stays pending while the connection is alive. */
  readonly timeoutMs?: number;
}

export type ResumeOptions = Pick<CallOptions, 'sent' | 'timeoutMs'> & {
  readonly join?: boolean;
  readonly force?: boolean;
  /** The window is the view's default, not a request to replace an existing window of another kind. */
  readonly follow?: boolean;
  /** Ends this caller's wait as `requestTimeout` when it aborts, as an explicit `timeoutMs` does: the watch of the operation the user
   *  waits on. It is not a refusal on the wire: a request that is out stays out, and its answer still attaches the thread. Two
   *  things end with the wait: a request nobody waits for any more that has not been written is not written, and a legacy
   *  replay still being resolved for the caller that started the attach ends as the thread's loss (`subscriptionLost`). */
  readonly signal?: AbortSignal;
};

/** Mutation params carry `opId`; the library assigns it, the caller may pin it through `CallOptions` or the params. */
export type CallParams<P> = P extends { opId: infer O } ? Omit<P, 'opId'> & { opId?: O } : P;

export interface ThreadSubscription {
  /** This client follows the thread and will restore it on reconnect. A cached fold alone does not imply this. */
  readonly followed: boolean;
  /** This client owns the control thread it started. */
  readonly held: boolean;
  /** A reconnect restore of this thread is still in flight. */
  readonly restoring: boolean;
  /** A resume is outstanding or its replacement snapshot has not finished folding. It stays so until that settles, whether or
   *  not a caller still waits. */
  readonly snapshotPending: boolean;
  /** The missed events promised by the attach have not all folded yet. */
  readonly replayPending: boolean;
  /** Number of restores started across all threads on this client. */
  readonly restoresStarted: number;
  /** Generation of the client's current transport connection. */
  readonly connection: number;
  /** The core's id of the subscription the thread is delivered on, once an attach named one (`thread/window/set` names it). */
  readonly subscriptionId?: string;
}

export interface ProtocolClient<S = Json> {
  readonly store: FoldStore<S>;
  /** Latest `initialize` result (replaced on every reconnect). */
  readonly server: InitializeResponse;
  readonly status: ConnectionStatus;

  /**
   * One typed request.
   * - Mutations get `params.opId` and are never auto-retried with a new one: on socket loss the library reconciles through
   *   `op/status{fence:true}` after reconnect and settles the promise from the answer (see `ClientErrorDetail`).
   * - `-32001` is retried on its trigger (SPEC R7): `inflightLimit` and `queueFull` after a response to an own request,
   *   `windowFull` after the next feed event of that thread. Never time based.
   * - Non-mutations in flight at socket loss reject `connectionLost`.
   * - While reconnecting, calls wait for the connection (in order); after `closed` they reject.
   */
  call<K extends keyof ClientMethods & string>(
    method: K,
    params: CallParams<ClientMethods[K]['params']>,
    options?: CallOptions
  ): Promise<ClientMethods[K]['result']>;
  /** Client notification (`terminal/input`, `terminal/resize`, `client/perfLog`, ...). Throws `connectionLost` when not ready. */
  notify(method: string, params: Json): void;
  /** Sends one binary frame (X17: 16-byte media header + payload, host role only). Throws `connectionLost` when not ready and
   * `protocolViolation` when the transport has no binary lane or the frame exceeds `limits.maxMediaFrameBytes` + 16. */
  sendBinary(data: Uint8Array): void;

  /** Follows a thread. One attach of a thread is out at a time: while it is, every caller it answers (its window holds the
   *  asked one) waits for it and sends nothing, and a caller asking for more sends its resume once that one has ended. After
   *  the answer, while the snapshot is still owed, equal windows share it and `join` also accepts a larger one; `force` sends
   *  a new resume then, for recovery. Resolves once the thread is followed; a replay the core could not bound (an older core)
   *  is resolved first, as part of the same attach, and rejects with the thread's loss when it cannot be. */
  resumeThread(threadId: string, window: ResumeWindow, options?: ResumeOptions): Promise<ThreadResumeResponse>;
  /** The user's retry of a thread that did not arrive. Whatever attach or restore of the thread is out ends as the thread's
   *  loss (`subscriptionLost`, `requestTimeout`): its waiters are rejected with it and its answer, when it comes, changes
   *  nothing. Then one ordinary resume goes out, with the window that was wanted and no cursor. */
  reopenThread(threadId: string, window: ResumeWindow, options?: ResumeOptions): Promise<ThreadResumeResponse>;
  /** Resolves true once nothing of the thread's transcript is owed: no attach is out, no snapshot or replay is still to
   *  fold. Resolves false when the thread was unsubscribed while it waited: the wait ended, the transcript did not arrive.
   *  Sends nothing and offers no window. Rejects as the attach that is out does, with the thread's loss, or
   *  `connectionLost` when the connection ends first. */
  whenThreadSettled(threadId: string): Promise<boolean>;
  /** Reads local subscription bookkeeping without sending a request or opening the thread. */
  threadSubscription(threadId: string): ThreadSubscription;
  /** Checks every live subscription owned by this connection, including that it still has the expected view feeds. */
  confirmFeeds(feedIds: readonly string[]): Promise<boolean>;
  /** `thread/unsubscribe`; drops the folded thread. Never stops work (X10). */
  unsubscribeThread(threadId: string, options?: Pick<CallOptions, 'sent'>): Promise<void>;
  /** `app/subscribe`, restored on reconnect with `resumeFrom`. */
  subscribeApp(options?: Pick<CallOptions, 'sent'>): Promise<void>;

  /** The held requests (see `ClientEvent` `serverRequest`): the ones offered to every eligible connection that the core has not resolved. */
  pendingServerRequests(): readonly ServerRequest[];
  /** The position of the last notification received on `feedId` (not yet necessarily folded); undefined when the feed is not
   *  followed. The core writes a connection's frames in the order it queued them (a lagged lane's recovery snapshot excepted), and
   *  queues the feed frames a mutation produced before its response: read once a response has arrived, this position is at or
   *  past every notification that response's mutation published. Comparable with a fold's position (`ThreadFold.order`, `feed.seq`). */
  feedPosition(feedId: string): StreamPosition | undefined;
  /** Answers a server request. A held one's validity is the core's decision (`serverRequest/resolved` follows); an addressed one is
   * ended by the answer. Throws `connectionLost` when not ready. */
  respond(id: RequestId, answer: ServerRequestAnswer): void;

  /** Reads all pages of a blob (`blob/read`, page ≤ `server.limits.maxBlobPageBytes`). Rejects `blobNotFound`/`blobCorrupt` for this read only. */
  readBlob(ref: BlobRef, options?: Pick<CallOptions, 'sent'>): Promise<Uint8Array>;
  /** Uploads in raw chunks ≤ `server.limits.maxBlobPutChunkBytes` (`blob/put`, SPEC R1) and returns the ref to put into a request.
   *  `options.sent` is the claim of the upload's LAST chunk: the upload is one message, which has left once its last chunk has. */
  putBlob(
    bytes: Uint8Array,
    mediaType: string,
    options?: Pick<CallOptions, 'sent'> & {
      /** Runs after each acknowledged chunk; throwing stops the remaining upload. */
      onChunkAccepted?(): void;
    }
  ): Promise<BlobRef>;

  on(listener: (event: ClientEvent) => void): () => void;
  /** Whether the core sends any frame within `timeoutMs` of the check (it is asked a question it answers at once). None drops the link and the ladder opens a new one (a link that
   * died unseen, as after a machine's sleep). False when no connection was ready to ask. */
  checkLink(): Promise<boolean>;
  /** Closes the socket with 1000 and stops the ladder. Pending calls reject `clientClosed`. Idempotent. */
  close(): Promise<void>;
}

export interface ConnectOptions<S = Json> {
  readonly target: Target;
  readonly connector: Connector;
  readonly clientInfo: ClientInfo;
  readonly capabilities: InitializeCapabilities;
  /** Required to fold thread feeds; without it `ThreadFold.state` is the raw snapshot params. */
  readonly threadReducer?: ThreadReducer<S>;
  /** Every thread resumed with a `lastItems` window is resumed positioned (`positionedWindow`): the core holds the ranges of
   *  its transcript this client asks for (`thread/window/set`) and sends their rows, not every row of the conversation. */
  readonly positionedTranscripts?: boolean;
  readonly clock: Clock;
  /** Uniform in [0, 1) for ladder jitter. */
  readonly random: () => number;
  /** UUIDv7 by default (protocol.md §9.1). */
  readonly newOpId?: () => OpId;
  readonly ladder?: LadderConfig;
  /** How long a call may wait before it is sent (DEFAULT_REQUEST_TIMEOUT_MS by default). It does not limit a request that was sent: that one lives as long as the connection (see healthIntervalMs). */
  readonly requestTimeoutMs?: number;
  /** When set, a failure before the first ready connection is retried on the ladder until this many ms have passed, then thrown;
   * a version refusal is never retried. Unset: the first failure is thrown. */
  readonly firstConnectDeadlineMs?: number;
  /** Keep using the first-connect ladder after the deadline, while still bounding each handshake. */
  readonly keepTryingFirstConnect?: boolean;
  /** The connection's health machine (`health.ts`): its heartbeat, observation window, gap policy and clock. Tests set them. */
  readonly health?: HealthOptions;
  /** Bounds how long the fold may hold the thread it runs on. Defaults: 8 ms, `performance.now`, a `setTimeout(0)` macrotask. */
  readonly turn?: TurnOptions;
  /** Link life-cycle lines (`link-open`, `link-down`, `link-reconnected`, `link-restore-settled`) for the host's own log: counts and times, never frames. */
  readonly onDiagnostic?: (event: string, fields: Record<string, unknown>) => void;
}

/**
 * A fold that has run for `budgetMs` since its turn began (the first frame of the loop turn, or the last yield) gives the thread
 * back through `yieldTurn` before it continues: the app snapshot's section staging and its change announcements, and blob-stub
 * resolution inside any feed's notification. A frame that arrives after the budget is spent waits for a later turn; the one that
 * opens a turn is handled at once. A frame is parsed in one piece; that cost is outside the budget.
 */
export interface TurnOptions {
  readonly budgetMs?: number;
  readonly now?: () => number;
  readonly yieldTurn?: () => Promise<void>;
}

/**
 * Opens the transport, performs `initialize` + `initialized`, and resolves when the connection is ready.
 * Rejects with `versionRefused`, the initialize `rpc` error, or the connector's own error. A failure before the first ready
 * connection is the caller's to handle (e.g. start the core); the ladder only runs after a ready connection drops.
 */
export type Connect = <S = Json>(options: ConnectOptions<S>) => Promise<ProtocolClient<S>>;

/** Wire names the client acts on. */
export const WIRE = {
  threadSnapshot: 'thread/snapshot',
  appSnapshot: 'app/snapshot',
  serverRequestResolved: 'serverRequest/resolved',
  appFeedId: 'app',
} as const;
