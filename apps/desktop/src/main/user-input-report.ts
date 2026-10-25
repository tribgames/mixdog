// The latest time the user operated this app: the keyboard, mouse buttons,
// wheel or mouse movement over the app's own window (webContents
// 'input-event'), reported to the session runtime (capability noteUserInput)
// so Mixy's heartbeat waits while the user is at the app. Nothing outside the
// window counts, and no guess is made: a time is the clock at an input event.

/** Input event types that are a user operation (keyboard, mouse, wheel). */
const OPERATION_TYPES: ReadonlySet<string> = new Set([
  'keyDown',
  'keyUp',
  'rawKeyDown',
  'char',
  'mouseDown',
  'mouseUp',
  'mouseMove',
  'mouseWheel',
]);

/** How often a newer input time is reported: bounds the runtime's staleness,
 *  far below the heartbeat's 30 minute idle rule. */
const USER_INPUT_REPORT_MS = 60_000;

interface InputEventSource {
  on(event: 'input-event', listener: (event: unknown, input: { type?: string }) => void): unknown;
  off(event: 'input-event', listener: (event: unknown, input: { type?: string }) => void): unknown;
}

interface UserInputReporterOptions {
  /** Delivers the latest input time to the runtime. */
  report: (at: number) => Promise<unknown> | unknown;
  now?: () => number;
  setInterval?: (run: () => void, ms: number) => unknown;
  clearInterval?: (timer: unknown) => void;
  intervalMs?: number;
}

/** Whether Computer Use is executing a command against `window` right now:
 *  the coordinator's windows of sessions with an active command include it.
 *  Input events on it then belong to the agent, not the user. */
export function computerUseOperates(
  coordinator: { windowIdsWithActiveCommand(): string[] },
  windowForNativeId: (windowId: string) => unknown,
  window: unknown
): boolean {
  return coordinator.windowIdsWithActiveCommand().some((windowId) => windowForNativeId(windowId) === window);
}

export interface UserInputReporter {
  /** Count the input events of `source` (an app window's or page's
   *  webContents), except while `ignore()` says the agent is driving them;
   *  returns its unwatch. */
  watch(source: InputEventSource, ignore?: () => boolean): () => void;
  /** Report a pending time now, stop the timer and every watch. */
  stop(): void;
}

export function createUserInputReporter({
  report,
  now = Date.now,
  setInterval: schedule = (run, ms) => {
    const timer = setInterval(run, ms);
    timer.unref?.();
    return timer;
  },
  clearInterval: cancel = (timer) => clearInterval(timer as NodeJS.Timeout),
  intervalMs = USER_INPUT_REPORT_MS,
}: UserInputReporterOptions): UserInputReporter {
  let latest = 0;
  let reported = 0;
  let stopped = false;
  const unwatchers = new Set<() => void>();

  const flush = (): void => {
    if (latest <= reported) return;
    const at = latest;
    // Only a delivered time counts as reported; a failed one is sent again.
    void Promise.resolve()
      .then(() => report(at))
      .then(() => {
        reported = Math.max(reported, at);
      })
      .catch(() => {});
  };
  const timer = schedule(flush, intervalMs);

  return {
    watch(source, ignore) {
      const onInput = (_event: unknown, input: { type?: string }): void => {
        if (stopped || !OPERATION_TYPES.has(String(input?.type)) || ignore?.()) return;
        latest = now();
      };
      source.on('input-event', onInput);
      const unwatch = (): void => {
        source.off('input-event', onInput);
        unwatchers.delete(unwatch);
      };
      unwatchers.add(unwatch);
      return unwatch;
    },
    stop() {
      if (stopped) return;
      flush();
      stopped = true;
      cancel(timer);
      for (const unwatch of [...unwatchers]) unwatch();
    },
  };
}
