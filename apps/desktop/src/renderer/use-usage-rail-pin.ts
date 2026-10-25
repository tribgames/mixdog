import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { beginBootSurface, reportBootSurfaceReady } from './boot-metrics';
import { REMOTE_CONNECTION_READY_EVENT } from './remote-connection-state';
import { usagePinVisibleCount } from './rail-usage-pin-room';
import { useUsageAccountPools } from './usage-account-pools';
import type { UsageApi, UsageDashboardSnapshot } from './usage-dashboard-store';
import {
  usagePinAccountEntries,
  usagePinEntries,
  usagePinEntriesWithRoster,
  usagePinRoster,
  usagePinRosterFromSetup,
  type UsagePinRosterEntry,
  type UsageRailBars,
  type UsageRailSlots,
} from './usage-pin-entries';
import { readGlobalCapabilities } from './global-capability-reads';
import { subscribeSetupChanges } from './setup-change-refresh';

const USAGE_RAIL_PIN_KEY = 'mixdog.desktop.usage-rail-pin.v1';
const USAGE_RAIL_PREFS_KEY = 'mixdog.desktop.usage-rail-prefs.v2';

// A stable empty list, so memoized rows do not change identity while unpinned.
const NO_ENTRIES: ReturnType<typeof usagePinEntries> = [];

type RailPrefs = { pinned: boolean; bars: UsageRailBars; expanded: boolean; slots: UsageRailSlots };

export function readRailPrefs(): RailPrefs {
  try {
    const stored = JSON.parse(window.localStorage.getItem(USAGE_RAIL_PREFS_KEY) || 'null');
    return {
      pinned: typeof stored?.pinned === 'boolean' ? stored.pinned : true,
      bars: stored?.bars === 'long' ? 'long' : 'short-long',
      expanded: stored?.expanded === true,
      slots: stored?.slots === '3' || stored?.slots === 'all' ? stored.slots : '5',
    };
  } catch {
    return { pinned: true, bars: 'short-long', expanded: false, slots: '5' };
  }
}

const USAGE_RAIL_ROSTER_KEY = 'mixdog.desktop.usage-rail-roster.v1';

/** The providers the rail last drew; null before the first live quota result. */
function readRailRoster(): UsagePinRosterEntry[] | null {
  try {
    const stored = JSON.parse(window.localStorage.getItem(USAGE_RAIL_ROSTER_KEY) || 'null');
    if (!Array.isArray(stored)) return null;
    return stored
      .filter((entry) => typeof entry?.key === 'string')
      .map((entry): UsagePinRosterEntry => ({ key: entry.key, bars: entry.bars === 2 ? 2 : 1 }));
  } catch {
    return null;
  }
}

