/** `window.localStorage`, or null where it is absent or access throws. */
export function safeLocalStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}
