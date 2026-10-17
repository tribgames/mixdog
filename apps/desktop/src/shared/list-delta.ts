import type { ViewResumePoint } from './remote-view-resume';

export interface KeyedListDeltaEncoder<T> {
  encode(items: readonly T[]): unknown;
  reset(): void;
  /** Some frame has left this encoder, so a receiver may hold its output. */
  readonly emitted: boolean;
  /** The keyed rows a receiver that applied every emitted frame holds; null
   *  without a baseline. Mirrors the decoder's resumePoint(). */
  resumePoint(): ViewResumePoint | null;
  /** The rows a receiver that applied frames up to `revision` holds, while
   *  that revision is in the bounded history (the current one always is). */
  resumePointAt(revision: number): ViewResumePoint | null;
  /** Continue from `revision` as if nothing after it was emitted; false (and
   *  nothing changed) when it is not retained. */
  rewind(revision: number): boolean;
  /** Take `items` as delivered, exactly as a full baseline would, without
   *  producing its frame: the receiver was brought to the same rows another
   *  way (a roster catch-up). Answers the revision a later patch builds on. */
  adopt(items: readonly T[]): number;
}

/** Emitted revisions a list encoder can still continue from (see
 *  DELTA_HISTORY_REVISIONS in main/state-delta.ts). Unchanged rows share one
 *  retained signature across every entry. */
const LIST_HISTORY_REVISIONS = 16;

interface KeyedListDeltaDecoder<T> {
  decode(wire: unknown): { ok: boolean; items?: T[] };
  reset(): void;
  resumePoint(): ViewResumePoint | null;
  /** resumePoint(), remembered: a patch built on the claimed revision (the
   *  sender rewound to it) applies to the claimed rows even after frames
   *  already in flight advanced this decoder. */
  claim(): ViewResumePoint | null;
  /** Rows a later `__listCatch` frame applies to. Holds no revision: any
   *  ordinary patch still answers `ok: false` until a frame establishes one. */
  seed(held: ReadonlyArray<readonly [string, T]>): void;
}

/** A roster catch-up (see main/remote-roster-log.ts): full rows changed since
 *  the version the receiver claimed, the keys removed since, and either the
 *  whole order or each upserted row's final index (ascending, aligned with
 *  `upsert`); every other row keeps its relative order. Only ever sent to a
 *  receiver that claimed rows, so older decoders never see it. */
type ListCatchUp<T> = {
  revision: number;
  upsert: Array<[string, T]>;
  removed: string[];
  place?: number[];
  order?: string[];
  count: number;
  digest: string;
};

const NO_LIST_DELTA = Symbol('mixdog.no-list-delta');
export function isNoListDelta(value: unknown): boolean {
  return value === NO_LIST_DELTA;
}

/** One upsert entry. `[key, item]` replaces the whole row; the 3- and
 *  4-element forms carry ONLY the fields that changed, the 4th listing keys the
 *  row no longer has. Older decoders require length 2 and answer `ok: false` to
 *  anything else, so they resync instead of mis-applying a shape they cannot
 *  read — the version skew is safe by construction. */
type ListUpsert<T> = [string, T] | [string, Partial<T>, 1] | [string, Partial<T>, 1, string[]];

type ListPatch<T> = {
  base: number;
  revision: number;
  upsert: Array<ListUpsert<T>>;
  removed: string[];
  order?: string[];
};

/** Fields that differ between two plain-object rows, plus the keys that
 *  disappeared. Null when either side is not a plain object: nothing but a
 *  whole-row replacement means anything then. */
function rowFieldDelta(
  before: unknown,
  after: unknown
): { changed: Record<string, unknown>; dropped: string[] } | null {
  if (!before || !after || typeof before !== 'object' || typeof after !== 'object') return null;
  if (Array.isArray(before) || Array.isArray(after)) return null;
  const from = before as Record<string, unknown>;
  const to = after as Record<string, unknown>;
  const changed: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(to)) {
    if (!Object.hasOwn(from, key) || JSON.stringify(from[key]) !== JSON.stringify(value)) {
      changed[key] = value;
    }
  }
  const dropped = Object.keys(from).filter((key) => !Object.hasOwn(to, key));
  return { changed, dropped };
}

