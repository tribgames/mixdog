// Marks the next picker opened as "opened from Enter" (App then forces its row
// indexes visible). The mark is cleared by App when a picker consumes it, or by
// this timer when the action opens none.
const PICKER_OPENED_FROM_ENTER_TTL_MS = 3000;

/** Runs `action` with the latch armed and re-arms the expiry timer after it. */
export function withPickerEnterLatch(openedFromEnterRef, openedFromEnterTimerRef, action) {
  openedFromEnterRef.current = true;
  if (openedFromEnterTimerRef.current) {
    clearTimeout(openedFromEnterTimerRef.current);
    openedFromEnterTimerRef.current = null;
  }
  try {
    return action();
  } finally {
    openedFromEnterTimerRef.current = setTimeout(() => {
      openedFromEnterRef.current = false;
      openedFromEnterTimerRef.current = null;
    }, PICKER_OPENED_FROM_ENTER_TTL_MS);
  }
}
