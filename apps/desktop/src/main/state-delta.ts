// Identity-preserving snapshot delta shared by the utility-process and remote
// transports. copySnapshot reuses unchanged field/item objects, so reference
// comparisons are sufficient: only appended transcript entries, appended
// streaming text, and changed state fields cross the structured-clone/JSON
// boundary.
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

export function createSnapshotDeltaEncoder(): SnapshotDeltaEncoder {
  let sentItems: readonly unknown[] | null = null;
  let sentStreamingTail: Record<string, unknown> | null = null;
  let sentStreamingTailEpoch: number | null = null;
  let sentStateFields: Record<string, unknown> | null = null;
  let revision = 0;

  const reset = (): void => {
    sentItems = null;
    sentStreamingTail = null;
    sentStreamingTailEpoch = null;
    sentStateFields = null;
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
        wire.__itemsPatch = {
          base,
          revision,
          prefix,
          append: items.slice(prefix),
        };

        const nextFields = snapshotFieldsFrom(record);
        const previousFields = sentStateFields || {};
        const changed: Record<string, unknown> = {};
        const removed: string[] = [];
        for (const [key, value] of Object.entries(nextFields)) {
          if (!Object.hasOwn(previousFields, key) || !Object.is(previousFields[key], value)) {
            changed[key] = value;
          }
        }
        for (const key of Object.keys(previousFields)) {
          if (!Object.hasOwn(nextFields, key)) removed.push(key);
        }
        wire.__statePatch = { base, revision, changed, removed };

        const previousTail = sentStreamingTail;
        if (previousTail !== streamingTail) {
          const previousText = typeof previousTail?.text === 'string' ? previousTail.text : '';
          const nextText = typeof streamingTail?.text === 'string' ? streamingTail.text : '';
          if (
            previousTail
            && streamingTail
            && previousTail.id != null
            && previousTail.id === streamingTail.id
            && streamingTailEpoch !== null
            && streamingTailEpoch === sentStreamingTailEpoch
            && nextText.length >= previousText.length
          ) {
            const tail = { ...streamingTail };
            delete tail.text;
            wire.__streamingTailPatch = {
              prefix: previousText.length,
              append: nextText.slice(previousText.length),
              tail,
            };
          } else {
            wire.streamingTail = streamingTail;
          }
        }
        carryStreamingTailEpoch(record, wire);
        sentItems = items;
        sentStreamingTail = streamingTail;
        sentStreamingTailEpoch = streamingTailEpoch;
        sentStateFields = nextFields;
        return wire;
      }
      sentItems = items;
      sentStreamingTail = streamingTail;
      sentStreamingTailEpoch = streamingTailEpoch;
      sentStateFields = snapshotFieldsFrom(record);
      const wire: Record<string, unknown> = { ...record, __itemsRevision: revision };
      carryStreamingTailEpoch(record, wire);
      return wire;
    },
  };
}

export function createSnapshotDeltaDecoder(): SnapshotDeltaDecoder {
  let items: unknown[] = [];
  let streamingTail: Record<string, unknown> | null = null;
  let stateFields: Record<string, unknown> = {};
  let revision: number | null = null;
  return {
    reset(): void {
      items = [];
      streamingTail = null;
      stateFields = {};
      revision = null;
    },
    decode(wire: unknown): SnapshotDeltaDecodeResult {
      if (!wire || typeof wire !== 'object') {
        items = [];
        streamingTail = null;
        stateFields = {};
        revision = null;
        return { ok: true, snapshot: wire };
      }
      const record = wire as Record<string, unknown>;
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
        restoreStreamingTailEpoch(record, snapshot);
        return { ok: true, snapshot };
      }
      const statePatch = record.__statePatch as StateFieldsPatch | undefined;
      if (
        revision === null
        || patch.base !== revision
        || !Number.isSafeInteger(patch.revision)
        || !Number.isSafeInteger(patch.prefix)
        || (patch.prefix as number) < 0
        || (patch.prefix as number) > items.length
        || !Array.isArray(patch.append)
        || (statePatch != null && (
          statePatch.base !== revision
          || statePatch.revision !== patch.revision
          || !statePatch.changed
          || typeof statePatch.changed !== 'object'
          || Array.isArray(statePatch.changed)
          || !Array.isArray(statePatch.removed)
        ))
      ) {
        return { ok: false };
      }
      const nextItems = (patch.prefix as number) !== items.length || patch.append.length > 0
        ? items.slice(0, patch.prefix as number).concat(patch.append)
        : items;
      let nextStateFields: Record<string, unknown>;
      if (statePatch) {
        nextStateFields = { ...stateFields };
        for (const key of statePatch.removed as string[]) {
          if (typeof key === 'string') delete nextStateFields[key];
        }
        Object.assign(nextStateFields, statePatch.changed);
      } else {
        // Backward compatibility for peers that send the old items-only delta.
        nextStateFields = snapshotFieldsFrom(record);
      }

      const tailPatch = record.__streamingTailPatch as StreamingTailPatch | undefined;
      let nextStreamingTail = streamingTail;
      if (tailPatch) {
        const previousText = typeof streamingTail?.text === 'string' ? streamingTail.text : '';
        const tail = tailPatch.tail;
        if (
          !streamingTail
          || !tail
          || typeof tail !== 'object'
          || Array.isArray(tail)
          || streamingTail.id == null
          || streamingTail.id !== (tail as Record<string, unknown>).id
          || !Number.isSafeInteger(tailPatch.prefix)
          || (tailPatch.prefix as number) < 0
          || (tailPatch.prefix as number) > previousText.length
          || typeof tailPatch.append !== 'string'
        ) {
          return { ok: false };
        }
        nextStreamingTail = {
          ...tail as Record<string, unknown>,
          text: previousText.slice(0, tailPatch.prefix as number) + tailPatch.append,
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
