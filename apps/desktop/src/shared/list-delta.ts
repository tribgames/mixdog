export interface KeyedListDeltaEncoder<T> {
  encode(items: readonly T[]): unknown;
  reset(): void;
}

export interface KeyedListDeltaDecoder<T> {
  decode(wire: unknown): { ok: boolean; items?: T[] };
  reset(): void;
}

/** One upsert entry. `[key, item]` replaces the whole row; the 3- and
 *  4-element forms carry ONLY the fields that changed, the 4th listing keys the
 *  row no longer has. Older decoders require length 2 and answer `ok: false` to
 *  anything else, so they resync instead of mis-applying a shape they cannot
 *  read — the version skew is safe by construction. */
type ListUpsert<T> =
  | [string, T]
  | [string, Partial<T>, 1]
  | [string, Partial<T>, 1, string[]];

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
  after: unknown,
): { changed: Record<string, unknown>; dropped: string[] } | null {
  if (!before || !after || typeof before !== "object" || typeof after !== "object") return null;
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

export function createKeyedListDeltaEncoder<T>(
  keyOf: (item: T, index: number) => string,
): KeyedListDeltaEncoder<T> {
  let revision = 0;
  let order: string[] | null = null;
  let previous = new Map<string, { item: T; signature: string }>();
  return {
    reset(): void {
      order = null;
      previous = new Map();
    },
    encode(items): unknown {
      revision += 1;
      const nextOrder = items.map((item, index) => keyOf(item, index));
      const next = new Map<string, { item: T; signature: string }>();
      const rows = items.map((item, index) => {
        const key = nextOrder[index];
        next.set(key, { item, signature: JSON.stringify(item) });
        return [key, item] as [string, T];
      });
      if (!order) {
        order = nextOrder;
        previous = next;
        return { __listRevision: revision, rows };
      }
      // An unchanged row is not sent at all, and a changed one sends only its
      // changed FIELDS whenever that is smaller than the row. One `working`
      // heartbeat flipping used to re-send that session's preview, title, cwd
      // and route every second — the flag itself is a few dozen bytes.
      const upsert: Array<ListUpsert<T>> = [];
      for (const [key, item] of rows) {
        const before = previous.get(key);
        if (before && before.signature === next.get(key)?.signature) continue;
        const delta = before ? rowFieldDelta(before.item, item) : null;
        if (delta) {
          const entry: ListUpsert<T> = delta.dropped.length > 0
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
      const orderChanged = order.length !== nextOrder.length
        || order.some((key, index) => key !== nextOrder[index]);
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
      return wire;
    },
  };
}

export function createKeyedListDeltaDecoder<T>(): KeyedListDeltaDecoder<T> {
  let revision: number | null = null;
  let order: string[] = [];
  let rows = new Map<string, T>();
  return {
    reset(): void {
      revision = null;
      order = [];
      rows = new Map();
    },
    decode(wire): { ok: boolean; items?: T[] } {
      if (!wire || typeof wire !== "object") return { ok: false };
      const record = wire as {
        __listRevision?: unknown;
        rows?: unknown;
        __listPatch?: Partial<ListPatch<T>>;
      };
      if (!record.__listPatch) {
        if (!Number.isSafeInteger(record.__listRevision) || !Array.isArray(record.rows)) {
          return { ok: false };
        }
        const nextRows = new Map<string, T>();
        const nextOrder: string[] = [];
        for (const entry of record.rows) {
          if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string") {
            return { ok: false };
          }
          nextOrder.push(entry[0]);
          nextRows.set(entry[0], entry[1] as T);
        }
        revision = record.__listRevision as number;
        order = nextOrder;
        rows = nextRows;
        return { ok: true, items: order.map((key) => rows.get(key) as T) };
      }
      const patch = record.__listPatch;
      if (
        revision === null
        || patch.base !== revision
        || !Number.isSafeInteger(patch.revision)
        || !Array.isArray(patch.upsert)
        || !Array.isArray(patch.removed)
        || (patch.order !== undefined && !Array.isArray(patch.order))
      ) return { ok: false };
      const nextRows = new Map(rows);
      for (const key of patch.removed) {
        if (typeof key !== "string") return { ok: false };
        nextRows.delete(key);
      }
      for (const raw of patch.upsert) {
        if (!Array.isArray(raw) || typeof raw[0] !== "string") return { ok: false };
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
        if (!base || typeof base !== "object") return { ok: false };
        const fields = parts[1];
        if (!fields || typeof fields !== "object" || Array.isArray(fields)) return { ok: false };
        const merged: Record<string, unknown> = {
          ...(base as Record<string, unknown>),
          ...(fields as Record<string, unknown>),
        };
        if (parts.length === 4) {
          if (!Array.isArray(parts[3])) return { ok: false };
          for (const dropped of parts[3]) {
            if (typeof dropped !== "string") return { ok: false };
            delete merged[dropped];
          }
        }
        nextRows.set(key, merged as T);
      }
      const nextOrder = patch.order ?? order.filter((key) => nextRows.has(key));
      if (nextOrder.some((key) => typeof key !== "string" || !nextRows.has(key))) {
        return { ok: false };
      }
      revision = patch.revision as number;
      order = [...nextOrder];
      rows = nextRows;
      return { ok: true, items: order.map((key) => rows.get(key) as T) };
    },
  };
}
