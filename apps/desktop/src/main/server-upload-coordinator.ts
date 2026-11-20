// The one place a server connection's file uploads are paced. Upload pacing is the sender's: the server states how many encoded
// bytes of `transfer/writeChunk` requests may be sent and not yet answered, across every upload on the connection
// (`initialize.limits.maxUploadInFlightBytes`), and promises that one upload's chunks are applied in the order they arrive. This
// coordinator holds that allowance for the connection's current ready generation: every window's uploads and the attachment
// staging draw on it, and nothing else on the connection waits for it (interactive calls never take credit).
//
// A generation is one ready period of the connection's client. Leaving ready retires it at once (every handle, queued chunk and
// held reply of it is rejected, nothing is replayed); the next ready starts a fresh one from the client's own `initialize`
// answer. A call that goes unanswered past the deadline retires the generation and reopens the link: its credit is never
// refunded, and the stuck socket is not used again.
import { SERVER_UPLOAD_ALLOWANCE_MAX_BYTES } from '../shared/server-files';
import { serverUploadBegun, serverUploadedEntry } from './server-file-access';

/** Room kept in a frame for the JSON-RPC envelope and the request's other fields around the base64 data. */
const ENVELOPE_BYTES = 4 * 1024;
/** How long an upload request (a chunk, the begin, the commit, the abort barrier) may stay unanswered. */
export const UPLOAD_CALL_DEADLINE_MS = 30_000;
/** Uploads one connection holds at once; a further begin is refused, never an active upload evicted. */
export const MAX_UPLOADS = 64;

export interface UploadLinkClient {
  call(method: string, params: unknown): Promise<unknown>;
  /** The client's own events: a `status` event carries `status.state`. Returns the removal. */
  on?(listener: (event: { readonly type: string }) => void): () => void;
  readonly server?: {
    readonly limits?: {
      readonly maxInboundFrameBytes?: unknown;
      readonly maxBlobPutChunkBytes?: unknown;
      readonly maxUploadInFlightBytes?: unknown;
    };
  };
}

/** What the coordinator needs of the connection (the main process's protocol connection to one server). */
export interface UploadLink {
  readonly status: string;
  /** The client that is open now, or null. */
  client(): UploadLinkClient | null;
  /** Raw client events; a `status` event carries `status.state`. Returns the removal. */
  onEvent(listener: (event: { readonly type: string }) => void): () => void;
  /** Replaces the client with a new one (the link is reopened). */
  reopen(): Promise<void>;
}

