/**
 * Coalesce refresh pressure into one active request and at most one follow-up.
 * Poll, focus and manual refresh can all arrive while Git is still answering;
 * they must not start overlapping requests that invalidate each other forever.
 */
export function createSingleFlightRefresh(refresh: () => Promise<void>): {
  request(): Promise<void>;
} {
  let pending = false;
  let current: Promise<void> | null = null;

  const drain = async () => {
    try {
      do {
        pending = false;
        await refresh();
      } while (pending);
    } finally {
      pending = false;
      current = null;
    }
  };

  return {
    request() {
      pending = true;
      current ||= drain();
      return current;
    },
  };
}
