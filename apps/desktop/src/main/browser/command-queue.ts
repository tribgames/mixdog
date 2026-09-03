/**
 * What may run at the same time. Gestures on one page serialize behind each
 * other, named background pages get their own queue so independent research
 * runs in parallel, and observations overlap freely — a write still waits for
 * the reads already in flight, so it never lands mid-observation.
 */
import type { BrowserCommand, BrowserCommandResult } from './command';
import { normalizeBackgroundTabName } from './tab-policy';

export interface BrowserCommandQueueHost {
  /** One promise chain per queue key. */
  chains: Map<string, Promise<unknown>>;
  /** Reads in flight per queue key, which a write must outlast. */
  pendingReads: Map<string, Set<Promise<unknown>>>;
  sessionId?(command: BrowserCommand): string;
  backgroundEntryByPageId(sessionId: string, pageId: string): [string, unknown] | null;
  run(command: BrowserCommand, signal?: AbortSignal): Promise<BrowserCommandResult>;
  /** The per-command ceiling, which also cancels the work it was waiting on. */
  bounded<T>(
    operation: Promise<T>,
    timeoutMs: number,
    label: string,
    signal?: AbortSignal,
    onTimeout?: () => void,
  ): Promise<T>;
  readOnlyActions: ReadonlySet<string>;
  commandTimeoutMs: number;
}

export function createBrowserCommandQueue(host: BrowserCommandQueueHost) {
  const {
    chains: commandChains,
    pendingReads,
    sessionId,
    backgroundEntryByPageId,
    run: runCommand,
    bounded,
    readOnlyActions: READ_ONLY_ACTIONS,
    commandTimeoutMs: COMMAND_TIMEOUT_MS,
  } = host;
  function waitForBarrier(barrier: Promise<unknown>, signal: AbortSignal): Promise<void> {
    if (signal.aborted) {
      return Promise.reject(signal.reason || new Error('browser command cancelled'));
    }
    return new Promise<void>((resolve, reject) => {
      const abort = () => {
        signal.removeEventListener('abort', abort);
        reject(signal.reason || new Error('browser command cancelled'));
      };
      signal.addEventListener('abort', abort, { once: true });
      void barrier.then(() => {
        signal.removeEventListener('abort', abort);
        resolve();
      }, (error) => {
        signal.removeEventListener('abort', abort);
        reject(error);
      });
    });
  }

  function commandQueueKey(command: BrowserCommand): string {
    const owner = sessionId?.(command);
    const prefix = owner ? `session:${owner}:` : '';
    const action = String(command.action || '').trim().toLowerCase();
    if (action === 'list_tabs' || action === 'downloads') return `${prefix}metadata`;
    const tab = String(command.tab || '').trim();
    if (/^p\d+$/i.test(tab)) {
      const found = backgroundEntryByPageId(owner ?? '', tab);
      if (found) return `${prefix}background:${found[0]}`;
      return `${prefix}foreground`;
    }
    if (command.background === true) {
      return `${prefix}background:${normalizeBackgroundTabName(tab)}`;
    }
    if (tab && !/^v\d+$/i.test(tab) && !/^p\d+$/i.test(tab)) {
      return `${prefix}background:${normalizeBackgroundTabName(tab, { required: true })}`;
    }
    return `${prefix}foreground`;
  }

  function executeSerialized(
    command: BrowserCommand,
    requestSignal?: AbortSignal,
  ): Promise<BrowserCommandResult> {
    const key = commandQueueKey(command);
    const readOnly = READ_ONLY_ACTIONS.has(String(command.action || '').trim().toLowerCase());
    const previous = commandChains.get(key) || Promise.resolve();
    const reads = pendingReads.get(key);
    const barrier = readOnly || !reads?.size
      ? previous.catch(() => undefined)
      : Promise.allSettled([previous, ...reads]).then(() => undefined);
    const controller = new AbortController();
    const signal = requestSignal
      ? AbortSignal.any([requestSignal, controller.signal])
      : controller.signal;
    const run = waitForBarrier(barrier, signal).then(async () => {
      if (signal.aborted) throw signal.reason || new Error('browser command cancelled');
      return await bounded(
        runCommand(command, signal),
        COMMAND_TIMEOUT_MS,
        `browser ${String(command.action || 'command')}`,
        signal,
        () => controller.abort(new Error(`browser command exceeded ${COMMAND_TIMEOUT_MS}ms`)),
      );
    });
    const tail = run.catch(() => undefined);
    if (readOnly) {
      const group = reads || new Set<Promise<unknown>>();
      group.add(tail);
      pendingReads.set(key, group);
      void tail.then(() => {
        group.delete(tail);
        if (!group.size && pendingReads.get(key) === group) pendingReads.delete(key);
      });
    } else {
      // A caller may cancel while still behind an older mutation. Its own
      // response can reject immediately, but the queue key must continue to
      // represent that older mutation until the barrier actually settles.
      const queueTail = Promise.allSettled([barrier, tail]).then(() => undefined);
      commandChains.set(key, queueTail);
      void queueTail.then(() => {
        if (commandChains.get(key) === queueTail) commandChains.delete(key);
      });
    }
    return run;
  }

  return { commandQueueKey, executeSerialized };
}
