//@@ BROWSER_DROP_GUARD_INSTALL
(() => {
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
})()
//@@ BROWSER_BOUND_DROP_GUARD_INSTALL
(() => {
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
})()
//@@ BROWSER_DROP_GUARD_AIM
function() {
  const state = globalThis.__mixdogDropGuard;
  if (!state || !this.isConnected) return false;
  state.target = this;
  return true;
}
//@@ BROWSER_BOUND_DROP_GUARD_TAKE
(() => {
  const state = globalThis.__mixdogDropGuard;
  if (!state) return { accepted: false, strayed: false };
  state.remove();
  return { accepted: state.accepted === true, strayed: state.strayed === true };
})()
//@@ BROWSER_DROP_GUARD_TAKE
(() => {
  const state = globalThis.__mixdogDropGuard;
  if (!state) return false;
  state.remove();
  return state.accepted === true;
})()
