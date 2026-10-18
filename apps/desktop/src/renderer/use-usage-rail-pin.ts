import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { beginBootSurface, reportBootSurfaceReady } from './boot-metrics';
import { REMOTE_CONNECTION_READY_EVENT } from './remote-connection-state';
import { usagePinStackFits } from './rail-usage-pin-room';
import type { UsageDashboardSnapshot } from './usage-dashboard-store';
import {
  usagePinEntries,
  usagePinEntriesWithRoster,
  usagePinRoster,
  usagePinRosterFromSetup,
  type UsagePinRosterEntry,
  type UsageRailBars,
} from './usage-pin-entries';
import { readGlobalCapabilities } from './global-capability-reads';
import { subscribeSetupChanges } from './setup-change-refresh';

const USAGE_RAIL_PIN_KEY = 'mixdog.desktop.usage-rail-pin.v1';
const USAGE_RAIL_PREFS_KEY = 'mixdog.desktop.usage-rail-prefs.v2';

type RailPrefs = { pinned: boolean; bars: UsageRailBars };

function readRailPrefs(): RailPrefs {
  try {
    const stored = JSON.parse(window.localStorage.getItem(USAGE_RAIL_PREFS_KEY) || 'null');
    return {
      pinned: typeof stored?.pinned === 'boolean' ? stored.pinned : true,
      bars: stored?.bars === 'short-long' ? 'short-long' : 'long',
    };
  } catch {
    return { pinned: true, bars: 'long' };
  }
}

const USAGE_RAIL_ROSTER_KEY = 'mixdog.desktop.usage-rail-roster.v1';

/** The providers the rail last drew; null before the first live quota result. */
function readRailRoster(): UsagePinRosterEntry[] | null {
  try {
    const stored = JSON.parse(window.localStorage.getItem(USAGE_RAIL_ROSTER_KEY) || 'null');
    if (!Array.isArray(stored)) return null;
    return stored.flatMap((entry) =>
      typeof entry?.key === 'string' ? [{ key: entry.key, bars: entry.bars === 2 ? 2 : 1 }] : []
    );
  } catch {
    return null;
  }
}

function writeRailRoster(roster: UsagePinRosterEntry[]): void {
  try {
    window.localStorage.setItem(USAGE_RAIL_ROSTER_KEY, JSON.stringify(roster));
  } catch {
    /* storage-less host */
  }
}

function writeRailPrefs(prefs: RailPrefs): void {
  try {
    window.localStorage.setItem(USAGE_RAIL_PREFS_KEY, JSON.stringify(prefs));
  } catch {
    /* storage-less host */
  }
}

type SidebarUsageModule = typeof import('./SidebarUsage');

// The usage flyout body is off the first screen until opened or warmed; the
// rail's pinned stack no longer depends on it.
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
  // The last-known choice paints the first frame at its final geometry (a
  // different bar count or an unpinned rail would otherwise resize the stack
  // when the settings read lands); the settings read stays authoritative.
  const [initialPrefs] = useState(readRailPrefs);
  const [usagePinned, setUsagePinned] = useState(() => {
    try {
      window.localStorage.removeItem(USAGE_RAIL_PIN_KEY);
    } catch {
      /* storage-less host */
    }
    return initialPrefs.pinned;
  });
  const [railBars, setRailBarsState] = useState<UsageRailBars>(initialPrefs.bars);
  useEffect(() => writeRailPrefs({ pinned: usagePinned, bars: railBars }), [usagePinned, railBars]);
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
          if (!live || token !== revision.current) return;
          if (typeof settings?.usageRailShortLong === 'boolean') {
            setRailBarsState(settings.usageRailShortLong ? 'short-long' : 'long');
          }
          if (typeof settings?.usagePinned === 'boolean') setUsagePinned(settings.usagePinned);
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
    // Remote clients: a read made while the connection was down fails and
    // would keep the code default (pinned) over the user's real choice until
    // a reload.
    window.addEventListener(REMOTE_CONNECTION_READY_EVENT, read);
    return () => {
      live = false;
      unsubscribe();
      window.removeEventListener(REMOTE_CONNECTION_READY_EVENT, read);
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
  // The bar mode is persisted beside the pin choice and applies at once.
  const setRailBars = (next: UsageRailBars) => {
    revision.current += 1;
    setSettingsReady(true);
    setRailBarsState(next);
    void window.mixdogDesktop?.updateSetting?.('usageRailShortLong', next === 'short-long')?.catch(() => {
      /* local state still applies */
    });
  };
  // Computed from the cached snapshot in the first render: the stack's space is
  // reserved from the start, and live data only updates the figures.
  const real = usagePinned ? usagePinEntries(snapshot.dashboard, railBars) : [];
  // Which providers get a row is local knowledge, never the slow quota fetch:
  // the roster the rail last drew, else the connected accounts of the provider
  // setup (a quick local read). Rows without quota yet keep their final size.
  const [remembered, setRemembered] = useState(readRailRoster);
  const [setupRoster, setSetupRoster] = useState<UsagePinRosterEntry[] | null>(null);
  useEffect(() => {
    if (!enabled || remembered) return;
    let live = true;
    void readGlobalCapabilities(window.mixdogDesktop, [{ capability: 'getProviderSetup', args: [] }]).then(
      ([setup]) => {
        if (live) setSetupRoster(usagePinRosterFromSetup(setup));
      },
      () => {
        /* the quota result alone decides the rows */
      }
    );
    return () => {
      live = false;
    };
  }, [enabled, remembered]);
  const liveResult = snapshot.status === 'ready';
  const wanted = usagePinned
    ? usagePinEntriesWithRoster(real, liveResult ? [] : (remembered ?? setupRoster ?? []), railBars)
    : [];
  const drawnRoster = usagePinRoster(usagePinEntries(snapshot.dashboard, railBars));
  const drawnSignature = JSON.stringify(drawnRoster);
  // biome-ignore lint/correctness/useExhaustiveDependencies: drawnSignature is the stable form of drawnRoster
  useEffect(() => {
    if (!liveResult) return;
    writeRailRoster(drawnRoster);
    setRemembered(drawnRoster);
  }, [liveResult, drawnSignature]);
  const doubleBarCount = wanted.filter((entry) => entry.bars.length > 1).length;
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
          doubleBarCount,
        })
      );
    // Measure before paint, not after a provisional tall stack was visible.
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [nav, rail, settings, wanted.length, doubleBarCount]);
  const loading =
    enabled &&
    wanted.length === 0 &&
    (!settingsReady || (usagePinned && (snapshot.status === 'idle' || snapshot.status === 'loading')));
  if (enabled) beginBootSurface('usage-controls', 'pin');
  useEffect(() => {
    if (enabled && !loading) reportBootSurfaceReady('usage-controls', 'pin');
  }, [enabled, loading]);
  return { usagePinned, toggleUsagePin, railBars, setRailBars, loading, usagePinRows: pinRoom ? wanted : [] };
}
