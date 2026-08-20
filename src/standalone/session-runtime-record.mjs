/** Dispose one worker-owned runtime and release every projection even when the
 * runtime's own dispose hook fails. The parent drops its proxy after a dispose
 * response, so leaving the worker record behind would make it unreachable and
 * retain the transcript for the worker process lifetime. */
export async function disposeSessionRuntimeRecord(records, record, args = []) {
  if (!record || record.disposed) return undefined;
  record.disposed = true;
  try {
    return await record.runtime?.dispose?.(...args);
  } finally {
    try { record.unsubscribe?.(); } catch {}
    record.unsubscribe = null;
    record.source = null;
    record.projected = null;
    record.published = null;
    record.fields?.clear?.();
    record.items?.clear?.();
    records?.delete?.(record.id);
  }
}
