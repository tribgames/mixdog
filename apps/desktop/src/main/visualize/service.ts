import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  type DesktopVisualizeEvent,
  type DesktopVisualizeTabCommand,
  type VisualizeHostEvent,
  type VisualizeHostState,
  type VisualizeInlineContent,
  type VisualizePaneView,
  type VisualizeSessionState,
  type VisualizeTabView,
  withDeferredInline,
} from '../../shared/visualize';
import type { ActStepOutcome, VisualizeActStep } from './act-steps';
import type { VisualizeServiceContext } from './context';
import { createExportActions } from './export-actions';
import type { HistoryEntry } from './history';
import { sleep } from './host-frames';
import { createLeaseGuard, type RequesterFrame } from './lease-guard';
import { createOpenActions } from './open-actions';
import type { VisualizeOverlayResult } from './overlay-script';
import { leasePrefixOf } from './page-problems';
import { createPanelCommands } from './panel-commands';
import { createPanes } from './panes';
import {
  createHydratedTab,
  createVisualizeParkStore,
  parkDirectoryFor,
  type ParkedSession,
  serializeSession,
  stripParkedHistory,
  type VisualizeParkStore,
} from './park-store';
import { createProblemTracker } from './problem-tracker';
import { createReadActions } from './read-actions';
import { createReloads } from './reloads';
import { createPublish, createSessionViews, readStates } from './session-views';
import {
  currentAnnotations,
  type FileTarget,
  fileTargetsKey,
  markFileTabMissing,
  rekeyFileTab,
  type SessionState,
  type TabState,
  type VisualizeResult,
  view,
} from './tab-state';
import { createTabVersions } from './tab-versions';
import { createTabs } from './tabs';
import { liveFilesFingerprint, OutsideRecordedRootError, parseVisualizeRequest, resolveTargetWithin } from './targets';
import { type VisualizeAnnotation, visualizePaneMarks } from '../../shared/visualize-annotations';
import { createThumbnails } from './thumbnails';
import { createTurnHolds, refusePast, type ShownFileTab, shownFileTabOf, type ShownState, shownNow } from './turn-hold';
import { createVersionRestore } from './version-restore';
import { createVersionSelection } from './version-select';
import {
  changedRestoreAssets,
  createVisualizeVersionStore,
  keptTargets,
  VersionHistoryFullError,
  type VisualizeVersionLimits,
} from './versions';

export type { RequesterFrame } from './lease-guard';
export type { VisualizeResult, VisualizeTabSummary } from './tab-state';

/** How far the user can see a displayed tab (see `VisualizeServiceDeps.onScreen`). */
export type VisualizeScreenState = 'visible' | 'background' | 'covered' | 'other-tab' | 'hidden';

/** Whether the user can reach a session's conversation right now (see
 *  `VisualizeServiceDeps.sessionReach`). */
export type VisualizeSessionReach = 'shown' | 'background' | 'hidden' | 'not-open';

/** The line a result run for another session's work ends with: chat cards
 *  of that work read the owner session from it. */
function visualizeOwnerNote(ownerSessionId: string): string {
  return `Shown in the side panel of session ${ownerSessionId} (the conversation this agent works for).`;
}

