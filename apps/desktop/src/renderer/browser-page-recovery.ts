/** Chromium's compositor reports a display sample it could not produce
 * (UnknownVizError, VizSentEmptyBitmap, ...). The next sample normally works,
 * so the pane retries these quietly and only shows one that persists. */
export function browserCaptureTransient(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\bUnknownVizError\b|\bViz\w*Error\b|\bVizSentEmptyBitmap\b/.test(message);
}

/** Only explicit, pre-dispatch page-transition errors are recoverable.
 * Transport errors and uncertain input outcomes must never be replayed. */
export function browserPageTransition(error: unknown, phase: 'capture' | 'input'): boolean {
  const message = error instanceof Error ? error.message : String(error);
  // The local pane and the paired phone report the same race in their own
  // words ("Browser page changed…" and "Remote Browser Use page changed…"),
  // and both mean the caller should sample again rather than show a failure.
  return message.includes(
    phase === 'capture' ? 'page changed during capture' : 'Browser page changed; input was not sent.'
  );
}