export function createKeyedListDeltaEncoder<T>(keyOf: (item: T, index: number) => string): KeyedListDeltaEncoder<T> {
  let revision = 0;
  let emitted = false;
  let order: string[] | null = null;
  let previous = new Map<string, { signature: string }>();
  const history = new Map<number, { order: string[]; previous: Map<string, { signature: string }> }>();
  /** A rewind abandoned emitted frames a receiver may still apply: the next
   *  patch travels even when empty, since its base restores the claimed rows. */
  let rewound = false;
  const remember = (): void => {
    if (!order) return;
    history.set(revision, { order, previous });
    while (history.size > LIST_HISTORY_REVISIONS) history.delete(history.keys().next().value as number);
  };
  const pointOf = (at: number, keys: string[], signatures: Map<string, { signature: string }>): ViewResumePoint => ({
    revision: at,
    held: keys.map((key) => {
      const signature = signatures.get(key)?.signature;
      return [key, signature === undefined ? null : JSON.parse(signature)];
    }),
  });
  /** The row signatures for `items`, reusing an unchanged row's retained one. */
  const signaturesOf = (keys: string[], items: readonly T[]): Map<string, { signature: string }> => {
    const next = new Map<string, { signature: string }>();
    items.forEach((item, index) => {
      const signature = JSON.stringify(item);
      const held = previous.get(keys[index]);
      next.set(keys[index], held?.signature === signature ? held : { signature });
    });
    return next;
  };
  return {
    reset(): void {
      order = null;
      previous = new Map();
      history.clear();
      rewound = false;
    },
    get emitted() {
      return emitted;
    },
    resumePoint(): ViewResumePoint | null {
      return order ? pointOf(revision, order, previous) : null;
    },
    resumePointAt(at): ViewResumePoint | null {
      const entry = history.get(at);
      return entry ? pointOf(at, entry.order, entry.previous) : null;
    },
    rewind(at): boolean {
      const entry = history.get(at);
      if (!entry) return false;
      order = entry.order;
      previous = entry.previous;
      revision = at;
      for (const kept of [...history.keys()]) {
        if (kept <= at) continue;
        history.delete(kept);
        rewound = true;
      }
      return true;
    },
    adopt(items): number {
      emitted = true;
      revision += 1;
      const keys = items.map((item, index) => keyOf(item, index));
      previous = signaturesOf(keys, items);
      order = keys;
      remember();
      return revision;
    },
    encode(items): unknown {
      emitted = true;
      revision += 1;
      const nextOrder = items.map((item, index) => keyOf(item, index));
      const next = signaturesOf(nextOrder, items);
      const rows = items.map((item, index) => [nextOrder[index], item] as [string, T]);
      if (!order) {
        order = nextOrder;
        previous = next;
        remember();
        return { __listRevision: revision, rows };
      }
      // An unchanged row is not sent at all, and a changed one sends only its
      // changed FIELDS whenever that is smaller than the row. One `working`
      // flag flipping used to re-send that session's preview, title, cwd
      // and route every second — the flag itself is a few dozen bytes.
      const upsert: Array<ListUpsert<T>> = [];
      for (const [key, item] of rows) {
        const before = previous.get(key);
        if (before && before.signature === next.get(key)?.signature) continue;
        // The caller may reuse a row object. Its retained JSON signature is
        // the last transmitted value even if that object changed in place.
        const delta = before ? rowFieldDelta(JSON.parse(before.signature), item) : null;
        if (delta) {
          const entry: ListUpsert<T> =
            delta.dropped.length > 0
              ? [key, delta.changed as Partial<T>, 1, delta.dropped]
              : [key, delta.changed as Partial<T>, 1];
          if (JSON.stringify(entry).length < JSON.stringify([key, item]).length) {
            upsert.push(entry);
            continue;
          }
        }
        upsert.push([key, item]);
      }
      const removed = order.filter((key) => !next.has(key));
      const orderChanged = order.length !== nextOrder.length || order.some((key, index) => key !== nextOrder[index]);
      const forced = rewound;
      rewound = false;
      if (upsert.length === 0 && removed.length === 0 && !orderChanged && !forced) {
        revision -= 1;
        previous = next;
        remember();
        return NO_LIST_DELTA;
      }
      const wire = {
        __listPatch: {
          base: revision - 1,
          revision,
          upsert,
          removed,
          ...(orderChanged ? { order: nextOrder } : {}),
        } satisfies ListPatch<T>,
      };
      order = nextOrder;
      previous = next;
      remember();
      return wire;
    },
  };
}

