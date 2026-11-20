import { useSyncExternalStore } from 'react';

import type { BootReportShape, CorePortBridge } from './core-direct/port-connector';
import { isRemoteHostRenderer } from './remote-ui-projection';

/** The sessions the core has read of how many while it rebuilds its conversation index at start. */
export interface BootProgress {
  done: number;
  total: number;
  /** The core process these counts are of: one boot's counts never decrease, and a new boot starts again. */
  boot: number | null;
}

/** A start that ends the same way each time it is tried: the core process exits at boot for the same recorded reason. */
export interface BootFailure {
  message: string;
  exitCode: number | null;
  stderrPath: string | null;
}

export interface BootReport {
  progress: BootProgress | null;
  failure: BootFailure | null;
}

export interface BootReportStore {
  get(): BootReport;
  subscribe(listener: () => void): () => void;
}

const NOTHING: BootReport = { progress: null, failure: null };

/** What the main process reports is taken only when it counts something: a report without counts shows the mark alone. */
function counted(value: unknown): BootProgress | null {
  const { done, total, boot } = (value ?? {}) as Partial<BootProgress>;
  if (!Number.isInteger(done) || !Number.isInteger(total) || (total as number) <= 0) return null;
  return {
    done: Math.min(Math.max(done as number, 0), total as number),
    total: total as number,
    boot: Number.isInteger(boot) ? (boot as number) : null,
  };
}

function failed(value: unknown): BootFailure | null {
  const { message, exitCode, stderrPath } = (value ?? {}) as Partial<BootFailure>;
  if (typeof message !== 'string' || message === '') return null;
  return {
    message,
    exitCode: typeof exitCode === 'number' ? exitCode : null,
    stderrPath: typeof stderrPath === 'string' ? stderrPath : null,
  };
}

/** What `bridge` reports (the window's port to its core), kept for the cover. A window without the bridge (a paired phone) has none. */
export function createBootReportStore(bridge: Pick<CorePortBridge, 'onBootReport'> | undefined): BootReportStore {
  let current = NOTHING;
  /** The most each core boot has come to: withdrawing the bar does not forget it, and a boot another has superseded is never current again. */
  const highs = new Map<number | null, BootProgress>();
  let bootNow: number | null | undefined;
  const listeners = new Set<() => void>();
  bridge?.onBootReport?.((report: BootReportShape) => {
    const next = counted(report?.progress);
    // The counts of one core boot never go back, whatever order the reports arrive in or whatever was withdrawn between; a new boot starts again.
    let progress: BootProgress | null = null;
    if (next) {
      const held = highs.get(next.boot);
      if (held && next.boot !== bootNow)
        progress = current.progress; // a superseded boot's late report changes nothing
      else {
        progress = held && next.done < held.done ? held : next;
        highs.set(next.boot, progress);
        bootNow = next.boot;
      }
    }
    current = { progress, failure: failed(report?.failure) };
    for (const listener of [...listeners]) listener();
  });
  return {
    get: () => current,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

let shared: BootReportStore | undefined;

function useBootReport(): BootReport {
  const remote = isRemoteHostRenderer();
  shared ??= createBootReportStore(
    typeof window === 'undefined' ? undefined : (window as { mixdogCorePort?: CorePortBridge }).mixdogCorePort
  );
  const store = shared;
  return useSyncExternalStore(
    store.subscribe,
    () => (remote ? NOTHING : store.get()),
    () => NOTHING
  );
}

/** How far the core's index rebuild has come, while one runs and the window waits for its core; null otherwise. Counts only decide
 *  whether a bar is drawn: they never end the wait. */
export function useBootProgress(): BootProgress | null {
  return useBootReport().progress;
}

/** The start that cannot succeed (the core exits at boot the same way each time), or null. */
export function useBootFailure(): BootFailure | null {
  return useBootReport().failure;
}
