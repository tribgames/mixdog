/** Wraps an "open this content" handler so the phone drawer (the existing
 *  closeSidebarForNavigation, a no-op above the narrow breakpoint) closes
 *  before the result opens. Without a close function the handler is unchanged. */
export function closingDrawerFirst<Args extends unknown[], Result>(
  close: (() => void) | undefined,
  open: (...args: Args) => Result
): (...args: Args) => Result {
  if (!close) return open;
  return (...args) => {
    close();
    return open(...args);
  };
}
