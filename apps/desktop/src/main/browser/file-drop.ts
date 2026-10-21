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

/** The guard of an approved upload (upload == submit: the approval binds the
 *  receiving frame and target). Defence in depth only: the boundary is the
 *  browser-side hit test right before the drop (`ref-upload.ts`
 *  `assertDropLandsOn`). Being a page-world listener, it runs after any
 *  capture listener the page registered first. Installed in every frame, it
 *  refuses a drop except, in the approved frame, one whose path holds the
 *  target it was aimed at (`BROWSER_DROP_GUARD_AIM`), and reports whether the
 *  page took the files. An unhandled drop is neutralised as above. Taking it
 *  back reports `{ accepted, strayed }`. */
export const BROWSER_BOUND_DROP_GUARD_INSTALL = `(() => {
  globalThis.__mixdogDropGuard?.remove?.();
  const state = { accepted: false, landed: false, strayed: false, target: null };
  const over = (event) => { if (!event.defaultPrevented) event.preventDefault(); };
  const admit = (event) => {
    if (state.target && event.composedPath().includes(state.target)) {
      state.landed = true;
      return;
    }
    state.strayed = true;
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  const drop = (event) => {
    if (!state.landed) return;
    state.accepted = event.defaultPrevented === true;
    if (!event.defaultPrevented) event.preventDefault();
  };
  state.remove = () => {
    window.removeEventListener('dragover', over);
    window.removeEventListener('drop', admit, true);
    window.removeEventListener('drop', drop);
    delete globalThis.__mixdogDropGuard;
  };
  window.addEventListener('dragover', over);
  window.addEventListener('drop', admit, true);
  window.addEventListener('drop', drop);
  globalThis.__mixdogDropGuard = state;
  return true;
})()`;

/** Called on the approved target, in the world its frame's guard lives in. */
export const BROWSER_DROP_GUARD_AIM = `function() {
  const state = globalThis.__mixdogDropGuard;
  if (!state || !this.isConnected) return false;
  state.target = this;
  return true;
}`;

export const BROWSER_BOUND_DROP_GUARD_TAKE = `(() => {
  const state = globalThis.__mixdogDropGuard;
  if (!state) return { accepted: false, strayed: false };
  state.remove();
  return { accepted: state.accepted === true, strayed: state.strayed === true };
})()`;

/** Whether the page took the files, and the guard's own cleanup. */
export const BROWSER_DROP_GUARD_TAKE = `(() => {
  const state = globalThis.__mixdogDropGuard;
  if (!state) return false;
  state.remove();
  return state.accepted === true;
})()`;
