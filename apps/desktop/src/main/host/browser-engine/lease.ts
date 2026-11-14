/**
 * The page lease and the person's input, for the browser engine lane. The
 * core claims a page for one agent command with `acquire` (the lease it gets
 * back is ended by `host/browser/lease/release`), and a person's input on the
 * page outranks it: the input aborts the agent calls running on the page
 * with -32012, keeps new ones out until the person has been quiet for a
 * moment, and is itself applied in the order it came, one input at a time.
 * `host/browser/userInput` tells the core when the person takes the page and
 * when they let go. Every lease ends with the connection.
 *
 * The same rules as the host-mode queue (browser/command-queue-local-input.ts)
 * with the page, not the session's queue key, as the unit.
 */
import { BROWSER_INPUT_EXPIRED, browserTypingInput } from '../../../shared/browser-input-policy';
import type { DesktopBrowserPageControl } from '../../../shared/contract';
import { COMMAND_TIMEOUT_MS } from '../../browser/command';
import { HOST_INVALID_PARAMS, type HostConnection, HostRpcError, objectParams } from '../connection';
import type { EngineContext } from './context';
import { ENGINE_ERROR, pageGone } from './errors';

export const LOCAL_INPUT_QUIET_MS = 1_000;
/** A pressed pointer the person never released stops holding the page after this long without input. */
export const POINTER_GESTURE_EXPIRY_MS = COMMAND_TIMEOUT_MS;
const LOCAL_INPUT_TAKEOVER =
  'Browser command interrupted by local user input. An earlier action may have completed; do not replay it. Wait until the user is idle, then observe the page again.';
/** A new `userInput` with a later `until` is sent only when it moved by this much. */
const UNTIL_REPUBLISH_MS = 250;

export type UserInputReason = 'pointer' | 'key' | 'dialog' | 'takeover' | 'filePicker';

export interface LocalInputOptions {
  takeover: boolean;
  dropIfBusy?: boolean;
  /** true: a pointer is down; false: it came up; absent: no change. */
  held?: boolean;
  maxWaitMs?: number;
  reason?: UserInputReason;
}

export interface Clock {
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}

