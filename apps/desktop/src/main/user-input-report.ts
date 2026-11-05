// The latest time the user operated this app: the keyboard, mouse buttons,
// wheel or mouse movement over the app's own window (webContents
// 'input-event'), reported to the core (`client/activity`, sent on input, no
// timer) so Mixy's heartbeat waits while the user is at the app. Nothing outside the
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

interface InputEventSource {
  on(event: 'input-event', listener: (event: unknown, input: { type?: string }) => void): unknown;
  off(event: 'input-event', listener: (event: unknown, input: { type?: string }) => void): unknown;
}

interface UserInputReporterOptions {
  /** Hands the input time to the core connection (`client/activity`), which sends it at most once a minute. */
  report: (at: number) => void;
  now?: () => number;
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
  /** Stop every watch. */
  stop(): void;
}

export function createUserInputReporter({ report, now = Date.now }: UserInputReporterOptions): UserInputReporter {
  let stopped = false;
  const unwatchers = new Set<() => void>();

  return {
    watch(source, ignore) {
      const onInput = (_event: unknown, input: { type?: string }): void => {
        if (stopped || !OPERATION_TYPES.has(String(input?.type)) || ignore?.()) return;
        report(now());
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
      stopped = true;
      for (const unwatch of [...unwatchers]) unwatch();
    },
  };
}
