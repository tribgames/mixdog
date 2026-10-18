const MAX_CONFIRM_TEXT = 100;

/** A command or path as one short line for a native dialog, which has no
 *  scrolling: a long value would push the buttons off-screen. */
export function confirmText(value: string, max = MAX_CONFIRM_TEXT): string {
  const line = value.replace(/\s+/g, ' ').trim();
  const chars = Array.from(line);
  return chars.length > max
    ? `${chars
        .slice(0, max - 1)
        .join('')
        .trimEnd()}…`
    : line;
}
