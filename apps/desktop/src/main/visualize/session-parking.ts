import {
  deferInlineContent,
  type VisualizeHostState,
  type VisualizePaneView,
  type VisualizeSessionState,
  withDeferredInline,
} from '../../shared/visualize';
import type { VisualizeServiceContext } from './context';
import type { HistoryEntry } from './history';
import {
  createHydratedTab,
  createVisualizeParkStore,
  parkDirectoryFor,
  type ParkedSession,
  type ParkedTab,
  serializeSession,
  stripParkedHistory,
} from './park-store';
import {
  type FileTarget,
  markFileTabMissing,
  rekeyFileTab,
  resolvedCanonicalKey,
  type SessionState,
  type TabState,
} from './tab-state';
import { versionViewsOf } from './tab-versions';
import { liveFilesFingerprint, OutsideRecordedRootError, resolveTargetWithin } from './targets';
import { type ShownFileTab, shownFileTabOf, type ShownState, shownNow, type TurnHold } from './turn-hold';
import { changedRestoreAssets, keptTargets, VersionHistoryFullError } from './versions';

const DEFAULT_RECENT_SHOWN_LIMIT = 3;
const MAX_PARK_RETRIES = 4;

interface ParkedViews {
  state: VisualizeSessionState;
  host: VisualizeHostState;
  keys: ReadonlyMap<string, string>;
  fileTabs: ReadonlyMap<string, ShownFileTab>;
  history: readonly HistoryEntry[];
}

export interface SessionParkingDeps {
  ctx: Pick<
    VisualizeServiceContext,
    | 'deps'
    | 'sessions'
    | 'versions'
    | 'sessionCwds'
    | 'holds'
    | 'views'
    | 'panes'
    | 'leases'
    | 'reloads'
    | 'tabs'
    | 'tabVersions'
    | 'publish'
    | 'sessionReleaseEpoch'
    | 'isSessionReleased'
  >;
  isDisposed: () => boolean;
}

const stripParkedDesktop = (state: VisualizeSessionState): VisualizeSessionState => {
  const deferred = withDeferredInline(state);
  return {
    ...deferred,
    tabs: deferred.tabs.map(({ thumbnail: _t, thumbnailVersion: _tv, ...tab }) => ({
      ...tab,
      panes: tab.panes.map((pane) => (pane.url ? { ...pane, url: '' } : pane)),
    })),
  };
};

const stripParkedHost = (state: VisualizeHostState): VisualizeHostState => ({
  ...state,
  tabs: state.tabs.map(({ thumbnail: _t, thumbnailVersion: _tv, ...tab }) => ({
    ...tab,
    panes: tab.panes.map((pane) => (pane.inline ? { ...pane, inline: deferInlineContent(pane.inline) } : pane)),
  })),
});

const hasLiveChanged = (
  parked: ParkedTab,
  missing: boolean | undefined,
  currentLiveStat: string | undefined,
  versionChanged: boolean,
  liveUnkept: boolean | undefined,
  hasVersions: boolean
): boolean => {
  const liveStatChanged =
    !missing && currentLiveStat !== undefined && parked.liveStat !== undefined && currentLiveStat !== parked.liveStat;
  return (
    versionChanged ||
    Boolean(liveUnkept) !== Boolean(parked.liveUnkept) ||
    ((Boolean(liveUnkept) || !hasVersions) && liveStatChanged)
  );
};

type HydratedTabOutcome =
  | { kind: 'aborted' }
  | { kind: 'outside-root' }
  | {
      kind: 'ready';
      targets: FileTarget[];
      panes: VisualizePaneView[];
      shown: TabState['shown'];
      missing: boolean | undefined;
      versionChanged: boolean;
      liveChanged: boolean;
      historyFull: boolean | undefined;
      liveUnkept: boolean | undefined;
      currentLiveStat: string | undefined;
    };

