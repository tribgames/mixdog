/**
 * What may run at the same time. Gestures on one page serialize behind each
 * other, named background pages get their own queue so independent research
 * runs in parallel, and observations overlap freely — a write still waits for
 * the reads already in flight, so it never lands mid-observation.
 */
import type { BrowserCommand, BrowserCommandResult } from './command';
import { normalizeBackgroundTabName } from './tab-policy';
import { timeBrowserCommand } from './timing';
import { BROWSER_INPUT_EXPIRED } from '../../shared/browser-input-policy';

const LOCAL_INPUT_QUIET_MS = 1_000;
const LOCAL_INPUT_TAKEOVER = 'Browser command interrupted by local user input. An earlier action may have completed; do not replay it. Wait until the user is idle, then observe the page again.';

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
  const agents = new Map<string, Set<AbortController>>();
  const localInput = new Map<string, { pending: number; held: boolean; until: number }>();
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

  function executeSerialized<T = BrowserCommandResult>(
    command: BrowserCommand,
    requestSignal?: AbortSignal,
    operation?: (signal: AbortSignal) => Promise<T>,
    maxWaitMs?: number,
  ): Promise<T> {
    const enqueuedAt = performance.now();
    const key = commandQueueKey(command);
    const local = localInput.get(key);
    if (!operation && local) {
      if (local.pending || local.held || enqueuedAt < local.until) {
        return Promise.reject(new Error(LOCAL_INPUT_TAKEOVER));
      }
      localInput.delete(key);
    }
    const readOnly = !operation && READ_ONLY_ACTIONS.has(String(command.action || '').trim().toLowerCase());
    const previous = commandChains.get(key) || Promise.resolve();
    const reads = pendingReads.get(key);
    const barrier = readOnly || !reads?.size
      ? previous.catch(() => undefined)
      : Promise.allSettled([previous, ...reads]).then(() => undefined);
    const controller = new AbortController();
    if (!operation) {
      const group = agents.get(key) ?? new Set<AbortController>();
      group.add(controller);
      agents.set(key, group);
    }
    const signal = requestSignal
      ? AbortSignal.any([requestSignal, controller.signal])
      : controller.signal;
    const waitTimer = maxWaitMs === undefined ? undefined : setTimeout(
      () => controller.abort(new Error(BROWSER_INPUT_EXPIRED)), maxWaitMs,
    );
    const ready = waitForBarrier(barrier, signal).finally(() => {
      if (waitTimer !== undefined) clearTimeout(waitTimer);
    });
    let dispatched: Promise<unknown> | undefined;
    const run = ready.then(async () => {
      if (signal.aborted) throw signal.reason || new Error('browser command cancelled');
      const execute = <Result>(work: () => Promise<Result>) => bounded(
        (dispatched = work()) as Promise<Result>, COMMAND_TIMEOUT_MS, `browser ${String(command.action || 'command')}`, signal,
        () => controller.abort(new Error(`browser command exceeded ${COMMAND_TIMEOUT_MS}ms`)),
      );
      return operation ? execute(() => operation(signal)) : timeBrowserCommand(
        performance.now() - enqueuedAt,
        () => execute(() => runCommand(command, signal)),
      ) as Promise<T>;
    });
    // Cancellation releases the caller, not the actual operation. A local
    // takeover must outlast any dispatch that has not acknowledged abort.
    const tail = run.catch(() => undefined).then(async () => {
      await dispatched?.catch(() => undefined);
      const group = agents.get(key);
      group?.delete(controller);
      if (!group?.size) agents.delete(key);
    });
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

  function executeLocal<T>(
    command: BrowserCommand,
    operation: (signal: AbortSignal) => Promise<T>,
    options: { takeover: boolean; dropIfBusy?: boolean; held?: boolean; maxWaitMs?: number },
  ): Promise<T | undefined> {
    const key = commandQueueKey(command);
    const group = agents.get(key);
    // Hover is expendable and must not cancel automation or build a backlog.
    if (options.dropIfBusy && group?.size) return Promise.resolve(undefined);
    if (!options.takeover) return executeSerialized(command, undefined, operation, options.maxWaitMs);
    const local = localInput.get(key) ?? { pending: 0, held: false, until: 0 };
    local.pending += 1;
    local.until = performance.now() + LOCAL_INPUT_QUIET_MS;
    localInput.set(key, local);
    for (const agent of group ?? []) agent.abort(new Error(LOCAL_INPUT_TAKEOVER));
    return executeSerialized(command, undefined, operation, options.maxWaitMs).then(result => {
      if (options.held !== undefined) local.held = options.held;
      return result;
    }).finally(() => {
      if (options.held === false) local.held = false;
      local.pending -= 1;
      local.until = performance.now() + LOCAL_INPUT_QUIET_MS;
    });
  }

  function releaseLocal(command: BrowserCommand): void {
    localInput.delete(commandQueueKey(command));
  }

  function interruptForLocal(command: BrowserCommand): void {
    const key = commandQueueKey(command);
    const local = localInput.get(key) ?? { pending: 0, held: false, until: 0 };
    local.held = false;
    local.until = performance.now() + LOCAL_INPUT_QUIET_MS;
    localInput.set(key, local);
    for (const agent of agents.get(key) ?? []) agent.abort(new Error(LOCAL_INPUT_TAKEOVER));
  }

  function holdLocal(command: BrowserCommand): () => void {
    interruptForLocal(command);
    const local = localInput.get(commandQueueKey(command))!;
    local.pending += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      local.pending -= 1;
      local.until = performance.now() + LOCAL_INPUT_QUIET_MS;
    };
  }

  return { commandQueueKey, executeSerialized, executeLocal, releaseLocal, interruptForLocal, holdLocal };
}
