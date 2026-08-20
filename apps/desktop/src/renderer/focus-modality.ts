// Focus rings are keyboard chrome. Chromium re-applies :focus-visible to
// whatever held focus when the window comes BACK — the composer "+" returning
// from a native file dialog, a trigger the app re-focuses when its menu
// closes — so a control pressed with the MOUSE kept wearing the ring long
// after its action finished (user: 동작 끝났는데 선택 프레임이 남는다).
// The root records the modality of the last interaction; 02-base.css drops
// button focus frames while that modality is the pointer. Text fields are
// deliberately untouched: a caret still needs its field outlined.
export type FocusModality = 'pointer' | 'keyboard';

const ROOT_ATTRIBUTE = 'data-mx-input';
// Boot quiet: nothing has been navigated by key yet, so focus restored during
// startup must not paint a ring nobody asked for.
let modality: FocusModality = 'pointer';

/** Keys that MOVE or ACT on focus. Typing prose into the composer is not a
 *  navigation signal, so plain characters leave the modality alone. */
const NAVIGATION_KEYS = new Set([
  'Tab', 'Enter', ' ', 'Escape',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'Home', 'End', 'PageUp', 'PageDown',
]);

function applyModality(next: FocusModality): void {
  modality = next;
  document.documentElement.setAttribute(ROOT_ATTRIBUTE, next);
}

export function focusModality(): FocusModality {
  return modality;
}

/** Installs the tracker and returns its uninstaller (bootstrap owns both). */
export function installFocusModality(): () => void {
  if (typeof document === 'undefined') return () => {};
  applyModality(modality);
  const onPointerDown = (): void => applyModality('pointer');
  const onKeyDown = (event: KeyboardEvent): void => {
    // A chord (Ctrl/Cmd/Alt) is a shortcut, not focus navigation.
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (!NAVIGATION_KEYS.has(event.key)) return;
    applyModality('keyboard');
  };
  // Capture phase: a surface that stops propagation must not hide the
  // interaction from the tracker.
  document.addEventListener('pointerdown', onPointerDown, true);
  document.addEventListener('keydown', onKeyDown, true);
  return () => {
    document.removeEventListener('pointerdown', onPointerDown, true);
    document.removeEventListener('keydown', onKeyDown, true);
    document.documentElement.removeAttribute(ROOT_ATTRIBUTE);
  };
}