const systemClock: Clock = {
  now: () => Date.now(),
  setTimer: (fn, ms) => {
    const handle = setTimeout(fn, ms);
    handle.unref?.();
    return handle;
  },
  clearTimer: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

/** What an engine handler holds while its call runs on a page. */
export interface EngineCall {
  /** Aborts when the core abandons the call, or when the person takes the page (with the -32012 error). */
  signal: AbortSignal;
  /** The call is over (it settled, whatever way). */
  end(): void;
}

export interface Leases {
  /** Claims `pageId` for the command; the person holding the page refuses it with -32012. */
  acquire(pageId: string, commandId: string, ttlMs: number): string;
  release(pageId: string, leaseId: string): void;
  /** The lease on the page now, if any. */
  leaseOn(pageId: string): string | undefined;
  /** An engine call starts on the page: refused with -32012 while the person holds it. */
  beginCall(pageId: string, signal?: AbortSignal): EngineCall;
  /** The person did something to the page: agent calls on it end, the core is told. */
  onUserInput(pageId: string, reason: UserInputReason): void;
  /** The person's input, applied in order after the earlier inputs and the aborted agent calls. */
  executeLocal<T>(
    pageId: string,
    operation: (signal: AbortSignal) => Promise<T>,
    options: LocalInputOptions
  ): Promise<T | undefined>;
  /** A native picker or prompt the person is answering: the page is held until the returned function is called. */
  hold(pageId: string, reason: UserInputReason): () => void;
  /** The page closed. */
  forget(pageId: string): void;
}

/** The `userInput` reason of a pane input. */
export function userInputReason(input: DesktopBrowserPageControl): UserInputReason {
  if (input.type === 'pointer') return 'pointer';
  if (browserTypingInput(input)) return 'key';
  if (input.type === 'answer-dialog') return 'dialog';
  if (input.type === 'choose-files') return 'filePicker';
  return 'takeover';
}

function takeoverError(until: number | undefined): HostRpcError {
  return new HostRpcError(ENGINE_ERROR.userInput, LOCAL_INPUT_TAKEOVER, until === undefined ? undefined : { until });
}

interface PageState {
  calls: Set<{ controller: AbortController; settled: Promise<void> }>;
  lease?: { id: string; timer: unknown };
  /** Local inputs running or waiting. */
  pending: number;
  holds: number;
  /** A pressed pointer holds the page until then. */
  gestureUntil: number;
  /** The quiet window ends then. */
  until: number;
  timer?: unknown;
  /** The last input's tail: the next input starts after it. */
  tail: Promise<unknown>;
  leases: number;
  published?: { held: boolean; until?: number };
  reason: UserInputReason;
}

export function createLeases(connection: HostConnection, ctx: EngineContext, clock: Clock = systemClock): Leases {
  const pages = new Map<string, PageState>();
  let closed = false;
  /** Rises with every `userInput` sent, for the connection's life: a page's state is dropped when idle, its order is not. */
  let seq = 0;

  const state = (pageId: string): PageState => {
    let page = pages.get(pageId);
    if (!page) {
      page = {
        calls: new Set(),
        pending: 0,
        holds: 0,
        gestureUntil: 0,
        until: 0,
        tail: Promise.resolve(),
        leases: 0,
        reason: 'takeover',
      };
      pages.set(pageId, page);
    }
    return page;
  };

  const holdsPage = (page: PageState): boolean => {
    const now = clock.now();
    return page.pending > 0 || page.holds > 0 || now < page.gestureUntil || now < page.until;
  };

  /** The end of the quiet window, absent while something other than time holds the page. */
  const quietEnd = (page: PageState): number | undefined =>
    page.pending > 0 || page.holds > 0 || clock.now() < page.gestureUntil ? undefined : page.until;

  const idle = (pageId: string, page: PageState): void => {
    if (pages.get(pageId) !== page) return;
    if (!page.lease && !page.calls.size && !page.pending && !page.holds && !page.published?.held && !page.timer) {
      pages.delete(pageId);
    }
  };

  function publish(pageId: string, page: PageState, held: boolean): void {
    const until = held ? quietEnd(page) : undefined;
    const last = page.published;
    if (last && last.held === held && (!held || (until ?? 0) - (last.until ?? 0) < UNTIL_REPUBLISH_MS)) return;
    page.published = { held, ...(until === undefined ? {} : { until }) };
    seq += 1;
    connection.notify('host/browser/userInput', {
      pageId,
      seq,
      held,
      ...(until === undefined ? {} : { until }),
      reason: page.reason,
    });
  }

  /** Lets go of the page when the person has been quiet, otherwise waits for the quiet again. */
  function schedule(pageId: string, page: PageState): void {
    if (page.timer !== undefined) clock.clearTimer(page.timer);
    const wait = Math.max(page.until, page.gestureUntil) - clock.now();
    page.timer = clock.setTimer(() => {
      page.timer = undefined;
      if (closed || pages.get(pageId) !== page) return;
      if (holdsPage(page)) return schedule(pageId, page);
      publish(pageId, page, false);
      idle(pageId, page);
    }, Math.max(wait, 1));
  }

  function dropLease(page: PageState): void {
    if (!page.lease) return;
    clock.clearTimer(page.lease.timer);
    page.lease = undefined;
  }

  /** The page is the person's from now for the quiet window; returns the agent calls this aborted. */
  function take(pageId: string, reason: UserInputReason, pointer?: boolean): Promise<unknown>[] {
    const page = state(pageId);
    const now = clock.now();
    page.reason = reason;
    page.until = now + LOCAL_INPUT_QUIET_MS;
    if (pointer === true) page.gestureUntil = now + POINTER_GESTURE_EXPIRY_MS;
    if (pointer === false) page.gestureUntil = 0;
    dropLease(page);
    const aborted: Promise<unknown>[] = [];
    for (const call of page.calls) {
      call.controller.abort(takeoverError(page.until));
      aborted.push(call.settled);
    }
    if (closed) return aborted;
    publish(pageId, page, true);
    schedule(pageId, page);
    return aborted;
  }

  /** An input ended: the quiet window restarts from now (after the connection closed, nothing is left to tell). */
  function settle(pageId: string, page: PageState): void {
    page.until = clock.now() + LOCAL_INPUT_QUIET_MS;
    if (closed) idle(pageId, page);
    else schedule(pageId, page);
  }

  const leases: Leases = {
    acquire(pageId, commandId, ttlMs) {
      if (!ctx.page(pageId)) throw pageGone(pageId);
      const page = state(pageId);
      if (holdsPage(page)) throw takeoverError(quietEnd(page));
      dropLease(page);
      page.leases += 1;
      const id = `lease-${pageId}-${page.leases}-${commandId}`;
      const timer = clock.setTimer(
        () => {
          if (page.lease?.id !== id) return;
          page.lease = undefined;
          idle(pageId, page);
        },
        Math.max(1, Math.floor(ttlMs))
      );
      page.lease = { id, timer };
      return id;
    },

    release(pageId, leaseId) {
      const page = pages.get(pageId);
      if (page?.lease?.id !== leaseId) return;
      dropLease(page);
      idle(pageId, page);
    },

    leaseOn: (pageId) => pages.get(pageId)?.lease?.id,

    beginCall(pageId, signal) {
      const page = state(pageId);
      if (holdsPage(page)) {
        idle(pageId, page);
        throw takeoverError(quietEnd(page));
      }
      const controller = new AbortController();
      let finish!: () => void;
      const settled = new Promise<void>((resolve) => (finish = resolve));
      const call = { controller, settled };
      page.calls.add(call);
      const onAbort = () => controller.abort(signal?.reason);
      if (signal?.aborted) onAbort();
      else signal?.addEventListener('abort', onAbort, { once: true });
      return {
        signal: controller.signal,
        end() {
          signal?.removeEventListener('abort', onAbort);
          page.calls.delete(call);
          finish();
          idle(pageId, page);
        },
      };
    },

    onUserInput(pageId, reason) {
      // Like the queue's interrupt: an input other than the pointer's own lets go of a pressed pointer.
      if (!closed) take(pageId, reason, false);
    },

    executeLocal(pageId, operation, options) {
      // The person's input is never refused: after the connection closed it still runs in order, unannounced.
      const page = state(pageId);
      // Hover is expendable and must not cancel automation or build a backlog.
      if (options.dropIfBusy && page.calls.size) return Promise.resolve(undefined);
      const aborted = options.takeover ? take(pageId, options.reason ?? 'pointer', options.held) : [];
      if (options.takeover) page.pending += 1;
      const controller = new AbortController();
      const waitTimer =
        options.maxWaitMs === undefined
          ? undefined
          : clock.setTimer(() => controller.abort(new Error(BROWSER_INPUT_EXPIRED)), options.maxWaitMs);
      // Rejects when the wait expires or the operation overruns, whichever stage it is in.
      const cancelled = new Promise<never>((_, reject) =>
        controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true })
      );
      cancelled.catch(() => undefined);
      let workDone: Promise<unknown> = Promise.resolve();
      const run = Promise.race([Promise.all([page.tail, ...aborted]), cancelled]).then(async () => {
        if (waitTimer !== undefined) clock.clearTimer(waitTimer);
        if (controller.signal.aborted) throw controller.signal.reason;
        const limit = clock.setTimer(
          () => controller.abort(new Error(`browser input exceeded ${COMMAND_TIMEOUT_MS}ms`)),
          COMMAND_TIMEOUT_MS
        );
        const work = operation(controller.signal);
        workDone = work.catch(() => undefined);
        try {
          return await Promise.race([work, cancelled]);
        } finally {
          clock.clearTimer(limit);
        }
      });
      // The next input starts after this one has really finished, not only after its caller was released.
      page.tail = run.catch(() => undefined).then(() => workDone);
      return run.finally(() => {
        if (waitTimer !== undefined) clock.clearTimer(waitTimer);
        if (!options.takeover) return;
        page.pending -= 1;
        if (options.held === false) page.gestureUntil = 0;
        settle(pageId, page);
      });
    },

    hold(pageId, reason) {
      take(pageId, reason, false);
      const page = state(pageId);
      page.holds += 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        page.holds -= 1;
        settle(pageId, page);
      };
    },

    forget(pageId) {
      const page = pages.get(pageId);
      if (!page) return;
      if (page.timer !== undefined) clock.clearTimer(page.timer);
      dropLease(page);
      pages.delete(pageId);
    },
  };

  connection.handleNotification('host/browser/lease/release', (params) => {
    const fields = objectParams(params, 'host/browser/lease/release');
    if (typeof fields.pageId !== 'string' || typeof fields.leaseId !== 'string') {
      throw new HostRpcError(HOST_INVALID_PARAMS, 'host/browser/lease/release needs a pageId and a leaseId.');
    }
    leases.release(fields.pageId, fields.leaseId);
  });

  // The connection ended: no one is left to be told, so nothing keeps a page claimed or a timer running.
  connection.onClose(() => {
    closed = true;
    for (const page of pages.values()) {
      if (page.timer !== undefined) clock.clearTimer(page.timer);
      dropLease(page);
      for (const call of page.calls) call.controller.abort(new Error('The host connection closed.'));
    }
    pages.clear();
  });

  return leases;
}
