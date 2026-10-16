// Android back-button (ABB) grammar for the projected phone surface: every
// transient layer (session drawer, tab overview, bottom panel, utility dock)
// claims the hardware/gesture back while it is open, so back closes the
// topmost layer instead of leaving the PWA (user: 백버튼 처리 — 지금은 그냥
// 닫히는데). With no layer open, back falls through to the browser default.
// Desktop/Electron surfaces never register: the helper no-ops unless the
// mobile-tabs marker is present.
//
// Browsers with CloseWatcher (Android Chrome) get one watcher per layer opened
// by a user gesture and history is never touched: a pushState/back pair on
// every open and close flashed the Android navigation bar white (user: 창을
// 열고 닫을 때 네비게이션 바가 잠시 흰색으로 반전). Browsers without it keep
// one history sentinel per layer.
//
// A CloseWatcher created WITHOUT transient user activation (a layer the app
// opens by itself, e.g. the agent's visualize panel) is not a back target of
// its own: Chrome joins it to the previous watcher's group, so one back
// closes both or the press falls through to leaving the page. Such layers use
// the history sentinel instead. Back always closes the newest layer, so the
// two mechanisms never coexist: the first activation-less layer converts the
// open watcher layers to sentinels, and watchers return once the stack drains.
import { useEffect, useRef } from 'react';
import { nativeAppInfo } from '../shared/native-app';

type CloseWatcherLike = { onclose: (() => void) | null; destroy(): void };
type CloseWatcherConstructor = new () => CloseWatcherLike;

type BackEntry = { close: () => void; armed: boolean; watcher: CloseWatcherLike | null };

const stack: BackEntry[] = [];
// Sentinel removals we caused ourselves (UI-side close → history.back());
// their popstate echoes must not close the next layer down.
let suppressedPops = 0;
let armed = false;

function armPendingEntries(): void {
  if (suppressedPops > 0) return;
  for (const entry of stack) {
    if (entry.armed || entry.watcher) continue;
    entry.armed = true;
    history.pushState({ mixdogBack: stack.indexOf(entry) + 1 }, '');
  }
}

function onPopState(): void {
  if (suppressedPops > 0) {
    suppressedPops--;
    armPendingEntries();
    return;
  }
  // Watcher layers answer to their own close event, never to history.
  if (stack[stack.length - 1]?.watcher) return;
  // Hardware back: the entry leaves the stack FIRST so the owner's cleanup
  // (unregister) sees it gone and does not pop history a second time.
  const top = stack.pop();
  if (top) top.armed = false;
  top?.close();
}

function mobileBackSurface(): boolean {
  return (
    typeof document !== 'undefined' &&
    document.documentElement.hasAttribute('data-mixdog-mobile-tabs') &&
    typeof history !== 'undefined'
  );
}

function closeWatcherConstructor(): CloseWatcherConstructor | null {
  // Inside the Mixdog phone app the Android WebView exposes CloseWatcher but
  // never routes the hardware back to it; the app's back handler pops the
  // history sentinels instead.
  if (nativeAppInfo()) return null;
  const ctor = (window as unknown as { CloseWatcher?: CloseWatcherConstructor }).CloseWatcher;
  return typeof ctor === 'function' ? ctor : null;
}

/** A CloseWatcher is a back target of its own only with transient user
 *  activation (the click that opened the layer is still fresh when the layer's
 *  effect runs). Browsers without the API cannot tell: assume activation. */
function hasTransientActivation(): boolean {
  const activation = (window.navigator as Navigator & { userActivation?: { isActive: boolean } }).userActivation;
  return activation ? activation.isActive : true;
}

/** The browser keeps the watcher stack, so the newest layer is closed first.
 *  A UI-side close destroys the watcher without firing its close event. */
function attachCloseWatcher(Watcher: CloseWatcherConstructor, entry: BackEntry): void {
  const watcher = new Watcher();
  entry.watcher = watcher;
  watcher.onclose = () => {
    if (entry.watcher !== watcher) return;
    entry.watcher = null;
    const index = stack.indexOf(entry);
    if (index >= 0) stack.splice(index, 1);
    entry.close();
  };
}

/** Register an open transient layer; returns its unregister cleanup. */
export function registerMobileBack(close: () => void): () => void {
  if (!mobileBackSurface()) return () => {};
  const Watcher = closeWatcherConstructor();
  const entry: BackEntry = { close, armed: false, watcher: null };
  // While a self-close traversal is outstanding the new layer stays
  // sentinel-backed: the echo arms it, and a watcher layer's cleanup would
  // otherwise leave that sentinel behind in history.
  if (Watcher && suppressedPops === 0 && stack.every((other) => other.watcher) && hasTransientActivation()) {
    stack.push(entry);
    attachCloseWatcher(Watcher, entry);
  } else {
    // Sentinel layer: older watcher layers below it become sentinels too, so
    // the newest layer is always the one back closes.
    for (const other of stack) {
      other.watcher?.destroy();
      other.watcher = null;
    }
    if (!armed) {
      armed = true;
      window.addEventListener('popstate', onPopState);
    }
    stack.push(entry);
    // A self-close traversal is asynchronous. Pushing a new sentinel before its
    // popstate echo arrives would let that old history.back() consume the new
    // layer, so queue registrations until the echo has settled.
    armPendingEntries();
  }
  return () => {
    const index = stack.indexOf(entry);
    if (index < 0) return; // already consumed by the back button
    stack.splice(index, 1);
    if (entry.watcher) {
      entry.watcher.destroy();
      entry.watcher = null;
      return;
    }
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
