/** Bounded read-only fan-out. Readiness waits never occupy an I/O slot. */
export function createBrowserReadPool(limit = 4) {
  if (!Number.isInteger(limit) || limit < 1) throw new Error('Invalid browser read concurrency.');
  let active = 0;
  const waiting: Array<() => void> = [];
  return async <T>(read: () => Promise<T>): Promise<T> => {
    if (active >= limit) await new Promise<void>((resolve) => waiting.push(resolve));
    else active += 1;
    try {
      return await read();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active -= 1;
    }
  };
}

/** Drain siblings on failure so a following page mutation cannot overtake them. */
export async function settleBrowserReads<T>(reads: Promise<T>[]): Promise<T[]> {
  const results = await Promise.allSettled(reads);
  return results.map((result) => {
    if (result.status === 'rejected') throw result.reason;
    return result.value;
  });
}
