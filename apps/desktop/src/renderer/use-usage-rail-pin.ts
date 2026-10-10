import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { beginBootSurface, reportBootSurfaceReady } from './boot-metrics';
import { usagePinStackFits } from './rail-usage-pin-room';
import type { UsageDashboardSnapshot } from './usage-dashboard-store';
import { subscribeSetupChanges } from './setup-change-refresh';

const USAGE_RAIL_PIN_KEY = 'mixdog.desktop.usage-rail-pin.v1';

type SidebarUsageModule = typeof import('./SidebarUsage');
type UsagePinEntries = SidebarUsageModule['usagePinEntries'];

// The usage flyout and the pin reader share one module that is off the first
// screen unless the rail is pinned; a pinned rail holds its boot surface until
// the reader arrives, so the stack never paints a provisional glyph first.
let sidebarUsageModule: Promise<SidebarUsageModule> | null = null;
let resolvedSidebarUsageModule: SidebarUsageModule | null = null;
export function loadSidebarUsageModule(): Promise<SidebarUsageModule> {
  sidebarUsageModule ||= import('./SidebarUsage').then(
    (module) => {
      resolvedSidebarUsageModule = module;
      return module;
    },
    (error) => {
      sidebarUsageModule = null;
      throw error;
    }
  );
  return sidebarUsageModule;
}
/** The module once it has arrived, so a warm open renders it synchronously. */
export function loadedSidebarUsageModule(): SidebarUsageModule | null {
  return resolvedSidebarUsageModule;
}
const NO_PIN_ENTRIES: UsagePinEntries = () => [];

/** Keep pin restoration and its measured first frame in one owner. */
export function useUsageRailPin(
  snapshot: UsageDashboardSnapshot,
  refs: {
    rail: RefObject<HTMLElement | null>;
    nav: RefObject<HTMLElement | null>;
    settings: RefObject<HTMLElement | null>;
  },
  enabled: boolean
) {
  // The config value (code default: pinned) is the single source; the retired
  // localStorage mirror is dropped once.
  const [usagePinned, setUsagePinned] = useState(() => {
    try {
      window.localStorage.removeItem(USAGE_RAIL_PIN_KEY);
    } catch {
      /* storage-less host */
    }
    return true;
  });
  const [settingsReady, setSettingsReady] = useState(false);
  const revision = useRef(0);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    const read = () => {
      const token = revision.current;
      void Promise.resolve()
        .then(() => window.mixdogDesktop?.readSettings?.())
        .then((settings) => {
          if (!live || token !== revision.current || typeof settings?.usagePinned !== 'boolean') return;
          setUsagePinned(settings.usagePinned);
        })
        .catch(() => {
          /* keep the code default */
        })
        .finally(() => {
          if (live) setSettingsReady(true);
        });
    };
    read();
    const unsubscribe = subscribeSetupChanges(read);
    return () => {
      live = false;
      unsubscribe();
    };
  }, [enabled]);

  // The latest pin value outside render, so the persistence side effects run
  // once per toggle instead of inside a (possibly re-invoked) state updater.
  const pinnedRef = useRef(usagePinned);
  pinnedRef.current = usagePinned;
  const toggleUsagePin = () => {
    revision.current += 1;
    const next = !pinnedRef.current;
    pinnedRef.current = next;
    setSettingsReady(true);
    setUsagePinned(next);
    void window.mixdogDesktop?.updateSetting?.('usagePinned', next)?.catch(() => {
      /* local state still applies */
    });
  };
  const [usagePinEntries, setUsagePinEntries] = useState<UsagePinEntries | null>(null);
  useEffect(() => {
    if (!usagePinned || usagePinEntries) return;
    let live = true;
    void loadSidebarUsageModule().then(
      (module) => {
        if (live) setUsagePinEntries(() => module.usagePinEntries);
      },
      () => {
        // An unavailable chunk leaves the plain glyph instead of a stuck gate.
        if (live) setUsagePinEntries(() => NO_PIN_ENTRIES);
      }
    );
    return () => {
      live = false;
    };
  }, [usagePinEntries, usagePinned]);
  const wanted = usagePinned && usagePinEntries ? usagePinEntries(snapshot.dashboard) : [];
  const [pinRoom, setPinRoom] = useState(true);
  const { rail, nav, settings } = refs;
  useLayoutEffect(() => {
    const element = rail.current;
    if (!element || wanted.length === 0) return;
    const measure = () =>
      setPinRoom(
        usagePinStackFits({
          railHeight: element.clientHeight,
          navHeight: nav.current?.scrollHeight ?? 0,
          settingsHeight: settings.current?.offsetHeight ?? 0,
          rowCount: wanted.length,
        })
      );
    // Measure before paint, not after a provisional tall stack was visible.
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [nav, rail, settings, wanted.length]);
  const loading =
    enabled &&
    (!settingsReady ||
      (usagePinned &&
        (!usagePinEntries || (wanted.length === 0 && (snapshot.status === 'idle' || snapshot.status === 'loading')))));
  if (enabled) beginBootSurface('usage-controls', 'pin');
  useEffect(() => {
    if (enabled && !loading) reportBootSurfaceReady('usage-controls', 'pin');
  }, [enabled, loading]);
  return { usagePinned, toggleUsagePin, loading, usagePinRows: pinRoom ? wanted : [] };
}