export function createKeyedListDeltaDecoder<T>(): KeyedListDeltaDecoder<T> {
  let revision: number | null = null;
  let order: string[] = [];
  let rows = new Map<string, T>();
  let seeded = false;
  let claimed: { revision: number; order: string[]; rows: Map<string, T> } | null = null;
  const catchUp = (patch: Partial<ListCatchUp<T>>): { ok: boolean; items?: T[] } => {
    if (
      (revision === null && !seeded) ||
      !Number.isSafeInteger(patch.revision) ||
      !Number.isSafeInteger(patch.count) ||
      !Array.isArray(patch.upsert) ||
      !Array.isArray(patch.removed) ||
      (patch.order === undefined
        ? !Array.isArray(patch.place) || patch.place.length !== patch.upsert.length
        : !Array.isArray(patch.order))
    )
      return { ok: false };
    const nextRows = new Map(rows);
    for (const key of patch.removed) {
      if (typeof key !== 'string') return { ok: false };
      nextRows.delete(key);
    }
    for (const entry of patch.upsert) {
      if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string') return { ok: false };
      nextRows.set(entry[0], entry[1] as T);
    }
    let nextOrder: string[];
    if (patch.order) {
      nextOrder = [...patch.order];
    } else {
      const placed = new Set(patch.upsert.map(([key]) => key));
      const rest = order.filter((key) => !placed.has(key) && nextRows.has(key));
      nextOrder = [];
      let taken = 0;
      for (const [index, at] of (patch.place as unknown[]).entries()) {
        if (
          !Number.isSafeInteger(at) ||
          (at as number) < nextOrder.length ||
          (at as number) - nextOrder.length > rest.length - taken
        ) {
          return { ok: false };
        }
        while (nextOrder.length < (at as number)) nextOrder.push(rest[taken++]);
        nextOrder.push(patch.upsert[index][0]);
      }
      nextOrder.push(...rest.slice(taken));
    }
    const listed = new Set(nextOrder);
    if (
      nextOrder.length !== patch.count ||
      listed.size !== nextOrder.length ||
      nextOrder.some((key) => typeof key !== 'string' || !nextRows.has(key))
    )
      return { ok: false };
    for (const key of nextRows.keys()) if (!listed.has(key)) nextRows.delete(key);
    revision = patch.revision as number;
    seeded = false;
    claimed = null;
    order = nextOrder;
    rows = nextRows;
    return { ok: true, items: order.map((key) => rows.get(key) as T) };
  };
  const resumePoint = (): ViewResumePoint | null => {
    if (revision === null) return null;
    const held = rows;
    return { revision, held: order.map((key) => [key, held.get(key) ?? null]) };
  };
  return {
    reset(): void {
      revision = null;
      seeded = false;
      claimed = null;
      order = [];
      rows = new Map();
    },
    claim(): ViewResumePoint | null {
      claimed = revision === null ? null : { revision, order, rows };
      return resumePoint();
    },
    seed(held): void {
      revision = null;
      seeded = true;
      claimed = null;
      order = held.map(([key]) => key);
      rows = new Map(held.map(([key, row]) => [key, row]));
    },
    resumePoint,
    decode(wire): { ok: boolean; items?: T[] } {
      if (!wire || typeof wire !== 'object') return { ok: false };
      const record = wire as {
        __listRevision?: unknown;
        rows?: unknown;
        __listPatch?: Partial<ListPatch<T>>;
        __listCatch?: Partial<ListCatchUp<T>>;
      };
      if (record.__listCatch) return catchUp(record.__listCatch);
      if (!record.__listPatch) {
        if (!Number.isSafeInteger(record.__listRevision) || !Array.isArray(record.rows)) {
          return { ok: false };
        }
        const nextRows = new Map<string, T>();
        const nextOrder: string[] = [];
        for (const entry of record.rows) {
          if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string') {
            return { ok: false };
          }
          nextOrder.push(entry[0]);
          nextRows.set(entry[0], entry[1] as T);
        }
        revision = record.__listRevision as number;
        order = nextOrder;
        rows = nextRows;
        claimed = null;
        return { ok: true, items: order.map((key) => rows.get(key) as T) };
      }
      const patch = record.__listPatch;
      // The sender rewound to the claimed revision while frames it had already
      // sent kept arriving: the patch builds on the claimed rows.
      const restored = claimed !== null && patch.base !== revision && patch.base === claimed.revision ? claimed : null;
      const prior = restored ? { revision, order, rows } : null;
      if (restored) ({ revision, order, rows } = restored);
      const applied = applyPatch(patch);
      if (applied.ok) {
        if (restored) claimed = null;
      } else if (prior) {
        ({ revision, order, rows } = prior);
      }
      return applied;
    },
  };

  function applyPatch(patch: Partial<ListPatch<T>>): { ok: boolean; items?: T[] } {
    if (
      revision === null ||
      patch.base !== revision ||
      !Number.isSafeInteger(patch.revision) ||
      !Array.isArray(patch.upsert) ||
      !Array.isArray(patch.removed) ||
      (patch.order !== undefined && !Array.isArray(patch.order))
    )
      return { ok: false };
    const nextRows = new Map(rows);
    for (const key of patch.removed) {
      if (typeof key !== 'string') return { ok: false };
      nextRows.delete(key);
    }
    for (const raw of patch.upsert) {
      if (!Array.isArray(raw) || typeof raw[0] !== 'string') return { ok: false };
      const parts = raw as unknown[];
      const key = parts[0] as string;
      if (parts.length === 2) {
        nextRows.set(key, parts[1] as T);
        continue;
      }
      // A field patch only means anything against the row this decoder
      // already holds: a missing base is a broken chain, never a new row.
      if ((parts.length !== 3 && parts.length !== 4) || parts[2] !== 1) return { ok: false };
      const base = nextRows.get(key);
      if (!base || typeof base !== 'object') return { ok: false };
      const fields = parts[1];
      if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return { ok: false };
      const merged: Record<string, unknown> = {
        ...(base as Record<string, unknown>),
        ...(fields as Record<string, unknown>),
      };
      if (parts.length === 4) {
        if (!Array.isArray(parts[3])) return { ok: false };
        for (const dropped of parts[3]) {
          if (typeof dropped !== 'string') return { ok: false };
          delete merged[dropped];
        }
      }
      nextRows.set(key, merged as T);
    }
    const nextOrder = patch.order ?? order.filter((key) => nextRows.has(key));
    if (nextOrder.some((key) => typeof key !== 'string' || !nextRows.has(key))) {
      return { ok: false };
    }
    revision = patch.revision as number;
    order = [...nextOrder];
    rows = nextRows;
    return { ok: true, items: order.map((key) => rows.get(key) as T) };
  }
}
