export interface KeyedListDeltaEncoder<T> {
  encode(items: readonly T[]): unknown;
  reset(): void;
}

export interface KeyedListDeltaDecoder<T> {
  decode(wire: unknown): { ok: boolean; items?: T[] };
  reset(): void;
}

type ListPatch<T> = {
  base: number;
  revision: number;
  upsert: Array<[string, T]>;
  removed: string[];
  order?: string[];
};

export function createKeyedListDeltaEncoder<T>(
  keyOf: (item: T, index: number) => string,
): KeyedListDeltaEncoder<T> {
  let revision = 0;
  let order: string[] | null = null;
  let signatures = new Map<string, string>();
  return {
    reset(): void {
      order = null;
      signatures = new Map();
    },
    encode(items): unknown {
      revision += 1;
      const nextOrder = items.map((item, index) => keyOf(item, index));
      const nextSignatures = new Map<string, string>();
      const rows = items.map((item, index) => {
        const key = nextOrder[index];
        nextSignatures.set(key, JSON.stringify(item));
        return [key, item] as [string, T];
      });
      if (!order) {
        order = nextOrder;
        signatures = nextSignatures;
        return { __listRevision: revision, rows };
      }
      const upsert = rows.filter(([key]) => signatures.get(key) !== nextSignatures.get(key));
      const removed = order.filter((key) => !nextSignatures.has(key));
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
      signatures = nextSignatures;
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
      for (const entry of patch.upsert) {
        if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string") {
          return { ok: false };
        }
        nextRows.set(entry[0], entry[1]);
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