function railSlotsOf(settings: { usageRailSlotsAll?: unknown; usageRailSlotsThree?: unknown }) {
  if (settings.usageRailSlotsAll) return 'all';
  return settings.usageRailSlotsThree ? '3' : '5';
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
  enabled: boolean,
  /** Height of rail cells below the destinations besides Settings (the update slot). */
  extraHeight = 0,
  api?: UsageApi
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
  const [accountsExpanded, setAccountsExpandedState] = useState(initialPrefs.expanded);
  const [railSlots, setRailSlotsState] = useState<UsageRailSlots>(initialPrefs.slots);
  useEffect(
    () => writeRailPrefs({ pinned: usagePinned, bars: railBars, expanded: accountsExpanded, slots: railSlots }),
    [usagePinned, railBars, accountsExpanded, railSlots]
  );
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
          if (typeof settings?.usageAccountsExpanded === 'boolean') {
            setAccountsExpandedState(settings.usageAccountsExpanded);
          }
          if (typeof settings?.usageRailSlotsAll === 'boolean' || typeof settings?.usageRailSlotsThree === 'boolean') {
            setRailSlotsState(railSlotsOf(settings));
          }
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
  const setAccountsExpanded = (next: boolean) => {
    revision.current += 1;
    setSettingsReady(true);
    setAccountsExpandedState(next);
    void window.mixdogDesktop?.updateSetting?.('usageAccountsExpanded', next)?.catch(() => {
      /* local state still applies */
    });
  };
  // Stored as two flags: 3 and All; neither means the default 5.
  const setRailSlots = (next: UsageRailSlots) => {
    revision.current += 1;
    setSettingsReady(true);
    setRailSlotsState(next);
    for (const [key, value] of [
      ['usageRailSlotsThree', next === '3'],
      ['usageRailSlotsAll', next === 'all'],
    ] as const) {
      void window.mixdogDesktop?.updateSetting?.(key, value)?.catch(() => {
        /* local state still applies */
      });
    }
  };
  // Computed from the cached snapshot in the first render: the stack's space is
  // reserved from the start, and live data only updates the figures.
  // Entries, windows and tooltips are rebuilt only when their inputs change,
  // not on every render (each scroll step re-renders).
  const dashboardEntries = useMemo(() => usagePinEntries(snapshot.dashboard, railBars), [snapshot.dashboard, railBars]);
  const real = usagePinned ? dashboardEntries : NO_ENTRIES;
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
  const providerRows = useMemo(() => {
    if (!usagePinned) return NO_ENTRIES;
    return usagePinEntriesWithRoster(real, liveResult ? [] : (remembered ?? setupRoster ?? []), railBars);
  }, [usagePinned, real, liveResult, remembered, setupRoster, railBars]);
  const expanding = usagePinned && accountsExpanded;
  const accountPools = useUsageAccountPools(
    api,
    providerRows.filter((entry) => !entry.pending).map((entry) => entry.provider),
    expanding
  );
  const wanted = useMemo(
    () => (expanding ? usagePinAccountEntries(providerRows, accountPools, railBars) : providerRows),
    [expanding, providerRows, accountPools, railBars]
  );
  // The slot limit only applies once accounts got slots of their own.
  const slotLimit =
    wanted.some((entry) => entry.accountIndex !== undefined) && railSlots !== 'all'
      ? Number(railSlots)
      : Number.POSITIVE_INFINITY;
  const drawnRoster = useMemo(() => usagePinRoster(dashboardEntries), [dashboardEntries]);
  const drawnSignature = JSON.stringify(drawnRoster);
  // biome-ignore lint/correctness/useExhaustiveDependencies: drawnSignature is the stable form of drawnRoster
  useEffect(() => {
    if (!liveResult) return;
    writeRailRoster(drawnRoster);
    setRemembered(drawnRoster);
  }, [liveResult, drawnSignature]);
  const doubleBarCount = wanted.filter((entry) => entry.bars.length > 1).length;
  // How many slots the rail has room for (unmeasured: all of them).
  const [pinRoom, setPinRoom] = useState(Number.POSITIVE_INFINITY);
  const [scrollStart, setScrollStart] = useState(0);
  const { rail, nav, settings } = refs;
  useLayoutEffect(() => {
    const element = rail.current;
    if (!element || wanted.length === 0) return;
    const measure = () =>
      setPinRoom(
        usagePinVisibleCount({
          railHeight: element.clientHeight,
          navHeight: nav.current?.scrollHeight ?? 0,
          settingsHeight: (settings.current?.offsetHeight ?? 0) + extraHeight,
          total: wanted.length,
          limit: slotLimit,
          doubleBarCount,
        })
      );
    // Measure before paint, not after a provisional tall stack was visible.
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [nav, rail, settings, wanted.length, doubleBarCount, extraHeight, slotLimit]);
  // Without accounts expanded the stack is all or nothing, as before; with a
  // slot limit it shows a window of slots that the chevrons and wheel move.
  const room = Math.min(wanted.length, slotLimit, pinRoom);
  const hasAccountSlots = wanted.some((entry) => entry.accountIndex !== undefined);
  const visibleCount = hasAccountSlots || room === wanted.length ? room : 0;
  const start = Math.max(0, Math.min(scrollStart, wanted.length - visibleCount));
  const usagePinScroll = {
    hasPrev: visibleCount > 0 && start > 0,
    hasNext: visibleCount > 0 && start + visibleCount < wanted.length,
    // Functional, so several notches landing in one render each count.
    step: (direction: 1 | -1) =>
      setScrollStart((current) =>
        Math.max(0, Math.min(Math.min(current, wanted.length - visibleCount) + direction, wanted.length - visibleCount))
      ),
  };
  const loading =
    enabled &&
    wanted.length === 0 &&
    (!settingsReady || (usagePinned && (snapshot.status === 'idle' || snapshot.status === 'loading')));
  if (enabled) beginBootSurface('usage-controls', 'pin');
  useEffect(() => {
    if (enabled && !loading) reportBootSurfaceReady('usage-controls', 'pin');
  }, [enabled, loading]);
  return {
    usagePinned,
    toggleUsagePin,
    railBars,
    setRailBars,
    accountsExpanded,
    setAccountsExpanded,
    railSlots,
    setRailSlots,
    loading,
    usagePinRows: wanted.slice(start, start + visibleCount),
    usagePinScroll,
  };
}
