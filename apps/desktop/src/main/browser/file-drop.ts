/**
 * Dropping files on a page that never shows a file chooser. A drop nobody
 * handles is a browser navigation to that file, which would throw away the
 * page the caller was working on, so a guard answers at the end of the bubble
 * path: a page handler that already prevented the default keeps it, and an
 * unhandled drop is neutralised and reported as refused.
 */
export const BROWSER_DROP_GUARD_INSTALL = `(() => {
  globalThis.__mixdogDropGuard?.remove?.();
  const state = { accepted: false };
  const over = (event) => { if (!event.defaultPrevented) event.preventDefault(); };
  const drop = (event) => {
    state.accepted = event.defaultPrevented === true;
    if (!event.defaultPrevented) event.preventDefault();
  };
  state.remove = () => {
    window.removeEventListener('dragover', over);
    window.removeEventListener('drop', drop);
    delete globalThis.__mixdogDropGuard;
  };
  window.addEventListener('dragover', over);
  window.addEventListener('drop', drop);
  globalThis.__mixdogDropGuard = state;
  return true;
})()`;

/** Whether the page took the files, and the guard's own cleanup. */
export const BROWSER_DROP_GUARD_TAKE = `(() => {
  const state = globalThis.__mixdogDropGuard;
  if (!state) return false;
  state.remove();
  return state.accepted === true;
})()`;
