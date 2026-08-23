// Identity-preserving snapshot delta shared by daemon, Electron, and remote
// transports. Decoders retain unchanged field/item objects, so only appended
// transcript entries, appended streaming text, and changed state fields cross
// the structured-clone/JSON boundary.
export interface SnapshotDeltaEncoder {
  encode(snapshot: unknown): unknown;
  reset(): void;
}

export interface SnapshotDeltaDecodeResult {
  ok: boolean;
  snapshot?: unknown;
}

export interface SnapshotDeltaDecoder {
  decode(wire: unknown): SnapshotDeltaDecodeResult;
  reset(): void;
}

interface SessionStateRetentionStore {
  keys(): IterableIterator<string>;
  delete(sessionId: string): boolean;
}

/** Release transport baselines for panes that are no longer visible. */
export function releaseHiddenSessionStateEntries(
  visibleSessionIds: ReadonlySet<string>,
  stores: readonly SessionStateRetentionStore[],
  beforeRelease?: (sessionId: string) => void,
): string[] {
  const retained = new Set<string>();
  for (const store of stores) {
    for (const sessionId of store.keys()) retained.add(sessionId);
  }
  const released: string[] = [];
  for (const sessionId of retained) {
    if (visibleSessionIds.has(sessionId)) continue;
    beforeRelease?.(sessionId);
    for (const store of stores) store.delete(sessionId);
    released.push(sessionId);
  }
  return released;
}

/** Pane transports publish only mounted/observed sessions. A null frame is
 * always forwarded because it releases a baseline retained by every hop. */
export function shouldPublishSessionState(
  sessionId: string,
  snapshot: unknown,
  visibleSessionIds: ReadonlySet<string>,
): boolean {
  return snapshot === null || visibleSessionIds.has(sessionId);
}

const STREAMING_TAIL_TEXT_EPOCH = Symbol.for('mixdog.streaming-tail-text-epoch');
const STREAMING_TAIL_WIRE_EPOCH = '__streamingTailTextEpoch';
const WIRE_FIELDS = new Set([
  '__itemsRevision',
  '__itemsPatch',
  '__streamingTailPatch',
  '__statePatch',
  STREAMING_TAIL_WIRE_EPOCH,
]);

interface ItemsPatch {
  base?: unknown;
  revision?: unknown;
  prefix?: unknown;
  append?: unknown;
}

interface StateFieldsPatch {
  base?: unknown;
  revision?: unknown;
  changed?: unknown;
  removed?: unknown;
}

interface StreamingTailPatch {
  prefix?: unknown;
  append?: unknown;
  tail?: unknown;
}

function carryStreamingTailEpoch(
  source: Record<PropertyKey, unknown>,
  target: Record<string, unknown>,
): void {
  const epoch = source[STREAMING_TAIL_TEXT_EPOCH];
  if (Number.isSafeInteger(epoch)) target[STREAMING_TAIL_WIRE_EPOCH] = epoch;
}

function restoreStreamingTailEpoch(
  source: Record<string, unknown>,
  target: Record<string | symbol, unknown>,
): void {
  const epoch = source[STREAMING_TAIL_WIRE_EPOCH];
  delete target[STREAMING_TAIL_WIRE_EPOCH];
  if (Number.isSafeInteger(epoch)) {
    Object.defineProperty(target, STREAMING_TAIL_TEXT_EPOCH, {
      value: epoch,
      enumerable: false,
      configurable: true,
    });
  }
}

/** Whether a state field still carries the value the receiver already holds.
 *  Reference equality is the fast path, not the answer: a snapshot rebuilt on
 *  every publish hands back equal-but-new objects, and `agentWorkers`,
 *  `agentJobs`, `shellJobs` and friends are exactly the fields that get rebuilt
 *  while an agent runs. Treating those as changed re-sent whole arrays on every
 *  streamed frame — the most expensive lane on the relay was mostly repeats. */
function sameSnapshotField(before: unknown, after: unknown): boolean {
  if (Object.is(before, after)) return true;
  if (!before || !after || typeof before !== 'object' || typeof after !== 'object') return false;
  return JSON.stringify(before) === JSON.stringify(after);
}

/** Item-by-item reuse. Transcript items are appended and settled in place, so
 *  an unchanged prefix is the norm, and its identity is exactly what the delta
 *  encoders read to mean "the receiver already holds this". */
function reconcileProjectionItems(
  before: readonly unknown[],
  after: readonly unknown[],
): readonly unknown[] {
  let reusedAll = before.length === after.length;
  const items = after.map((item, index) => {
    const prior = index < before.length ? before[index] : undefined;
    if (index < before.length && sameSnapshotField(prior, item)) return prior;
    reusedAll = false;
    return item;
  });
  return reusedAll ? before : items;
}

