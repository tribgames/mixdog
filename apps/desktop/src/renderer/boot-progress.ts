import { useSyncExternalStore } from 'react';

import type { BootReportShape, CorePortBridge } from './core-direct/port-connector';
import { isRemoteHostRenderer } from './remote-ui-projection';

/** What the core does before it serves: the conversion of the earlier version's data, its conversation index rebuild, or the wait
 *  for the earlier version's daemon to close. */
export type BootStage = 'migration' | 'rebuild' | 'legacy';

/** What the core does at start, and how far it has come (0 of 0 while it names no counts). */
export interface BootProgress {
  stage: BootStage;
  done: number;
  total: number;
  /** The core process these counts are of: one boot's counts never decrease, and a new boot starts again. */
  boot: number | null;
}

/** The process a start is blocked on (main/core-port/boot-progress.ts `BootBlock`). */
export interface BootBlock {
  pid: number | null;
  image: string | null;
  commandLine: string | null;
  releasable: boolean;
  legacy: boolean;
  retireError: string | null;
  resolving: boolean;
  resolveError: string | null;
}

/** A start that ends the same way each time it is tried (the core process exits at boot for the same recorded reason), or one
 *  blocked on a process the person decides about. */
export interface BootFailure {
  message: string;
  exitCode: number | null;
  stderrPath: string | null;
  blocked: BootBlock | null;
}

export interface BootReport {
  progress: BootProgress | null;
  failure: BootFailure | null;
  /** An update replaces the core: the app is about to quit for its installer. */
  updating: boolean;
}

export interface BootReportStore {
  get(): BootReport;
  subscribe(listener: () => void): () => void;
}

const NOTHING: BootReport = { progress: null, failure: null, updating: false };
const STAGES: readonly BootStage[] = ['migration', 'rebuild', 'legacy'];

/** What the main process reports: a stage it names (a report of an older main names none: the rebuild), with its counts when it
 *  counts something. A rebuild without counts shows the mark alone. */
function counted(value: unknown): BootProgress | null {
  const { done, total, boot, stage } = (value ?? {}) as Partial<BootProgress>;
  const named = STAGES.includes(stage as BootStage) ? (stage as BootStage) : 'rebuild';
  const counts = Number.isInteger(done) && Number.isInteger(total) && (total as number) > 0;
  if (!counts && named === 'rebuild') return null;
  return {
    stage: named,
    done: counts ? Math.min(Math.max(done as number, 0), total as number) : 0,
    total: counts ? (total as number) : 0,
    boot: Number.isInteger(boot) ? (boot as number) : null,
  };
}

const text = (value: unknown): string | null => (typeof value === 'string' && value ? value : null);

function blockedOf(value: unknown): BootBlock | null {
  if (!value || typeof value !== 'object') return null;
  const held = value as Record<string, unknown>;
  return {
    pid: Number.isInteger(held.pid) ? (held.pid as number) : null,
    image: text(held.image),
    commandLine: text(held.commandLine),
    releasable: held.releasable === true,
    legacy: held.legacy === true,
    retireError: text(held.retireError),
    resolving: held.resolving === true,
    resolveError: text(held.resolveError),
  };
}

function failed(value: unknown): BootFailure | null {
  const { message, exitCode, stderrPath, blocked } = (value ?? {}) as Partial<BootFailure>;
  if (typeof message !== 'string' || message === '') return null;
  return {
    message,
    exitCode: typeof exitCode === 'number' ? exitCode : null,
    stderrPath: typeof stderrPath === 'string' ? stderrPath : null,
    blocked: blockedOf(blocked),
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
        // A stage the boot moved on to starts its counts again.
        progress = held && held.stage === next.stage && next.done < held.done ? held : next;
        highs.set(next.boot, progress);
        bootNow = next.boot;
      }
    }
    current = { progress, failure: failed(report?.failure), updating: report?.updating === true };
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

/** The start that cannot succeed (the core exits at boot the same way each time) or is blocked on a process, or null. */
export function useBootFailure(): BootFailure | null {
  return useBootReport().failure;
}

/** An update replaces the core and the app quits for its installer: the window that waits for its core is not failing. */
export function useBootUpdating(): boolean {
  return useBootReport().updating;
}
