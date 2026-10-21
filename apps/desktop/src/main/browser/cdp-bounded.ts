import type { UserWaitClock } from './user-wait';

/** Race a promise against a timeout and the caller's cancellation. While
 *  `userWait` has a wait open (the person is being asked) the timeout stands
 *  still; it runs on with what was left when the last wait closes. */
export async function bounded<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
  signal?: AbortSignal,
  onTimeout?: () => void,
  userWait?: UserWaitClock
): Promise<T> {
  if (signal?.aborted) throw signal.reason || new Error(`${label} cancelled`);
  let timer: NodeJS.Timeout | null = null;
  let abortListener: (() => void) | null = null;
  const subscription: { stop: (() => void) | null } = { stop: null };
  try {
    const timeout = new Promise<never>((_resolve, reject) => {
      let remaining = timeoutMs;
      let armedAt = 0;
      const arm = () => {
        armedAt = Date.now();
        timer = setTimeout(() => {
          onTimeout?.();
          reject(new Error(`${label} timed out after ${timeoutMs}ms`));
        }, remaining);
      };
      const hold = () => {
        if (!timer) return;
        clearTimeout(timer);
        timer = null;
        remaining = Math.max(0, remaining - (Date.now() - armedAt));
      };
      subscription.stop = userWait?.subscribe((waiting) => (waiting ? hold() : arm())) ?? null;
      if (!userWait?.waiting) arm();
    });
    const cancellation = signal
      ? new Promise<never>((_resolve, reject) => {
          abortListener = () => reject(signal.reason || new Error(`${label} cancelled`));
          signal.addEventListener('abort', abortListener, { once: true });
        })
      : new Promise<never>(() => undefined);
    return await Promise.race([promise, timeout, cancellation]);
  } finally {
    subscription.stop?.();
    if (timer) clearTimeout(timer);
    if (signal && abortListener) signal.removeEventListener('abort', abortListener);
  }
}
