// Android back-button (ABB) grammar for the projected phone surface: every
// transient layer (session drawer, tab overview, bottom panel, utility dock)
// pushes ONE history sentinel when it opens, so the hardware/gesture back
// closes the topmost layer instead of leaving the PWA (user: 백버튼 처리 —
// 지금은 그냥 닫히는데). With no layer open, back falls through to the
// browser default. Desktop/Electron surfaces never register: the helper
// no-ops unless the mobile-tabs marker is present.
import { useEffect, useRef } from "react";

type BackEntry = { close: () => void; armed: boolean };

const stack: BackEntry[] = [];
// Sentinel removals we caused ourselves (UI-side close → history.back());
// their popstate echoes must not close the next layer down.
let suppressedPops = 0;
let armed = false;

function armPendingEntries(): void {
  if (suppressedPops > 0) return;
  for (const entry of stack) {
    if (entry.armed) continue;
    entry.armed = true;
    history.pushState({ mixdogBack: stack.indexOf(entry) + 1 }, "");
  }
}

function onPopState(): void {
  if (suppressedPops > 0) {
    suppressedPops--;
    armPendingEntries();
    return;
  }
  // Hardware back: the entry leaves the stack FIRST so the owner's cleanup
  // (unregister) sees it gone and does not pop history a second time.
  const top = stack.pop();
  if (top) top.armed = false;
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
  const entry: BackEntry = { close, armed: false };
  stack.push(entry);
  // A self-close traversal is asynchronous. Pushing a new sentinel before its
  // popstate echo arrives would let that old history.back() consume the new
  // layer, so queue registrations until the echo has settled.
  armPendingEntries();
  return () => {
    const index = stack.indexOf(entry);
    if (index < 0) return; // already consumed by the back button
    stack.splice(index, 1);
    if (!entry.armed) return;
    entry.armed = false;
    // UI closed the layer itself: consume our sentinel quietly.
    suppressedPops++;
    history.back();
  };
}

/** Arms the sentinel for as long as `open` stays true.
 *
 *  Every transient layer in the renderer registers through this hook, so the
 *  registration order IS the visual stacking order and back always closes the
 *  topmost one. The close callback is read through a ref: a re-render must
 *  never re-push history, only the open transition may. */
export function useMobileBack(open: boolean, close: () => void): void {
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    if (!open) return undefined;
    return registerMobileBack(() => closeRef.current());
  }, [open]);
}
