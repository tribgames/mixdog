// Registry of the session runtimes this host owns, with the session-id →
// runtime lookup tool-completion delivery needs. A runtime leaves the registry
// when its dispose() settles.

export function createRuntimeRecords() {
  const records = new Map();
  const recordsBySessionId = new Map();
  let nextRuntimeId = 0;

  function forget(record) {
    if (!record || !records.delete(record.id)) return;
    for (const [sessionId, owner] of recordsBySessionId) {
      if (owner === record) recordsBySessionId.delete(sessionId);
    }
  }

  /** Register a freshly created runtime; its dispose() is wrapped so the
   *  record is forgotten once disposal settles. */
  function adopt(runtime, { hintedSessionId = '' } = {}) {
    const record = {
      id: `inline-${process.pid}-${++nextRuntimeId}`,
      runtime,
    };
    records.set(record.id, record);
    if (hintedSessionId) recordsBySessionId.set(hintedSessionId, record);

    const originalDispose = typeof runtime.dispose === 'function' ? runtime.dispose.bind(runtime) : null;
    runtime.dispose = async (...args) => {
      try {
        return await originalDispose?.(...args);
      } finally {
        forget(record);
      }
    };
    return runtime;
  }

  function ownerRuntime(sessionId) {
    const id = String(sessionId || '').trim();
    const known = recordsBySessionId.get(id);
    if (known) return known.runtime;
    for (const record of records.values()) {
      const current = String(record.runtime.getState?.()?.sessionId || record.runtime.id || '');
      if (!current || current !== id) continue;
      recordsBySessionId.set(id, record);
      return record.runtime;
    }
    return null;
  }

  async function disposeAll(reason) {
    const active = [...records.values()];
    await Promise.allSettled(active.map((record) => record.runtime.dispose?.(reason)));
    records.clear();
    recordsBySessionId.clear();
  }

  return {
    adopt,
    ownerRuntime,
    disposeAll,
    get size() {
      return records.size;
    },
  };
}
