/** Only explicit, pre-dispatch page-transition errors are recoverable.
 * Transport errors and uncertain input outcomes must never be replayed. */
export function browserPageTransition(error: unknown, phase: 'capture' | 'input'): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes(phase === 'capture'
    ? 'Browser page changed during capture.'
    : 'Browser page changed; input was not sent.');
}
