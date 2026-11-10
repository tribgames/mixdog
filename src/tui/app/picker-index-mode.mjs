/*
 * app/picker-index-mode.mjs — index-mode carry-over applied to every picker
 * state update (runs inside the React state updater in App.jsx).
 */

// `resolved` is the picker state about to be committed, `prev` the one on
// screen. Consumes the Enter-open flag (and its timer) when a picker opens.
export function resolvePickerState(prev, resolved, { pickerOpenedFromEnterRef, pickerOpenedFromEnterTimerRef }) {
  if (resolved && typeof resolved === 'object' && pickerOpenedFromEnterRef.current) {
    pickerOpenedFromEnterRef.current = false;
    if (pickerOpenedFromEnterTimerRef.current) {
      clearTimeout(pickerOpenedFromEnterTimerRef.current);
      pickerOpenedFromEnterTimerRef.current = null;
    }
    return resolved.indexMode ? resolved : { ...resolved, indexMode: 'always' };
  }
  // Same-kind reopen (toggle-driven rebuilds like the MCP ←/→ flip):
  // carry the previous picker's indexMode so an 'always' injected at
  // Enter-open time survives the rebuild instead of falling back to
  // 'auto' and hiding the row indexes.
  if (
    resolved &&
    typeof resolved === 'object' &&
    !resolved.indexMode &&
    prev &&
    typeof prev === 'object' &&
    prev.indexMode &&
    prev._kind &&
    prev._kind === resolved._kind
  ) {
    return { ...resolved, indexMode: prev.indexMode };
  }
  return resolved;
}