export interface VisualizeServiceDeps {
  /** False while no desktop window can show the panel. */
  windowAvailable(): boolean;
  /** The URL a pane loads for this file (fresh after a change), its page
   *  assets served from `target.root`. */
  preparePane(target: FileTarget): Promise<string>;
  /** Push to the renderer: tab state, reveal requests, web URL hand-offs. */
  publish(event: DesktopVisualizeEvent): void;
  /** A scripted inline page (`chart` / `html` content): the URL of its
   *  in-memory page on the local page server. Absent = the static render. */
  prepareInlinePage?(content: VisualizeInlineContent): Promise<string>;
  /** Revoke a virtual page lease created by `prepareInlinePage` when its tab ends or parks. */
  revokeInlinePage?(url: string): void | Promise<void>;
  /** True while a paired remote device is viewing `sessionId`; keeps it unparked. */
  remoteViewing?(sessionId: string): Promise<boolean>;
  /** Number of most-recently-shown sessions kept warm in memory across thread switches. */
  recentShownLimit?: number;
  /** The same change with each pane's resolved file, for paired remote clients. */
  publishHost?(event: VisualizeHostEvent): void;
  /** Throws when the browser panel cannot take a web URL. */
  browserAvailable(): boolean;
  /** Start waiting for the browser tab the pane creates for the open request
   *  `requestId` (the id the published `openUrl` event carries); its `page`
   *  resolves with that tab's page id (`p…`), or null when the request got no
   *  tab of its own in time. Absent (or undefined) when there is no browser
   *  host. Call before handing the pane the URL. */
  watchBrowserTab?(sessionId: string, requestId: string): { page: Promise<string | null>; cancel(): void } | undefined;
  /** Watch one file; returns the disposer. */
  watch(path: string, onChange: () => void): () => void;
  /** Show exactly `marks` (the tab's whole list, by displayed pane) in the
   *  displayed tab's HTML panes of the desktop window. Null when only a paired
   *  device shows the tab: it draws the marks from the tab state itself. */
  annotate(
    sessionId: string,
    tab: VisualizeTabView,
    marks: VisualizeAnnotation[]
  ): Promise<Array<{ pane: string; result: VisualizeOverlayResult }> | null>;
  /** Screen reading: run the inspection in every HTML pane of the displayed
   *  tab (laid out at `viewport` for the duration when given). The answers are
   *  the pages' own and untrusted; the service types and bounds them. */
  inspect?(
    sessionId: string,
    tab: VisualizeTabView,
    options: { viewport?: { width: number; height: number }; selector?: string }
  ): Promise<Array<{ pane: string; result: unknown }>>;
  /** Screen reading without the panel (an agent turn leaves it alone): one
   *  HTML pane loaded in a hidden window at `viewport` (a default size when
   *  absent), its inspection and the problems it showed while loading. */
  inspectOffscreen?(
    pane: VisualizePaneView,
    allowNetwork: boolean,
    options: { viewport?: { width: number; height: number }; selector?: string; roots: readonly string[] }
  ): Promise<{ result: unknown; problems: string[] }>;
  /** `act` in the panel: run `steps` in displayed pane `pane`'s frame (an
   *  HTML pane of the displayed tab), stopping at the first failure. */
  act?(sessionId: string, tab: VisualizeTabView, pane: number, steps: VisualizeActStep[]): Promise<ActStepOutcome[]>;
  /** `act` without the panel: one HTML pane loaded in a hidden window at
   *  `viewport`, the steps run in it, then (`capture`) a PNG of what it shows,
   *  with the problems the page showed meanwhile. */
  actOffscreen?(
    pane: VisualizePaneView,
    allowNetwork: boolean,
    options: {
      steps: VisualizeActStep[];
      viewport: { width: number; height: number };
      roots: readonly string[];
      capture: boolean;
    }
  ): Promise<{ outcomes: ActStepOutcome[]; png?: Buffer; problems: string[] }>;
  /** PNG bytes of the displayed tab body. */
  capture(sessionId: string, tab: VisualizeTabView): Promise<Buffer>;
  /** Resolves once the displayed tab's HTML panes are on screen (so their
   *  problems are being captured); throws when they cannot be. */
  ensureShown?(sessionId: string, tab: VisualizeTabView): Promise<void>;
  /** Whether the user can see the displayed tab right now: `visible` (the
   *  desktop window is in front with the tab's panel uncovered, or a paired
   *  remote device is viewing it), `background` (drawn uncovered, but another
   *  app has the focus), `covered` (drawn, but an overlay in the window hides
   *  it), `other-tab` (the session's panel is on screen showing another tab)
   *  or `hidden` (window minimized or hidden, panel closed, session not
   *  shown). Absent = assumed visible. */
  onScreen?(sessionId: string, tab: VisualizeTabView): Promise<VisualizeScreenState>;
  /** Whether the user can reach the session now (an open held by a running
   *  turn shows when the turn ends): `shown` (a pane of the window in front,
   *  or a paired device, shows the session), `background` (another app has
   *  the focus), `hidden` (window minimized or hidden) or `not-open` (no pane
   *  shows the session). Absent = assumed shown. */
  sessionReach?(sessionId: string): Promise<VisualizeSessionReach>;
  /** The listed conversation a session's work shows in: a sub-agent's owner,
   *  a room member's room (the approval rules); the session itself otherwise. */
  ownerSessionId?(sessionId: string): string;
  /** Keep version history in this folder (the app's data folder, never a
   *  project); absent = no history. */
  versions?: { directory: string } & VisualizeVersionLimits;
  /** A downscaled PNG of the tab for its chat card (at most
   *  VISUALIZE_THUMBNAIL_MAX_BYTES), or null when none can be taken (the
   *  session is not shown and no pane file can stand in). `signal` aborts
   *  when the picture is no longer wanted (a newer revision, a newer job for
   *  the tab, the tab closed): the taker stops and its result is dropped. */
  thumbnail?(
    sessionId: string,
    tab: VisualizeTabView,
    targets: FileTarget[],
    signal: AbortSignal
  ): Promise<Buffer | null>;
  /** The same picture drawn without the panel (a turn's end, when the panel
   *  still shows what it showed before): `files` is the file behind each
   *  displayed pane. Null (or a rejection) when it cannot be drawn or must
   *  not be (a page showing a password field); stops once `signal` aborts. */
  thumbnailOffscreen?(
    sessionId: string,
    tab: VisualizeTabView,
    files: readonly string[],
    signal: AbortSignal
  ): Promise<Buffer | null>;
  /** The session's working directory, for reopening a closed tab from its
   *  chat card when this run never saw the session. */
  sessionCwd?(sessionId: string): Promise<string | null>;
  /** The OS save dialog for an export: the chosen file path, null when the
   *  user cancels. `directory` is the preferred folder (it may not exist;
   *  `fallback` then). Absent = exports to files are unavailable. */
  chooseExportPath?(request: {
    sessionId: string;
    directory: string;
    fallback: string;
    name: string;
    format: 'png' | 'pdf';
  }): Promise<string | null>;
  /** Render one HTML page (a lease URL) whole in a hidden window for an agent
   *  export, with the problems the page showed meanwhile. */
  renderExport?(
    pane: VisualizePaneView,
    format: 'png' | 'pdf',
    allowNetwork: boolean,
    options: { roots: readonly string[]; signal: AbortSignal }
  ): Promise<{ data: Buffer; problems: string[] }>;
  /** Longest an agent `export` may take end to end (render and write), ms;
   *  the runtime client waits longer, so a timeout is reported, not raced. */
  exportDeadlineMs?: number;
  /** The bytes of an export of displayed pane `pane`: the whole page for an
   *  HTML pane, else what the panel shows. With `offscreenFiles` (the file
   *  behind each displayed pane, empty for inline content) it draws without
   *  the panel wherever it can, so the panel may be hidden. */
  exportBytes?(
    sessionId: string,
    tab: VisualizeTabView,
    format: 'png' | 'pdf',
    pane: number,
    offscreenFiles?: readonly string[],
    /** A document had more pages than one PNG stacks (first `included` of `total`). */
    onPagesCut?: (included: number, total: number) => void
  ): Promise<Buffer>;
  delay?(ms: number): Promise<void>;
  reloadDebounceMs?: number;
  /** The turn end's file-existence check (test seam: the file system's
   *  `stat`) and the budget all of its checks share (ms). */
  statFile?(path: string): Promise<unknown>;
  goneCheckBudgetMs?: number;
  /** Test seam: custom parked-session store. */
  parkStore?: VisualizeParkStore;
}