async function hydrateInlineTab(
  ctx: Pick<VisualizeServiceContext, 'panes'>,
  parked: ParkedTab,
  stillParked: () => boolean,
  preparedPanes: VisualizePaneView[]
): Promise<HydratedTabOutcome> {
  const inline = parked.inline;
  if (!inline) return { kind: 'aborted' };
  const pane = await ctx.panes.inlinePaneFor(inline);
  preparedPanes.push(pane);
  if (!stillParked()) return { kind: 'aborted' };
  let shown: TabState['shown'] = null;
  if (parked.shown) {
    const entry = parked.inlineHistory?.find((candidate) => candidate.n === parked.shown?.n);
    if (entry) {
      const shownPane = await ctx.panes.inlinePaneFor(entry.content);
      preparedPanes.push(shownPane);
      if (!stillParked()) return { kind: 'aborted' };
      shown = { n: entry.n, targets: [], panes: [shownPane], restoreAssets: [] };
    }
  }
  return {
    kind: 'ready',
    targets: parked.targets,
    panes: [pane],
    shown,
    missing: parked.missing,
    versionChanged: false,
    liveChanged: false,
    historyFull: parked.historyFull,
    liveUnkept: parked.liveUnkept,
    currentLiveStat: parked.liveStat,
  };
}

async function hydrateFileTab(
  ctx: Pick<VisualizeServiceContext, 'panes' | 'versions'>,
  sessionId: string,
  parked: ParkedTab,
  stillParked: () => boolean,
  preparedPanes: VisualizePaneView[]
): Promise<HydratedTabOutcome> {
  const { versions } = ctx;
  let tabTargets = parked.targets;
  let tabPanes: VisualizePaneView[] = [];
  let shown: TabState['shown'] = null;
  let missing = parked.missing;
  let versionChanged = false;
  let historyFull = parked.historyFull;
  let liveUnkept = parked.liveUnkept;
  let currentLiveStat = parked.liveStat;
  let outsideRoot = false;
  try {
    tabTargets = await Promise.all(
      parked.targets.map((target) => resolveTargetWithin(parked.cwd, target.target, [target.root]))
    );
    if (!stillParked()) return { kind: 'aborted' };
    tabPanes = await ctx.panes.preparePanes(tabTargets);
    preparedPanes.push(...tabPanes);
    missing = false;
    currentLiveStat = await liveFilesFingerprint(tabTargets);
  } catch (error) {
    if (error instanceof OutsideRecordedRootError) {
      outsideRoot = true;
      console.warn('visualize tab closed:', error.message);
    } else {
      missing = true;
      currentLiveStat = undefined;
      tabTargets = parked.targets.map((target) => ({ ...target, path: '' }));
      tabPanes = parked.targets.map((target) => ({
        kind: target.kind,
        label: target.label,
        target: target.target,
        url: '',
      }));
    }
  }
  if (!stillParked()) return { kind: 'aborted' };
  if (outsideRoot) return { kind: 'outside-root' };
  if (!missing && !parked.verify && versions) {
    try {
      const outcome = await versions.record(sessionId, parked.id, tabTargets);
      historyFull = false;
      versionChanged = outcome.status === 'recorded';
      liveUnkept = outcome.status === 'too-large';
    } catch (error) {
      if (error instanceof VersionHistoryFullError) {
        historyFull = true;
        liveUnkept = true;
      } else {
        console.warn('visualize version snapshot failed:', (error as Error).message);
        liveUnkept = true;
      }
    }
    if (!stillParked()) return { kind: 'aborted' };
  }
  const liveChanged = hasLiveChanged(parked, missing, currentLiveStat, versionChanged, liveUnkept, versions !== null);
  if (parked.shown && versions) {
    const version = versions.get(sessionId, parked.id, parked.shown.n);
    if (version) {
      const targets = keptTargets(version, tabTargets);
      const shownPanes = await ctx.panes.preparePanes(targets).catch(() => null);
      if (shownPanes) preparedPanes.push(...shownPanes);
      if (!stillParked()) return { kind: 'aborted' };
      if (shownPanes) {
        let restoreAssets: string[] = [];
        if (version.assets.length) {
          restoreAssets =
            liveChanged || liveUnkept
              ? await changedRestoreAssets(version).catch(() => [])
              : (parked.shown.restoreAssets ?? []);
        }
        if (!stillParked()) return { kind: 'aborted' };
        shown = { n: version.n, targets, panes: shownPanes, restoreAssets };
      }
    }
  }
  return {
    kind: 'ready',
    targets: tabTargets,
    panes: tabPanes,
    shown,
    missing,
    versionChanged,
    liveChanged,
    historyFull,
    liveUnkept,
    currentLiveStat,
  };
}

