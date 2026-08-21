export type MotionVisibilityState = "running" | "paused";

export function motionStateForVisibility(
  visibilityState: DocumentVisibilityState,
): MotionVisibilityState {
  return visibilityState === "visible" ? "running" : "paused";
}

// Mobile browsers do not consistently pair a background visibilitychange with
// another visibilitychange when a suspended page returns. pageshow and focus
// are independent foreground signals, so either can release the shared CSS
// animation pause before React has to repaint anything.
export function installMotionVisibility(): () => void {
  if (typeof document === "undefined" || typeof window === "undefined") return () => {};

  const sync = (): void => {
    document.documentElement.dataset.mixdogMotion =
      motionStateForVisibility(document.visibilityState);
  };

  sync();
  document.addEventListener("visibilitychange", sync);
  window.addEventListener("pageshow", sync);
  window.addEventListener("focus", sync);

  return () => {
    document.removeEventListener("visibilitychange", sync);
    window.removeEventListener("pageshow", sync);
    window.removeEventListener("focus", sync);
    delete document.documentElement.dataset.mixdogMotion;
  };
}
