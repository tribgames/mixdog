import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  DesktopVisualizeEvent,
  DesktopVisualizeTabCommand,
  VisualizeHostEvent,
  VisualizeHostState,
  VisualizeInlineContent,
  VisualizePaneView,
  VisualizeSessionState,
  VisualizeTabView,
} from '../../shared/visualize';
import type { ActStepOutcome, VisualizeActStep } from './act-steps';
import type { VisualizeServiceContext } from './context';
import { createExportActions } from './export-actions';
import { sleep } from './host-frames';
import { createLeaseGuard, type RequesterFrame } from './lease-guard';
import { createOpenActions } from './open-actions';
import type { VisualizeOverlayResult } from './overlay-script';
import { leasePrefixOf } from './page-problems';
import { createPanelCommands } from './panel-commands';
import { createPanes } from './panes';
import type { VisualizeParkStore } from './park-store';
import { createProblemTracker } from './problem-tracker';
import { createReadActions } from './read-actions';
import { createReloads } from './reloads';
import { createSessionParking, type SessionParking } from './session-parking';
import { createPublish, createSessionViews, readStates } from './session-views';
import { currentAnnotations, type FileTarget, type SessionState, type VisualizeResult, view } from './tab-state';
import { createTabVersions } from './tab-versions';
import { createTabs } from './tabs';
import { parseVisualizeRequest } from './targets';
import { type VisualizeAnnotation, visualizePaneMarks } from '../../shared/visualize-annotations';
import { createThumbnails } from './thumbnails';
import { createTurnHolds, refusePast } from './turn-hold';
import { createVersionRestore } from './version-restore';
import { createVersionSelection } from './version-select';
import { createVisualizeVersionStore, type VisualizeVersionLimits } from './versions';

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
  let parking: SessionParking | null = null;
  const versions = deps.versions
    ? createVisualizeVersionStore({
        ...deps.versions,
        // The version a tab shows (live, hydrating, or parked) is never evicted under it.
        pinned: (sessionId, tabId) =>
          sessions.get(sessionId)?.tabs.find((tab) => tab.id === tabId)?.shown?.n ??
          parking?.pinnedVersion(sessionId, tabId) ??
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

  const thumbnails = createThumbnails(ctx);
  const rawPublish = createPublish(ctx);
  const publish: VisualizeServiceContext['publish'] = (sessionId, revealTab, updatedTab, callId, join) => {
    parking?.notePublished(sessionId);
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

  const sessionParking = createSessionParking({ ctx, isDisposed: () => disposed });
  parking = sessionParking;

  const turns = createTurnHolds({
    ...ctx,
    parkedShown: sessionParking.parkedShown,
    publishParked: sessionParking.publishParked,
    onTurnIdle: (sessionId) => {
      sessionParking.touchSession(sessionId);
      return sessionParking.parkIfHidden(sessionId);
    },
  });

  const run = async (request: ReturnType<typeof parseVisualizeRequest>): Promise<VisualizeResult> =>
    sessionParking.withSessionOp(request.sessionId, async (releaseEpoch) => {
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
    setShownSessions: sessionParking.setShownSessions,
    /** Rehydrate any currently shown sessions that are still parked (e.g. renderer reload). */
    hydrateShown: sessionParking.hydrateShown,
    /** See `createTurnHolds`: the session roster tells when agent turns run. */
    observeTurns: turns.observeTurns,
    observeTurnEdge: turns.observeEdge,
    setTurnActive: turns.setTurnActive,
    /** The source text of a displayed pane (the source view). */
    paneText: (sessionId: string, tabId: string, pane = 0) =>
      sessionParking.withSessionOp(sessionId, () => reads.paneText(sessionId, tabId, pane)),
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
      await sessionParking.settledChains();
      await reloads.settled();
      await versions?.settled();
      await sessionParking.settledStore();
    },
    /** Every session's tabs, for a renderer that (re)loads. */
    snapshot(): VisualizeSessionState[] {
      return readStates(ctx, (hold) => hold.shown.state, ctx.views.stateOf, sessionParking.parkedDesktopEntries());
    },
    /** Every session's tabs with their resolved files, for the remote mirror. */
    hostSnapshot(): VisualizeHostState[] {
      return readStates(ctx, (hold) => hold.shown.host, ctx.views.hostStateOf, sessionParking.parkedHostEntries());
    },
    /** One panel tab as the renderer draws it (feedback finds its frames). */
    tabView(sessionId: string, tabId: string): VisualizeTabView | null {
      const tab = sessions.get(sessionId)?.tabs.find((candidate) => candidate.id === tabId && !candidate.url);
      return tab ? view(tab) : null;
    },
    /** See `createPanelCommands`. */
    command: async (command: DesktopVisualizeTabCommand) => {
      if (command.action === 'thumbnail') {
        const parked = await sessionParking.tryReadParkedThumbnail(command.sessionId, command.tabId, command.version);
        if (parked !== null) return parked;
      }
      return sessionParking.withSessionOp(command.sessionId, () => commands.command(command));
    },
    /** A paired device's PNG/PDF export (`remote-visualize.ts`): rendered like
     *  the Export menu's, into a fresh temp folder instead of a save dialog.
     *  The daemon hands the file to the device as a download and removes it.
     *  Drawn without the desktop panel wherever a pane can be, so the panel
     *  may be hidden. */
    exportForDevice: async (command: DesktopVisualizeTabCommand) =>
      sessionParking.withSessionOp(command.sessionId, async () => {
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
        sessionParking.clearSessionState(sessionId);
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
        await sessionParking.releaseSession(sessionId, () => {
          failures.push(...dropLive());
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
      const clearLive = (): void => {
        for (const state of sessions.values()) for (const tab of state.tabs) tabs.end(tab);
        sessions.clear();
      };
      clearLive();
      releaseEpochs.clear();
      ctx.sessionCwds.clear();
      leases.clearPolicies();
      for (const sessionId of [...ctx.holds.keys()]) turns.discard(sessionId);
      sessionParking.dispose(clearLive);
    },
  };
}

export type VisualizeService = ReturnType<typeof createVisualizeService>;
