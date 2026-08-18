// Android back-button (ABB) grammar for the projected phone surface: every
// transient layer (session drawer, tab overview, bottom panel, utility dock)
// pushes ONE history sentinel when it opens, so the hardware/gesture back
// closes the topmost layer instead of leaving the PWA (user: 백버튼 처리 —
// 지금은 그냥 닫히는데). With no layer open, back falls through to the
// browser default. Desktop/Electron surfaces never register: the helper
// no-ops unless the mobile-tabs marker is present.
type BackEntry = { close: () => void };

const stack: BackEntry[] = [];
// Sentinel removals we caused ourselves (UI-side close → history.back());
// their popstate echoes must not close the next layer down.
let suppressedPops = 0;
let armed = false;

function onPopState(): void {
  if (suppressedPops > 0) {
    suppressedPops--;
    return;
  }
  // Hardware back: the entry leaves the stack FIRST so the owner's cleanup
  // (unregister) sees it gone and does not pop history a second time.
  const top = stack.pop();
  top?.close();
}

function mobileBackSurface(): boolean {
  return typeof document !== "undefined"
    && document.documentElement.hasAttribute("data-mixdog-mobile-tabs")
    && typeof history !== "undefined";
}

/** Register an open transient layer; returns its unregister cleanup. */
export function registerMobileBack(close: () => void): () => void {
  if (!mobileBackSurface()) return () => {};
  if (!armed) {
    armed = true;
    window.addEventListener("popstate", onPopState);
  }
  const entry: BackEntry = { close };
  stack.push(entry);
  history.pushState({ mixdogBack: stack.length }, "");
  return () => {
    const index = stack.indexOf(entry);
    if (index < 0) return; // already consumed by the back button
    stack.splice(index, 1);
    // UI closed the layer itself: consume our sentinel quietly.
    suppressedPops++;
    history.back();
  };
}
