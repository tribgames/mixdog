// Adopting a deploy that landed while this app was already running.
//
// The service worker answers a navigation from the document it already had and
// refreshes it behind the paint (sw.js shellFirst). That document pins the
// content-hashed bundle of the deploy it came from, so the running app is the
// PREVIOUS build in full until something reloads it. The worker reports a
// document that genuinely changed; this decides WHEN to take it.
//
// A reload throws the DOM away, so it waits for a moment where that costs
// nothing: no turn in flight, nothing half-typed, and either an app that is
// off screen or a short pause in use.
import { useEffect, useRef } from "react";

export const SHELL_UPDATE_MESSAGE = "mixdog:shell-updated";

/** How long the app has to sit untouched before a reload interrupts a VISIBLE
 *  screen. Off screen there is nothing to interrupt. */
export const SHELL_RELOAD_IDLE_MS = 2000;

export interface ShellReloadState {
  /** A changed document is waiting to be adopted. */
  pending: boolean;
  /** A turn is running somewhere in the app. */
  busy: boolean;
  /** The app is not on screen. */
  hidden: boolean;
  /** Focus sits in an editor holding text that was never sent. */
  editing: boolean;
  /** Milliseconds since the last pointer or key event. */
  idleFor: number;
  idleThreshold?: number;
}

/** null: nothing to schedule — a later state change re-decides.
 *  0: reload now. Positive: re-decide after that many milliseconds. */
export function shellReloadDelay({
  pending,
  busy,
  hidden,
  editing,
  idleFor,
  idleThreshold = SHELL_RELOAD_IDLE_MS,
}: ShellReloadState): number | null {
  if (!pending) return null;
  // Both hold state the reload would discard, and both end on an event that
  // re-runs this decision, so neither needs a timer of its own.
  if (busy || editing) return null;
  if (hidden) return 0;
  if (idleFor >= idleThreshold) return 0;
  return idleThreshold - idleFor;
}

/** Unsent text, not merely focus: a phone leaves focus parked in the composer
 *  when the app goes to the background, and an empty composer loses nothing. */
function editingUnsentText(): boolean {
  const active = typeof document === "undefined" ? null : document.activeElement;
  if (!active) return false;
  if (active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement) {
    return active.value.trim().length > 0;
  }
  if (active instanceof HTMLElement && active.isContentEditable) {
    return (active.textContent ?? "").trim().length > 0;
  }
  return false;
}

export function useShellUpdateReload({ busy, reload }: {
  busy: boolean;
  /** Test seam; defaults to reloading this window. */
  reload?: () => void;
}): void {
  const pending = useRef(false);
  // Zero means "never touched since launch", which reads as fully idle: a
  // deploy found during boot applies before the user does anything.
  const lastInteraction = useRef(0);
  const reloadRef = useRef(reload);
  reloadRef.current = reload;

  useEffect(() => {
    // Electron has no worker, so nothing here ever fires there.
    if (typeof window === "undefined" || typeof navigator === "undefined") return undefined;
    if (!("serviceWorker" in navigator)) return undefined;
    let timer = 0;
    let settled = false;

    const decide = (): void => {
      if (settled) return;
      window.clearTimeout(timer);
      const delay = shellReloadDelay({
        pending: pending.current,
        busy,
        hidden: document.visibilityState === "hidden",
        editing: editingUnsentText(),
        idleFor: Date.now() - lastInteraction.current,
      });
      if (delay === null) return;
      if (delay === 0) {
        settled = true;
        (reloadRef.current ?? (() => { window.location.reload(); }))();
        return;
      }
      timer = window.setTimeout(decide, delay);
    };

    const onMessage = (event: MessageEvent): void => {
      const data = event.data as { type?: unknown } | null;
      if (!data || data.type !== SHELL_UPDATE_MESSAGE) return;
      pending.current = true;
      decide();
    };
    const onInteraction = (): void => {
      lastInteraction.current = Date.now();
      decide();
    };

    navigator.serviceWorker.addEventListener("message", onMessage);
    document.addEventListener("visibilitychange", decide);
    // Capture: a pause in use is a pause anywhere, including inside surfaces
    // that stop their own events from bubbling.
    window.addEventListener("pointerdown", onInteraction, true);
    window.addEventListener("keydown", onInteraction, true);
    // A busy turn that just ended, or a re-mount with an update already
    // pending, decides immediately rather than waiting for the next event.
    decide();
    return () => {
      settled = true;
      window.clearTimeout(timer);
      navigator.serviceWorker.removeEventListener("message", onMessage);
      document.removeEventListener("visibilitychange", decide);
      window.removeEventListener("pointerdown", onInteraction, true);
      window.removeEventListener("keydown", onInteraction, true);
    };
  }, [busy]);
}
