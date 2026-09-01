// Browser Use ships install-first, so every entry point to it — the rail
// launcher included — appears only once the feature is installed, matching the
// session tool surface. The settings panel announces marker changes, so an
// install lands live without polling.
import { useEffect, useState } from "react";

let cachedBrowserFeatureInstalled: boolean | null = null;

export async function readBrowserFeatureInstalled(): Promise<boolean | null> {
  try {
    const settings = await window.mixdogDesktop?.readSettings?.();
    cachedBrowserFeatureInstalled = settings?.browserInstalled !== false;
  } catch {
    // A failed read stays UNKNOWN (or keeps the last known value). Caching
    // it as false poisoned the whole app run: one boot-time IPC race — the
    // app and daemon restart together after a deploy — hid every Browser
    // Use entry point until the next restart (user: 브라우저 유즈 버튼 왜
    // 사라짐).
  }
  return cachedBrowserFeatureInstalled;
}

/** `null` while the marker is still unknown: callers hide the entry instead of
 *  painting one that disappears a frame later. A read that FAILS leaves the
 *  marker unknown, so this retries with backoff instead of letting one boot
 *  race hide an installed feature until the next restart. */
export function useBrowserFeatureInstalled(): boolean | null {
  const [installed, setInstalled] = useState<boolean | null>(
    () => cachedBrowserFeatureInstalled,
  );
  useEffect(() => {
    let live = true;
    let timer = 0;
    const refresh = (attempt = 0) => {
      void readBrowserFeatureInstalled().then((next) => {
        if (!live) return;
        setInstalled(next);
        if (next === null && attempt < 5) {
          timer = window.setTimeout(() => refresh(attempt + 1), (attempt + 1) * 1000);
        }
      });
    };
    refresh();
    // The listener wraps refresh so the Event object can never ride in as
    // the attempt counter.
    const onChange = () => refresh();
    window.addEventListener("mixdog:built-in-features-changed", onChange);
    return () => {
      live = false;
      window.clearTimeout(timer);
      window.removeEventListener("mixdog:built-in-features-changed", onChange);
    };
  }, []);
  return installed;
}
