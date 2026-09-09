/** Per-command diagnostics only. Parallel pages never share a collector;
 * phases may overlap, so their durations must not be added to commandMs. */
import { AsyncLocalStorage } from 'node:async_hooks';
import { performance } from 'node:perf_hooks';
import type { BrowserCommandResult } from './command';

type Phase = 'wait' | 'snapshot' | 'screenshot' | 'target' | 'actionability' | 'input';
const PHASES: Phase[] = ['wait', 'snapshot', 'screenshot', 'target', 'actionability', 'input'];
export interface BrowserStepTiming {
  index: number;
  commandMs: number;
  waitMs: number;
  snapshotMs: number;
  targetMs: number;
  actionabilityMs: number;
  inputMs: number;
}
export interface BrowserCommandTiming {
  queueMs: number;
  commandMs: number;
  waitMs: number;
  snapshotMs: number;
  screenshotMs: number;
  snapshots: number;
  screenshots: number;
  targetMs: number;
  actionabilityMs: number;
  inputMs: number;
  steps?: BrowserStepTiming[];
  mouseEvents?: Partial<Record<'mouseMoved' | 'mousePressed' | 'mouseReleased', { count: number; totalMs: number }>>;
}

interface Collector {
  timing: BrowserCommandTiming;
  active: Record<Phase, { depth: number; started: number }>;
  closed: boolean;
}
const current = new AsyncLocalStorage<Collector>();
const failures = new WeakMap<object, BrowserCommandTiming>();

export function browserFailureTiming(error: unknown): BrowserCommandTiming | undefined {
  return error !== null && (typeof error === 'object' || typeof error === 'function')
    ? failures.get(error) : undefined;
}

export async function measureBrowserMouseEvent<T>(
  type: 'mouseMoved' | 'mousePressed' | 'mouseReleased',
  operation: () => Promise<T>,
): Promise<T> {
  const collector = current.getStore();
  if (!collector || collector.closed) return operation();
  const started = performance.now();
  try {
    return await operation();
  } finally {
    if (!collector.closed) {
      const events = collector.timing.mouseEvents ??= {};
      const event = events[type] ??= { count: 0, totalMs: 0 };
      event.count++;
      event.totalMs += performance.now() - started;
    }
  }
}

export async function measureBrowserPhase<T>(phase: Phase, operation: () => Promise<T>): Promise<T> {
  const collector = current.getStore();
  if (!collector || collector.closed) return operation();
  const slot = collector.active[phase];
  if (slot.depth++ === 0) slot.started = performance.now();
  if (phase === 'snapshot') collector.timing.snapshots++;
  if (phase === 'screenshot') collector.timing.screenshots++;
  try {
    return await operation();
  } finally {
    if (--slot.depth === 0 && !collector.closed) {
      collector.timing[`${phase}Ms`] += performance.now() - slot.started;
    }
  }
}

export function timedBrowserOperation<Args extends unknown[], Result>(
  phase: Phase,
  operation: (...args: Args) => Promise<Result>,
): (...args: Args) => Promise<Result> {
  return (...args) => measureBrowserPhase(phase, () => operation(...args));
}

/** Sequence steps are sequential, so phase deltas belong to exactly one step. */
export async function measureBrowserStep<T>(index: number, operation: () => Promise<T>): Promise<T> {
  const collector = current.getStore();
  if (!collector || collector.closed) return operation();
  const before = { ...collector.timing };
  const started = performance.now();
  try {
    return await operation();
  } finally {
    if (!collector.closed && index >= 1 && index <= 6) {
      const steps = collector.timing.steps ??= [];
      if (steps.length < 6) steps.push({
        index,
        commandMs: performance.now() - started,
        waitMs: collector.timing.waitMs - before.waitMs,
        snapshotMs: collector.timing.snapshotMs - before.snapshotMs,
        targetMs: collector.timing.targetMs - before.targetMs,
        actionabilityMs: collector.timing.actionabilityMs - before.actionabilityMs,
        inputMs: collector.timing.inputMs - before.inputMs,
      });
    }
  }
}

export async function timeBrowserCommand(
  queueMs: number,
  operation: () => Promise<BrowserCommandResult>,
): Promise<BrowserCommandResult> {
  const collector: Collector = {
    timing: { queueMs, commandMs: 0, waitMs: 0, snapshotMs: 0, screenshotMs: 0, snapshots: 0, screenshots: 0,
      targetMs: 0, actionabilityMs: 0, inputMs: 0 },
    active: {
      wait: { depth: 0, started: 0 },
      snapshot: { depth: 0, started: 0 },
      screenshot: { depth: 0, started: 0 },
      target: { depth: 0, started: 0 },
      actionability: { depth: 0, started: 0 },
      input: { depth: 0, started: 0 },
    },
    closed: false,
  };
  const started = performance.now();
  return current.run(collector, async () => {
    try {
      const result = await operation();
      collector.timing.commandMs = performance.now() - started;
      return { ...result, timing: collector.timing };
    } catch (error) {
      if (error !== null && (typeof error === 'object' || typeof error === 'function')) {
        failures.set(error, collector.timing);
      }
      throw error;
    } finally {
      const finished = performance.now();
      collector.timing.commandMs = finished - started;
      for (const phase of PHASES) {
        const slot = collector.active[phase];
        if (slot.depth) collector.timing[`${phase}Ms`] += finished - slot.started;
      }
      collector.closed = true;
    }
  });
}