function reconcileHeldFromParked(
  ctx: Pick<VisualizeServiceContext, 'views' | 'sessions'>,
  hold: TurnHold,
  sessionId: string,
  droppedIds: ReadonlySet<string>,
  preRekeyHistory: readonly HistoryEntry[] | null
): void {
  hold.fromParked = false;
  const hydrated = shownNow(ctx, sessionId);
  const hydratedDesktop = new Map(hydrated.state.tabs.map((tab) => [tab.id, tab]));
  const hydratedHost = new Map(hydrated.host.tabs.map((tab) => [tab.id, tab]));
  const preRekeyById = new Map((preRekeyHistory ?? []).map((entry) => [entry.id, entry]));
  const nextDesktopTabs = hold.shown.state.tabs
    .filter((tab) => !droppedIds.has(tab.id))
    .map((tab) => hydratedDesktop.get(tab.id) ?? tab);
  const nextHostTabs = hold.shown.host.tabs
    .filter((tab) => !droppedIds.has(tab.id))
    .map((tab) => hydratedHost.get(tab.id) ?? tab);
  const nextKeys = new Map(hold.shown.keys);
  const nextFileTabs = new Map(hold.shown.fileTabs);
  const nextTurn = new Set(hold.shown.turn);
  for (const id of droppedIds) {
    nextKeys.delete(id);
    nextFileTabs.delete(id);
    nextTurn.delete(id);
  }
  for (const tab of nextDesktopTabs) {
    const key = hydrated.keys.get(tab.id);
    if (key !== undefined) nextKeys.set(tab.id, key);
    const fileTab = hydrated.fileTabs.get(tab.id);
    if (fileTab) nextFileTabs.set(tab.id, fileTab);
  }
  const nextDesktopActive =
    hold.shown.state.active && nextDesktopTabs.some((tab) => tab.id === hold.shown.state.active)
      ? hold.shown.state.active
      : (nextDesktopTabs.at(-1)?.id ?? null);
  const nextHostActive =
    hold.shown.host.active && nextHostTabs.some((tab) => tab.id === hold.shown.host.active)
      ? hold.shown.host.active
      : (nextHostTabs.at(-1)?.id ?? null);
  hold.shown = {
    ...hold.shown,
    state: { ...hold.shown.state, active: nextDesktopActive, tabs: nextDesktopTabs },
    host: { ...hold.shown.host, active: nextHostActive, tabs: nextHostTabs },
    keys: nextKeys,
    fileTabs: nextFileTabs,
    turn: nextTurn,
    history: hold.shown.history.map((entry) => preRekeyById.get(entry.id) ?? entry),
  };
  if (hold.picked && droppedIds.has(hold.picked)) hold.picked = undefined;
}