type LateGroups = Pick<
  VisualizeServiceContext,
  'publish' | 'thumbnails' | 'problems' | 'leases' | 'panes' | 'tabVersions' | 'reloads' | 'tabs' | 'opens' | 'exports'
>;

/** The shared context of the service's groups; `late` yields the groups
 *  created after it, read only when a handler runs. */
function createServiceContext(
  deps: VisualizeServiceDeps,
  sessions: Map<string, SessionState>,
  sessionOf: (sessionId: string) => SessionState,
  versions: VisualizeServiceContext['versions'],
  late: () => LateGroups,
  release: Pick<VisualizeServiceContext, 'sessionReleaseEpoch' | 'isSessionReleased'>
): VisualizeServiceContext {
  /** Start order of opens and file reloads (`TabState.loadedStamp`). */
  let loadStamp = 0;
  return {
    deps,
    sessions,
    sessionOf,
    delay: deps.delay ?? sleep,
    versions,
    sessionCwds: new Map(),
    pendingReloads: new Set(),
    holds: new Map(),
    panelSize: { current: null },
    nextLoadStamp: () => {
      loadStamp += 1;
      return loadStamp;
    },
    ...release,
    views: createSessionViews(sessions, sessionOf),
    get publish() {
      return late().publish;
    },
    get thumbnails() {
      return late().thumbnails;
    },
    get problems() {
      return late().problems;
    },
    get leases() {
      return late().leases;
    },
    get panes() {
      return late().panes;
    },
    get tabVersions() {
      return late().tabVersions;
    },
    get reloads() {
      return late().reloads;
    },
    get tabs() {
      return late().tabs;
    },
    get opens() {
      return late().opens;
    },
    get exports() {
      return late().exports;
    },
  };
}