export interface UploadClock {
  setTimeout(run: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface UploadBegun {
  /** Opaque, main-side: names an upload of one owner on one generation. */
  uploadId: string;
  /** Raw bytes of a full chunk. */
  chunkBytes: number;
  maxBytes: number;
  /** How many chunks of this upload a producer may have submitted and not seen answered. */
  inFlightChunks: number;
}

interface Waiter {
  offset: number;
  bytes: Uint8Array;
  resolve(): void;
  reject(error: unknown): void;
}

/** One request on a generation's client, with its unanswered-call deadline. `end` is idempotent: it clears the deadline and
 *  forgets the call; whoever awaits `promise` is let go by `reject` (only a retiring generation does that). */
interface SentCall {
  promise: Promise<unknown>;
  end(): void;
  reject(error: unknown): void;
}

/** A write in flight. Its `release` is the ONE way its credit comes back: it returns the charge, clears the deadline and forgets
 *  the flight, once, whichever path gets there first (the reply, a failure, the abort barrier's answer, the generation's end). */
interface Flight {
  charge: number;
  upload: Upload;
  /** The producer waiting for this write's answer; detached (null) once the upload ended or the answer came. */
  waiter: Waiter | null;
  sent: SentCall;
  released: boolean;
  release(): void;
}

/** A begin the server has not answered yet. It reserves one place of the connection's capacity and is owned by its owner from
 *  the moment it is issued, so an owner that goes away meanwhile finds it, and a late answer is aborted on the server. */
interface PendingBegin {
  owner: object;
  cancelled: boolean;
  cancel(): void;
}

interface Upload {
  id: string;
  owner: object;
  gen: Generation;
  remoteId: string;
  size: number;
  chunkBytes: number;
  inFlightChunks: number;
  /** The next offset a producer may submit (submissions are contiguous). */
  nextOffset: number;
  ackedBytes: number;
  queued: Waiter[];
  flights: Set<Flight>;
  failure: { error: unknown } | null;
  closed: boolean;
  committing: boolean;
}

interface Generation {
  client: UploadLinkClient;
  retired: boolean;
  /** Encoded bytes the connection's uploads may have unanswered (the core's `maxUploadInFlightBytes`, clamped). */
  windowBytes: number;
  /** The raw chunk size of an upload: the core's `maxBlobPutChunkBytes`, within what the client's own frame bound admits. */
  chunkBytes: number;
  /** Set when the core's limits are unusable: uploads on this generation fail at setup with it. */
  problem: string | null;
  stopWatching: () => void;
  /** Encoded bytes of the unreleased flights: always their sum. */
  outstanding: number;
  ring: Upload[];
  cursor: number;
  /** Every unreleased write, of open and of ended uploads. */
  flights: Set<Flight>;
  /** The requests in flight on this generation. */
  calls: Set<SentCall>;
}

const encodedBytes = (raw: number): number => Math.ceil(raw / 3) * 4;

export class ServerUploadCoordinator {
  readonly #link: UploadLink;
  readonly #clock: UploadClock;
  readonly #deadlineMs: number;
  readonly #uploads = new Map<string, Upload>();
  readonly #begins = new Set<PendingBegin>();
  #gen: Generation | null = null;
  #sequence = 0;
  #stopWatching: () => void;

  constructor(link: UploadLink, options: { clock?: UploadClock; deadlineMs?: number } = {}) {
    this.#link = link;
    this.#clock = options.clock ?? {
      setTimeout: (run, ms) => setTimeout(run, ms),
      clearTimeout: (h) => clearTimeout(h as never),
    };
    this.#deadlineMs = options.deadlineMs ?? UPLOAD_CALL_DEADLINE_MS;
    this.#stopWatching = link.onEvent((event) => {
      if (event.type !== 'status') return;
      const state = (event as { status?: { state?: string } }).status?.state;
      if (state === 'ready') this.#start();
      else this.#retire('The connection to the server was interrupted.');
    });
    if (link.status === 'ready') this.#start();
  }

  /** Stops following the link; every upload is rejected. */
  dispose(): void {
    this.#stopWatching();
    this.#retire('The server connection was closed.');
  }

  /** Encoded bytes sent and not yet answered on the current generation. */
  get outstandingBytes(): number {
    return this.#gen?.outstanding ?? 0;
  }

  #start(): void {
    const client = this.#link.client();
    if (!client || (this.#gen && !this.#gen.retired && this.#gen.client === client)) return;
    this.#retire('The connection to the server was replaced.');
    // Everything an upload is sized by is what this connection's core advertised at `initialize`; one that did not state it
    // (or stated nonsense) cannot be uploaded to, and says so at setup.
    const limits = client.server?.limits ?? {};
    const positive = (value: unknown): value is number =>
      typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
    const { maxInboundFrameBytes: frame, maxBlobPutChunkBytes: chunk, maxUploadInFlightBytes: offered } = limits;
    let problem: string | null = null;
    if (!positive(frame) || frame <= ENVELOPE_BYTES) problem = 'The server did not state a usable frame size.';
    else if (!positive(chunk)) problem = 'The server did not state an upload chunk size.';
    else if (!positive(offered)) problem = 'The server did not state a valid upload window.';
    const gen: Generation = {
      client,
      retired: false,
      windowBytes: positive(offered) ? Math.min(offered, SERVER_UPLOAD_ALLOWANCE_MAX_BYTES) : 0,
      // The advertised chunk, and never a frame the client's own bound refuses.
      chunkBytes:
        positive(frame) && positive(chunk) ? Math.min(chunk, Math.floor((frame - ENVELOPE_BYTES) / 4) * 3) : 0,
      problem,
      outstanding: 0,
      ring: [],
      cursor: 0,
      flights: new Set(),
      calls: new Set(),
      stopWatching: () => undefined,
    };
    // The client's own status is observed as well, so a client that is closed (not only one that was replaced) retires the
    // generation at once, whether or not the connection announces it.
    gen.stopWatching =
      client.on?.((event) => {
        if (event.type !== 'status') return;
        const state = (event as { status?: { state?: string } }).status?.state;
        if (state !== 'ready') this.#retireGen(gen, 'The connection to the server was interrupted.');
      }) ?? (() => undefined);
    this.#gen = gen;
  }

  #retire(reason: string): void {
    if (this.#gen) this.#retireGen(this.#gen, reason);
  }

  /** Ends a generation: every upload of it is rejected at once, every flight releases itself, every other request is let go.
   *  Nothing of it is sent again. */
  #retireGen(gen: Generation, reason: string): void {
    if (gen.retired) return;
    gen.retired = true;
    if (this.#gen === gen) this.#gen = null;
    gen.stopWatching();
    for (const upload of [...gen.ring]) this.#close(upload, new Error(reason));
    for (const flight of [...gen.flights]) flight.release();
    for (const call of [...gen.calls]) {
      call.end();
      call.reject(new Error(reason));
    }
  }

  #ready(): Generation {
    const gen = this.#gen;
    if (gen && !gen.retired && this.#link.status === 'ready' && this.#link.client() === gen.client) return gen;
    if (gen) this.#retire('The connection to the server was replaced.');
    if (this.#link.status === 'ready') this.#start();
    if (!this.#gen) throw new Error('The server connection is not ready.');
    return this.#gen;
  }

  /** One request on `gen`'s client with the unanswered-call deadline; an expiry retires the generation and reopens the link. */
  #call(gen: Generation, method: string, params: unknown): SentCall {
    let timer: unknown;
    let ended = false;
    const sent = {} as SentCall;
    sent.end = () => {
      if (ended) return;
      ended = true;
      gen.calls.delete(sent);
      this.#clock.clearTimeout(timer);
    };
    sent.promise = new Promise<unknown>((resolve, reject) => {
      sent.reject = reject;
      if (gen.retired) {
        ended = true;
        reject(new Error('The upload is gone: the server connection was interrupted.'));
        return;
      }
      timer = this.#clock.setTimeout(() => {
        sent.end();
        this.#retireGen(gen, 'The server did not answer an upload request in time; the connection is being reopened.');
        void this.#link.reopen().catch(() => undefined);
        reject(new Error('The server did not answer an upload request in time.'));
      }, this.#deadlineMs);
      gen.calls.add(sent);
      try {
        gen.client.call(method, params).then(
          (value) => (sent.end(), resolve(value)),
          (error: unknown) => (sent.end(), reject(error))
        );
      } catch (error) {
        sent.end();
        reject(error);
      }
    });
    return sent;
  }

  #find(owner: object, uploadId: string): Upload {
    const upload = this.#uploads.get(uploadId);
    if (!upload || upload.owner !== owner || upload.gen.retired) {
      throw new Error('The upload is gone: it was cancelled or failed.');
    }
    return upload;
  }

  /** A begin the server answered for an owner that is gone: the transfer it names is aborted, not installed. */
  #abortRemote(gen: Generation, reply: unknown): void {
    const id = (reply as { uploadId?: unknown } | null)?.uploadId;
    if (typeof id === 'string' && !gen.retired)
      void this.#call(gen, 'transfer/abort', { transferId: id }).promise.catch(() => undefined);
  }

  async begin(owner: object, name: string, size: number, scope: string): Promise<UploadBegun> {
    const gen = this.#ready();
    if (gen.problem) throw new Error(gen.problem);
    // Uploads and begins still waiting for their answer share the capacity: concurrent begins cannot all pass one check.
    if (this.#uploads.size + this.#begins.size >= MAX_UPLOADS) throw new Error('Too many uploads are in progress.');
    const sent = this.#call(gen, 'transfer/beginWrite', { name, size, scope });
    return new Promise<UploadBegun>((resolve, reject) => {
      const pending: PendingBegin = {
        owner,
        cancelled: false,
        cancel: () => {
          if (pending.cancelled) return;
          pending.cancelled = true;
          reject(new Error('The upload was cancelled.'));
        },
      };
      this.#begins.add(pending);
      // The reservation ends in ONE synchronous step, the answer's: either the handle is installed (owner-tracked from that very
      // moment) or the transfer the answer names is aborted. Nothing runs between the reservation's end and the handle.
      sent.promise.then(
        (reply) => {
          this.#begins.delete(pending);
          try {
            resolve(this.#installBegun(gen, pending, reply, size));
          } catch (error) {
            reject(error);
          }
        },
        (error: unknown) => {
          this.#begins.delete(pending);
          reject(error);
        }
      );
    });
  }

  /** Turns the server's answer to a begin into a handle, or aborts the transfer it names; never both, never neither. */
  #installBegun(gen: Generation, pending: PendingBegin, reply: unknown, size: number): UploadBegun {
    const refuse = (message: string): never => {
      this.#abortRemote(gen, reply);
      throw new Error(message);
    };
    if (pending.cancelled) return refuse('The upload was cancelled.');
    if (gen.retired) throw new Error('The upload is gone: the server connection was interrupted.');
    let begun: ReturnType<typeof serverUploadBegun>;
    try {
      begun = serverUploadBegun(reply);
    } catch (error) {
      this.#abortRemote(gen, reply);
      throw error;
    }
    const { chunkBytes } = gen;
    if (chunkBytes < 1) return refuse('The server connection admits no upload chunk.');
    const encoded = encodedBytes(chunkBytes);
    if (gen.windowBytes < encoded) return refuse('The server upload window is smaller than one chunk.');
    const upload: Upload = {
      id: `upload-${++this.#sequence}-${Math.random().toString(36).slice(2, 10)}`,
      owner: pending.owner,
      gen,
      remoteId: begun.uploadId,
      size,
      chunkBytes,
      inFlightChunks: Math.floor(gen.windowBytes / encoded),
      nextOffset: 0,
      ackedBytes: 0,
      queued: [],
      flights: new Set(),
      failure: null,
      closed: false,
      committing: false,
    };
    this.#uploads.set(upload.id, upload);
    gen.ring.push(upload);
    return { uploadId: upload.id, chunkBytes, maxBytes: begun.maxBytes, inFlightChunks: upload.inFlightChunks };
  }
  /** Submits the next chunk of an upload (contiguous offsets only); resolves when the server answered it. */
  write(owner: object, uploadId: string, offset: number, bytes: Uint8Array): Promise<void> {
    let upload: Upload;
    try {
      upload = this.#find(owner, uploadId);
      if (upload.closed || upload.committing) throw new Error('The upload is gone: it was cancelled or failed.');
      if (upload.failure) throw upload.failure.error;
      if (!(bytes instanceof Uint8Array) || bytes.length === 0 || bytes.length > upload.chunkBytes) {
        throw new TypeError('upload chunk is invalid.');
      }
      if (offset !== upload.nextOffset || offset + bytes.length > upload.size)
        throw new TypeError('upload offset is invalid.');
      if (upload.queued.length + upload.flights.size >= upload.inFlightChunks) {
        throw new TypeError('too many upload chunks are waiting.');
      }
    } catch (error) {
      return Promise.reject(error);
    }
    upload.nextOffset += bytes.length;
    return new Promise<void>((resolve, reject) => {
      upload.queued.push({ offset, bytes, resolve, reject });
      this.#pump(upload.gen);
    });
  }

  /** Sends what the allowance admits: runnable uploads in turn, one chunk each, the actual chunk charged before it leaves. */
  #pump(gen: Generation): void {
    while (!gen.retired && gen.ring.length > 0) {
      let chosen: Upload | undefined;
      for (let step = 0; step < gen.ring.length; step += 1) {
        const candidate = gen.ring[(gen.cursor + step) % gen.ring.length];
        if (!candidate.closed && candidate.queued.length > 0) {
          chosen = candidate;
          gen.cursor = (gen.cursor + step + 1) % gen.ring.length;
          break;
        }
      }
      if (!chosen) return;
      const waiter = chosen.queued[0];
      const charge = encodedBytes(waiter.bytes.length);
      // The window holds at least one full chunk (checked at begin), so a chunk always fits an empty connection.
      if (gen.outstanding + charge > gen.windowBytes) {
        gen.cursor = gen.ring.indexOf(chosen);
        return;
      }
      chosen.queued.shift();
      this.#dispatch(gen, chosen, waiter, charge);
    }
  }

  #dispatch(gen: Generation, upload: Upload, waiter: Waiter, charge: number): void {
    const sent = this.#call(gen, 'transfer/writeChunk', {
      transferId: upload.remoteId,
      offset: waiter.offset,
      bytesB64: Buffer.from(waiter.bytes.buffer, waiter.bytes.byteOffset, waiter.bytes.byteLength).toString('base64'),
    });
    const flight: Flight = {
      charge,
      upload,
      waiter,
      sent,
      released: false,
      release: () => {
        if (flight.released) return;
        flight.released = true;
        gen.outstanding -= charge;
        gen.flights.delete(flight);
        upload.flights.delete(flight);
        sent.end();
      },
    };
    gen.outstanding += charge;
    gen.flights.add(flight);
    upload.flights.add(flight);
    // Every path below only calls `flight.release()`; a flight released by anything else (the abort barrier, the generation's
    // end) finds its late reply with nothing left to do.
    sent.promise.then(
      () => {
        const live = !flight.released;
        const producer = flight.waiter;
        flight.waiter = null;
        flight.release();
        if (live && producer) {
          upload.ackedBytes += producer.bytes.length;
          producer.resolve();
        }
        this.#pump(gen);
      },
      (error: unknown) => {
        const live = !flight.released;
        const producer = flight.waiter;
        flight.waiter = null;
        flight.release();
        // The first failure is the cause: the upload ends here, whatever its caller does next.
        if (live && producer) this.#fail(upload, error, producer);
        this.#pump(gen);
      }
    );
  }

  /** A chunk failed: the error is latched, the handle retired, every producer detached and one keyed abort issued, here. */
  #fail(upload: Upload, error: unknown, failing?: Waiter): void {
    failing?.reject(error);
    if (upload.closed) return;
    upload.failure ??= { error };
    this.#cancel(upload, upload.failure.error);
  }

  /** Ends an upload locally: unsent and unanswered producers are rejected now, nothing more is sent for it. Its flights stay
   *  charged until they release themselves. */
  #close(upload: Upload, error: unknown): void {
    if (upload.closed) return;
    upload.closed = true;
    upload.failure ??= { error };
    for (const waiter of upload.queued.splice(0)) waiter.reject(error);
    for (const flight of upload.flights) {
      flight.waiter?.reject(error);
      flight.waiter = null;
    }
    this.#uploads.delete(upload.id);
    const at = upload.gen.ring.indexOf(upload);
    if (at >= 0) upload.gen.ring.splice(at, 1);
    if (upload.gen.cursor >= upload.gen.ring.length) upload.gen.cursor = 0;
  }

  /** Ends an upload and sends its one keyed abort on the original generation. The barrier runs behind every write already sent
   *  there, so its answer proves they drained: the flights it left charged release themselves then. An unanswered barrier keeps
   *  its deadline (the link is reopened). */
  #cancel(upload: Upload, error: unknown): void {
    const { gen } = upload;
    this.#close(upload, error);
    if (gen.retired) return;
    this.#call(gen, 'transfer/abort', { transferId: upload.remoteId }).promise.then(
      () => {
        for (const flight of [...upload.flights]) flight.release();
        this.#pump(gen);
      },
      () => undefined
    );
  }

  /** Completes an upload whose chunks were all answered. */
  async commit(
    owner: object,
    uploadId: string
  ): Promise<{ absolutePath: string; name: string; dir: boolean; size: number }> {
    const upload = this.#find(owner, uploadId);
    if (upload.closed || upload.committing) throw new Error('The upload is gone: it was cancelled or failed.');
    if (upload.failure) throw upload.failure.error;
    if (
      upload.nextOffset !== upload.size ||
      upload.ackedBytes !== upload.size ||
      upload.queued.length > 0 ||
      upload.flights.size > 0
    ) {
      throw new Error('The upload is not complete: every chunk must be sent and answered before it is committed.');
    }
    upload.committing = true;
    try {
      const reply = await this.#call(upload.gen, 'transfer/commit', { transferId: upload.remoteId }).promise;
      if (upload.closed) throw new Error('The upload is gone: it was cancelled or failed.');
      const entry = serverUploadedEntry(reply, upload.size);
      this.#close(upload, new Error('The upload is complete.'));
      return entry;
    } catch (error) {
      upload.failure ??= { error };
      throw upload.failure.error;
    }
  }

  /** Cancels an upload (idempotent): its producers are rejected now and one keyed abort goes out on the original generation. */
  abort(owner: object, uploadId: string): boolean {
    const upload = this.#uploads.get(uploadId);
    if (!upload || upload.owner !== owner) return false;
    this.#cancel(upload, new Error('The upload was cancelled.'));
    return true;
  }

  /** Cancels every upload of `owner` (its window closed), begins still waiting for their answer included; another owner's are
   *  untouched. */
  releaseOwner(owner: object): void {
    for (const pending of [...this.#begins]) if (pending.owner === owner) pending.cancel();
    for (const upload of [...this.#uploads.values()]) if (upload.owner === owner) this.abort(owner, upload.id);
  }
}
const coordinators = new WeakMap<object, ServerUploadCoordinator>();

/** The one coordinator of a connection, shared by every window and staging path that uses it. */
export function serverUploadCoordinatorFor(link: UploadLink): ServerUploadCoordinator {
  let coordinator = coordinators.get(link);
  if (!coordinator) {
    coordinator = new ServerUploadCoordinator(link);
    coordinators.set(link, coordinator);
  }
  return coordinator;
}
