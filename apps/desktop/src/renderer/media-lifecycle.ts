import { useEffect, useState } from "react";

export function mediaPlaybackAllowed(
  active: boolean,
  visibilityState: DocumentVisibilityState,
  documentFocused: boolean,
): boolean {
  return active && visibilityState !== "hidden" && documentFocused;
}

function foregroundState(active: boolean): boolean {
  let focused = true;
  try {
    focused = typeof document.hasFocus !== "function" || document.hasFocus();
  } catch {
    // A host without focus introspection should not disable foreground media.
  }
  return mediaPlaybackAllowed(active, document.visibilityState, focused);
}

/**
 * Media decoders are useful only while their workspace surface and app window
 * are foregrounded. Releasing their source while Mixdog is behind a browser
 * prevents Electron from competing with that browser's video decoder/GPU.
 */
export function useForegroundMedia(active: boolean): boolean {
  const [allowed, setAllowed] = useState(() => foregroundState(active));
  useEffect(() => {
    const refresh = () => setAllowed(foregroundState(active));
    const suspend = () => setAllowed(false);
    refresh();
    window.addEventListener("focus", refresh);
    window.addEventListener("blur", suspend);
    window.addEventListener("pagehide", suspend);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.removeEventListener("focus", refresh);
      window.removeEventListener("blur", suspend);
      window.removeEventListener("pagehide", suspend);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [active]);
  return allowed;
}
