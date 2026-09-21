/** Keep dialog keyboard focus local and restore the trigger on cleanup. */
export function watchBrowserDialogFocus(
  dialog: { current: HTMLElement | null },
  requestClose: () => void,
  selector: string,
  initialSelector = selector
): () => void {
  const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const focusFrame = window.requestAnimationFrame(() => {
    dialog.current?.querySelector<HTMLElement>(initialSelector)?.focus();
  });
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      requestClose();
      return;
    }
    if (event.key !== 'Tab' || !dialog.current) return;
    const focusable = [...dialog.current.querySelectorAll<HTMLElement>(selector)].filter(
      (element) => element.offsetParent !== null || element === document.activeElement
    );
    const first = focusable[0];
    const last = focusable.at(-1);
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };
  document.addEventListener('keydown', onKeyDown);
  return () => {
    window.cancelAnimationFrame(focusFrame);
    document.removeEventListener('keydown', onKeyDown);
    returnFocus?.focus();
  };
}
