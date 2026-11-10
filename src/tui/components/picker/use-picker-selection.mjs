/*
 * components/picker/use-picker-selection.mjs — selected-row / confirm-bar focus
 * state and its stability effects for Picker.
 */
import { useEffect, useRef, useState } from 'react';
import { clampItemIndex } from './picker-layout.mjs';

export function usePickerSelection({ items, initialIndex, onHighlight, confirmButtons, confirmBar }) {
  const [selectedIndex, setSelectedIndex] = useState(() => clampItemIndex(initialIndex, items.length));
  // -1 = list focus; 0..n-1 = confirm-bar button focus.
  const [confirmFocus, setConfirmFocus] = useState(-1);
  const lastTabAtRef = useRef(0);
  useEffect(() => {
    // Reset to list focus whenever the bar identity/shape changes (step switch).
    setConfirmFocus(-1);
  }, [confirmButtons.length, confirmBar]);

  // Selection stability across owner-driven reopens: command pickers
  // (settings/hooks/skills/channels toggles) rebuild their item list and call
  // repaint the surface on every ←/→ toggle. Follow the previously selected
  // item's `value` into the new list instead of snapping back to row 0.
  // (useState-backed ref: mutation must never trigger a re-render.)
  const [selectionMemo] = useState(() => ({ value: null, initialIndex }));
  useEffect(() => {
    const item = items[selectedIndex];
    if (item && item.value != null) selectionMemo.value = item.value;
  }, [items, selectedIndex, selectionMemo]);

  useEffect(() => {
    setSelectedIndex((i) => {
      if (selectionMemo.value != null) {
        const found = items.findIndex((entry) => entry && entry.value === selectionMemo.value);
        if (found >= 0) return found;
        // Previous selection no longer exists — this is a different picker
        // (or the row was removed). Start from the owner's initialIndex/top
        // instead of carrying a stale row number across picker transitions.
        selectionMemo.value = null;
        return clampItemIndex(initialIndex, items.length);
      }
      return Math.min(Math.max(0, i), Math.max(0, items.length - 1));
    });
  }, [items, selectionMemo, initialIndex]);

  useEffect(() => {
    // Explicit highlight target: honor initialIndex only when the owner
    // actually provides a *new* one. A reopen that drops initialIndex
    // (prop -> null default) must not reset the user's position to row 0.
    if (initialIndex == null) {
      selectionMemo.initialIndex = null;
      return;
    }
    if (selectionMemo.initialIndex === initialIndex) return;
    selectionMemo.initialIndex = initialIndex;
    setSelectedIndex(clampItemIndex(initialIndex, items.length));
  }, [initialIndex, items.length, selectionMemo]);

  // Live-preview hook: notify the owner whenever the highlighted row changes
  // (arrow keys, paging, initial mount). The /theme picker uses this to apply a
  // non-persisted palette preview as the selection moves. Kept side-effect-free
  // for pickers that do not pass onHighlight.
  useEffect(() => {
    if (typeof onHighlight !== 'function') return;
    const item = items[selectedIndex];
    if (item) onHighlight(item.value, item, selectedIndex);
  }, [onHighlight, items, selectedIndex]);
  return { selectedIndex, setSelectedIndex, confirmFocus, setConfirmFocus, lastTabAtRef };
}
