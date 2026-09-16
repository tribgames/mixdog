import type { DesktopBrowserPageFrame } from '../../shared/contract';

/** Local pixels are not agent observations. They never reserve the gesture
 * queue, and late results cannot resurrect a released session. */
export function createBrowserPresentationReads(host: {
  capture(sessionId: string, signal: AbortSignal, texture?: boolean): Promise<DesktopBrowserPageFrame>;
  bounded<T>(
    work: Promise<T>,
    timeoutMs: number,
    label: string,
    signal: AbortSignal,
    onTimeout: () => void
  ): Promise<T>;
}) {
  const reads = new Map<
    string,
    { sessionId: string; controller: AbortController; work: Promise<DesktopBrowserPageFrame> }
  >();
  let disposed = false;
  function release(sessionId: string): void {
    for (const [key, read] of reads) {
      if (read.sessionId !== sessionId) continue;
      reads.delete(key);
      read.controller.abort(new Error('Browser page changed during capture.'));
    }
  }
  return {
    read(sessionId: string, previousId = '', texture = false): Promise<DesktopBrowserPageFrame> {
      if (disposed) return Promise.reject(new Error('Browser display is closed.'));
      const key = JSON.stringify([sessionId, texture]);
      let read = reads.get(key);
      if (!read) {
        const controller = new AbortController();
        const { signal } = controller;
        const work = host.bounded(
          host.capture(sessionId, signal, texture).then((frame) => {
            signal.throwIfAborted();
            return frame;
          }),
          2500,
          'Browser display frame',
          signal,
          () => controller.abort(new Error('Browser display frame timed out.'))
        );
        read = { sessionId, controller, work };
        reads.set(key, read);
        const entry = read;
        void work
          .finally(() => {
            if (reads.get(key) === entry) reads.delete(key);
          })
          .catch(() => {});
      }
      const { work, controller } = read;
      return work.then((frame) => {
        controller.signal.throwIfAborted();
        return previousId === frame.frameId ? { ...frame, image: undefined } : frame;
      });
    },
    release,
    dispose(): void {
      disposed = true;
      for (const read of reads.values()) release(read.sessionId);
    },
  };
}
