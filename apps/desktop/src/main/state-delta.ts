// Identity-prefix items delta for remote state pushes: the same protocol the
// in-process IPC uses (ipc.ts sendEngineState). copySnapshot reuses the SAME
// clone object for an unchanged transcript item, so the shared prefix is
// found by reference and only appended/changed items cross the wire — a
// streaming push costs the new tokens, not the whole conversation.
export interface SnapshotDeltaEncoder {
  encode(snapshot: unknown): unknown;
  reset(): void;
}

export function createSnapshotDeltaEncoder(): SnapshotDeltaEncoder {
  let sentItems: readonly unknown[] | null = null;
  let revision = 0;
  return {
    reset(): void { sentItems = null; },
    encode(snapshot: unknown): unknown {
      const record = snapshot as Record<string, unknown> | null;
      const items = record && Array.isArray(record.items) ? record.items as unknown[] : null;
      if (!record || !items) {
        sentItems = null;
        return snapshot;
      }
      revision += 1;
      if (sentItems) {
        let prefix = 0;
        const shared = Math.min(sentItems.length, items.length);
        while (prefix < shared && sentItems[prefix] === items[prefix]) prefix += 1;
        const wire: Record<string, unknown> = { ...record };
        delete wire.items;
        wire.__itemsPatch = {
          base: revision - 1,
          revision,
          prefix,
          append: items.slice(prefix),
        };
        sentItems = items;
        return wire;
      }
      sentItems = items;
      return { ...record, __itemsRevision: revision };
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
