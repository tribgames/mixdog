export const STUDIO_THUMBNAIL_TIMEOUT_MS = 15_000;

/** Bound a hydration attempt and invalidate its late results on timeout/unmount. */
export async function runStudioThumbnailTask(
  task: (signal: AbortSignal) => Promise<void>,
  parent: AbortSignal,
  timeoutMs = STUDIO_THUMBNAIL_TIMEOUT_MS
): Promise<void> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: () => void = () => {};
  const interrupted = new Promise<never>((_, reject) => {
    abort = () => {
      controller.abort();
      reject(new Error('thumbnail hydration cancelled'));
    };
    parent.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error('thumbnail hydration timed out'));
    }, timeoutMs);
  });
  try {
    if (parent.aborted) abort();
    await Promise.race([interrupted, controller.signal.aborted ? Promise.resolve() : task(controller.signal)]);
  } finally {
    clearTimeout(timer);
    parent.removeEventListener('abort', abort);
  }
}