/** A failed export removes its temp folder here; a finished one is the download's to remove. */
async function exportTabForDevice(
  sessions: ReadonlyMap<string, SessionState>,
  exports: ReturnType<typeof createExportActions>,
  command: DesktopVisualizeTabCommand
): Promise<{ path: string; pages?: { included: number; total: number } }> {
  if (command.action !== 'export' || command.format === 'project') throw new TypeError('export format is invalid.');
  const tab = sessions
    .get(command.sessionId)
    ?.tabs.find((candidate) => candidate.id === command.tabId && !candidate.url);
  if (!tab) throw new Error('This visualize tab is closed.');
  let folder: string | undefined;
  let pages: { included: number; total: number } | undefined;
  try {
    const result = await exports.exportTab(
      command.sessionId,
      tab,
      command.format,
      command.pane ?? 0,
      async ({ name }) => {
        folder = await mkdtemp(join(tmpdir(), 'mixdog-visualize-export-'));
        return join(folder, name);
      },
      {
        onPagesCut: (included, total) => {
          pages = { included, total };
        },
      }
    );
    if (!result.path) throw new Error('The export did not produce a file.');
    return { path: result.path, ...(pages ? { pages } : {}) };
  } catch (error) {
    if (folder) await rm(folder, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

export function createVisualizeService(deps: VisualizeServiceDeps) {
  const sessions = new Map<string, SessionState>();
  const hydratingPins = new Map<string, Map<string, number>>();
  const parkedSessions = new Map<
    string,
    {
      state: VisualizeSessionState;
      host: VisualizeHostState;
      keys: ReadonlyMap<string, string>;
      fileTabs: ReadonlyMap<string, ShownFileTab>;
      history: readonly HistoryEntry[];
    }
  >();
  const versions = deps.versions
    ? createVisualizeVersionStore({
        ...deps.versions,
        // The version a tab shows (live, hydrating, or parked) is never evicted under it.
        pinned: (sessionId, tabId) =>
          sessions.get(sessionId)?.tabs.find((tab) => tab.id === tabId)?.shown?.n ??
          hydratingPins.get(sessionId)?.get(tabId) ??
          parkedSessions.get(sessionId)?.state.tabs.find((tab) => tab.id === tabId)?.version ??
          null,
      })
    : null;

  const sessionOf = (sessionId: string): SessionState => {
    let state = sessions.get(sessionId);
    if (!state) {
      state = { tabs: [], active: null, counter: 0, history: [] };
      sessions.set(sessionId, state);
    }
    return state;
  };

  let disposed = false;
  const releaseEpochs = new Map<string, number>();
  const sessionReleaseEpoch = (sessionId: string): number => releaseEpochs.get(sessionId) ?? 0;
  const isSessionReleased = (sessionId: string, epoch: number): boolean =>
    disposed || (releaseEpochs.get(sessionId) ?? 0) !== epoch;

  // The groups below are created in dependency order; one that is created
  // later is reached through the context's getters only when a handler runs.
  const ctx = createServiceContext(
    deps,
    sessions,
    sessionOf,
    versions,
    () => ({
      publish,
      thumbnails,
      problems,
      leases,
      panes,
      tabVersions,
      reloads,
      tabs,
      opens,
      exports,
    }),
    { sessionReleaseEpoch, isSessionReleased }
  );

  const sessionEpochs = new Map<string, number>();
  const touchSession = (sessionId: string): void => {
    sessionEpochs.set(sessionId, (sessionEpochs.get(sessionId) ?? 0) + 1);
  };

  const thumbnails = createThumbnails(ctx);
  const rawPublish = createPublish(ctx);
  const unpublishedHydrations = new Set<string>();
  const publish: VisualizeServiceContext['publish'] = (sessionId, revealTab, updatedTab, callId, join) => {
    touchSession(sessionId);
    unpublishedHydrations.delete(sessionId);
    rawPublish(sessionId, revealTab, updatedTab, callId, join);
  };
  const problems = createProblemTracker(ctx);
  const leases = createLeaseGuard((lease, kind, message) => {
    const found = problems.paneOfUrl([lease]);
    if (found) problems.recordPageProblem(found, { kind, message, source: '', line: 0 });
  });
  const panes = createPanes(ctx);
  const tabVersions = { ...createTabVersions(ctx), ...createVersionSelection(ctx), ...createVersionRestore(ctx) };
  const reloads = createReloads(ctx);
  const tabs = createTabs(ctx);
  const opens = createOpenActions(ctx);
  const reads = createReadActions(ctx);
  const exports = createExportActions(ctx);
  const commands = createPanelCommands(ctx);

  const DEFAULT_RECENT_SHOWN_LIMIT = 3;
  const recentShownLimit = Math.max(0, deps.recentShownLimit ?? DEFAULT_RECENT_SHOWN_LIMIT);
  const parkStore =
    deps.parkStore ?? createVisualizeParkStore(deps.versions ? parkDirectoryFor(deps.versions.directory) : undefined);
  let trackingShown = false;
  const shownSessions = new Set<string>();
  const recentShown = new Set<string>();
  const activeOps = new Map<string, number>();
  const lifecycleChains = new Map<string, Promise<void>>();

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
      panes: tab.panes.map((pane) =>
        pane.inline
          ? {
              ...pane,
              inline: {
                kind: pane.inline.kind,
                source: '',
                ...(pane.inline.title ? { title: pane.inline.title } : {}),
                deferred: true as const,
              },
            }
          : pane
      ),
    })),
  });

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
    !disposed &&
    trackingShown &&
    !shownSessions.has(sessionId) &&
    !recentShown.has(sessionId) &&
    !ctx.holds.has(sessionId) &&
    (activeOps.get(sessionId) ?? 0) === 0;

  const MAX_PARK_RETRIES = 4;

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
      if (disposed || !canPark(sessionId) || sessions.get(sessionId) !== state) {
        await parkStore.remove(sessionId).catch(() => undefined);
        return;
      }
      if (stale) {
        // State mutated while save was in flight: discard stale snapshot and retry with fresh state.
        await parkStore.remove(sessionId).catch(() => undefined);
        continue;
      }
      const parkedViews = {
        state: stripParkedDesktop(ctx.views.stateOf(sessionId)),
        host: stripParkedHost(ctx.views.hostStateOf(sessionId)),
        keys: new Map(state.tabs.filter((tab) => !tab.url && !tab.verify).map((tab) => [tab.id, tab.key])),
        fileTabs: new Map(
          state.tabs.filter((tab) => !tab.url && !tab.verify && !tab.inline).map((tab) => [tab.id, shownFileTabOf(tab)])
        ),
        history: stripParkedHistory(state.history),
      };
      for (const tab of state.tabs) tabs.end(tab);
      sessions.delete(sessionId);
      ctx.sessionCwds.delete(sessionId);
      unpublishedHydrations.delete(sessionId);
      parkedSessions.set(sessionId, parkedViews);
      return;
    }
    if (!disposed && canPark(sessionId) && sessions.has(sessionId)) {
      void parkIfHidden(sessionId);
    }
  };

  const parkIfHidden = (sessionId: string): Promise<void> => {
    if (!canPark(sessionId) || !sessions.has(sessionId)) return Promise.resolve();
    return enqueueLifecycle(sessionId, () => parkNow(sessionId));
  };

  const hydrateNow = async (sessionId: string, publishAfter: boolean, forOp: boolean): Promise<void> => {
    const stillParked = () =>
      !disposed &&
      parkedSessions.has(sessionId) &&
      !sessions.has(sessionId) &&
      (forOp || shownSessions.has(sessionId) || recentShown.has(sessionId) || (activeOps.get(sessionId) ?? 0) > 0);
    if (!stillParked()) {
      if (
        !disposed &&
        publishAfter &&
        unpublishedHydrations.has(sessionId) &&
        shownSessions.has(sessionId) &&
        sessions.has(sessionId)
      ) {
        publish(sessionId);
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
      for (const tab of hydratedTabs) tabs.end(tab);
      hydratedTabs.length = 0;
      tabs.releasePanes(preparedPanes);
      preparedPanes.length = 0;
    };
    try {
      for (const parked of data.tabs) {
        if (!stillParked()) {
          cleanupPrepared();
          return;
        }
        let tabTargets = parked.targets;
        let tabPanes: VisualizePaneView[] = [];
        let shown: TabState['shown'] = null;
        let missing = parked.missing;
        let versionChanged = false;
        let historyFull = parked.historyFull;
        let liveUnkept = parked.liveUnkept;
        let currentLiveStat = parked.liveStat;
        if (parked.url) {
          tabPanes = [];
        } else if (parked.inline) {
          const pane = await panes.inlinePaneFor(parked.inline);
          preparedPanes.push(pane);
          if (!stillParked()) {
            cleanupPrepared();
            return;
          }
          tabPanes = [pane];
          if (parked.shown) {
            const entry = parked.inlineHistory?.find((candidate) => candidate.n === parked.shown?.n);
            if (entry) {
              const shownPane = await panes.inlinePaneFor(entry.content);
              preparedPanes.push(shownPane);
              if (!stillParked()) {
                cleanupPrepared();
                return;
              }
              shown = {
                n: entry.n,
                targets: [],
                panes: [shownPane],
                restoreAssets: [],
              };
            }
          }
        } else {
          let outsideRoot = false;
          try {
            tabTargets = await Promise.all(
              parked.targets.map((target) => resolveTargetWithin(parked.cwd, target.target, [target.root]))
            );
            if (!stillParked()) {
              cleanupPrepared();
              return;
            }
            tabPanes = await panes.preparePanes(tabTargets);
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
          if (!stillParked()) {
            cleanupPrepared();
            return;
          }
          if (outsideRoot) {
            droppedIds.add(parked.id);
            continue;
          }
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
            if (!stillParked()) {
              cleanupPrepared();
              return;
            }
          }
          const liveStatChanged =
            !missing &&
            currentLiveStat !== undefined &&
            parked.liveStat !== undefined &&
            currentLiveStat !== parked.liveStat;
          const liveChanged =
            versionChanged ||
            Boolean(liveUnkept) !== Boolean(parked.liveUnkept) ||
            ((Boolean(liveUnkept) || !versions) && liveStatChanged);
          if (parked.shown && versions) {
            const version = versions.get(sessionId, parked.id, parked.shown.n);
            if (version) {
              const targets = keptTargets(version, tabTargets);
              const shownPanes = await panes.preparePanes(targets).catch(() => null);
              if (shownPanes) preparedPanes.push(...shownPanes);
              if (!stillParked()) {
                cleanupPrepared();
                return;
              }
              if (shownPanes) {
                const restoreAssets = !version.assets.length
                  ? []
                  : liveChanged || liveUnkept
                    ? await changedRestoreAssets(version).catch(() => [])
                    : (parked.shown.restoreAssets ?? []);
                if (!stillParked()) {
                  cleanupPrepared();
                  return;
                }
                shown = {
                  n: version.n,
                  targets,
                  panes: shownPanes,
                  restoreAssets,
                };
              }
            }
          }
        }
        const liveStatChanged =
          !missing &&
          currentLiveStat !== undefined &&
          parked.liveStat !== undefined &&
          currentLiveStat !== parked.liveStat;
        const liveChanged =
          versionChanged ||
          Boolean(liveUnkept) !== Boolean(parked.liveUnkept) ||
          ((Boolean(liveUnkept) || !versions) && liveStatChanged);
        const lastCanonicalKey =
          !missing && tabTargets.length && tabTargets.every((target) => target.path)
            ? fileTargetsKey(tabTargets)
            : (parked.lastCanonicalKey ??
              (parked.targets.length && parked.targets.every((target) => target.path)
                ? fileTargetsKey(parked.targets)
                : undefined));
        const tab = createHydratedTab(
          {
            ...parked,
            targets: tabTargets,
            revision: liveChanged ? parked.revision + 1 : parked.revision,
            ...(historyFull ? { historyFull: true } : { historyFull: undefined }),
            ...(liveUnkept ? { liveUnkept: true } : { liveUnkept: undefined }),
            ...(currentLiveStat ? { liveStat: currentLiveStat } : { liveStat: undefined }),
            ...(liveChanged ? { thumbnail: undefined, thumbnailVersion: undefined } : {}),
            ...(missing ? { missing: true } : { missing: undefined }),
            ...(lastCanonicalKey ? { lastCanonicalKey } : {}),
          },
          tabPanes,
          shown
        );
        if (versionChanged) versionChangedTabs.add(tab);
        hydratedTabs.push(tab);
      }
      if (!stillParked()) {
        cleanupPrepared();
        return;
      }
      if (versions) {
        for (const tab of hydratedTabs) {
          if (tab.url || tab.inline) continue;
          tab.versions = versions.list(sessionId, tab.id).map(({ n, at, label, turns }) => ({
            n,
            at,
            ...(label ? { label } : {}),
            ...(turns?.length ? { turns } : {}),
          }));
        }
      }
      for (const tab of hydratedTabs) {
        leases.claimLeases(sessionId, tab, tab.panes);
        if (tab.shown) leases.claimLeases(sessionId, tab, tab.shown.panes);
        if (!tab.url && !tab.inline && !tab.verify) {
          if (tab.missing) {
            if (tab.shown) tab.pendingReload = true;
            else reloads.armMissingRetry(sessionId, tab);
          } else {
            reloads.watchTab(sessionId, tab);
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
      for (const id of droppedIds) tabVersions.dropVersions(sessionId, id);
      for (const tab of versionChangedTabs) {
        if (!tab.verify) ctx.views.rememberTab(sessionId, tab, false);
      }
      unpublishedHydrations.add(sessionId);
      if (data.cwd !== undefined) ctx.sessionCwds.set(sessionId, data.cwd);
      if (hold?.fromParked) {
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
          state: {
            ...hold.shown.state,
            active: nextDesktopActive,
            tabs: nextDesktopTabs,
          },
          host: {
            ...hold.shown.host,
            active: nextHostActive,
            tabs: nextHostTabs,
          },
          keys: nextKeys,
          fileTabs: nextFileTabs,
          turn: nextTurn,
          history: hold.shown.history.map((entry) => preRekeyById.get(entry.id) ?? entry),
        };
        if (hold.picked && droppedIds.has(hold.picked)) hold.picked = undefined;
      }
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
    if (!disposed && publishAfter && shownSessions.has(sessionId) && sessions.has(sessionId)) publish(sessionId);
  };

  const hydrateSession = (sessionId: string): Promise<void> => {
    if (!parkedSessions.has(sessionId) || sessions.has(sessionId)) return Promise.resolve();
    return enqueueLifecycle(sessionId, () => hydrateNow(sessionId, false, true));
  };

  const withSessionOp = async <T>(sessionId: string, work: (releaseEpoch: number) => Promise<T>): Promise<T> => {
    const releaseEpoch = sessionReleaseEpoch(sessionId);
    if (disposed) throw new Error(`visualize session "${sessionId}" was released`);
    touchSession(sessionId);
    activeOps.set(sessionId, (activeOps.get(sessionId) ?? 0) + 1);
    try {
      await hydrateSession(sessionId);
      if (isSessionReleased(sessionId, releaseEpoch)) {
        throw new Error(`visualize session "${sessionId}" was released`);
      }
      return await work(releaseEpoch);
    } finally {
      touchSession(sessionId);
      const remaining = (activeOps.get(sessionId) ?? 1) - 1;
      if (remaining > 0) activeOps.set(sessionId, remaining);
      else activeOps.delete(sessionId);
      if (!isSessionReleased(sessionId, releaseEpoch)) await parkIfHidden(sessionId);
    }
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

  const parkedShown = (sessionId: string): ShownState | null => {
    const parked = parkedSessions.get(sessionId);
    if (!parked) return null;
    return {
      ...structuredClone({ state: parked.state, host: parked.host }),
      keys: new Map(parked.keys),
      fileTabs: new Map(parked.fileTabs),
      history: structuredClone(parked.history),
      turn: new Set(),
    };
  };

  const publishParked = (sessionId: string): void => {
    const parked = parkedSessions.get(sessionId);
    if (!parked) return;
    deps.publish({ sessionId, state: parked.state });
    deps.publishHost?.({ sessionId, state: parked.host });
  };

  const turns = createTurnHolds({
    ...ctx,
    parkedShown,
    publishParked,
    onTurnIdle: (sessionId) => {
      touchSession(sessionId);
      return parkIfHidden(sessionId);
    },
  });

  const run = async (request: ReturnType<typeof parseVisualizeRequest>): Promise<VisualizeResult> =>
    withSessionOp(request.sessionId, async (releaseEpoch) => {
      await turns.ended(request.sessionId);
      if (isSessionReleased(request.sessionId, releaseEpoch)) {
        throw new Error(`visualize session "${request.sessionId}" was released`);
      }
      if (request.action === 'open') return opens.open(request);
      if (request.action === 'close') return tabs.close(request);
      if (request.action === 'annotate') return reads.annotate(request);
      if (request.action === 'export') return exports.exportToFile(request);
      if (request.action === 'check') return reads.check(request);
      if (request.action === 'inspect') return reads.inspect(request);
      if (request.action === 'act') return reads.act(request);
      return reads.capture(request);
    });

  return {
    /** Sessions currently painted in the desktop window: keeps a small MRU of
     *  recently shown sessions warm, parks older hidden sessions to disk, and
     *  parks all non-remote-viewing sessions when the window is hidden. */
    async setShownSessions(sessionIds: Iterable<string>): Promise<void> {
      if (disposed) return;
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
    /** Rehydrate any currently shown sessions that are still parked (e.g. renderer reload). */
    async hydrateShown(): Promise<void> {
      if (disposed) return;
      const work: Promise<void>[] = [];
      for (const id of [...parkedSessions.keys()]) {
        if (shownSessions.has(id)) work.push(enqueueLifecycle(id, () => hydrateNow(id, false, false)));
      }
      await Promise.all(work);
    },
    /** See `createTurnHolds`: the session roster tells when agent turns run. */
    observeTurns: turns.observeTurns,
    observeTurnEdge: turns.observeEdge,
    setTurnActive: turns.setTurnActive,
    /** The source text of a displayed pane (the source view). */
    paneText: (sessionId: string, tabId: string, pane = 0) =>
      withSessionOp(sessionId, () => reads.paneText(sessionId, tabId, pane)),
    /** The side panel's content size the renderer last measured (CSS px). */
    setPanelSize(size: { width: number; height: number }): void {
      ctx.panelSize.current = { width: size.width, height: size.height };
    },
    /** Bridge entry point: one validated request → result or thrown error. */
    async execute(raw: unknown): Promise<VisualizeResult> {
      const parsed = parseVisualizeRequest(raw);
      // A sub-agent's or room member's session is never listed: its tabs
      // live in the conversation it works for, where the user sees them.
      const owner = deps.ownerSessionId?.(parsed.sessionId) || parsed.sessionId;
      if (owner === parsed.sessionId) return run(parsed);
      const result = await run({ ...parsed, sessionId: owner });
      // The note is for the model; the field is what chat cards read.
      return { ...result, text: `${result.text}\n${visualizeOwnerNote(owner)}`, ownerSessionId: owner };
    },
    /** See `createProblemTracker`. */
    reportConsole: problems.reportConsole,
    reportNavigation: problems.reportNavigation,
    /** A request of a displayed page's lease failed (`detail`: HTTP status or
     *  network error): a missing local stylesheet, script, image or font. */
    reportAssetFailure(url: string, detail: string, requester: RequesterFrame[]): void {
      // Only a frame of the same lease may have made the request.
      const lease = leasePrefixOf(url);
      if (!lease || leases.ownerLease(requester) !== lease) return;
      const found = problems.paneOfUrl([url]);
      if (found)
        problems.recordPageProblem(found, { kind: 'asset-failed', message: `${url} (${detail})`, source: '', line: 0 });
    },
    /** See `createLeaseGuard`. */
    guardNavigation: leases.guardNavigation,
    guardRequest: leases.guardRequest,
    reportLoadFailure: problems.reportLoadFailure,
    /** Whether `url` is a page of a displayed pane. */
    isPaneFrame(url: string): boolean {
      return problems.paneOfUrl([url]) !== null;
    },
    /** The marks a desktop pane frame at `url` shows (from the tab state):
     *  a page that loaded again within its revision gets them redrawn. */
    marksForFrame(url: string): Array<{ selector: string; label: string }> {
      const found = problems.paneOfUrl([url]);
      return found ? visualizePaneMarks(currentAnnotations(found.tab), found.index) : [];
    },
    /** See `createReloads`; also waits for the version files still being written. */
    async settled(): Promise<void> {
      await Promise.all([...lifecycleChains.values()]);
      await reloads.settled();
      await versions?.settled();
      await parkStore.settled();
    },
    /** Every session's tabs, for a renderer that (re)loads. */
    snapshot(): VisualizeSessionState[] {
      return readStates(
        ctx,
        (hold) => hold.shown.state,
        ctx.views.stateOf,
        [...parkedSessions.entries()].map(([id, views]) => [id, views.state] as const)
      );
    },
    /** Every session's tabs with their resolved files, for the remote mirror. */
    hostSnapshot(): VisualizeHostState[] {
      return readStates(
        ctx,
        (hold) => hold.shown.host,
        ctx.views.hostStateOf,
        [...parkedSessions.entries()].map(([id, views]) => [id, views.host] as const)
      );
    },
    /** One panel tab as the renderer draws it (feedback finds its frames). */
    tabView(sessionId: string, tabId: string): VisualizeTabView | null {
      const tab = sessions.get(sessionId)?.tabs.find((candidate) => candidate.id === tabId && !candidate.url);
      return tab ? view(tab) : null;
    },
    /** See `createPanelCommands`. */
    command: async (command: DesktopVisualizeTabCommand) => {
      if (command.action === 'thumbnail' && parkedSessions.has(command.sessionId) && !sessions.has(command.sessionId)) {
        await (lifecycleChains.get(command.sessionId) ?? Promise.resolve());
        if (parkedSessions.has(command.sessionId) && !sessions.has(command.sessionId)) {
          const thumbnail = await readParkedThumbnail(command.sessionId, command.tabId, command.version);
          return thumbnail ? { thumbnail } : {};
        }
      }
      return withSessionOp(command.sessionId, () => commands.command(command));
    },
    /** A paired device's PNG/PDF export (`remote-visualize.ts`): rendered like
     *  the Export menu's, into a fresh temp folder instead of a save dialog.
     *  The daemon hands the file to the device as a download and removes it.
     *  Drawn without the desktop panel wherever a pane can be, so the panel
     *  may be hidden. */
    exportForDevice: async (command: DesktopVisualizeTabCommand) =>
      withSessionOp(command.sessionId, async () => {
        refusePast(ctx, command.sessionId, command.tabId);
        return exportTabForDevice(sessions, exports, command);
      }),
    /** A deleted session: its tabs, watchers, kept versions, pictures and
     *  remembered folder go with it. */
    async releaseSession(sessionId: string): Promise<void> {
      releaseEpochs.set(sessionId, (releaseEpochs.get(sessionId) ?? 0) + 1);
      const dropLive = (): unknown[] => {
        const closing = sessions.get(sessionId)?.tabs.splice(0) ?? [];
        sessions.delete(sessionId);
        parkedSessions.delete(sessionId);
        unpublishedHydrations.delete(sessionId);
        shownSessions.delete(sessionId);
        recentShown.delete(sessionId);
        sessionEpochs.delete(sessionId);
        ctx.sessionCwds.delete(sessionId);
        leases.forgetSession(sessionId);
        turns.discard(sessionId);
        const errors: unknown[] = [];
        for (const tab of closing) {
          try {
            tabs.end(tab);
          } catch (error) {
            errors.push(error);
          }
        }
        return errors;
      };
      const failures = dropLive();
      try {
        await enqueueLifecycle(sessionId, async () => {
          failures.push(...dropLive());
          await parkStore.remove(sessionId);
        });
      } catch (error) {
        failures.push(error);
      }
      try {
        await versions?.dropSession(sessionId);
      } catch (error) {
        failures.push(error);
      }
      if (failures.length) throw failures[0];
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      for (const state of sessions.values()) for (const tab of state.tabs) tabs.end(tab);
      sessions.clear();
      parkedSessions.clear();
      unpublishedHydrations.clear();
      shownSessions.clear();
      recentShown.clear();
      sessionEpochs.clear();
      releaseEpochs.clear();
      ctx.sessionCwds.clear();
      leases.clearPolicies();
      for (const sessionId of [...ctx.holds.keys()]) turns.discard(sessionId);
      const draining = [...lifecycleChains.values()];
      parkStore.dispose();
      if (draining.length) {
        void Promise.allSettled(draining).then(() => {
          for (const state of sessions.values()) for (const tab of state.tabs) tabs.end(tab);
          sessions.clear();
          parkedSessions.clear();
        });
      }
    },
  };
}

export type VisualizeService = ReturnType<typeof createVisualizeService>;
