import type { DesktopApi } from '../../shared/contract';

/** Initial read, event-triggered rereads, and a fallback if no event arrives.
 * Replaceable reads must check their signal before publishing. Give one slow
 * read a replacement, then let the latest read finish unless invalidated. */
export function startSettingsReadRecovery(
  read: (signal: AbortSignal) => void | Promise<unknown>,
  delay: number,
  immediate = true,
  replaceable = false
) {
  let stopped = false;
  let running: AbortController | undefined;
  // Aborting publication does not cancel every bridge's underlying request.
  const outstanding = new Set<AbortController>();
  let waitingForSlot = false;
  let connected = true;
  let again = false;
  let timer: number | undefined;
  let deadline: number | undefined;
  const schedule = () => {
    window.clearTimeout(timer);
    if (!stopped && connected) timer = window.setTimeout(refresh, delay);
  };
  function refresh(): void {
    if (stopped || !connected) return;
    window.clearTimeout(timer);
    if (running) {
      again = true;
      return;
    }
    start(false);
  }
  function abandon(): void {
    window.clearTimeout(deadline);
    running?.abort();
    running = undefined;
  }
  function invalidate(): void {
    window.clearTimeout(timer);
    abandon();
    again = false;
    waitingForSlot = false;
  }
  function start(retry: boolean): void {
    if (outstanding.size >= 2) {
      waitingForSlot = true;
      return;
    }
    waitingForSlot = false;
    const request = new AbortController();
    running = request;
    outstanding.add(request);
    if (replaceable && !retry) {
      deadline = window.setTimeout(() => {
        // With no free slot, abandoning this read would discard the only reply
        // that can publish without actually issuing a replacement.
        if (outstanding.size >= 2) return;
        abandon();
        again = false;
        start(true);
      }, delay);
    }
    void Promise.resolve()
      .then(() => (request.signal.aborted ? undefined : read(request.signal)))
      .catch(() => undefined)
      .finally(() => {
        outstanding.delete(request);
        if (running !== request) {
          if (waitingForSlot) refresh();
          return;
        }
        window.clearTimeout(deadline);
        running = undefined;
        if (again) {
          again = false;
          refresh();
        } else schedule();
      });
  }
  if (immediate) refresh();
  else schedule();
  return {
    refresh,
    replace() {
      if (stopped) return;
      abandon();
      again = false;
      refresh();
    },
    invalidate,
    setConnected(next: boolean) {
      if (stopped || connected === next) return;
      connected = next;
      if (next) refresh();
      else invalidate();
    },
    stop() {
      stopped = true;
      window.clearTimeout(timer);
      abandon();
    },
  };
}

/** A replaceable read that also follows the host connection and re-reads when the window regains focus.
 *  `replace` re-reads now; `stop` ends all three. */
export function watchSettingsRead(
  api: Partial<Pick<DesktopApi, 'sections'>> | undefined,
  read: (signal: AbortSignal) => void | Promise<unknown>,
  delay: number
) {
  const recovery = startSettingsReadRecovery(read, delay, true, true);
  const stopLink = followSettingsReadConnection(api, recovery);
  window.addEventListener('focus', recovery.replace);
  return {
    replace: recovery.replace,
    stop() {
      stopLink?.();
      recovery.stop();
      window.removeEventListener('focus', recovery.replace);
    },
  };
}

export function followSettingsReadConnection(
  api: Partial<Pick<DesktopApi, 'sections'>> | undefined,
  recovery: Pick<ReturnType<typeof startSettingsReadRecovery>, 'setConnected'>
): (() => void) | undefined {
  return api?.sections?.subscribe((push) => {
    if (push.kind === 'status') recovery.setConnected(push.status === 'ready');
  });
}
