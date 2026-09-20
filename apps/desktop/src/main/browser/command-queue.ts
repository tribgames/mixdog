/**
 * What may run at the same time. Gestures on one page serialize behind each
 * other, named background pages get their own queue so independent research
 * runs in parallel, and observations overlap freely — a write still waits for
 * the reads already in flight, so it never lands mid-observation.
 */
import type { BrowserCommand, BrowserCommandResult } from './command';
import { queueBarrier, trackQueueTail, waitForBarrier, type QueueLedger } from './command-queue-barrier';
import { commandQueueKey, normalizedAction, type QueueKeyHost } from './command-queue-key';
import { createLocalInputQueue } from './command-queue-local-input';
import { timeBrowserCommand } from './timing';
import { BROWSER_INPUT_EXPIRED } from '../../shared/browser-input-policy';

export interface BrowserCommandQueueHost extends QueueLedger, QueueKeyHost {
  run(command: BrowserCommand, signal?: AbortSignal): Promise<BrowserCommandResult>;
  /** The per-command ceiling, which also cancels the work it was waiting on. */
  bounded<T>(
    operation: Promise<T>,
    timeoutMs: number,
    label: string,
    signal?: AbortSignal,
    onTimeout?: () => void
  ): Promise<T>;
  readOnlyActions: ReadonlySet<string>;
  commandTimeoutMs: number;
}

export function createBrowserCommandQueue(host: BrowserCommandQueueHost) {
  /** Agent command controllers per queue key; a local takeover aborts them. */
  const agents = new Map<string, Set<AbortController>>();
  const {
    chains: commandChains,
    pendingReads,
    run: runCommand,
    bounded,
    readOnlyActions: READ_ONLY_ACTIONS,
    commandTimeoutMs: COMMAND_TIMEOUT_MS,
  } = host;
  const keyFor = (command: BrowserCommand): string => commandQueueKey(host, command);
  const local = createLocalInputQueue({ agents, keyFor, executeSerialized });

  function releaseAgent(key: string, controller: AbortController): void {
    const group = agents.get(key);
    group?.delete(controller);
    if (!group?.size) agents.delete(key);
  }

  function executeSerialized<T = BrowserCommandResult>(
    command: BrowserCommand,
    requestSignal?: AbortSignal,
    operation?: (signal: AbortSignal) => Promise<T>,
    maxWaitMs?: number
  ): Promise<T> {
    const enqueuedAt = performance.now();
    const key = keyFor(command);
    if (!operation) {
      const interrupted = local.takeoverError(key, enqueuedAt);
      if (interrupted) return Promise.reject(interrupted);
    }
    const readOnly = !operation && READ_ONLY_ACTIONS.has(normalizedAction(command));
    const reads = pendingReads.get(key);
    const barrier = queueBarrier(commandChains.get(key), reads, readOnly);
    const controller = new AbortController();
    if (!operation) {
      const group = agents.get(key) ?? new Set<AbortController>();
      group.add(controller);
      agents.set(key, group);
    }
    const signal = requestSignal ? AbortSignal.any([requestSignal, controller.signal]) : controller.signal;
    const waitTimer =
      maxWaitMs === undefined
        ? undefined
        : setTimeout(() => controller.abort(new Error(BROWSER_INPUT_EXPIRED)), maxWaitMs);
    const ready = waitForBarrier(barrier, signal).finally(() => {
      if (waitTimer !== undefined) clearTimeout(waitTimer);
    });
    let dispatched: Promise<unknown> | undefined;
    const run = ready.then(async () => {
      if (signal.aborted) throw signal.reason || new Error('browser command cancelled');
      const execute = <Result>(work: () => Promise<Result>) =>
        bounded(
          (dispatched = work()) as Promise<Result>,
          COMMAND_TIMEOUT_MS,
          `browser ${String(command.action || 'command')}`,
          signal,
          () => controller.abort(new Error(`browser command exceeded ${COMMAND_TIMEOUT_MS}ms`))
        );
      return operation
        ? execute(() => operation(signal))
        : (timeBrowserCommand(performance.now() - enqueuedAt, () =>
            execute(() => runCommand(command, signal))
          ) as Promise<T>);
    });
    // Cancellation releases the caller, not the actual operation. A local
    // takeover must outlast any dispatch that has not acknowledged abort.
    const tail = run
      .catch(() => undefined)
      .then(async () => {
        await dispatched?.catch(() => undefined);
        releaseAgent(key, controller);
      });
    trackQueueTail(host, key, readOnly, reads, barrier, tail);
    return run;
  }

  return {
    commandQueueKey: keyFor,
    executeSerialized,
    executeLocal: local.executeLocal,
    releaseLocal: local.releaseLocal,
    interruptForLocal: local.interruptForLocal,
    holdLocal: local.holdLocal,
  };
}
