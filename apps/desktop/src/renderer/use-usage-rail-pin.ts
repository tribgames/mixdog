import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { beginBootSurface, reportBootSurfaceReady } from "./boot-metrics";
import { usagePinEntries } from "./SidebarUsage";
import { usagePinStackFits } from "./rail-usage-pin-room";
import type { UsageDashboardSnapshot } from "./usage-dashboard-store";

const USAGE_RAIL_PIN_KEY = "mixdog.desktop.usage-rail-pin.v1";

/** Keep pin restoration and its measured first frame in one owner. */
export function useUsageRailPin(
  snapshot: UsageDashboardSnapshot,
  refs: {
    rail: RefObject<HTMLElement | null>;
    nav: RefObject<HTMLElement | null>;
    settings: RefObject<HTMLElement | null>;
  },
  enabled: boolean,
) {
  const [usagePinned, setUsagePinned] = useState(() => {
    try { return window.localStorage.getItem(USAGE_RAIL_PIN_KEY) === "1"; }
    catch { return false; }
  });
  const [settingsReady, setSettingsReady] = useState(false);
  const revision = useRef(0);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    const token = revision.current;
    void Promise.resolve().then(() => window.mixdogDesktop?.readSettings?.())
      .then((settings) => {
        if (!live || token !== revision.current || typeof settings?.usagePinned !== "boolean") return;
        setUsagePinned(settings.usagePinned);
        try {
          window.localStorage.setItem(USAGE_RAIL_PIN_KEY, settings.usagePinned ? "1" : "0");
        } catch { /* seed only */ }
      })
      .catch(() => { /* preserve the local seed */ })
      .finally(() => { if (live) setSettingsReady(true); });
    return () => { live = false; };
  }, [enabled]);

  const toggleUsagePin = () => {
    revision.current += 1;
    setSettingsReady(true);
    setUsagePinned((pinned) => {
      const next = !pinned;
      try { window.localStorage.setItem(USAGE_RAIL_PIN_KEY, next ? "1" : "0"); }
      catch { /* the toggle still applies for this session */ }
      void window.mixdogDesktop?.updateSetting?.("usagePinned", next)
        ?.catch(() => { /* local state still applies */ });
      return next;
    });
  };
  const wanted = usagePinned ? usagePinEntries(snapshot.dashboard) : [];
  const [pinRoom, setPinRoom] = useState(true);
  const { rail, nav, settings } = refs;
  useLayoutEffect(() => {
    const element = rail.current;
    if (!element || wanted.length === 0) return;
    const measure = () => setPinRoom(usagePinStackFits({
      railHeight: element.clientHeight,
      navHeight: nav.current?.scrollHeight ?? 0,
      settingsHeight: settings.current?.offsetHeight ?? 0,
      rowCount: wanted.length,
    }));
    // Measure before paint, not after a provisional tall stack was visible.
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [nav, rail, settings, wanted.length]);
  const loading = enabled && (!settingsReady || (usagePinned && wanted.length === 0
    && (snapshot.status === "idle" || snapshot.status === "loading")));
  if (enabled) beginBootSurface("usage-controls", "pin");
  useEffect(() => {
    if (enabled && !loading) reportBootSurfaceReady("usage-controls", "pin");
  }, [enabled, loading]);
  return { usagePinned, toggleUsagePin, loading, usagePinRows: pinRoom ? wanted : [] };
}
