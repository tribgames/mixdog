// A surface module kept off the first-screen bundle: a phone's cold open
// downloads, parses and evaluates only what that screen renders, and these
// chunks follow from the idle lane (or the first open). Once loaded, a module
// renders synchronously, so a surface opened after the warm-up never passes
// through a placeholder frame.
import { useEffect, useState, useSyncExternalStore } from 'react';
import { holdBootSurface, reportBootSurfaceReady } from './boot-metrics';

export interface DeferredModule<T> {
  /** The module once loaded, else null. */
  peek(): T | null;
  /** One shared import; a failed one clears itself so the next call retries. */
  load(): Promise<T>;
  subscribe(listener: () => void): () => void;
}

export function deferredModule<T>(importer: () => Promise<T>): DeferredModule<T> {
  let loaded: T | null = null;
  let pending: Promise<T> | null = null;
  const listeners = new Set<() => void>();
  return {
    peek: () => loaded,
    load() {
      if (loaded) return Promise.resolve(loaded);
      pending ??= importer().then(
        (module) => {
          loaded = module;
          for (const listener of [...listeners]) listener();
          return module;
        },
        (error: unknown) => {
          pending = null;
          throw error;
        }
      );
      return pending;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/** The deferred module for a mounted surface: null until it has loaded.
 *  `load: false` only follows a load started elsewhere (an open request, the
 *  warm-up lane). A boot surface name holds the cold-start cover while a
 *  surface mounted during boot is still loading, so the reveal never shows
 *  its placeholder; a failed import reaches the nearest error boundary. */
export function useDeferredModule<T>(
  module: DeferredModule<T>,
  options: { load?: boolean; bootSurface?: string } = {}
): T | null {
  const { load = true, bootSurface } = options;
  const loaded = useSyncExternalStore(module.subscribe, module.peek, module.peek);
  const [failure, setFailure] = useState<{ error: unknown } | null>(null);
  useEffect(() => {
    if (loaded || !load) return undefined;
    let active = true;
    const release = bootSurface ? holdBootSurface(bootSurface, 'module') : undefined;
    module.load().then(
      () => {
        if (bootSurface) reportBootSurfaceReady(bootSurface, 'module');
      },
      (error: unknown) => {
        release?.();
        if (active) setFailure({ error });
      }
    );
    return () => {
      active = false;
      // An unmount before the module arrived stops holding the cover; once it
      // has, the ready report above releases it at the content's paint.
      if (!module.peek()) release?.();
    };
  }, [bootSurface, load, loaded, module]);
  if (failure) throw failure.error;
  return loaded;
}
