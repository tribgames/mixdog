import type { DesktopBrowserPageFrame } from '../../shared/contract';

/** Local pixels are not agent observations. They never reserve the gesture
 * queue, and late results cannot resurrect a released session. */
export function createBrowserPresentationReads(host: {
  capture(sessionId: string, signal: AbortSignal): Promise<DesktopBrowserPageFrame>;
  bounded<T>(work: Promise<T>, timeoutMs: number, label: string, signal: AbortSignal, onTimeout: () => void): Promise<T>;
}) {
  const reads = new Map<string, { controller: AbortController; work: Promise<DesktopBrowserPageFrame> }>();
  let disposed = false;
  function release(sessionId: string): void {
    const read = reads.get(sessionId);
    reads.delete(sessionId);
    read?.controller.abort(new Error('Browser page changed during capture.'));
  }
  return {
    read(sessionId: string, previousId = ''): Promise<DesktopBrowserPageFrame> {
      if (disposed) return Promise.reject(new Error('Browser display is closed.'));
      let read = reads.get(sessionId);
      if (!read) {
        const controller = new AbortController();
        const { signal } = controller;
        const work = host.bounded(
          host.capture(sessionId, signal).then(frame => { signal.throwIfAborted(); return frame; }),
          2500, 'Browser display frame', signal,
          () => controller.abort(new Error('Browser display frame timed out.')),
        );
        read = { controller, work };
        reads.set(sessionId, read);
        const entry = read;
        void work.finally(() => {
          if (reads.get(sessionId) === entry) reads.delete(sessionId);
        }).catch(() => {});
      }
      return read.work.then(frame =>
        previousId === frame.frameId ? { ...frame, image: undefined } : frame);
    },
    release,
    dispose(): void {
      disposed = true;
      for (const sessionId of reads.keys()) release(sessionId);
    },
  };
}
