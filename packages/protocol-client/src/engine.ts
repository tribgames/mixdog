// Reference engine for the frozen API (api.ts). It exists so the shared conformance suite has something to run and so the
// API is proven implementable; WP-CLIENT-TS owns the production client and must pass the same suite.
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
  TransportSink,
  TransportWriter,
} from './api.ts';
import type { OpStatusEntry } from '@mixdog/protocol';
import { DEFAULT_LADDER, WIRE } from './api.ts';
import { isSectionMethod, methodInfo } from './method-table.ts';

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
    super(detail.kind === 'rpc' ? `${detail.code} ${detail.reason ?? ''} ${detail.message}` : detail.kind);
    this.name = 'ClientError';
    this.detail = detail;
  }
}
const fail = (detail: ClientErrorDetail): ClientFailure => new ClientFailure(detail);
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
  readonly sectionMap = new Map<string, Map<string, SectionEntry>>();
  app: FeedStamp | undefined;
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
  subscribe(listener: (c: StoreChange) => void): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }
  emit(c: StoreChange): void {
    for (const l of [...this.listeners]) l(c);
  }
  applySection(u: SectionUpdate): void {
    const bucket = this.sectionMap.get(u.section) ?? new Map<string, SectionEntry>();
    this.sectionMap.set(u.section, bucket);
    const k = u.key ?? '';
    const cur = bucket.get(k);
    if (cur && cur.revision >= u.revision) return;
    if (u.removed === true) bucket.delete(k);
    else bucket.set(k, { section: u.section, key: u.key ?? null, revision: u.revision, value: u.value ?? null });
    this.emit({ type: 'section', section: u.section, key: u.key ?? null });
  }
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
interface SentAt {
  readonly all: number;
  readonly byClass: Record<RequestClass, number>;
  readonly feed: number;
}

const INTERNAL: MethodInfo = { class: 'C0', mutation: false, opScope: () => undefined };
const READ_C1: MethodInfo = { class: 'C1', mutation: false, opScope: () => undefined };
const classes = (): Record<RequestClass, number> => ({ C0: 0, C1: 0, C2: 0, C3: 0 });
const jsonKey = (id: RequestId): string => JSON.stringify(id);
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const validFeed = (f: unknown): boolean =>
  f === undefined || (isObject(f) && typeof f.id === 'string' && typeof f.epoch === 'string' && typeof f.seq === 'number');
