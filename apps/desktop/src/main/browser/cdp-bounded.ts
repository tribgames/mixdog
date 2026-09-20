/** Race a promise against a timeout and the caller's cancellation. */
export async function bounded<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
  signal?: AbortSignal,
  onTimeout?: () => void
): Promise<T> {
  if (signal?.aborted) throw signal.reason || new Error(`${label} cancelled`);
  let timer: NodeJS.Timeout | null = null;
  let abortListener: (() => void) | null = null;
  try {
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        onTimeout?.();
        reject(new Error(`${label} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    });
    const cancellation = signal
      ? new Promise<never>((_resolve, reject) => {
          abortListener = () => reject(signal.reason || new Error(`${label} cancelled`));
          signal.addEventListener('abort', abortListener, { once: true });
        })
      : new Promise<never>(() => undefined);
    return await Promise.race([promise, timeout, cancellation]);
  } finally {
    if (timer) clearTimeout(timer);
    if (signal && abortListener) signal.removeEventListener('abort', abortListener);
  }
}