/** Fold a freshly read stored projection onto the one already held.
 *
 *  A stored read has no baseline to diff against, so it always answers with a
 *  FULL snapshot — and a cold view that is merely VISIBLE is re-read on a one
 *  second clock. Each read parses a brand-new object graph, which the encoders
 *  below can only read as "every item changed": a phone watching a session
 *  whose screen never moved was receiving the whole transcript once a second.
 *
 *  Returns the previous snapshot itself when nothing differs, so the caller can
 *  compare by reference and publish nothing at all. */
export function reconcileSessionProjection<T>(previous: T, next: T): T {
  if (!previous || !next || typeof previous !== 'object' || typeof next !== 'object') return next;
  if (Array.isArray(previous) || Array.isArray(next)) return next;
  const before = previous as Record<string, unknown>;
  const after = next as Record<string, unknown>;
  const merged: Record<string, unknown> = {};
  let identical = Object.keys(before).length === Object.keys(after).length;
  for (const [key, value] of Object.entries(after)) {
    if (key === 'items' && Array.isArray(value) && Array.isArray(before.items)) {
      const items = reconcileProjectionItems(before.items, value);
      merged.items = items;
      if (items !== before.items) identical = false;
      continue;
    }
    if (Object.hasOwn(before, key) && sameSnapshotField(before[key], value)) {
      merged[key] = before[key];
      continue;
    }
    merged[key] = value;
    identical = false;
  }
  return identical ? previous : merged as T;
}

function snapshotFieldsFrom(record: Record<string, unknown>): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (key !== 'items' && key !== 'streamingTail' && !WIRE_FIELDS.has(key)) {
      fields[key] = value;
    }
  }
  return fields;
}