export function createSessionParking({ ctx, isDisposed }: SessionParkingDeps) {
  const { deps, sessions, versions } = ctx;
  const hydratingPins = new Map<string, Map<string, number>>();
  const parkedSessions = new Map<string, ParkedViews>();
  const unpublishedHydrations = new Set<string>();
  const sessionEpochs = new Map<string, number>();
  const recentShownLimit = Math.max(0, deps.recentShownLimit ?? DEFAULT_RECENT_SHOWN_LIMIT);
  const parkStore =
    deps.parkStore ?? createVisualizeParkStore(deps.versions ? parkDirectoryFor(deps.versions.directory) : undefined);
  let trackingShown = false;
  const shownSessions = new Set<string>();
  const recentShown = new Set<string>();
  const activeOps = new Map<string, number>();
  const lifecycleChains = new Map<string, Promise<void>>();

  const touchSession = (sessionId: string): void => {
    sessionEpochs.set(sessionId, (sessionEpochs.get(sessionId) ?? 0) + 1);
  };

  const enqueueLifecycle = (sessionId: string, work: () => Promise<void>): Promise<void> => {
    const previous = lifecycleChains.get(sessionId) ?? Promise.resolve();
    const next = previous.then(work, work);
    const tail = next.catch(() => undefined);
    lifecycleChains.set(sessionId, tail);
    void tail.finally(() => {
      if (lifecycleChains.get(sessionId) === tail) lifecycleChains.delete(sessionId);
    });
    return next;
  };

  const canPark = (sessionId: string): boolean =>
    !isDisposed() &&
    trackingShown &&
    !shownSessions.has(sessionId) &&
    !recentShown.has(sessionId) &&
    !ctx.holds.has(sessionId) &&
    (activeOps.get(sessionId) ?? 0) === 0;

  const parkNow = async (sessionId: string): Promise<void> => {
    if (!canPark(sessionId)) return;
    if (await deps.remoteViewing?.(sessionId).catch(() => false)) return;
    for (let attempt = 0; attempt < MAX_PARK_RETRIES; attempt += 1) {
      if (!canPark(sessionId)) return;
      const state = sessions.get(sessionId);
      if (!state) return;
      if (!state.tabs.length && !state.history.length && !state.goneOpens?.length && state.counter === 0) {
        sessions.delete(sessionId);
        ctx.sessionCwds.delete(sessionId);
        parkedSessions.delete(sessionId);
        unpublishedHydrations.delete(sessionId);
        await parkStore.remove(sessionId);
        return;
      }
      const epoch = sessionEpochs.get(sessionId) ?? 0;
      const serialized = serializeSession(state, ctx.sessionCwds.get(sessionId));
      try {
        await parkStore.save(sessionId, serialized);
      } catch (error) {
        console.warn('visualize park save failed:', (error as Error).message);
        return;
      }
      const stale = (sessionEpochs.get(sessionId) ?? 0) !== epoch;
      if (isDisposed() || !canPark(sessionId) || sessions.get(sessionId) !== state) {
        await parkStore.remove(sessionId).catch(() => undefined);
        return;
      }
      if (stale) {
        // State mutated while save was in flight: discard stale snapshot and retry with fresh state.
        await parkStore.remove(sessionId).catch(() => undefined);
        continue;
      }
      const parkedViews: ParkedViews = {
        state: stripParkedDesktop(ctx.views.stateOf(sessionId)),
        host: stripParkedHost(ctx.views.hostStateOf(sessionId)),
        keys: new Map(state.tabs.filter((tab) => !tab.url && !tab.verify).map((tab) => [tab.id, tab.key])),
        fileTabs: new Map(
          state.tabs.filter((tab) => !tab.url && !tab.verify && !tab.inline).map((tab) => [tab.id, shownFileTabOf(tab)])
        ),
        history: stripParkedHistory(state.history),
      };
      for (const tab of state.tabs) ctx.tabs.end(tab);
      sessions.delete(sessionId);
      ctx.sessionCwds.delete(sessionId);
      unpublishedHydrations.delete(sessionId);
      parkedSessions.set(sessionId, parkedViews);
      return;
    }
    if (!isDisposed() && canPark(sessionId) && sessions.has(sessionId)) {
      void parkIfHidden(sessionId);
    }
  };

  const parkIfHidden = (sessionId: string): Promise<void> => {
    if (!canPark(sessionId) || !sessions.has(sessionId)) return Promise.resolve();
    return enqueueLifecycle(sessionId, () => parkNow(sessionId));
  };

  const hydrateNow = async (sessionId: string, publishAfter: boolean, forOp: boolean): Promise<void> => {
    const stillParked = () =>
      !isDisposed() &&
      parkedSessions.has(sessionId) &&
      !sessions.has(sessionId) &&
      (forOp || shownSessions.has(sessionId) || recentShown.has(sessionId) || (activeOps.get(sessionId) ?? 0) > 0);
    if (!stillParked()) {
      if (
        !isDisposed() &&
        publishAfter &&
        unpublishedHydrations.has(sessionId) &&
        shownSessions.has(sessionId) &&
        sessions.has(sessionId)
      ) {
        ctx.publish(sessionId);
      }
      return;
    }
    let data: ParkedSession | null;
    try {
      data = await parkStore.load(sessionId);
    } catch (error) {
      console.warn('visualize park load failed:', (error as Error).message);
      if (forOp) throw error;
      return;
    }
    if (!stillParked()) return;
    if (!data) {
      parkedSessions.delete(sessionId);
      return;
    }
    const hydratedTabs: TabState[] = [];
    const droppedIds = new Set<string>();
    const versionChangedTabs = new Set<TabState>();
    const preparedPanes: VisualizePaneView[] = [];
    const pins = new Map<string, number>();
    for (const parked of data.tabs) {
      if (parked.shown) pins.set(parked.id, parked.shown.n);
    }
    if (pins.size) hydratingPins.set(sessionId, pins);
    const cleanupPrepared = () => {
      for (const tab of hydratedTabs) ctx.tabs.end(tab);
      hydratedTabs.length = 0;
      ctx.tabs.releasePanes(preparedPanes);
      preparedPanes.length = 0;
    };
    try {
      for (const parked of data.tabs) {
        if (!stillParked()) {
          cleanupPrepared();
          return;
        }
        let outcome: HydratedTabOutcome;
        if (parked.url) {
          outcome = {
            kind: 'ready',
            targets: parked.targets,
            panes: [],
            shown: null,
            missing: parked.missing,
            versionChanged: false,
            liveChanged: false,
            historyFull: parked.historyFull,
            liveUnkept: parked.liveUnkept,
            currentLiveStat: parked.liveStat,
          };
        } else if (parked.inline) {
          outcome = await hydrateInlineTab(ctx, parked, stillParked, preparedPanes);
        } else {
          outcome = await hydrateFileTab(ctx, sessionId, parked, stillParked, preparedPanes);
        }
        if (outcome.kind === 'aborted') {
          cleanupPrepared();
          return;
        }
        if (outcome.kind === 'outside-root') {
          droppedIds.add(parked.id);
          continue;
        }
        const lastCanonicalKey =
          (!outcome.missing ? resolvedCanonicalKey(outcome.targets) : undefined) ??
          parked.lastCanonicalKey ??
          resolvedCanonicalKey(parked.targets);
        const tab = createHydratedTab(
          {
            ...parked,
            targets: outcome.targets,
            revision: outcome.liveChanged ? parked.revision + 1 : parked.revision,
            ...(outcome.historyFull ? { historyFull: true } : { historyFull: undefined }),
            ...(outcome.liveUnkept ? { liveUnkept: true } : { liveUnkept: undefined }),
            ...(outcome.currentLiveStat ? { liveStat: outcome.currentLiveStat } : { liveStat: undefined }),
            ...(outcome.liveChanged ? { thumbnail: undefined, thumbnailVersion: undefined } : {}),
            ...(outcome.missing ? { missing: true } : { missing: undefined }),
            ...(lastCanonicalKey ? { lastCanonicalKey } : {}),
          },
          outcome.panes,
          outcome.shown
        );
        if (outcome.versionChanged) versionChangedTabs.add(tab);
        hydratedTabs.push(tab);
      }
      if (!stillParked()) {
        cleanupPrepared();
        return;
      }
      if (versions) {
        for (const tab of hydratedTabs) {
          if (tab.url || tab.inline) continue;
          tab.versions = versionViewsOf(versions, sessionId, tab.id);
        }
      }
      for (const tab of hydratedTabs) {
        ctx.leases.claimLeases(sessionId, tab, tab.panes);
        if (tab.shown) ctx.leases.claimLeases(sessionId, tab, tab.shown.panes);
        if (!tab.url && !tab.inline && !tab.verify) {
          if (tab.missing) {
            if (tab.shown) tab.pendingReload = true;
            else ctx.reloads.armMissingRetry(sessionId, tab);
          } else {
            ctx.reloads.watchTab(sessionId, tab);
          }
        }
      }
      parkedSessions.delete(sessionId);
      const active =
        data.active && hydratedTabs.some((tab) => tab.id === data.active)
          ? data.active
          : (hydratedTabs.filter((tab) => !tab.url && !tab.verify).at(-1)?.id ?? null);
      const hold = ctx.holds.get(sessionId);
      const preRekeyHistory = hold?.fromParked ? structuredClone(data.history) : null;
      const sessionState: SessionState = {
        tabs: hydratedTabs,
        active,
        counter: data.counter,
        history: data.history,
        ...(data.goneOpens ? { goneOpens: data.goneOpens } : {}),
      };
      for (const tab of hydratedTabs) {
        if (!tab.url && !tab.inline) {
          if (tab.missing) markFileTabMissing(sessionState, tab);
          else rekeyFileTab(sessionState, tab, tab.targets);
        }
      }
      sessions.set(sessionId, sessionState);
      for (const id of droppedIds) ctx.tabVersions.dropVersions(sessionId, id);
      for (const tab of versionChangedTabs) {
        if (!tab.verify) ctx.views.rememberTab(sessionId, tab, false);
      }
      unpublishedHydrations.add(sessionId);
      if (data.cwd !== undefined) ctx.sessionCwds.set(sessionId, data.cwd);
      if (hold?.fromParked) reconcileHeldFromParked(ctx, hold, sessionId, droppedIds, preRekeyHistory);
    } catch (error) {
      cleanupPrepared();
      throw error;
    } finally {
      hydratingPins.delete(sessionId);
    }
    await parkStore.remove(sessionId);
    if (!forOp && canPark(sessionId)) {
      await parkNow(sessionId);
      return;
    }
    if (!isDisposed() && publishAfter && shownSessions.has(sessionId) && sessions.has(sessionId)) {
      ctx.publish(sessionId);
    }
  };

  const hydrateSession = (sessionId: string): Promise<void> => {
    if (!parkedSessions.has(sessionId) || sessions.has(sessionId)) return Promise.resolve();
    return enqueueLifecycle(sessionId, () => hydrateNow(sessionId, false, true));
  };

  const readParkedThumbnail = async (sessionId: string, tabId: string, version: number): Promise<string> => {
    let data: ParkedSession | null;
    try {
      data = await parkStore.load(sessionId);
    } catch {
      return '';
    }
    const tab = data?.tabs.find((candidate) => candidate.id === tabId && !candidate.url);
    if (!tab) return '';
    if (tab.thumbnail && tab.thumbnailVersion === version) return tab.thumbnail;
    if (!version) return '';
    if (tab.inline) return tab.inlineHistory?.find((candidate) => candidate.n === version)?.thumbnail ?? '';
    return (await versions?.readThumbnail(sessionId, tabId, version)) ?? '';
  };

  return {
    pinnedVersion(sessionId: string, tabId: string): number | null {
      return (
        hydratingPins.get(sessionId)?.get(tabId) ??
        parkedSessions.get(sessionId)?.state.tabs.find((tab) => tab.id === tabId)?.version ??
        null
      );
    },
    touchSession,
    notePublished(sessionId: string): void {
      touchSession(sessionId);
      unpublishedHydrations.delete(sessionId);
    },
    parkIfHidden,
    async withSessionOp<T>(sessionId: string, work: (releaseEpoch: number) => Promise<T>): Promise<T> {
      const releaseEpoch = ctx.sessionReleaseEpoch?.(sessionId) ?? 0;
      if (isDisposed()) throw new Error(`visualize session "${sessionId}" was released`);
      touchSession(sessionId);
      activeOps.set(sessionId, (activeOps.get(sessionId) ?? 0) + 1);
      try {
        await hydrateSession(sessionId);
        if (ctx.isSessionReleased?.(sessionId, releaseEpoch)) {
          throw new Error(`visualize session "${sessionId}" was released`);
        }
        return await work(releaseEpoch);
      } finally {
        touchSession(sessionId);
        const remaining = (activeOps.get(sessionId) ?? 1) - 1;
        if (remaining > 0) activeOps.set(sessionId, remaining);
        else activeOps.delete(sessionId);
        if (!ctx.isSessionReleased?.(sessionId, releaseEpoch)) await parkIfHidden(sessionId);
      }
    },
    async setShownSessions(sessionIds: Iterable<string>): Promise<void> {
      if (isDisposed()) return;
      trackingShown = true;
      const next = new Set(sessionIds);
      shownSessions.clear();
      for (const id of next) shownSessions.add(id);
      if (shownSessions.size === 0) {
        recentShown.clear();
      } else {
        for (const id of shownSessions) {
          recentShown.delete(id);
          recentShown.add(id);
        }
        const keepLimit = Math.max(shownSessions.size, recentShownLimit);
        while (recentShown.size > keepLimit) {
          const oldest = [...recentShown].find((id) => !shownSessions.has(id));
          if (!oldest) break;
          recentShown.delete(oldest);
        }
      }
      const work: Promise<void>[] = [];
      for (const id of [...sessions.keys()]) {
        if (!shownSessions.has(id) && !recentShown.has(id)) work.push(parkIfHidden(id));
      }
      for (const id of shownSessions) {
        if (parkedSessions.has(id) || (unpublishedHydrations.has(id) && sessions.has(id))) {
          work.push(enqueueLifecycle(id, () => hydrateNow(id, true, false)));
        }
      }
      await Promise.all(work);
    },
    async hydrateShown(): Promise<void> {
      if (isDisposed()) return;
      const work: Promise<void>[] = [];
      for (const id of [...parkedSessions.keys()]) {
        if (shownSessions.has(id)) work.push(enqueueLifecycle(id, () => hydrateNow(id, false, false)));
      }
      await Promise.all(work);
    },
    parkedShown(sessionId: string): ShownState | null {
      const parked = parkedSessions.get(sessionId);
      if (!parked) return null;
      return {
        ...structuredClone({ state: parked.state, host: parked.host }),
        keys: new Map(parked.keys),
        fileTabs: new Map(parked.fileTabs),
        history: structuredClone(parked.history),
        turn: new Set(),
      };
    },
    publishParked(sessionId: string): void {
      const parked = parkedSessions.get(sessionId);
      if (!parked) return;
      deps.publish({ sessionId, state: parked.state });
      deps.publishHost?.({ sessionId, state: parked.host });
    },
    parkedDesktopEntries(): Array<readonly [string, VisualizeSessionState]> {
      return [...parkedSessions.entries()].map(([id, views]) => [id, views.state] as const);
    },
    parkedHostEntries(): Array<readonly [string, VisualizeHostState]> {
      return [...parkedSessions.entries()].map(([id, views]) => [id, views.host] as const);
    },
    async tryReadParkedThumbnail(
      sessionId: string,
      tabId: string,
      version: number
    ): Promise<{ thumbnail?: string } | null> {
      if (!parkedSessions.has(sessionId) || sessions.has(sessionId)) return null;
      await (lifecycleChains.get(sessionId) ?? Promise.resolve());
      if (!parkedSessions.has(sessionId) || sessions.has(sessionId)) return null;
      const thumbnail = await readParkedThumbnail(sessionId, tabId, version);
      return thumbnail ? { thumbnail } : {};
    },
    clearSessionState(sessionId: string): void {
      parkedSessions.delete(sessionId);
      unpublishedHydrations.delete(sessionId);
      shownSessions.delete(sessionId);
      recentShown.delete(sessionId);
      sessionEpochs.delete(sessionId);
    },
    releaseSession(sessionId: string, onDrop: () => void): Promise<void> {
      return enqueueLifecycle(sessionId, async () => {
        onDrop();
        await parkStore.remove(sessionId);
      });
    },
    async settledChains(): Promise<void> {
      await Promise.all([...lifecycleChains.values()]);
    },
    async settledStore(): Promise<void> {
      await parkStore.settled();
    },
    dispose(clearLiveSessions: () => void): void {
      parkedSessions.clear();
      unpublishedHydrations.clear();
      shownSessions.clear();
      recentShown.clear();
      sessionEpochs.clear();
      const draining = [...lifecycleChains.values()];
      parkStore.dispose();
      if (draining.length) {
        void Promise.allSettled(draining).then(() => {
          clearLiveSessions();
          parkedSessions.clear();
        });
      }
    },
  };
}

export type SessionParking = ReturnType<typeof createSessionParking>;
