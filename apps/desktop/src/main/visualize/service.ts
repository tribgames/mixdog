/**
 * The agent `visualize` tool's desktop half: per-session side-panel tabs that
 * show produced artifacts (pages, documents, media) next to the chat. Main owns
 * the tab state; the renderer draws what `publish` sends. Electron-specific
 * work (preview URLs, frames, capture, file watching) comes in as `deps`, so
 * request handling, containment and routing stay testable without a window.
 */
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
import type { VisualizeServiceContext } from './context';
import { createExportActions } from './export-actions';
import { createLeaseGuard, type RequesterFrame } from './lease-guard';
import { createOpenActions } from './open-actions';
import type { VisualizeOverlayResult } from './overlay-script';
import { leasePrefixOf } from './page-problems';
import { createPanelCommands } from './panel-commands';
import { createPanes } from './panes';
import { createProblemTracker } from './problem-tracker';
import { createReadActions } from './read-actions';
import { createReloads } from './reloads';
import { createPublish, createSessionViews } from './session-views';
import { currentAnnotations, type FileTarget, type SessionState, type VisualizeResult, view } from './tab-state';
import { createTabVersions } from './tab-versions';
import { createTabs } from './tabs';
import { parseVisualizeRequest } from './targets';
import { type VisualizeAnnotation, visualizePaneMarks } from '../../shared/visualize-annotations';
import { createThumbnails } from './thumbnails';
import { createVersionRestore } from './version-restore';
import { createVersionSelection } from './version-select';
import { createVisualizeVersionStore, type VisualizeVersionLimits } from './versions';

export type { RequesterFrame } from './lease-guard';
export type { VisualizeResult, VisualizeTabSummary } from './tab-state';

/** How far the user can see a displayed tab (see `VisualizeServiceDeps.onScreen`). */
export type VisualizeScreenState = 'visible' | 'background' | 'covered' | 'hidden';

export interface VisualizeServiceDeps {
  /** False while no desktop window can show the panel. */
  windowAvailable(): boolean;
  /** The URL a pane loads for this file (fresh after a change). */
  preparePane(target: FileTarget, cwd: string): Promise<string>;
  /** Push to the renderer: tab state, reveal requests, web URL hand-offs. */
  publish(event: DesktopVisualizeEvent): void;
  /** A scripted inline page (`chart` / `html` content): the URL of its
   *  in-memory page on the local page server. Absent = the static render. */
  prepareInlinePage?(content: VisualizeInlineContent): Promise<string>;
  /** The same change with each pane's resolved file, for paired remote clients. */
  publishHost?(event: VisualizeHostEvent): void;
  /** Throws when the browser panel cannot take a web URL. */
  browserAvailable(): boolean;
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
  /** PNG bytes of the displayed tab body. */
  capture(sessionId: string, tab: VisualizeTabView): Promise<Buffer>;
  /** Resolves once the displayed tab's HTML panes are on screen (so their
   *  problems are being captured); throws when they cannot be. */
  ensureShown?(sessionId: string, tab: VisualizeTabView): Promise<void>;
  /** Whether the user can see the displayed tab right now: `visible` (the
   *  desktop window is in front with the tab's panel uncovered, or a paired
   *  remote device is viewing it), `background` (drawn uncovered, but another
   *  app has the focus), `covered` (drawn, but an overlay in the window hides
   *  it) or `hidden` (window minimized or hidden, panel closed, session not
   *  shown). Absent = assumed visible. */
  onScreen?(sessionId: string, tab: VisualizeTabView): Promise<VisualizeScreenState>;
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
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function createVisualizeService(deps: VisualizeServiceDeps) {
  const sessions = new Map<string, SessionState>();
  const versions = deps.versions
    ? createVisualizeVersionStore({
        ...deps.versions,
        // The version a tab shows is never evicted under it.
        pinned: (sessionId, tabId) => sessions.get(sessionId)?.tabs.find((tab) => tab.id === tabId)?.shown?.n ?? null,
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

  /** Start order of opens and file reloads (`TabState.loadedStamp`). */
  let loadStamp = 0;

  // The groups below are created in dependency order; one that is created
  // later is reached through these getters only when a handler runs.
  const ctx: VisualizeServiceContext = {
    deps,
    sessions,
    sessionOf,
    delay: deps.delay ?? sleep,
    versions,
    sessionCwds: new Map(),
    pendingReloads: new Set(),
    nextLoadStamp: () => {
      loadStamp += 1;
      return loadStamp;
    },
    views: createSessionViews(sessions, sessionOf),
    get publish() {
      return publish;
    },
    get thumbnails() {
      return thumbnails;
    },
    get problems() {
      return problems;
    },
    get leases() {
      return leases;
    },
    get panes() {
      return panes;
    },
    get tabVersions() {
      return tabVersions;
    },
    get reloads() {
      return reloads;
    },
    get tabs() {
      return tabs;
    },
    get opens() {
      return opens;
    },
    get exports() {
      return exports;
    },
  };

  const thumbnails = createThumbnails(ctx);
  const publish = createPublish(ctx);
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

  return {
    /** The source text of a displayed pane (the source view). */
    paneText: reads.paneText,
    /** Bridge entry point: one validated request → result or thrown error. */
    async execute(raw: unknown): Promise<VisualizeResult> {
      const request = parseVisualizeRequest(raw);
      if (request.action === 'open') return opens.open(request);
      if (request.action === 'close') return tabs.close(request);
      if (request.action === 'annotate') return reads.annotate(request);
      if (request.action === 'export') return exports.exportToFile(request);
      if (request.action === 'check') return reads.check(request);
      if (request.action === 'inspect') return reads.inspect(request);
      return reads.capture(request);
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
    /** The marks a desktop pane frame at `url` shows (from the tab state):
     *  a page that loaded again within its revision gets them redrawn. */
    marksForFrame(url: string): Array<{ selector: string; label: string }> {
      const found = problems.paneOfUrl([url]);
      return found ? visualizePaneMarks(currentAnnotations(found.tab), found.index) : [];
    },
    /** See `createReloads`. */
    settled: reloads.settled,
    /** Every session's tabs, for a renderer that (re)loads. */
    snapshot(): VisualizeSessionState[] {
      return [...sessions.keys()]
        .map(ctx.views.stateOf)
        .filter((state) => state.tabs.length > 0 || state.history?.length);
    },
    /** Every session's tabs with their resolved files, for the remote mirror. */
    hostSnapshot(): VisualizeHostState[] {
      return [...sessions.keys()]
        .map(ctx.views.hostStateOf)
        .filter((state) => state.tabs.length > 0 || state.history?.length);
    },
    /** One panel tab as the renderer draws it (feedback finds its frames). */
    tabView(sessionId: string, tabId: string): VisualizeTabView | null {
      const tab = sessions.get(sessionId)?.tabs.find((candidate) => candidate.id === tabId && !candidate.url);
      return tab ? view(tab) : null;
    },
    /** See `createPanelCommands`. */
    command: commands.command,
    /** A paired device's PNG/PDF export (`remote-visualize.ts`): rendered like
     *  the Export menu's, into a fresh temp folder instead of a save dialog.
     *  The daemon hands the file to the device as a download and removes it.
     *  Drawn without the desktop panel wherever a pane can be, so the panel
     *  may be hidden. A failed export removes its temp folder here; a
     *  finished one is the download's to remove. */
    async exportForDevice(
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
    },
    dispose(): void {
      for (const state of sessions.values()) for (const tab of state.tabs) tabs.dispose(tab);
      sessions.clear();
    },
  };
}

export type VisualizeService = ReturnType<typeof createVisualizeService>;