function streamingTailFrom(record: Record<string, unknown> | null): Record<string, unknown> | null {
  const value = record?.streamingTail;
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/** Wire marker for the compact frame shape. A live streaming frame is mostly
 *  bookkeeping — an empty items patch, an empty state patch and a repeated
 *  tail identity cost ~135 bytes around ~30 bytes of new text — so the compact
 *  encoder omits every unchanged part and the decoder reads absence as "no
 *  change". The marker keeps that reading away from v1 frames, where a missing
 *  state patch means an older peer sent whole fields instead. */
const COMPACT_WIRE_VERSION = 2;

/** Returned by an encoder instead of a wire when the snapshot did not move.
 *  The caller must send NOTHING: a frame that says "nothing changed" pays for
 *  a whole E2EE envelope — box, nonce and base64 — to deliver what the
 *  receiver already holds. The encoder keeps its revision, so the next real
 *  patch still chains onto the baseline the receiver has. */
export const REMOTE_NO_DELTA = Symbol.for('mixdog.remote-no-delta');

export function isNoDelta(wire: unknown): boolean {
  return wire === REMOTE_NO_DELTA;
}

export interface SnapshotDeltaEncoderOptions {
  /** Only for a peer that announced it understands the compact shape. */
  compact?: boolean;
}

export function createSnapshotDeltaEncoder(
  options: SnapshotDeltaEncoderOptions = {},
): SnapshotDeltaEncoder {
  const compact = options.compact === true;
  let sentItems: readonly unknown[] | null = null;
  let sentStreamingTail: Record<string, unknown> | null = null;
  let sentStreamingTailEpoch: number | null = null;
  let sentStateFields: Record<string, unknown> | null = null;
  let sentTailIdentity: string | null = null;
  let sentWireEpoch: number | null = null;
  let revision = 0;

  const reset = (): void => {
    sentItems = null;
    sentStreamingTail = null;
    sentStreamingTailEpoch = null;
    sentStateFields = null;
    sentTailIdentity = null;
    sentWireEpoch = null;
  };

  return {
    reset,
    encode(snapshot: unknown): unknown {
      const record = snapshot as Record<string, unknown> | null;
      const items = record && Array.isArray(record.items) ? record.items as unknown[] : null;
      if (!record || !items) {
        reset();
        return snapshot;
      }
      const streamingTail = streamingTailFrom(record);
      const epochValue = (record as Record<PropertyKey, unknown>)[STREAMING_TAIL_TEXT_EPOCH];
      const streamingTailEpoch = Number.isSafeInteger(epochValue) ? epochValue as number : null;
      revision += 1;
      if (sentItems) {
        const base = revision - 1;
        let prefix = sentItems === items ? items.length : 0;
        if (sentItems !== items) {
          const shared = Math.min(sentItems.length, items.length);
          while (prefix < shared && sentItems[prefix] === items[prefix]) prefix += 1;
        }
        const wire: Record<string, unknown> = {};
        const append = items.slice(prefix);
        // Ordering fields alone are not news. Anything that gives the receiver
        // something it does not already hold sets this.
        let carriesNews = append.length > 0 || prefix !== items.length;
        if (compact) {
          // `r` alone orders the stream: base is always the previous revision,
          // so the receiver derives it rather than reading it. Item movement
          // does not happen while tokens stream into the tail, so `ip` appears
          // only when the list really moved. The frame version is carried by
          // the envelope, not repeated in every payload.
          wire.r = revision;
          if (append.length > 0 || prefix !== items.length) {
            wire.ip = { p: prefix, a: append };
          }
        } else {
          wire.__itemsPatch = { base, revision, prefix, append };
        }

        const nextFields = snapshotFieldsFrom(record);
        const previousFields = sentStateFields || {};
        const changed: Record<string, unknown> = {};
        const removed: string[] = [];
        for (const [key, value] of Object.entries(nextFields)) {
          if (!Object.hasOwn(previousFields, key)
            || !sameSnapshotField(previousFields[key], value)) {
            changed[key] = value;
          }
        }
        for (const key of Object.keys(previousFields)) {
          if (!Object.hasOwn(nextFields, key)) removed.push(key);
        }
        if (Object.keys(changed).length > 0 || removed.length > 0) carriesNews = true;
        if (!compact) {
          wire.__statePatch = { base, revision, changed, removed };
        } else if (Object.keys(changed).length > 0 || removed.length > 0) {
          // Ordering rides the items patch, so this carries payload only —
          // and an unchanged state block leaves the frame entirely.
          if (Object.keys(changed).length > 0) wire.sc = changed;
          if (removed.length > 0) wire.sd = removed;
        }

        const previousTail = sentStreamingTail;
        if (previousTail !== streamingTail) {
          const previousText = typeof previousTail?.text === 'string' ? previousTail.text : '';
          const nextText = typeof streamingTail?.text === 'string' ? streamingTail.text : '';
          // The epoch marker proves an append without reading the text, but it
          // is non-enumerable and every desktop hop rebuilds the snapshot, so
          // it survives only in-process. Where it does not, one prefix compare
          // proves the same thing; refusing to prove it ships the entire
          // streamed text again on every frame of the turn.
          const appendProven = streamingTailEpoch !== null
            ? streamingTailEpoch === sentStreamingTailEpoch
            : sentStreamingTailEpoch === null && nextText.startsWith(previousText);
          if (
            previousTail
            && streamingTail
            && previousTail.id != null
            && previousTail.id === streamingTail.id
            && appendProven
            && nextText.length >= previousText.length
          ) {
            const tail = { ...streamingTail };
            delete tail.text;
            // The identity block (id, kind, streaming flags) is repeated on
            // every frame of a turn. A compact frame sends it once and then
            // only when something in it actually changes.
            const identity = JSON.stringify(tail);
            const sameIdentity = identity === sentTailIdentity;
            const repeatedIdentity = compact && sameIdentity;
            sentTailIdentity = identity;
            const appended = nextText.slice(previousText.length);
            if (appended !== '' || !sameIdentity) carriesNews = true;
            if (compact) {
              // The splice point is the receiver's own tail length on an
              // append-only stream, so only the appended text travels.
              wire.ta = appended;
              if (!repeatedIdentity) wire.tt = tail;
            } else {
              wire.__streamingTailPatch = {
                prefix: previousText.length,
                append: appended,
                tail,
              };
            }
          } else {
            wire.streamingTail = streamingTail;
            sentTailIdentity = null;
            carriesNews = true;
          }
        }
        if (compact) {
          // The epoch repeats unchanged for a whole turn; send it only when
          // it actually rolls over.
          if (streamingTailEpoch !== null && streamingTailEpoch !== sentWireEpoch) {
            wire.x = streamingTailEpoch;
            sentWireEpoch = streamingTailEpoch;
            carriesNews = true;
          }
        } else {
          carryStreamingTailEpoch(record, wire);
        }
        sentItems = items;
        sentStreamingTail = streamingTail;
        sentStreamingTailEpoch = streamingTailEpoch;
        sentStateFields = nextFields;
        if (!carriesNews) {
          // Hold the revision: the receiver's baseline never moved, so the next
          // real patch has to chain onto the one it already holds.
          revision -= 1;
          return REMOTE_NO_DELTA;
        }
        return wire;
      }
      sentItems = items;
      sentStreamingTail = streamingTail;
      sentStreamingTailEpoch = streamingTailEpoch;
      sentStateFields = snapshotFieldsFrom(record);
      // A full snapshot restarts the stream: the next patch has to restate the
      // tail identity and epoch because the receiver's baseline was replaced.
      sentTailIdentity = null;
      sentWireEpoch = streamingTailEpoch;
      const wire: Record<string, unknown> = { ...record, __itemsRevision: revision };
      carryStreamingTailEpoch(record, wire);
      return wire;
    },
  };
}

/** Compact frames use one-letter keys; normalizing them back to the internal
 *  shape keeps ONE decode path for both wire versions. */
function expandCompactWire(record: Record<string, unknown>): Record<string, unknown> {
  const itemsPatch = record.ip as Record<string, unknown> | undefined;
  const expanded: Record<string, unknown> = { __v: COMPACT_WIRE_VERSION };
  const revision = record.r;
  expanded.__itemsPatch = {
    // The sender only ever advances by one, so the base is implied.
    base: Number.isSafeInteger(revision) ? (revision as number) - 1 : undefined,
    revision,
    ...(itemsPatch && typeof itemsPatch === 'object' && !Array.isArray(itemsPatch)
      ? { prefix: itemsPatch.p, append: itemsPatch.a }
      : {}),
  };
  if (Object.hasOwn(record, 'sc') || Object.hasOwn(record, 'sd')) {
    expanded.__statePatch = {
      ...(Object.hasOwn(record, 'sc') ? { changed: record.sc } : {}),
      ...(Object.hasOwn(record, 'sd') ? { removed: record.sd } : {}),
    };
  }
  if (Object.hasOwn(record, 'ta')) {
    // No prefix on the wire: the decoder splices at its own retained length.
    expanded.__streamingTailPatch = {
      append: record.ta,
      ...(Object.hasOwn(record, 'tt') ? { tail: record.tt } : {}),
    };
  }
  if (Object.hasOwn(record, 'streamingTail')) expanded.streamingTail = record.streamingTail;
  if (Object.hasOwn(record, 'x')) expanded[STREAMING_TAIL_WIRE_EPOCH] = record.x;
  return expanded;
}

/** The compact shape is announced by the transport envelope, so the receiving
 *  side marks the payload before decoding it. Keeping the marker off the wire
 *  saves it from every streaming frame. */
export function markCompactWire(wire: Record<string, unknown>): void {
  wire.__v = COMPACT_WIRE_VERSION;
}

export function createSnapshotDeltaDecoder(): SnapshotDeltaDecoder {
  let items: unknown[] = [];
  let streamingTail: Record<string, unknown> | null = null;
  let stateFields: Record<string, unknown> = {};
  let revision: number | null = null;
  // Compact frames carry the tail epoch only when it rolls over.
  let retainedEpoch: number | null = null;
  return {
    reset(): void {
      items = [];
      streamingTail = null;
      stateFields = {};
      revision = null;
      retainedEpoch = null;
    },
    decode(wire: unknown): SnapshotDeltaDecodeResult {
      if (!wire || typeof wire !== 'object') {
        items = [];
        streamingTail = null;
        stateFields = {};
        revision = null;
        retainedEpoch = null;
        return { ok: true, snapshot: wire };
      }
      const raw = wire as Record<string, unknown>;
      let record = raw;
      if (raw.__v === COMPACT_WIRE_VERSION) {
        record = expandCompactWire(raw);
        if (Object.hasOwn(record, STREAMING_TAIL_WIRE_EPOCH)) {
          const value = record[STREAMING_TAIL_WIRE_EPOCH];
          retainedEpoch = Number.isSafeInteger(value) ? value as number : null;
        } else if (retainedEpoch !== null) {
          record[STREAMING_TAIL_WIRE_EPOCH] = retainedEpoch;
        }
      }
      const patch = record.__itemsPatch as ItemsPatch | undefined;
      if (!patch) {
        const snapshot = { ...record };
        delete snapshot.__itemsRevision;
        delete snapshot.__itemsPatch;
        delete snapshot.__streamingTailPatch;
        delete snapshot.__statePatch;
        if (Array.isArray(snapshot.items)) {
          items = snapshot.items;
          revision = Number.isSafeInteger(record.__itemsRevision)
            ? record.__itemsRevision as number
            : null;
        } else {
          items = [];
          revision = null;
        }
        streamingTail = streamingTailFrom(snapshot);
        stateFields = snapshotFieldsFrom(snapshot);
        // A full snapshot re-establishes the epoch that later compact frames
        // will omit while it stays unchanged.
        const epoch = record[STREAMING_TAIL_WIRE_EPOCH];
        retainedEpoch = Number.isSafeInteger(epoch) ? epoch as number : null;
        restoreStreamingTailEpoch(record, snapshot);
        return { ok: true, snapshot };
      }
      const statePatch = record.__statePatch as StateFieldsPatch | undefined;
      // In a compact frame an absent section means "unchanged"; in a v1 frame
      // it means an older peer inlined whole fields, so the two readings must
      // stay apart.
      const compactFrame = record.__v === COMPACT_WIRE_VERSION;
      const patchPrefix = Object.hasOwn(patch, 'prefix')
        ? patch.prefix
        : (compactFrame ? items.length : undefined);
      const patchAppend = Object.hasOwn(patch, 'append')
        ? patch.append
        : (compactFrame ? [] : undefined);
      if (
        revision === null
        || patch.base !== revision
        || !Number.isSafeInteger(patch.revision)
        || !Number.isSafeInteger(patchPrefix)
        || (patchPrefix as number) < 0
        || (patchPrefix as number) > items.length
        || !Array.isArray(patchAppend)
        || (statePatch != null && (
          (!compactFrame && (
            statePatch.base !== revision
            || statePatch.revision !== patch.revision
            || !statePatch.changed
            || !Array.isArray(statePatch.removed)
          ))
          || (statePatch.changed !== undefined && (
            typeof statePatch.changed !== 'object'
            || statePatch.changed === null
            || Array.isArray(statePatch.changed)
          ))
          || (statePatch.removed !== undefined && !Array.isArray(statePatch.removed))
        ))
      ) {
        return { ok: false };
      }
      const nextItems = (patchPrefix as number) !== items.length || patchAppend.length > 0
        ? items.slice(0, patchPrefix as number).concat(patchAppend)
        : items;
      let nextStateFields: Record<string, unknown>;
      if (statePatch) {
        nextStateFields = { ...stateFields };
        for (const key of (statePatch.removed as string[] | undefined) ?? []) {
          if (typeof key === 'string') delete nextStateFields[key];
        }
        if (statePatch.changed) Object.assign(nextStateFields, statePatch.changed);
      } else if (compactFrame) {
        nextStateFields = stateFields;
      } else {
        // Backward compatibility for peers that send the old items-only delta.
        nextStateFields = snapshotFieldsFrom(record);
      }

      const tailPatch = record.__streamingTailPatch as StreamingTailPatch | undefined;
      let nextStreamingTail = streamingTail;
      if (tailPatch) {
        const previousText = typeof streamingTail?.text === 'string' ? streamingTail.text : '';
        // A compact frame omits the identity block while it is unchanged, so
        // the retained tail supplies it.
        let tail = tailPatch.tail;
        if (tail === undefined && compactFrame && streamingTail) {
          const retained = { ...streamingTail };
          delete retained.text;
          tail = retained;
        }
        // An append-only compact patch leaves the splice point out: it is
        // exactly the length of the text this decoder already holds.
        const tailPrefix = Object.hasOwn(tailPatch, 'prefix')
          ? tailPatch.prefix
          : (compactFrame ? previousText.length : undefined);
        if (
          !streamingTail
          || !tail
          || typeof tail !== 'object'
          || Array.isArray(tail)
          || streamingTail.id == null
          || streamingTail.id !== (tail as Record<string, unknown>).id
          || !Number.isSafeInteger(tailPrefix)
          || (tailPrefix as number) < 0
          || (tailPrefix as number) > previousText.length
          || typeof tailPatch.append !== 'string'
        ) {
          return { ok: false };
        }
        nextStreamingTail = {
          ...tail as Record<string, unknown>,
          text: previousText.slice(0, tailPrefix as number) + tailPatch.append,
        };
      } else if (Object.hasOwn(record, 'streamingTail')) {
        nextStreamingTail = streamingTailFrom(record);
      }

      items = nextItems;
      stateFields = nextStateFields;
      streamingTail = nextStreamingTail;
      revision = patch.revision as number;
      const snapshot: Record<string, unknown> = {
        ...stateFields,
        items,
        streamingTail,
      };
      restoreStreamingTailEpoch(record, snapshot);
      return { ok: true, snapshot };
    },
  };
}

// Transport-level resync frame (mirrors the IPC stateResync channel): a
// client whose patch base did not match asks for a fresh full snapshot.
export function isStateResyncFrame(raw: string): boolean {
  if (!raw.includes('stateResync')) return false;
  try {
    const message = JSON.parse(raw) as { method?: unknown; id?: unknown };
    return message.method === 'stateResync' && typeof message.id !== 'number';
  } catch {
    return false;
  }
}
