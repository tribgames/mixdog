const REMOTE_TRANSCRIPT_DROP_FIELDS = ['thinkingBlocks', 'providerReplay'] as const;
const projectedTranscriptItems = new WeakMap<object, object>();

function remoteTranscriptItem(item: unknown): unknown {
  if (!item || typeof item !== 'object') return item;
  const cached = projectedTranscriptItems.get(item as object);
  if (cached) return cached;
  let projected: Record<string, unknown> | null = null;
  for (const field of REMOTE_TRANSCRIPT_DROP_FIELDS) {
    if (!Object.hasOwn(item, field)) continue;
    projected ??= { ...(item as Record<string, unknown>) };
    delete projected[field];
  }
  const result = projected ?? item;
  projectedTranscriptItems.set(item as object, result as object);
  return result;
}

/** Keep item identity and the host's full history page across both ordinary
 * deltas and recovery baselines; omit only provider-private replay material. */
export function remoteTranscriptSnapshot(snapshot: unknown): unknown {
  if (!snapshot || typeof snapshot !== 'object') return snapshot;
  const record = snapshot as Record<string, unknown>;
  if (!Array.isArray(record.items)) return snapshot;
  let dropped = false;
  const items = record.items.map((item) => {
    const projected = remoteTranscriptItem(item);
    if (projected !== item) dropped = true;
    return projected;
  });
  return dropped ? { ...record, items } : snapshot;
}
