/**
 * abort-race.mjs — settle `work` or reject with 'aborted' the moment the
 * caller's signal fires, without leaving the abort listener behind.
 */
export function raceAbort(work, signal) {
  if (!signal) return work;
  let onAbort = null;
  const abortP = new Promise((_, reject) => {
    if (signal.aborted) {
      reject(new Error('aborted'));
      return;
    }
    onAbort = () => reject(new Error('aborted'));
    signal.addEventListener('abort', onAbort, { once: true });
  });
  const cleanup = () => {
    if (!onAbort) return;
    try {
      signal.removeEventListener('abort', onAbort);
    } catch {}
    onAbort = null;
  };
  return Promise.race([work, abortP]).then(
    (v) => {
      cleanup();
      return v;
    },
    (e) => {
      cleanup();
      throw e;
    }
  );
}
