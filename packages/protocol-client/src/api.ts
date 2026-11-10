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
  closed(code: number, reason: string): void;
}
/** Receives the completion of one request frame: it settles once the frame has been handed to the wire, and never if it was dropped first. */
export type SentClaim = (sent: Promise<void>) => void;
/** Outbound half. One JSON message per text frame. */
export interface TransportWriter {
  /** `sent`, when given, receives a promise that settles when this frame has left the page (a transport that cannot tell never calls it). */
  send(text: string, sent?: SentClaim): void;
  /** One binary frame (X17 host media). Absent on transports that cannot carry one. */
  sendBinary?(data: Uint8Array): void;
  close(code: number, reason: string): void;
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
  | { readonly kind: 'rpc'; readonly code: number; readonly reason: string | undefined; readonly message: string; readonly data: ErrorData | undefined }
  /** Non-mutation request in flight when the socket closed. Never retried by the library. */
  | { readonly kind: 'connectionLost' }
  | { readonly kind: 'clientClosed' }
  /** initialize refused by the version gate; terminal, no ladder (protocol.md §4.4). */
  | { readonly kind: 'versionRefused'; readonly reason: 'clientOutdated' | 'serverOutdated'; readonly serverVersion: string; readonly clientVersion: string }
  | { readonly kind: 'unknownMethod'; readonly method: string }
  /** `op/status` said the mutation never ran and now never will (fenced). The caller decides whether to issue a new op. */
  | { readonly kind: 'opNotApplied'; readonly opId: string }
  /** The outcome cannot be known: `expired` or `externalUnknown` (protocol.md §9.4, §9.6), or `statusFailed` when the
   * `op/status` call itself failed for good (`cause`). */
  | { readonly kind: 'opOutcomeUnknown'; readonly opId: string; readonly state: 'expired' | 'externalUnknown' | 'statusFailed'; readonly cause?: ClientErrorDetail }
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
  readonly state: S;
}
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
  | { readonly type: 'thread'; readonly threadId: string }
  | { readonly type: 'section'; readonly section: SectionName; readonly key: string | null }
  /**
   * A whole `app/snapshot` is folded. Until then the store still holds the previous app state, whole and consistent: the
   * snapshot is staged section by section across turns and swapped in at once. Before this change, `section` changes announce
   * every section of the new snapshot and every section it removed.
   */
  | { readonly type: 'appSnapshot' }
  /** A subscription was re-attached after a reconnect. `feedId` is the thread id, or `app`. Its snapshot (or the missed notifications) follows as ordinary changes. */
  | { readonly type: 'subscription'; readonly feedId: string; readonly state: 'restored' }
  /** Re-attaching failed with a typed error (the `subscriptionLost` client event); the subscription is dropped and a thread's fold is gone. */
  | { readonly type: 'subscription'; readonly feedId: string; readonly state: 'lost'; readonly error: ClientErrorDetail };

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
  [K in keyof ServerRequestMethods]: { readonly id: RequestId; readonly method: K; readonly params: ServerRequestMethods[K]['params'] };
}[keyof ServerRequestMethods];
export type ServerRequestAnswer = { readonly result: Json } | { readonly error: { readonly code: number; readonly message: string; readonly data?: Json } };

// ───────────────────────────── client ─────────────────────────────

export type ConnectionStatus =
  | { readonly state: 'ready'; readonly serverInstanceId: string }
  /** Socket closed; `attempt` counts ladder rounds since the last successful initialize. */
  | { readonly state: 'reconnecting'; readonly attempt: number }
  /** Terminal: `close()` or a version refusal. */
  | { readonly state: 'closed'; readonly reason: ClientErrorDetail };

export type ClientEvent =
  | { readonly type: 'status'; readonly status: ConnectionStatus }
  /** Delivered in order. Removed when `serverRequest/resolved` arrives or the socket closes (the core re-delivers). */
  | { readonly type: 'serverRequest'; readonly request: ServerRequest }
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
}

/** Mutation params carry `opId`; the library assigns it, the caller may pin it through `CallOptions` or the params. */
export type CallParams<P> = P extends { opId: infer O } ? Omit<P, 'opId'> & { opId?: O } : P;

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
  call<K extends keyof ClientMethods & string>(method: K, params: CallParams<ClientMethods[K]['params']>, options?: CallOptions): Promise<ClientMethods[K]['result']>;
  /** Client notification (`terminal/input`, `terminal/resize`, `client/perfLog`, ...). Throws `connectionLost` when not ready. */
  notify(method: string, params: Json): void;
  /** Sends one binary frame (X17: 16-byte media header + payload, host role only). Throws `connectionLost` when not ready and
   * `protocolViolation` when the transport has no binary lane or the frame exceeds `limits.maxMediaFrameBytes` + 16. */
  sendBinary(data: Uint8Array): void;

  /** `thread/resume`. Registers the subscription for restore after reconnect, sending the folded position as `resumeFrom`. */
  resumeThread(threadId: string, window: ResumeWindow, options?: Pick<CallOptions, 'sent'>): Promise<ThreadResumeResponse>;
  /** `thread/unsubscribe`; drops the folded thread. Never stops work (X10). */
  unsubscribeThread(threadId: string, options?: Pick<CallOptions, 'sent'>): Promise<void>;
  /** `app/subscribe`, restored on reconnect with `resumeFrom`. */
  subscribeApp(options?: Pick<CallOptions, 'sent'>): Promise<void>;

  pendingServerRequests(): readonly ServerRequest[];
  /** Answers a server request. Validity is the core's decision (`serverRequest/resolved` follows). Throws `connectionLost` when not ready. */
  respond(id: RequestId, answer: ServerRequestAnswer): void;

  /** Reads all pages of a blob (`blob/read`, page ≤ `server.limits.maxBlobPageBytes`). Rejects `blobNotFound`/`blobCorrupt` for this read only. */
  readBlob(ref: BlobRef, options?: Pick<CallOptions, 'sent'>): Promise<Uint8Array>;
  /** Uploads in raw chunks ≤ `server.limits.maxBlobPutChunkBytes` (`blob/put`, SPEC R1) and returns the ref to put into a request. */
  /** `options.sent` is the claim of the upload's LAST chunk: the upload is one message, which has left once its last chunk has. */
  putBlob(bytes: Uint8Array, mediaType: string, options?: Pick<CallOptions, 'sent'>): Promise<BlobRef>;

  on(listener: (event: ClientEvent) => void): () => void;
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
  readonly clock: Clock;
  /** Uniform in [0, 1) for ladder jitter. */
  readonly random: () => number;
  /** UUIDv7 by default (protocol.md §9.1). */
  readonly newOpId?: () => OpId;
  readonly ladder?: LadderConfig;
  /** Bounds how long the fold may hold the thread it runs on. Defaults: 8 ms, `performance.now`, a `setTimeout(0)` macrotask. */
  readonly turn?: TurnOptions;
}

/**
 * A fold that has run for `budgetMs` since its turn began (the frame's arrival, or the last yield) gives the thread back through
 * `yieldTurn` before it continues: the app snapshot's section staging and its change announcements, and blob-stub resolution
 * inside any feed's notification. A frame is parsed in one piece, before the fold starts; that cost is outside the budget.
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
