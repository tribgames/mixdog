/*
 * components/picker/use-picker-input.mjs — Picker keyboard handling.
 */
import { useCallback } from 'react';
import { useInput } from 'ink';

export function usePickerInput({
  items,
  selectedIndex,
  setSelectedIndex,
  confirmFocus,
  setConfirmFocus,
  lastTabAtRef,
  onSelect,
  onCancel,
  onLeft,
  onRight,
  onTab,
  onKey,
  effectiveVisibleLimit,
  hasConfirm,
  confirmButtons,
  confirmBar,
}) {
  useInput(
    useCallback(
      (input, key) => {
        if (key.upArrow) {
          // Single vertical loop over [list items...] + [confirm buttons...].
          if (hasConfirm) {
            const last = items.length - 1;
            if (confirmFocus > 0) {
              setConfirmFocus((f) => f - 1);
              return;
            }
            if (confirmFocus === 0) {
              setConfirmFocus(-1);
              setSelectedIndex(Math.max(0, last));
              return;
            }
            // list focus: first row ↑ → last confirm button.
            if (items.length === 0 || selectedIndex === 0) {
              setConfirmFocus(confirmButtons.length - 1);
              return;
            }
            setSelectedIndex((i) => i - 1);
            return;
          }
          setSelectedIndex((i) => {
            const total = items.length;
            return total > 0 ? (i - 1 + total) % total : 0;
          });
          return;
        }
        if (key.downArrow) {
          if (hasConfirm) {
            const last = items.length - 1;
            const lastBtn = confirmButtons.length - 1;
            if (confirmFocus >= 0) {
              if (confirmFocus < lastBtn) {
                setConfirmFocus((f) => f + 1);
                return;
              }
              // last button ↓ → first list row.
              setConfirmFocus(-1);
              setSelectedIndex(0);
              return;
            }
            // list focus: last row ↓ → first confirm button.
            if (items.length === 0 || selectedIndex === last) {
              setConfirmFocus(0);
              return;
            }
            setSelectedIndex((i) => i + 1);
            return;
          }
          setSelectedIndex((i) => {
            const total = items.length;
            return total > 0 ? (i + 1) % total : 0;
          });
          return;
        }
        if (key.pageUp) {
          setSelectedIndex((i) => Math.max(0, i - effectiveVisibleLimit));
          return;
        }
        if (key.pageDown) {
          setSelectedIndex((i) => Math.min(items.length - 1, i + effectiveVisibleLimit));
          return;
        }
        if (key.home) {
          setSelectedIndex(0);
          return;
        }
        if (key.end) {
          setSelectedIndex(items.length - 1);
          return;
        }
        if (key.leftArrow) {
          if (hasConfirm) {
            setConfirmFocus((f) => (f <= 0 ? -1 : f - 1));
            return;
          }
          if (onLeft) onLeft(items[selectedIndex], selectedIndex);
          return;
        }
        if (key.rightArrow) {
          if (hasConfirm) {
            setConfirmFocus((f) => (f < 0 ? 0 : Math.min(confirmButtons.length - 1, f + 1)));
            return;
          }
          if (onRight) onRight(items[selectedIndex], selectedIndex);
          return;
        }
        if (key.tab || input === '\t') {
          const now = Date.now();
          if (now - lastTabAtRef.current < 120) return;
          lastTabAtRef.current = now;
          if (hasConfirm) {
            setConfirmFocus((f) => {
              if (f < 0) return 0;
              return f + 1 > confirmButtons.length - 1 ? -1 : f + 1;
            });
            return;
          }
          if (onTab) onTab(items[selectedIndex], selectedIndex);
          return;
        }
        if (key.return) {
          if (hasConfirm && confirmFocus >= 0) {
            const button = confirmButtons[confirmFocus];
            if (button && confirmBar?.onConfirm) confirmBar.onConfirm(button, confirmFocus);
            return;
          }
          const selected = items[selectedIndex];
          if (selected && onSelect) onSelect(selected.value, selected);
          return;
        }
        if (key.escape) {
          onCancel();
          return;
        }
        if (key.ctrl && (input === 'c' || input === 'C')) {
          return;
        }
        if (onKey) onKey(input, key, items[selectedIndex], selectedIndex);
      },
      [
        items,
        selectedIndex,
        onSelect,
        onCancel,
        onLeft,
        onRight,
        onTab,
        onKey,
        effectiveVisibleLimit,
        hasConfirm,
        confirmFocus,
        confirmButtons,
        confirmBar,
      ]
    )
  );
}
