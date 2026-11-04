// Where a daemon call's time went, for its `[slow-op]` line. The daemon's
// span recorder (src/runtime/shared/slow-span.mjs) lives in the runtime, not in
// this bundle, so the desktop service is handed it once (setPhaseRecorder) and
// every read reports through here. Unset (the Electron main process, tests),
// nothing is recorded.
export interface PhaseRecorder {
  notePhase(name: string, ms: number): void;
  timePhase<T>(name: string, task: () => Promise<T>): Promise<T>;
}

let recorder: PhaseRecorder | null = null;

export function setPhaseRecorder(next: PhaseRecorder | null): void {
  recorder = next;
}

/** Adds `ms` to the calling operation's `name` cost. */
export function notePhase(name: string, ms: number): void {
  recorder?.notePhase(name, ms);
}

/** Runs `task`, adding its elapsed time to the calling operation's `name` cost. */
export function timePhase<T>(name: string, task: () => Promise<T>): Promise<T> {
  return recorder ? recorder.timePhase(name, task) : task();
}