const validErrorBody = (e: unknown): boolean => isObject(e) && typeof e.code === 'number' && typeof e.message === 'string';
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
  private readonly listeners = new Set<(e: ClientEvent) => void>();
  private readonly subs = new Map<string, ResumeWindow>();
  private appSubscribed = false;
  private readonly serverRequests = new Map<string, ServerRequest>();
  private readonly recv = new Map<string, { epoch: string; seq: number }>();
  private chain: Promise<void> = Promise.resolve();
  private responses = 0;
  private classResponses = classes();
  private feedEvents = 0;
  private readonly threadLastEvent = new Map<string, number>();
  private wake: Array<() => void> = [];
  private readyWaiters: Array<{ ok: () => void; err: (e: ClientFailure) => void }> = [];
  private readonly unanswered = new Map<string, Unanswered>();
  private looping = false;
  private everReady = false;
  private terminal: ClientErrorDetail | undefined;
  private readonly reducer: ThreadReducer<Json> | undefined;
  private readonly o: ConnectOptions<Json>;

  constructor(options: ConnectOptions<Json>) {
    this.o = options;
    this.reducer = options.threadReducer;
  }

  // ── lifecycle ──

  async start(): Promise<void> {
    await this.openTransport();
    try {
      await this.handshake();
    } catch (e) {
      this.writer?.close(1000, 'handshake failed');
      this.writer = null;
      throw e;
    }
    this.everReady = true;
    this.setStatus({ state: 'ready', serverInstanceId: this.server.serverInstanceId });
  }

  private async openTransport(): Promise<void> {
    const conn = ++this.connSeq;
    let early: { code: number; reason: string } | undefined;
    const sink: TransportSink = {
      frame: (t) => {
        if (conn === this.connSeq) this.onFrame(t);
      },
      closed: (code, reason) => {
        if (conn !== this.connSeq) return;
        if (this.writer === null) early = { code, reason };
        else this.onClosed();
      },
    };
    const w = await this.o.connector.open(this.o.target, sink);
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
    this.generation++;
    this.recv.clear();
    this.serverRequests.clear();
    for (const p of drain(this.pending)) p.reject(fail({ kind: 'connectionLost' }));
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
      this.setStatus({ state: 'ready', serverInstanceId: this.server.serverInstanceId });
      // The connection is usable now. Each subscription and each scope's reconciliation proceeds independently.
      this.restoreSubscriptions();
      this.reconcileOps();
      return;
    }
  }

  private restoreSubscriptions(): void {
    for (const [threadId, window] of [...this.subs]) void this.restoreThread(threadId, window);
    if (this.appSubscribed) void this.restoreApp();
  }

  /** An rpc error drops the subscription; the end of the connection is the ladder's business. */
  private async restoreThread(threadId: string, window: ResumeWindow): Promise<void> {
    try {
      await this.run('thread/resume', this.resumeParams(threadId, window), INTERNAL, (r) => this.attached(threadId, r));
    } catch (e) {
      const d = detailOf(e);
      if (d.kind !== 'rpc') return;
      this.subs.delete(threadId);
      this.store.threads.delete(threadId);
      this.emit({ type: 'subscriptionLost', threadId, error: d });
    }
  }
  private async restoreApp(): Promise<void> {
    try {
      await this.run('app/subscribe', this.appParams(), INTERNAL, (r) => this.attached(WIRE.appFeedId, r));
    } catch (e) {
      const d = detailOf(e);
      if (d.kind !== 'rpc') return;
      this.appSubscribed = false;
      this.emit({ type: 'subscriptionLost', threadId: WIRE.appFeedId, error: d });
    }
  }

  private terminate(detail: ClientErrorDetail): void {
    this.terminal = detail;
    for (const p of drain(this.pending)) p.reject(fail(detail));
    for (const u of [...this.unanswered.values()]) u.reject(fail(detail));
    this.unanswered.clear();
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

  private send(frame: Record<string, unknown>): void {
    const w = this.writer;
    if (!w) throw fail({ kind: 'connectionLost' });
    w.send(JSON.stringify(frame));
  }

  private rpc(method: string, params: Json | undefined, cls?: RequestClass, sync?: (v: Json) => void): Promise<Json> {
    return new Promise<Json>((resolve, reject) => {
      const id = this.nextRequestId++;
      try {
        this.pending.set(id, { cls, resolve, reject, ...(sync ? { sync } : {}) });
        this.send(params === undefined ? { id, method } : { id, method, params });
      } catch (e) {
        this.pending.delete(id);
        reject(e);
      }
    });
  }

  private emit(e: ClientEvent): void {
    for (const l of [...this.listeners]) l(e);
  }
  on(listener: (e: ClientEvent) => void): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  private violation(code: number, what: string): void {
    this.emit({ type: 'protocolViolation', what });
    this.writer?.close(code, what);
  }

  private onFrame(text: string): void {
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
    this.serverRequests.set(jsonKey(r.id), r);
    this.emit({ type: 'serverRequest', request: r });
  }
  pendingServerRequests(): readonly ServerRequest[] {
    return [...this.serverRequests.values()];
  }
  respond(id: RequestId, answer: ServerRequestAnswer): void {
    this.send({ id, ...answer });
  }
  notify(method: string, params: Json): void {
    this.send({ method, params });
  }

  // ── feeds ──

  private onNotification(n: JsonRpcNotification): void {
    const gen = this.generation;
    const f = n.feed;
    if (!f) {
      this.chain = this.chain.then(() => this.deliverConnectionScoped(n, gen));
      return;
    }
    this.feedEvents++;
    this.threadLastEvent.set(f.id, this.feedEvents);
    this.pulse();
    const tracked = f.id === WIRE.appFeedId ? this.appSubscribed : this.subs.has(f.id);
    if (!tracked) return;
    const snapshot = n.method === WIRE.threadSnapshot || n.method === WIRE.appSnapshot;
    const cur = this.recv.get(f.id);
    if (!snapshot && (!cur || cur.epoch !== f.epoch || f.seq !== cur.seq + 1)) {
      return this.violation(1002, `feed gap on ${f.id}`);
    }
    this.recv.set(f.id, { epoch: f.epoch, seq: f.seq });
    this.chain = this.chain.then(() => this.fold(n, f, snapshot, gen));
  }

  private deliverConnectionScoped(n: JsonRpcNotification, gen: number): void {
    if (gen !== this.generation) return;
    if (n.method === WIRE.serverRequestResolved) {
      const p = n.params as ServerRequestResolvedParams;
      this.serverRequests.delete(jsonKey(p.requestId));
      this.emit({ type: 'serverRequestResolved', params: p });
    } else this.emit({ type: 'notification', notification: n });
  }

  private async fold(n: JsonRpcNotification, f: FeedStamp, snapshot: boolean, gen: number): Promise<void> {
    const failed: ClientErrorDetail[] = [];
    let resolved: JsonRpcNotification;
    try {
      resolved = { ...n, params: await this.resolveBlobs(n.params ?? null, failed) };
    } catch {
      return; // the connection ended; the next generation re-attaches
    }
    if (gen !== this.generation) return;
    for (const error of failed) this.emit({ type: 'blobUnavailable', feed: f, error });
    if (f.id === WIRE.appFeedId) return this.foldApp(resolved, f, snapshot);
    const prev = this.store.threads.get(f.id);
    const params = resolved.params ?? null;
    let state: Json;
    if (snapshot) state = this.reducer ? this.reducer.initial(params) : params;
    else if (!prev) return;
    else state = this.reducer ? this.reducer.apply(prev.state, resolved) : prev.state;
    this.store.threads.set(f.id, { feed: f, state });
    this.store.emit({ type: 'thread', threadId: f.id });
  }

  private foldApp(n: JsonRpcNotification, f: FeedStamp, snapshot: boolean): void {
    this.store.app = f;
    if (snapshot) {
      this.store.sectionMap.clear();
      for (const u of (n.params as unknown as AppSnapshotParams).sections) this.store.applySection(u);
    } else if (isSectionMethod(n.method)) this.store.applySection(n.params as unknown as SectionUpdate);
    else this.emit({ type: 'notification', notification: n });
  }

  /** Replaces every text stub by its content. A stub that cannot be read stays a stub and its error is appended to `failed`;
   * only the end of the connection aborts the whole resolution. */
  private async resolveBlobs(v: Json, failed: ClientErrorDetail[]): Promise<Json> {
    if (Array.isArray(v)) {
      const out: Json[] = [];
      for (const x of v) out.push(await this.resolveBlobs(x, failed));
      return out;
    }
    if (typeof v === 'object' && v !== null) {
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
      const out: { [k: string]: Json } = {};
      for (const [k, x] of Object.entries(v)) out[k] = await this.resolveBlobs(x as Json, failed);
      return out;
    }
    return v;
  }

  private resumeParams(threadId: string, window: ResumeWindow): Json {
    const prev = this.store.threads.get(threadId);
    const prevWindow = this.subs.get(threadId);
    const resumeFrom = prev && prevWindow ? { epoch: prev.feed.epoch, seq: prev.feed.seq, window: prevWindow } : undefined;
    return { threadId, window, ...(resumeFrom ? { resumeFrom } : {}) } as unknown as Json;
  }
  private appParams(): Json {
    const a = this.store.app;
    return (a ? { resumeFrom: { epoch: a.epoch, seq: a.seq } } : {}) as unknown as Json;
  }
  private attached(feedId: string, r: Json): void {
    const s = (r as unknown as ThreadResumeResponse).subscription;
    this.recv.set(feedId, { epoch: s.epoch, seq: s.startSeq - 1 });
  }

  async resumeThread(threadId: string, window: ResumeWindow): Promise<ThreadResumeResponse> {
    const params = this.resumeParams(threadId, window);
    const r = await this.run('thread/resume', params, INTERNAL, (v) => {
      this.attached(threadId, v);
      this.subs.set(threadId, window);
    });
    return r as unknown as ThreadResumeResponse;
  }
  async unsubscribeThread(threadId: string): Promise<void> {
    this.subs.delete(threadId);
    this.recv.delete(threadId);
    this.store.threads.delete(threadId);
    await this.run('thread/unsubscribe', { threadId }, INTERNAL);
  }
  async subscribeApp(): Promise<void> {
    await this.run('app/subscribe', this.appParams(), INTERNAL, (v) => {
      this.attached(WIRE.appFeedId, v);
      this.appSubscribed = true;
    });
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
    return this.run(method, p, info) as Promise<never>;
  }

  /** `stay` calls (stub resolution inside the fold) never wait for a reconnect: they reject `connectionLost` instead. */
  private async run(method: string, params: Json, info: MethodInfo, sync?: (v: Json) => void, stay = false): Promise<Json> {
    for (;;) {
      if (stay) {
        if (this.status.state !== 'ready') throw fail({ kind: 'connectionLost' });
      } else await this.whenReady();
      const sent: SentAt = { all: this.responses, byClass: { ...this.classResponses }, feed: this.feedEvents };
      try {
        return await this.rpc(method, params, info.class, sync);
      } catch (e) {
        const d = detailOf(e);
        if (d.kind === 'rpc' && d.code === -32001) {
          await this.awaitRetryTrigger(d, sent);
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
      if (cause.kind === 'connectionLost' || cause.kind === 'clientClosed') return;
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
        return u.resolve(e.result ?? null);
      case 'rejected':
        return u.reject(rpcFailure(e.error as unknown as JsonRpcErrorBody));
      case 'inProgress':
        // Same opId and payload: the core attaches the request to the running execution (protocol.md §9.3).
        this.run(u.method, u.params, u.info).then(u.resolve, u.reject);
        return;
      case 'notApplied':
        return u.reject(fail({ kind: 'opNotApplied', opId: e.opId }));
      default:
        return u.reject(fail({ kind: 'opOutcomeUnknown', opId: e.opId, state: e.state }));
    }
  }

  // ── blobs ──

  private async readPages(blob: BlobDescriptor, stay: boolean): Promise<Uint8Array> {
    const page = this.server.limits.maxBlobPageBytes;
    const parts: Uint8Array[] = [];
    let offset = 0;
    while (offset < blob.bytes) {
      const params = { digest: blob.digest, offset, length: Math.min(page, blob.bytes - offset) };
      let r: Json;
      try {
        r = await this.run('blob/read', params, READ_C1, undefined, stay);
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
  readBlob(ref: BlobRef): Promise<Uint8Array> {
    return this.readPages(ref.blob, false);
  }

  async putBlob(bytes: Uint8Array, mediaType: string): Promise<BlobRef> {
    const digest = `sha256:${[...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((x) => x.toString(16).padStart(2, '0')).join('')}`;
    const chunk = this.server.limits.maxBlobPutChunkBytes;
    let offset = 0;
    do {
      await this.run('blob/put', { digest, offset, bytesB64: toB64(bytes.subarray(offset, offset + chunk)) }, READ_C1);
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
