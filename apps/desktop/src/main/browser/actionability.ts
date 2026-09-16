/** Retry only read-only preflight failures, never an input or its verification. */
import { pause } from './settle';

export class BrowserActionabilityError extends Error {
  constructor(
    message: string,
    readonly reason: string
  ) {
    super(message);
    this.name = 'BrowserActionabilityError';
  }
}

export async function waitForBrowserActionable<T>(
  probe: () => Promise<T>,
  signal?: AbortSignal,
  timeoutMs = 5_000
): Promise<T> {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    signal?.throwIfAborted();
    try {
      const result = await probe();
      signal?.throwIfAborted();
      return result;
    } catch (error) {
      signal?.throwIfAborted();
      if (!(error instanceof BrowserActionabilityError)) throw error;
      const remaining = deadline - performance.now();
      if (remaining <= 0) throw error;
      await pause(Math.min(100, remaining), signal);
    }
  }
}
