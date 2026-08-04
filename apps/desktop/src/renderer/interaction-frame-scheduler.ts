export interface FrameCoordinator {
  schedule(key: object, work: () => void): void;
  flush(key: object): void;
  cancel(key: object): void;
  cancelAll(): void;
}

type FrameRequest = (callback: FrameRequestCallback) => number;
type FrameCancel = (handle: number) => void;

function defaultRequestFrame(callback: FrameRequestCallback): number {
  if (typeof globalThis.requestAnimationFrame === "function") {
    return globalThis.requestAnimationFrame(callback);
  }
  const browserWindow = (globalThis as {
    window?: { requestAnimationFrame?: FrameRequest };
  }).window;
  if (typeof browserWindow?.requestAnimationFrame === "function") {
    return browserWindow.requestAnimationFrame(callback);
  }
  return globalThis.setTimeout(
    () => callback(typeof performance === "undefined" ? Date.now() : performance.now()),
    16,
  ) as unknown as number;
}

function defaultCancelFrame(handle: number): void {
  if (typeof globalThis.cancelAnimationFrame === "function") {
    globalThis.cancelAnimationFrame(handle);
  } else if (typeof (globalThis as {
    window?: { cancelAnimationFrame?: FrameCancel };
  }).window?.cancelAnimationFrame === "function") {
    (globalThis as {
      window: { cancelAnimationFrame: FrameCancel };
    }).window.cancelAnimationFrame(handle);
  } else {
    globalThis.clearTimeout(handle);
  }
}

/** One shared animation-frame queue for layout reads/writes. A component key
 * owns at most one job per frame, while unrelated panes batch into the same
 * browser callback instead of each creating its own resize cascade. */
export function createFrameCoordinator({
  requestFrame = defaultRequestFrame,
  cancelFrame = defaultCancelFrame,
}: {
  requestFrame?: FrameRequest;
  cancelFrame?: FrameCancel;
} = {}): FrameCoordinator {
  const jobs = new Map<object, () => void>();
  let handle: number | null = null;
  const run = (timestamp: number): void => {
    void timestamp;
    handle = null;
    const pending = [...jobs.values()];
    jobs.clear();
    for (const work of pending) work();
  };
  const cancelHandleIfIdle = (): void => {
    if (handle === null || jobs.size > 0) return;
    cancelFrame(handle);
    handle = null;
  };
  return {
    schedule(key, work) {
      jobs.set(key, work);
      if (handle === null) handle = requestFrame(run);
    },
    flush(key) {
      const work = jobs.get(key);
      if (!work) return;
      jobs.delete(key);
      cancelHandleIfIdle();
      work();
    },
    cancel(key) {
      jobs.delete(key);
      cancelHandleIfIdle();
    },
    cancelAll() {
      jobs.clear();
      if (handle !== null) cancelFrame(handle);
      handle = null;
    },
  };
}

export const layoutFrameCoordinator = createFrameCoordinator();
export const scheduleLayoutFrame = (key: object, work: () => void): void =>
  layoutFrameCoordinator.schedule(key, work);
export const flushLayoutFrame = (key: object): void =>
  layoutFrameCoordinator.flush(key);
export const cancelLayoutFrame = (key: object): void =>
  layoutFrameCoordinator.cancel(key);
