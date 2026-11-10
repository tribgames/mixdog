// A listener-leak warning (MaxListenersExceededWarning) is only actionable
// with its stack: Node prints the message alone, and the stack is what names
// the code that keeps adding listeners. Rendered as one bounded log line.

const STACK_MAX_CHARS = 4_000;

/** The log line for a listener-leak warning; null for every other warning. */
export function listenerLeakWarningLine(warning) {
  if (warning?.name !== 'MaxListenersExceededWarning') return null;
  const stack = String(warning.stack || warning.message || warning)
    .split('\n')
    .map((line) => line.trim())
    .join(' | ');
  return `listener leak warning: ${stack.slice(0, STACK_MAX_CHARS)}`;
}
