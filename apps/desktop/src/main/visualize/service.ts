/**
 * The agent `visualize` tool's desktop half: per-session side-panel tabs that
 * show produced artifacts (pages, documents, media) next to the chat. Main owns
 * the tab state; the renderer draws what `publish` sends. Electron-specific
 * work (preview URLs, frames, capture, file watching) comes in as `deps`, so
 * request handling, containment and routing stay testable without a window.
 */
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { open as openFileHandle, realpath, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, sep } from 'node:path';

import type {
  DesktopVisualizeEvent,
  DesktopVisualizeTabCommand,
  VisualizeCommandResult,
  VisualizeHostEvent,
  VisualizeHostPane,
  VisualizeHostState,
  VisualizeInlineContent,
  VisualizeHistoryItem,
  VisualizeInlineKind,
  VisualizePaneText,
  VisualizePaneView,
  VisualizeProblem,
  VisualizeSessionState,
  VisualizeTabView,
  VisualizeVersionView,
} from '../../shared/visualize';
import { MAX_VISUALIZE_SOURCE_BYTES, MAX_VISUALIZE_VERSIONS, visualizeThumbnail } from '../../shared/visualize';
import { inlineContentIsPage } from '../../shared/visualize-inline-page';
import { formatPageInspection, inspectFindingsSummary, visualizePageInspection } from '../../shared/visualize-inspect';
import { MOCKUPS_DIRECTORY, mockupSlug, resolveExportOutput, saveInlineToProject, writeExportFile } from './export';
import { type HistoryEntry, historyId, historyItems, rememberHistory } from './history';
import type { VisualizeOverlayResult } from './overlay-script';
import { localizeProblemText } from './page-problems';
import {
  createVisualizeVersionStore,
  restoreDestination,
  VersionHistoryFullError,
  versionChanges,
  type VisualizeVersionLimits,
  writeFileInside,
} from './versions';
import {
  buildProblem,
  classifyConsole,
  formatProblemsSection,
  leasePrefixOf,
  type PageConsoleReport,
  recordProblem,
} from './page-problems';
import {
  insidePath,
  OutsideWorkingDirectoryError,
  parseVisualizeRequest,
  resolveCaptureOutput,
  resolveVisualizeTarget,
  type VisualizeAnnotateOp,
  type VisualizeRequest,
  type VisualizeTarget,
} from './targets';

const MAX_TABS_PER_SESSION = 8;
const RELOAD_DEBOUNCE_MS = 300;
const ACTIVATE_SETTLE_MS = 500;
/** A page counts as settled after this long without a new problem. */
const PROBLEM_QUIET_MS = 400;
const PROBLEM_SETTLE_ROUNDS = 6;

type FileTarget = Exclude<VisualizeTarget, { kind: 'url' }>;

/** A frame that made a request or navigation: its URL and, when known, its
 *  stable id (`frameTreeNodeId`). A bare string is a URL with no frame. */
export type RequesterFrame = string | { url: string; id?: number };

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
  /** Run the overlay operation in every HTML pane of the displayed tab. */
  annotate(sessionId: string, tab: VisualizeTabView, op: VisualizeAnnotateOp): Promise<
    Array<{ pane: string; result: VisualizeOverlayResult }>
  >;
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
  /** Keep version history in this folder (the app's data folder, never a
   *  project); absent = no history. */
  versions?: { directory: string } & VisualizeVersionLimits;
  /** A downscaled PNG of the tab for its chat card (at most
   *  VISUALIZE_THUMBNAIL_MAX_BYTES), or null when none can be taken (the
   *  session is not shown and no pane file can stand in). */
  thumbnail?(sessionId: string, tab: VisualizeTabView, targets: FileTarget[]): Promise<Buffer | null>;
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
   *  HTML pane, else what the panel shows. */
  exportBytes?(sessionId: string, tab: VisualizeTabView, format: 'png' | 'pdf', pane: number): Promise<Buffer>;
  delay?(ms: number): Promise<void>;
  reloadDebounceMs?: number;
}

/** A kept version on screen in place of (or beside) the live files. */
interface ShownVersion {
  n: number;
  /** The version's snapshot folder; each pane file sits at `rels[i]` in it. */
  dir: string;
  rels: string[];
  targets: FileTarget[];
  panes: VisualizePaneView[];
  /** Its kept page assets that differ from the current files (cwd-relative):
   *  what the restore confirm lists. */
  restoreAssets: string[];
}

export interface VisualizeTabSummary {
  id: string;
  label: string;
  kind: string;
  target: string;
}

export interface VisualizeResult {
  text: string;
  tabs?: VisualizeTabSummary[];
  path?: string;
  /** The tab's page problems, when it has any (the text already lists them). */
  problems?: VisualizeProblem[];
}

interface TabState {
  id: string;
  label: string;
  /** Identity for reuse: the resolved targets in order. */
  key: string;
  cwd: string;
  revision: number;
  /** Web URL tabs live in the browser panel and carry no panes. */
  url?: string;
  targets: FileTarget[];
  panes: VisualizePaneView[];
  unwatch: Array<() => void>;
  reloadTimer: NodeJS.Timeout | null;
  /** Distinct runtime problems since the last reload (replaced, never mutated). */
  problems: VisualizeProblem[];
  /** Bumps on every report, repeats included: a page still erroring is not settled. */
  problemSeq: number;
  /** The user lifted the outside-network block for this tab's pages (for the
   *  tab's lifetime; off by default). */
  allowNetwork?: boolean;
  /** Kept versions (file tabs, with history on). */
  versions?: VisualizeVersionView[];
  /** The kept version shown instead of live (null/absent = live). */
  shown?: ShownVersion | null;
  /** The shown version sits beside the live files. */
  compare?: boolean;
  /** A file changed while a kept version was shown; reload on back to live. */
  pendingReload?: boolean;
  /** The last snapshot was skipped: the session's version history is full. */
  historyFull?: boolean;
  /** The chat card's picture (a PNG data URL). */
  thumbnail?: string;
  /** Direct-renderer tabs: the live content (no files, `targets` is empty). */
  inline?: VisualizeInlineContent;
  /** Kept contents of an inline tab, oldest first (held in memory). */
  inlineHistory?: Array<{ n: number; at: number; content: VisualizeInlineContent }>;
  /** Displayed pane indices whose inline render finished since the last open. */
  rendered?: Set<number>;
  /** Render ids already spent, with the tab revision they were issued for. */
  rendersSpent?: Map<string, number>;
}

interface SessionState {
  tabs: TabState[];
  active: string | null;
  counter: number;
  /** Everything opened this session, newest first (see history.ts). */
  history: HistoryEntry[];
}

/** Host-side deadline of an agent `export`; the bridge client's is longer. */
const EXPORT_DEADLINE_MS = 45_000;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function summary(tab: TabState): VisualizeTabSummary {
  if (tab.url) return { id: tab.id, label: tab.label, kind: 'url', target: tab.url };
  return {
    id: tab.id,
    label: tab.label,
    kind: tab.panes.length === 1 ? tab.panes[0].kind : 'split',
    target: tab.inline ? inlinePaneTarget(tab.inline) : tab.targets.map((target) => target.target).join(' | '),
  };
}

/** `summary` for an export result: file targets as project-relative paths and
 *  no host path or page-server URL in the label. */
function exportSummary(tab: TabState, cwd: string): VisualizeTabSummary {
  const base = summary(tab);
  if (tab.url) return base;
  return {
    ...base,
    label: localizeProblemText(base.label, [cwd, tab.cwd]),
    target: tab.inline ? base.target : tab.targets.map((target) => remoteTargetOf(tab.cwd, target)).join(' | '),
  };
}

const INLINE_LABELS: Record<VisualizeInlineKind, string> = {
  mermaid: 'Mermaid diagram',
  svg: 'SVG',
  chart: 'Chart',
  html: 'HTML',
  markdown: 'Markdown',
};

/** What an inline pane is called as a target (never a host path). */
const inlinePaneTarget = (content: VisualizeInlineContent): string => content.title ?? `inline ${content.kind}`;

const inlinePane = (content: VisualizeInlineContent): VisualizePaneView => ({
  kind: 'inline',
  label: content.title ?? INLINE_LABELS[content.kind],
  target: inlinePaneTarget(content),
  url: '',
  inline: content,
});

/** Reuse identity of an inline tab: its title, else its exact content. */
const inlineKey = (content: VisualizeInlineContent): string =>
  content.title
    ? `inline:${content.title}`
    : `inline:${content.kind}:${createHash('sha1').update(content.source).digest('hex')}`;

const sameInline = (a: VisualizeInlineContent, b: VisualizeInlineContent): boolean =>
  a.kind === b.kind && a.source === b.source && a.title === b.title;

/** A target as a remote client may see it: relative to the (resolved) cwd,
 *  or the file name when it is not representable that way. */
function remoteTargetOf(cwd: string, target: FileTarget): string {
  let root = cwd;
  try {
    root = realpathSync(cwd);
  } catch {
    // An unreadable cwd falls back to the file name below.
  }
  const rel = relative(root, target.path);
  if (!rel || isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) return basename(target.path);
  return rel.split(sep).join('/');
}

/** Absolute paths in free text: POSIX roots, drive letters, UNC shares, ~/. */
const ABSOLUTE_PATH = /(?:^|[\s"'`(=,:;[])(?:\/(?!\/)|[A-Za-z]:[\\/]|\\\\|~[\\/])/;

/** The tab label a remote client may see: the agent's label unless it names a
 *  host path (cwd, a raw target or any absolute path), else the panes. */
function remoteLabelOf(tab: TabState, panes: Array<{ target: string; remoteTarget: string }>): string {
  const fallback = panes.map((pane) => pane.remoteTarget).join(' · ');
  const label = tab.label;
  const named = [tab.cwd, ...panes.filter((pane) => isAbsolute(pane.target)).map((pane) => pane.target)];
  if (ABSOLUTE_PATH.test(label) || named.some((path) => path && label.includes(path))) return fallback;
  return label;
}

/** Compare layout: version pane, live pane, version pane, live pane… */
function interleave<T>(shown: T[], live: T[]): T[] {
  return shown.flatMap((pane, index) => (live[index] ? [pane, live[index]] : [pane]));
}

/** What the tab draws: live panes, a kept version's, or both interleaved. */
function displayedPanes(tab: TabState): VisualizePaneView[] {
  const shown = tab.shown;
  if (!shown) return tab.panes;
  const old = shown.panes.map((pane) => ({ ...pane, version: shown.n }));
  return tab.compare ? interleave(old, tab.panes) : old;
}

function versionFields(tab: TabState): Pick<VisualizeTabView, 'versions' | 'version' | 'compare' | 'restoreAssets'> {
  if (!tab.versions) return {};
  return {
    versions: tab.versions,
    version: tab.shown?.n ?? null,
    ...(tab.shown && tab.compare ? { compare: true } : {}),
    ...(tab.shown?.restoreAssets.length ? { restoreAssets: tab.shown.restoreAssets } : {}),
  };
}

/** The tool result's note on a tab's history (once it has 2+ versions, or
 *  when the current files could not be kept). */
function versionNote(tab: TabState): string {
  const full = tab.historyFull
    ? " The current files were not kept as a version: this session's version history is full (close visualize tabs to free it)."
    : '';
  const list = tab.versions ?? [];
  if (list.length < 2 && !tab.shown) return full;
  const range = list.length ? ` (v${list[0].n}–v${list.at(-1)?.n})` : '';
  if (tab.shown) {
    return ` Showing kept version v${tab.shown.n} of ${list.length}${range}, read-only; live reloads wait until the user goes back to live.${full}`;
  }
  return ` ${list.length} versions kept${range}; pass input.version to show an older one.${full}`;
}

function view(tab: TabState): VisualizeTabView {
  return {
    id: tab.id,
    label: tab.label,
    revision: tab.revision,
    panes: displayedPanes(tab),
    ...(tab.problems.length ? { problems: tab.problems } : {}),
    ...(tab.allowNetwork ? { networkAllowed: true as const } : {}),
    ...versionFields(tab),
    ...(tab.thumbnail ? { thumbnail: tab.thumbnail } : {}),
  };
}

/** The tool result's problems section, appended to `text` when there is one. */
function withProblems(tab: TabState, text: string): string {
  const section = formatProblemsSection(tab.id, tab.problems, displayedPanes(tab).map((pane) => pane.label));
  return section ? `${text}\n${section}` : text;
}

const problemsOf = (tab: TabState): Pick<VisualizeResult, 'problems'> =>
  tab.problems.length ? { problems: tab.problems } : {};

export function createVisualizeService(deps: VisualizeServiceDeps) {
  const sessions = new Map<string, SessionState>();
  /** Signs the render ids issued to the desktop window. */
  const renderSecret = randomBytes(32);
  const delay = deps.delay ?? sleep;
  const versions = deps.versions
    ? createVisualizeVersionStore({
        ...deps.versions,
        // The version a tab shows is never evicted under it.
        pinned: (sessionId, tabId) =>
          sessions.get(sessionId)?.tabs.find((tab) => tab.id === tabId)?.shown?.n ?? null,
      })
    : null;

  /** Refresh every file tab's version list (eviction spans the session). */
  const syncVersions = (sessionId: string) => {
    if (!versions) return;
    for (const tab of sessions.get(sessionId)?.tabs ?? []) {
      if (tab.url || tab.inline) continue;
      tab.versions = versions
        .list(sessionId, tab.id)
        .map(({ n, at, label }) => ({ n, at, ...(label ? { label } : {}) }));
    }
  };

  /** Keep the tab's current files as a version when they changed. */
  const recordVersion = async (sessionId: string, tab: TabState, label?: string) => {
    if (!versions || tab.inline) return;
    try {
      await versions.snapshot(sessionId, tab.id, tab.cwd, tab.targets, label);
      tab.historyFull = false;
    } catch (error) {
      // The tab keeps working live; its version list stays as it was.
      if (error instanceof VersionHistoryFullError) tab.historyFull = true;
      else console.warn('visualize version snapshot failed:', (error as Error).message);
    }
    syncVersions(sessionId);
  };

  /** Kept version `n`'s page assets a restore would overwrite now. */
  const restoreAssetsOf = async (sessionId: string, tab: TabState, n: number): Promise<string[]> => {
    const version = versions?.get(sessionId, tab.id, n);
    if (!version?.assets.length) return [];
    try {
      const changes = await versionChanges(version, await realpath(tab.cwd), tab.targets.map((target) => target.path));
      return changes.filter((change) => change.asset).map((change) => change.rel);
    } catch {
      // Unlisted: a restore then refuses any changed asset until listed.
      return [];
    }
  };

  const dropVersions = (sessionId: string, tabId: string) => {
    void versions?.drop(sessionId, tabId).catch(() => {});
  };

  const sessionOf = (sessionId: string): SessionState => {
    let state = sessions.get(sessionId);
    if (!state) {
      state = { tabs: [], active: null, counter: 0, history: [] };
      sessions.set(sessionId, state);
    }
    return state;
  };

  /** One render instance's id: bound to this service's secret, the session,
   *  the tab, its revision (every remount bumps it), the displayed pane and
   *  the version it shows. Issued with the tab state, never guessable. */
  const renderIdOf = (sessionId: string, tab: TabState, index: number, pane: VisualizePaneView): string =>
    createHmac('sha256', renderSecret)
      .update([sessionId, tab.id, tab.revision, index, pane.version ?? 'live'].join('\0'))
      .digest('base64url');

  const withRenderIds = (sessionId: string, tab: TabState, tabView: VisualizeTabView): VisualizeTabView => ({
    ...tabView,
    panes: tabView.panes.map((pane, index) =>
      pane.kind === 'inline' ? { ...pane, renderId: renderIdOf(sessionId, tab, index, pane) } : pane
    ),
  });

  /** The "All visuals" list: what the session opened, open tabs marked. */
  const historyOf = (sessionId: string, remote: boolean): VisualizeHistoryItem[] => {
    const state = sessions.get(sessionId);
    if (!state) return [];
    const open = new Map(state.tabs.filter((tab) => !tab.url).map((tab) => [tab.key, tab.versions?.length ?? 1]));
    return historyItems(state.history, open, remote);
  };

  /** Remember `tab` in its session's history (moved to the front when
   *  `touch`: it was just opened). Web pages are not visuals. */
  const rememberTab = (sessionId: string, tab: TabState, touch: boolean) => {
    if (tab.url) return;
    const state = sessionOf(sessionId);
    const previous = state.history.find((entry) => entry.key === tab.key);
    const live = tab.inline
      ? tab.panes.map((pane) => ({ target: pane.target, remoteTarget: pane.target }))
      : tab.targets.map((target) => ({ target: target.target, remoteTarget: remoteTargetOf(tab.cwd, target) }));
    const entry: HistoryEntry = {
      id: historyId(tab.key),
      key: tab.key,
      label: tab.label,
      remoteLabel: remoteLabelOf(tab, live),
      kind: tab.inline ? tab.inline.kind : tab.panes.length === 1 ? tab.panes[0].kind : 'split',
      targets: tab.inline ? [] : tab.targets.map((target) => target.target),
      ...(tab.inline ? { content: tab.inline } : {}),
      at: touch || !previous ? Date.now() : previous.at,
      versions: tab.versions?.length ?? 1,
    };
    if (touch || !previous) state.history = rememberHistory(state.history, entry);
    else state.history = state.history.map((candidate) => (candidate === previous ? entry : candidate));
  };

  const stateOf = (sessionId: string): VisualizeSessionState => {
    const state = sessions.get(sessionId);
    // Only the desktop window gets render ids (remote states are built from
    // the host state, which carries none).
    const tabs = (state?.tabs ?? []).filter((tab) => !tab.url).map((tab) => withRenderIds(sessionId, tab, view(tab)));
    const active = state?.active && tabs.some((tab) => tab.id === state.active) ? state.active : (tabs.at(-1)?.id ?? null);
    const history = historyOf(sessionId, false);
    return { sessionId, tabs, active, ...(history.length ? { history } : {}) };
  };

  const hostStateOf = (sessionId: string): VisualizeHostState => {
    const { tabs: views, active } = stateOf(sessionId);
    const tabs = (sessions.get(sessionId)?.tabs ?? []).filter((tab) => !tab.url);
    const history = historyOf(sessionId, true);
    return {
      sessionId,
      active,
      ...(history.length ? { history } : {}),
      tabs: views.map((view, index) => {
        const tab = tabs[index];
        // Inline panes carry their content, not a file: no host path at all.
        const inlineHost = (pane: VisualizePaneView, extra: Partial<VisualizeHostPane> = {}): VisualizeHostPane => ({
          kind: pane.kind,
          label: pane.label,
          target: pane.target,
          path: '',
          remoteTarget: pane.target,
          ...(pane.inline ? { inline: pane.inline } : {}),
          ...extra,
        });
        const live = tab.inline
          ? tab.panes.map((pane) => inlineHost(pane))
          : tab.targets.map((target) => ({
              kind: target.kind,
              label: target.label,
              target: target.target,
              path: target.path,
              remoteTarget: remoteTargetOf(tab.cwd, target),
            }));
        // A kept version's panes are served from its snapshot folder.
        const shown = tab.shown;
        const old = shown && tab.inline
          ? shown.panes.map((pane) => inlineHost(pane, { version: shown.n }))
          : shown
          ? shown.targets.map((target, pane) => ({
              kind: target.kind,
              label: target.label,
              target: target.target,
              path: target.path,
              remoteTarget: shown.rels[pane],
              root: shown.dir,
              version: shown.n,
            }))
          : [];
        const panes = !shown ? live : tab.compare ? interleave<VisualizeHostPane>(old, live) : old;
        return {
          ...view,
          remoteLabel: remoteLabelOf(tab, live),
          cwd: tab.cwd,
          panes,
        };
      }),
    };
  };

  const publish = (sessionId: string, reveal = false) => {
    deps.publish({ sessionId, state: stateOf(sessionId), ...(reveal ? { reveal: true } : {}) });
    deps.publishHost?.({ sessionId, state: hostStateOf(sessionId), ...(reveal ? { reveal: true } : {}) });
  };

  /** Each scheduled file-change reload, from its debounce until it finished
   *  (or was superseded/cancelled): what `settled()` waits for. */
  const pendingReloads = new Set<Promise<void>>();
  const reloadSettlers = new WeakMap<TabState, () => void>();
  const cancelScheduledReload = (tab: TabState) => {
    if (tab.reloadTimer) clearTimeout(tab.reloadTimer);
    tab.reloadTimer = null;
    reloadSettlers.get(tab)?.();
    reloadSettlers.delete(tab);
  };

  /** The working directory each session last opened files in (reopen from a
   *  chat card). */
  const sessionCwds = new Map<string, string>();

  /** Take the tab's chat-card picture once the shown page had time to
   *  settle; a newer reload or a closed tab drops it. Tracked by `settled()`. */
  const refreshThumbnail = (sessionId: string, tab: TabState) => {
    const take = deps.thumbnail;
    if (!take || tab.url) return;
    const revision = tab.revision;
    const current = () => sessions.get(sessionId)?.tabs.includes(tab) === true && tab.revision === revision;
    const run = (async () => {
      await delay(ACTIVATE_SETTLE_MS);
      if (!current()) return;
      const png = await take(sessionId, view(tab), tab.shown ? tab.shown.targets : tab.targets);
      const thumbnail = png?.length ? visualizeThumbnail(`data:image/png;base64,${png.toString('base64')}`) : '';
      if (!thumbnail || !current()) return;
      tab.thumbnail = thumbnail;
      publish(sessionId);
    })().catch((error: unknown) => {
      console.warn('visualize thumbnail failed:', (error as Error).message);
    });
    pendingReloads.add(run);
    void run.then(() => pendingReloads.delete(run));
  };

  /** A tab that was not on screen when its picture was due (another tab
   *  opened right after it) gets it once it is shown. */
  const thumbnailWhenMissing = (sessionId: string, tab: TabState) => {
    if (!tab.thumbnail) refreshThumbnail(sessionId, tab);
  };

  const dispose = (tab: TabState) => {
    for (const stop of tab.unwatch) stop();
    tab.unwatch = [];
    cancelScheduledReload(tab);
  };

  /** Every page-server lease a tab's HTML panes were ever served from, so a
   *  page that outlives its reload (or its tab) is still held to the tab's
   *  network policy. Bounded; the oldest leases fall out first. */
  const leaseOwners = new Map<string, { sessionId: string; tab: TabState }>();
  const MAX_TRACKED_LEASES = 4096;
  const claimLeases = (sessionId: string, tab: TabState, panes: VisualizePaneView[]) => {
    for (const pane of panes) {
      const prefix = pane.kind === 'html' ? leasePrefixOf(pane.url) : '';
      if (!prefix) continue;
      leaseOwners.delete(prefix);
      leaseOwners.set(prefix, { sessionId, tab });
    }
    while (leaseOwners.size > MAX_TRACKED_LEASES) leaseOwners.delete(leaseOwners.keys().next().value as string);
  };

  /** Pane iframes by frame id (`frameTreeNodeId`, stable across the frame's
   *  navigations) → the lease they were pointed at. Ownership of a request is
   *  decided by the frame, not its current URL: a page that navigates itself
   *  to `blob:`/`data:`/`about:` is still the same pane. */
  const paneFrames = new Map<number, string>();
  const MAX_TRACKED_FRAMES = 4096;
  const setPaneFrame = (id: number, lease: string) => {
    paneFrames.delete(id);
    paneFrames.set(id, lease);
    while (paneFrames.size > MAX_TRACKED_FRAMES) paneFrames.delete(paneFrames.keys().next().value as number);
  };
  const frameEntry = (entry: RequesterFrame): { url: string; id?: number } =>
    typeof entry === 'string' ? { url: entry } : entry;
  /** The owned lease of the first frame in `chain` (the requesting frame, then
   *  its ancestors) that is, or was, a displayed lease page; '' when none. */
  const ownerLease = (chain: RequesterFrame[]): string => {
    for (const entry of chain) {
      const { url, id } = frameEntry(entry);
      const own = leasePrefixOf(url);
      if (own && leaseOwners.has(own)) {
        if (id !== undefined) setPaneFrame(id, own);
        return own;
      }
      const remembered = id === undefined ? undefined : paneFrames.get(id);
      if (remembered && leaseOwners.has(remembered)) return remembered;
    }
    return '';
  };

  const preparePanes = async (targets: FileTarget[], cwd: string): Promise<VisualizePaneView[]> =>
    Promise.all(
      targets.map(async (target) => ({
        kind: target.kind,
        label: target.label,
        target: target.target,
        url: await deps.preparePane(target, cwd),
        // What the user's panel feedback names: never a host path.
        file: remoteTargetOf(cwd, target),
      }))
    );

  const reload = async (sessionId: string, tab: TabState, versionLabel?: string) => {
    const state = sessions.get(sessionId);
    if (!state?.tabs.includes(tab)) return;
    // A kept version is on screen: live reloads wait for "Back to live".
    if (tab.shown) {
      tab.pendingReload = true;
      // What a restore would overwrite may have changed with the files.
      const shown = tab.shown;
      const restoreAssets = await restoreAssetsOf(sessionId, tab, shown.n);
      if (tab.shown === shown && restoreAssets.join('\0') !== shown.restoreAssets.join('\0')) {
        shown.restoreAssets = restoreAssets;
        publish(sessionId);
      }
      return;
    }
    try {
      // Re-resolve from the original request every time: a parent folder
      // swapped for a link must not carry the tab outside cwd.
      const targets = (await Promise.all(
        tab.targets.map((target) => resolveVisualizeTarget(tab.cwd, target.target))
      )) as FileTarget[];
      const panes = await preparePanes(targets, tab.cwd);
      if (!state.tabs.includes(tab)) return;
      const moved = targets.some((target, index) => target.path !== tab.targets[index]?.path);
      tab.targets = targets;
      tab.panes = panes;
      claimLeases(sessionId, tab, panes);
      tab.problems = [];
      tab.revision += 1;
      if (moved) {
        for (const stop of tab.unwatch) stop();
        watchTab(sessionId, tab);
      }
      await recordVersion(sessionId, tab, versionLabel);
      publish(sessionId);
      refreshThumbnail(sessionId, tab);
    } catch (error) {
      if (error instanceof OutsideWorkingDirectoryError) {
        // Fail closed: the tab stops showing anything from that path.
        console.warn('visualize tab closed:', error.message);
        closeTab(sessionId, tab.id);
        return;
      }
      // A file caught mid-write (or briefly gone) keeps its last view; the
      // next change event retries.
      console.warn('visualize reload failed:', (error as Error).message);
    }
  };

  const watchTab = (sessionId: string, tab: TabState) => {
    const schedule = () => {
      cancelScheduledReload(tab);
      let settle = () => {};
      const done = new Promise<void>((resolve) => {
        settle = resolve;
      });
      pendingReloads.add(done);
      void done.then(() => pendingReloads.delete(done));
      reloadSettlers.set(tab, settle);
      tab.reloadTimer = setTimeout(() => {
        tab.reloadTimer = null;
        reloadSettlers.delete(tab);
        void reload(sessionId, tab).finally(settle);
      }, deps.reloadDebounceMs ?? RELOAD_DEBOUNCE_MS);
      tab.reloadTimer.unref?.();
    };
    tab.unwatch = tab.targets.map((target) => deps.watch(target.path, schedule));
  };

  const findTab = (sessionId: string, id: string): TabState => {
    const state = sessions.get(sessionId);
    const tab = state?.tabs.find((candidate) => candidate.id === id);
    if (tab) return tab;
    const open = state?.tabs.map((candidate) => candidate.id) ?? [];
    throw new Error(`no visualize tab "${id}"; ${open.length ? `open tabs: ${open.join(', ')}` : 'no tabs are open'}`);
  };

  const addTab = (sessionId: string, tab: TabState) => {
    const state = sessionOf(sessionId);
    state.tabs.push(tab);
    while (state.tabs.length > MAX_TABS_PER_SESSION) {
      const evicted = state.tabs.shift();
      if (evicted) {
        rememberTab(sessionId, evicted, false);
        dispose(evicted);
        dropVersions(sessionId, evicted.id);
      }
    }
  };

  /** Show kept version `n` (null = live), beside live when `compare`. The
   *  newest version without compare is live itself. Callers publish. */
  const selectVersion = async (sessionId: string, tab: TabState, n: number | null, compare: boolean) => {
    const before = `${tab.shown?.n ?? ''}|${tab.shown && tab.compare ? 'compare' : ''}`;
    try {
      await applyVersionSelection(sessionId, tab, n, compare);
    } finally {
      // Pane indices and versions of recorded problems belong to the old
      // layout; the pages that now display start clean.
      if (before !== `${tab.shown?.n ?? ''}|${tab.shown && tab.compare ? 'compare' : ''}`) {
        tab.problems = [];
        tab.problemSeq += 1;
      }
    }
  };

  /** The pane that shows `content`: a scripted page from the page server's
   *  virtual lease for chart / html (a page pane, so it gets HTML-pane
   *  protections), else (or when no page can be served) the static render. */
  const inlinePaneFor = async (content: VisualizeInlineContent): Promise<VisualizePaneView> => {
    const pane = inlinePane(content);
    if (!deps.prepareInlinePage || !inlineContentIsPage(content)) return pane;
    try {
      return { ...pane, kind: 'html', url: await deps.prepareInlinePage(content) };
    } catch (error) {
      console.warn('visualize inline page unavailable, showing the static render:', (error as Error).message);
      return pane;
    }
  };

  /** Inline tabs keep their versions in memory: showing one needs no files. */
  const applyInlineSelection = async (sessionId: string, tab: TabState, n: number | null, compare: boolean) => {
    const history = tab.inlineHistory ?? [];
    if (n !== null) {
      const version = history.find((candidate) => candidate.n === n);
      if (!version) {
        const kept = history.length ? `kept versions: ${history.map((candidate) => candidate.n).join(', ')}` : 'it keeps no versions';
        throw new Error(`tab ${tab.id} has no version ${n}; ${kept}`);
      }
      if (version !== history.at(-1) || compare) {
        if (tab.shown?.n !== n) {
          const panes = [await inlinePaneFor(version.content)];
          tab.shown = { n, dir: '', rels: [], targets: [], panes, restoreAssets: [] };
          claimLeases(sessionId, tab, panes);
        }
        tab.compare = compare;
        tab.revision += 1;
        return;
      }
    }
    if (tab.shown) tab.revision += 1;
    tab.shown = null;
    tab.compare = false;
  };

  const applyVersionSelection = async (sessionId: string, tab: TabState, n: number | null, compare: boolean) => {
    if (tab.inline) return applyInlineSelection(sessionId, tab, n, compare);
    if (n !== null) {
      const list = versions?.list(sessionId, tab.id) ?? [];
      const version = list.find((candidate) => candidate.n === n);
      if (!version) {
        const kept = list.length ? `kept versions: ${list.map((candidate) => candidate.n).join(', ')}` : 'it keeps no versions';
        throw new Error(`tab ${tab.id} has no version ${n}; ${kept}`);
      }
      if (version !== list.at(-1) || compare) {
        const restoreAssets = await restoreAssetsOf(sessionId, tab, n);
        if (tab.shown?.n === n) {
          tab.shown.restoreAssets = restoreAssets;
        } else {
          const targets = version.panes.map((rel, pane) => ({
            ...tab.targets[pane],
            path: join(version.dir, ...rel.split('/')),
          }));
          const panes = await preparePanes(targets, version.dir);
          tab.shown = { n, dir: version.dir, rels: version.panes, targets, panes, restoreAssets };
          claimLeases(sessionId, tab, panes);
        }
        tab.compare = compare;
        tab.revision += 1;
        return;
      }
    }
    if (tab.shown) tab.revision += 1;
    tab.shown = null;
    tab.compare = false;
  };

  /** After a selection: back on live, catch up on changes made meanwhile. */
  const afterSelect = async (sessionId: string, tab: TabState) => {
    if (!tab.shown && tab.pendingReload) {
      tab.pendingReload = false;
      await reload(sessionId, tab);
      return;
    }
    publish(sessionId);
  };

  /** Write kept version `n` back over the tab's project files and the page
   *  assets kept with them, where they differ; the restored content becomes
   *  the newest version. A changed asset the user did not confirm (`confirmed`,
   *  cwd-relative) refuses the whole restore. */
  const restoreVersion = async (sessionId: string, tab: TabState, n: number, confirmed: string[]) => {
    if (tab.inline) throw new Error(`tab ${tab.id} shows inline content, which has no project file to restore`);
    const version = versions?.get(sessionId, tab.id, n);
    if (!version) throw new Error(`tab ${tab.id} has no version ${n}`);
    // Re-resolve every pane target: the restored bytes must land inside cwd.
    const targets = (await Promise.all(
      tab.targets.map((target) => resolveVisualizeTarget(tab.cwd, target.target))
    )) as FileTarget[];
    const root = await realpath(tab.cwd);
    const changes = await versionChanges(version, root, targets.map((target) => target.path));
    const unconfirmed = changes.filter((change) => change.asset && !confirmed.includes(change.rel));
    if (unconfirmed.length) {
      // Refresh the list the confirm shows, then let the user review it.
      if (tab.shown?.n === n) {
        tab.shown.restoreAssets = changes.filter((change) => change.asset).map((change) => change.rel);
        publish(sessionId);
      }
      throw new Error(
        `v${n} was not restored: it would also overwrite ${unconfirmed.map((change) => change.rel).join(', ')}, which the confirmation did not list; review and restore again`
      );
    }
    // Every destination is checked before anything is written, and each one
    // again right before its own write.
    for (const change of changes) {
      await restoreDestination(root, change.path).catch((error: Error) => {
        throw new Error(`v${n} was not restored: ${error.message}`);
      });
    }
    const restored: string[] = [];
    for (const change of changes) {
      try {
        await writeFileInside(root, change.path, change.data);
      } catch (error) {
        const partial = restored.length ? `; already restored: ${restored.join(', ')}` : '';
        throw new Error(`restoring v${n} stopped at ${change.rel}: ${(error as Error).message}${partial}`);
      }
      restored.push(change.rel);
    }
    if (tab.shown) tab.revision += 1;
    tab.shown = null;
    tab.compare = false;
    tab.pendingReload = false;
    await reload(sessionId, tab, `Restored from v${n}`);
  };

  /** Make `tab` the displayed one; resolves once a newly shown tab had time
   *  to mount and load. */
  const display = async (sessionId: string, tab: TabState) => {
    const state = sessionOf(sessionId);
    if (state.active === tab.id) return;
    state.active = tab.id;
    publish(sessionId);
    await delay(ACTIVATE_SETTLE_MS);
  };

  /** Wait until no problem was reported (and no reload is pending) for one
   *  quiet interval, at most `rounds` intervals. */
  const settle = async (tab: TabState, rounds: number) => {
    for (let round = 0; round < rounds; round += 1) {
      const seen = tab.problemSeq;
      await delay(PROBLEM_QUIET_MS);
      if (tab.problemSeq === seen && !tab.reloadTimer) return;
    }
  };

  const rootsByCwd = new Map<string, string[]>();
  const rootsOf = (cwd: string): string[] => {
    let roots = rootsByCwd.get(cwd);
    if (!roots) {
      let real = cwd;
      try {
        real = realpathSync(cwd);
      } catch {
        // An unreadable cwd is still stripped as given.
      }
      roots = real === cwd ? [cwd] : [cwd, real];
      rootsByCwd.set(cwd, roots);
    }
    return roots;
  };

  /** The tab and HTML pane whose page-server lease any of `urls` belongs to,
   *  among the panes the tab displays (a kept version's, compare layout
   *  included): `index` is the displayed index, `version` the kept version. */
  const paneOfUrl = (
    urls: string[]
  ): { sessionId: string; tab: TabState; index: number; version?: number } | null => {
    for (const [sessionId, state] of sessions) {
      for (const tab of state.tabs) {
        const panes = displayedPanes(tab);
        const index = panes.findIndex((pane) => {
          const prefix = pane.kind === 'html' ? leasePrefixOf(pane.url) : '';
          return prefix !== '' && urls.some((url) => url.startsWith(prefix));
        });
        if (index >= 0) return { sessionId, tab, index, version: panes[index].version };
      }
    }
    return null;
  };

  const recordPageProblem = (
    found: { sessionId: string; tab: TabState; index: number; version?: number },
    draft: { kind: VisualizeProblem['kind']; message: string; source: string; line: number }
  ) => {
    const { sessionId, tab, index, version } = found;
    const next = recordProblem(tab.problems, buildProblem({ ...draft, pane: index, version }, rootsOf(tab.cwd)));
    tab.problems = next.list;
    tab.problemSeq += 1;
    if (next.added) publish(sessionId);
  };

  /** The panel finished rendering inline pane `index` (of the displayed
   *  panes); a failure becomes a page problem like any other. */
  const reportInlineRender = (sessionId: string, tab: TabState, index: number, renderId: string, error?: string) => {
    const pane = displayedPanes(tab)[index];
    if (pane?.kind !== 'inline' || !pane.inline) return;
    // One report per render instance of exactly this tab / version / session;
    // anything else (a stale, repeated or foreign id) is ignored.
    const expected = renderIdOf(sessionId, tab, index, pane);
    const spent = (tab.rendersSpent ??= new Map());
    if (renderId !== expected || spent.has(expected)) return;
    for (const [id, revision] of spent) if (revision !== tab.revision) spent.delete(id);
    spent.set(expected, tab.revision);
    tab.rendered?.add(index);
    tab.problemSeq += 1;
    if (!error) return;
    recordPageProblem(
      { sessionId, tab, index, version: pane.version },
      { kind: 'render', message: `The ${pane.inline.kind} could not be rendered: ${error.replace(/\s+/g, ' ').trim()}`, source: pane.label, line: 0 }
    );
  };

  /** Wait (bounded) until the panel reports every inline pane of the tab
   *  rendered, then until it stops reporting problems, so a failed render
   *  rides the tool result. */
  const awaitInlineRender = async (tab: TabState) => {
    // Only static panes report a render; scripted pages report problems as pages do.
    const pending = () => displayedPanes(tab).some((pane, index) => pane.kind === 'inline' && !tab.rendered?.has(index));
    for (let round = 0; round < PROBLEM_SETTLE_ROUNDS && pending(); round += 1) await delay(PROBLEM_QUIET_MS);
  };

  /** `open` with `input.content`: a direct-renderer tab, no files. Reopening
   *  the same title keeps the tab and adds a version when the content changed. */
  async function openInline(
    request: Extract<VisualizeRequest, { action: 'open' }>,
    content: VisualizeInlineContent
  ): Promise<VisualizeResult> {
    const { sessionId, cwd } = request;
    const state = sessionOf(sessionId);
    const key = inlineKey(content);
    let tab = state.tabs.find((candidate) => candidate.key === key);
    const pane = await inlinePaneFor(content);
    if (tab) {
      tab.label = request.label ?? tab.label;
      tab.cwd = cwd;
      tab.inline = content;
      tab.panes = [pane];
      tab.problems = [];
      tab.revision += 1;
      state.tabs.splice(state.tabs.indexOf(tab), 1);
      state.tabs.push(tab);
    } else {
      state.counter += 1;
      tab = {
        id: `v${state.counter}`,
        label: request.label ?? pane.label,
        key,
        cwd,
        revision: 0,
        inline: content,
        inlineHistory: [],
        targets: [],
        panes: [pane],
        unwatch: [],
        reloadTimer: null,
        problems: [],
        problemSeq: 0,
      };
      addTab(sessionId, tab);
    }
    tab.rendered = new Set();
    tab.shown = null;
    tab.compare = false;
    claimLeases(sessionId, tab, tab.panes);
    const history = tab.inlineHistory ?? [];
    if (!history.length || !sameInline(history[history.length - 1].content, content)) {
      history.push({ n: (history.at(-1)?.n ?? 0) + 1, at: Date.now(), content });
      if (history.length > MAX_VISUALIZE_VERSIONS) history.shift();
    }
    tab.inlineHistory = history;
    tab.versions = history.map(({ n, at }) => ({ n, at }));
    let versionError: Error | null = null;
    if (request.version !== undefined) {
      try {
        await selectVersion(sessionId, tab, request.version, false);
      } catch (error) {
        versionError = error as Error;
      }
    }
    state.active = tab.id;
    rememberTab(sessionId, tab, true);
    publish(sessionId, true);
    if (versionError) throw new Error(`${versionError.message}; tab ${tab.id} shows the live content`);
    await awaitInlineRender(tab);
    // A scripted page gets a moment to load, so its first errors ride this result.
    if (displayedPanes(tab).some((candidate) => candidate.kind === 'html')) await settle(tab, 1);
    sessionCwds.set(sessionId, cwd);
    refreshThumbnail(sessionId, tab);
    return {
      text: withProblems(
        tab,
        `Showing inline ${content.kind}${content.title ? ` "${content.title}"` : ''} in the side panel as tab ${tab.id}. Open again with the same title to add a version.${versionNote(tab)}`
      ),
      tabs: [summary(tab)],
      ...problemsOf(tab),
    };
  }

  async function open(request: Extract<VisualizeRequest, { action: 'open' }>): Promise<VisualizeResult> {
    if (!deps.windowAvailable()) throw new Error('the Mixdog desktop window is not open');
    if (request.content) return openInline(request, request.content);
    const { sessionId, cwd } = request;
    const targets = await Promise.all(request.targets.map((target) => resolveVisualizeTarget(cwd, target)));
    const web = targets.filter((target) => target.kind === 'url');
    if (web.length) {
      if (targets.length > 1) {
        throw new Error('a web URL opens alone in the browser panel; pass it as the only target');
      }
      if (request.version !== undefined) throw new Error('input.version applies to file tabs; a web URL keeps no versions');
      const target = web[0];
      if (!deps.browserAvailable()) {
        throw new Error('web URLs open in the browser panel, which needs the Browser Use feature installed');
      }
      deps.publish({ sessionId, openUrl: target.url });
      deps.publishHost?.({ sessionId, openUrl: target.url });
      const state = sessionOf(sessionId);
      let tab = state.tabs.find((candidate) => candidate.url === target.url);
      if (!tab) {
        state.counter += 1;
        tab = {
          id: `v${state.counter}`,
          label: request.label ?? target.label,
          key: `url:${target.url}`,
          cwd,
          revision: 0,
          url: target.url,
          targets: [],
          panes: [],
          unwatch: [],
          reloadTimer: null,
          problems: [],
          problemSeq: 0,
        };
        addTab(sessionId, tab);
      }
      return { text: `Opened ${target.url} in the session's browser panel (tab ${tab.id}).`, tabs: [summary(tab)] };
    }
    const files = targets as FileTarget[];
    const key = files.map((target) => target.path).join('\0');
    const panes = await preparePanes(files, cwd);
    const state = sessionOf(sessionId);
    let tab = state.tabs.find((candidate) => candidate.key === key);
    const label = request.label ?? files.map((target) => target.label).join(' · ');
    if (tab) {
      dispose(tab);
      tab.label = request.label ?? tab.label;
      tab.cwd = cwd;
      tab.targets = files;
      tab.panes = panes;
      tab.problems = [];
      tab.revision += 1;
      // Reopening moves the tab to the end, like a fresh open.
      state.tabs.splice(state.tabs.indexOf(tab), 1);
      state.tabs.push(tab);
    } else {
      state.counter += 1;
      tab = {
        id: `v${state.counter}`,
        label,
        key,
        cwd,
        revision: 0,
        targets: files,
        panes,
        unwatch: [],
        reloadTimer: null,
        problems: [],
        problemSeq: 0,
      };
      addTab(sessionId, tab);
    }
    claimLeases(sessionId, tab, panes);
    watchTab(sessionId, tab);
    // An agent open shows the live files; a kept version only on request.
    if (tab.shown) tab.revision += 1;
    tab.shown = null;
    tab.compare = false;
    tab.pendingReload = false;
    await recordVersion(sessionId, tab);
    let versionError: Error | null = null;
    if (request.version !== undefined) {
      try {
        await selectVersion(sessionId, tab, request.version, false);
      } catch (error) {
        versionError = error as Error;
      }
    }
    state.active = tab.id;
    rememberTab(sessionId, tab, true);
    publish(sessionId, true);
    if (versionError) throw new Error(`${versionError.message}; tab ${tab.id} shows the live files`);
    const shown = files
      .map((target) => `${relative(cwd, target.path).replace(/\\/g, '/') || target.label} (${target.kind})`)
      .join(', ');
    // Give a fresh page a moment to load, so its first errors ride this result.
    if (panes.some((pane) => pane.kind === 'html')) await settle(tab, 1);
    sessionCwds.set(sessionId, cwd);
    refreshThumbnail(sessionId, tab);
    return {
      text: withProblems(
        tab,
        `Showing ${shown} in the side panel as tab ${tab.id}. The tab reloads when ${files.length > 1 ? 'these files change' : 'the file changes'}.${versionNote(tab)}`
      ),
      tabs: [summary(tab)],
      ...problemsOf(tab),
    };
  }

  function close(request: Extract<VisualizeRequest, { action: 'close' }>): VisualizeResult {
    const { sessionId } = request;
    const state = sessions.get(sessionId);
    if (request.tab) {
      const tab = findTab(sessionId, request.tab);
      // The page itself belongs to the browser panel; visualize cannot close it.
      if (tab.url) throw new Error(`tab ${tab.id} is a page in the browser panel (${tab.url}); close it with the browser tool`);
      const count = tab.versions?.length ?? 0;
      closeTab(sessionId, tab.id);
      const history = count > 1 ? ` Its ${count} kept versions were discarded.` : '';
      return { text: `Closed visualize tab ${tab.id}.${history}`, tabs: (state?.tabs ?? []).map(summary) };
    }
    const closing = (state?.tabs ?? []).filter((tab) => !tab.url);
    const browserPages = (state?.tabs ?? []).filter((tab) => tab.url);
    const histories = closing
      .filter((tab) => (tab.versions?.length ?? 0) > 1)
      .map((tab) => `${tab.id} (${tab.versions?.length} versions)`);
    for (const tab of closing) {
      rememberTab(sessionId, tab, false);
      dispose(tab);
      dropVersions(sessionId, tab.id);
    }
    // The session entry stays (empty): its tab counter must not restart, or
    // a new tab would take the id an older chat card still names.
    if (state) {
      state.tabs = browserPages;
      state.active = null;
    }
    publish(sessionId);
    const count = closing.length;
    const closed = count ? `Closed ${count} visualize tab${count === 1 ? '' : 's'}.` : 'No visualize tabs were open.';
    const kept = browserPages.length
      ? ` Still open in the browser panel: ${browserPages.map((tab) => `${tab.id} (${tab.url})`).join(', ')}; close those with the browser tool.`
      : '';
    const discarded = histories.length ? ` Discarded the version history of ${histories.join(', ')}.` : '';
    return { text: `${closed}${discarded}${kept}`, tabs: browserPages.map(summary) };
  }

  function closeTab(sessionId: string, tabId: string): void {
    const state = sessions.get(sessionId);
    const tab = state?.tabs.find((candidate) => candidate.id === tabId);
    if (!state || !tab) return;
    rememberTab(sessionId, tab, false);
    dispose(tab);
    dropVersions(sessionId, tab.id);
    state.tabs.splice(state.tabs.indexOf(tab), 1);
    if (state.active === tab.id) state.active = state.tabs.filter((candidate) => !candidate.url).at(-1)?.id ?? null;
    publish(sessionId);
    const shown = state.tabs.find((candidate) => candidate.id === state.active);
    if (shown) thumbnailWhenMissing(sessionId, shown);
  }

  async function annotate(request: Extract<VisualizeRequest, { action: 'annotate' }>): Promise<VisualizeResult> {
    const tab = findTab(request.sessionId, request.tab);
    if (tab.url || !tab.panes.some((pane) => pane.kind === 'html')) {
      throw new Error(`annotate works on HTML tabs only; tab ${tab.id} shows no HTML page`);
    }
    await display(request.sessionId, tab);
    const results = await deps.annotate(request.sessionId, view(tab), request.op);
    const lines = results.map(({ pane, result }) => {
      const marks = result.marks.length
        ? result.marks
            .map((mark) => `${mark.selector}${mark.label ? ` "${mark.label}"` : ''} → ${mark.count} match${mark.count === 1 ? '' : 'es'}`)
            .join('; ')
        : 'no marks';
      const invalid = result.invalid.length ? ` · invalid selector(s): ${result.invalid.join(', ')}` : '';
      return `${pane}: ${marks}${invalid}`;
    });
    return {
      text: withProblems(tab, [`Annotations on tab ${tab.id} (cleared when the page reloads):`, ...lines].join('\n')),
      tabs: [summary(tab)],
      ...problemsOf(tab),
    };
  }

  async function capture(request: Extract<VisualizeRequest, { action: 'capture' }>): Promise<VisualizeResult> {
    const tab = findTab(request.sessionId, request.tab);
    if (tab.url) throw new Error(`tab ${tab.id} lives in the browser panel; capture it with the browser tool`);
    const output = await resolveCaptureOutput(request.cwd, request.output);
    await display(request.sessionId, tab);
    const png = await deps.capture(request.sessionId, view(tab));
    await writeFile(output, png);
    return { text: withProblems(tab, `Captured tab ${tab.id} to ${output}.`), tabs: [summary(tab)], path: output, ...problemsOf(tab) };
  }

  /** The page an agent export renders: live `tab.panes`, or kept `version`'s
   *  snapshot (prepared for this render only; the tab's own view is untouched). */
  async function exportPanes(sessionId: string, tab: TabState, version: number | undefined): Promise<VisualizePaneView[]> {
    if (version === undefined) return tab.panes;
    const missing = (kept: number[]) =>
      new Error(`tab ${tab.id} has no version ${version}; ${kept.length ? `kept versions: ${kept.join(', ')}` : 'it keeps no versions'}`);
    if (tab.inline) {
      const history = tab.inlineHistory ?? [];
      const found = history.find((candidate) => candidate.n === version);
      if (!found) throw missing(history.map((candidate) => candidate.n));
      return [await inlinePaneFor(found.content)];
    }
    const list = versions?.list(sessionId, tab.id) ?? [];
    const found = list.find((candidate) => candidate.n === version);
    if (!found) throw missing(list.map((candidate) => candidate.n));
    const targets = found.panes.map((rel, pane) => ({ ...tab.targets[pane], path: join(found.dir, ...rel.split('/')) }));
    return preparePanes(targets, found.dir);
  }

  /** The agent's `export`: tab (or one kept version of it) → PNG / PDF file
   *  inside the project. A single HTML page (file, inline html/chart) is
   *  rendered whole in a hidden window, so the tab need not be on screen;
   *  anything else falls back to `capture`'s view of the displayed tab.
   *  The whole request has one host deadline: when it passes, the hidden
   *  window is destroyed and nothing is written. Errors and results carry
   *  project-relative paths only. */
  async function exportToFile(request: Extract<VisualizeRequest, { action: 'export' }>): Promise<VisualizeResult> {
    const controller = new AbortController();
    const limit = deps.exportDeadlineMs ?? EXPORT_DEADLINE_MS;
    const timedOut = () => new Error(`export timed out after ${Math.round(limit / 1000)}s; no file was written`);
    let timer: NodeJS.Timeout | undefined;
    let committed = false;
    const expired = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        if (committed) return;
        controller.abort();
        reject(timedOut());
      }, limit);
    });
    // Called right before the write: past the deadline nothing is written;
    // before it, the write is no longer cut short.
    const commit = () => {
      if (controller.signal.aborted) throw timedOut();
      committed = true;
      clearTimeout(timer);
    };
    const work = exportWork(request, controller.signal, commit);
    work.catch(() => {});
    try {
      return await Promise.race([work, expired]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(localizeProblemText(message, [request.cwd]));
    } finally {
      clearTimeout(timer);
    }
  }

  async function exportWork(
    request: Extract<VisualizeRequest, { action: 'export' }>,
    signal: AbortSignal,
    commit: () => void
  ): Promise<VisualizeResult> {
    const { format, version } = request;
    const tab = findTab(request.sessionId, request.tab);
    if (tab.url) throw new Error(`tab ${tab.id} lives in the browser panel; capture it with the browser tool`);
    const rel = await resolveExportOutput(request.cwd, request.output, format);
    const panes = await exportPanes(request.sessionId, tab, version);
    const page = panes.length === 1 && panes[0].kind === 'html' ? panes[0] : null;
    if (format === 'pdf' && !page) throw new Error(`Save as PDF is for a single HTML page; tab ${tab.id} shows no such page (export png instead)`);
    if (version !== undefined && !page) throw new Error(`exporting a kept version needs a single HTML page; tab ${tab.id} version ${version} is not one`);
    let data: Buffer;
    let problemLines: string[] = [];
    let how: string;
    if (page) {
      if (!deps.renderExport) throw new Error('exporting to a file is unavailable');
      ({ data, problems: problemLines } = await deps.renderExport(page, format, tab.allowNetwork === true, {
        roots: [request.cwd, tab.cwd],
        signal,
      }));
      how = 'rendered off screen: the tab did not need to be on screen';
    } else {
      await display(request.sessionId, tab);
      data = await deps.capture(request.sessionId, view(tab));
      how = 'captured as the panel shows it';
    }
    commit();
    await writeExportFile(request.cwd, rel, data, { overwrite: request.overwrite });
    const size =
      format === 'png' && data.length >= 24 && data.toString('latin1', 1, 4) === 'PNG'
        ? `${data.readUInt32BE(16)}×${data.readUInt32BE(20)} px, `
        : '';
    const kb = data.length < 1024 ? `${data.length} B` : `${(data.length / 1024).toFixed(1)} KB`;
    const text = `Exported tab ${tab.id}${version === undefined ? '' : ` v${version}`} to ${rel} (${format}, ${size}${kb}; ${how}).`;
    const problems = problemLines.length ? `\nPage problems during the render:\n${problemLines.map((line) => `- ${line}`).join('\n')}` : '';
    return {
      text: page ? `${text}${problems}` : withProblems(tab, text),
      tabs: [exportSummary(tab, request.cwd)],
      path: rel,
      ...(page ? {} : problemsOf(tab)),
    };
  }

  async function check(request: Extract<VisualizeRequest, { action: 'check' }>): Promise<VisualizeResult> {
    const tab = findTab(request.sessionId, request.tab);
    if (tab.url || !displayedPanes(tab).some((pane) => pane.kind === 'html' || pane.inline)) {
      throw new Error(`check works on HTML tabs only; tab ${tab.id} shows no HTML page`);
    }
    await display(request.sessionId, tab);
    await awaitInlineRender(tab);
    if (displayedPanes(tab).some((pane) => pane.kind === 'html')) await deps.ensureShown?.(request.sessionId, view(tab));
    await settle(tab, PROBLEM_SETTLE_ROUNDS);
    const findings = inspectFindingsSummary(await layoutFindingCount(request.sessionId, tab));
    return {
      text:
        (tab.problems.length ? withProblems(tab, `Checked tab ${tab.id}.`) : `No page problems on tab ${tab.id}.`) +
        (findings ? `\n${findings}` : ''),
      tabs: [summary(tab)],
      ...problemsOf(tab),
    };
  }

  /** Layout findings on the displayed pages (0 when they cannot be read:
   *  `check` stays about runtime problems). */
  async function layoutFindingCount(sessionId: string, tab: TabState): Promise<number> {
    if (!deps.inspect || !displayedPanes(tab).some((pane) => pane.kind === 'html')) return 0;
    try {
      const answers = await deps.inspect(sessionId, view(tab), {});
      return answers.reduce((sum, { result }) => {
        const parsed = visualizePageInspection(result);
        return parsed && !('error' in parsed) ? sum + parsed.findingCount : sum;
      }, 0);
    } catch {
      return 0;
    }
  }

  async function inspect(request: Extract<VisualizeRequest, { action: 'inspect' }>): Promise<VisualizeResult> {
    const tab = findTab(request.sessionId, request.tab);
    if (tab.url) throw new Error(`tab ${tab.id} lives in the browser panel; read it with the browser tool`);
    const panes = displayedPanes(tab);
    if (!panes.some((pane) => pane.kind === 'html')) {
      const staticKind = panes.find((pane) => pane.inline)?.inline?.kind;
      throw new Error(
        staticKind
          ? `inspect reads pages with a layout; tab ${tab.id} shows static ${staticKind} content, which has no elements to read (use capture to look at it)`
          : `inspect works on HTML tabs only; tab ${tab.id} shows no HTML page`
      );
    }
    if (!deps.inspect) throw new Error('inspect is unavailable here');
    await display(request.sessionId, tab);
    await awaitInlineRender(tab);
    // The reader checks the tab is on screen itself (and says when only a
    // remote device shows it); page problems are captured while it is.
    const answers = await deps.inspect(request.sessionId, view(tab), {
      ...(request.viewport ? { viewport: request.viewport } : {}),
      ...(request.selector ? { selector: request.selector } : {}),
    });
    await settle(tab, 2);
    const sections = answers.map(({ pane, result }) => {
      const parsed = visualizePageInspection(result);
      if (!parsed) return `${pane}: the page returned no reading`;
      if ('error' in parsed) return `${pane}: ${parsed.error}`;
      return formatPageInspection(parsed, pane);
    });
    return {
      text: withProblems(tab, `Inspection of tab ${tab.id}${request.viewport ? ` at ${request.viewport.width}×${request.viewport.height}` : ''}:\n${sections.join('\n\n')}`),
      tabs: [summary(tab)],
      ...problemsOf(tab),
    };
  }

  /** Open `targets` (or inline `content`) again in the session's last working
   *  directory: the working directory is main's to know, never the client's,
   *  and the targets are validated exactly like an agent open. */
  async function reopen(
    sessionId: string,
    targets: string[],
    content: VisualizeInlineContent | undefined,
    label: string | undefined
  ): Promise<void> {
    const cwd = sessionCwds.get(sessionId) ?? (await deps.sessionCwd?.(sessionId)) ?? null;
    if (!cwd) throw new Error("the session's working directory is unknown; ask the agent to show it again");
    await open(
      parseVisualizeRequest({
        sessionId,
        cwd,
        action: 'open',
        input: { ...(content ? { content } : { targets }), ...(label ? { label } : {}) },
      }) as Extract<VisualizeRequest, { action: 'open' }>
    );
  }

  /** The panel's Export menu: `project` saves inline content under
   *  design/mockups/ in the working directory; `png` / `pdf` go through the
   *  OS save dialog (desktop window only; the remote path refuses them). */
  async function exportTab(
    sessionId: string,
    tab: TabState,
    format: 'png' | 'pdf' | 'project',
    paneIndex: number
  ): Promise<VisualizeCommandResult> {
    const pane = displayedPanes(tab)[paneIndex];
    if (!pane) throw new Error(`tab ${tab.id} has no pane ${paneIndex}`);
    if (format === 'project') {
      if (!pane.inline) throw new Error('only inline content can be saved to the project; a file tab already is a project file');
      const saved = await saveInlineToProject(tab.cwd, pane.inline, tab.label);
      return { path: saved.rel, openable: saved.openable };
    }
    if (!deps.chooseExportPath || !deps.exportBytes) throw new Error('exporting to a file is unavailable');
    if (format === 'pdf' && pane.kind !== 'html') throw new Error('Save as PDF is for HTML pages');
    const name = `${mockupSlug(pane.inline?.title ?? tab.label, pane.inline?.kind ?? 'visual')}.${format}`;
    const target = await deps.chooseExportPath({
      sessionId,
      directory: join(tab.cwd, ...MOCKUPS_DIRECTORY.split('/')),
      fallback: tab.cwd,
      name,
      format,
    });
    if (!target) return { canceled: true };
    await writeFile(target, await deps.exportBytes(sessionId, view(tab), format, paneIndex));
    return { path: target };
  }

  /** The source text of displayed pane `index`: inline content as given, an
   *  HTML file as read now (a kept version from its snapshot), capped. */
  async function paneText(sessionId: string, tabId: string, index: number): Promise<VisualizePaneText> {
    const tab = findTab(sessionId, tabId);
    const pane = displayedPanes(tab)[index];
    if (!pane || tab.url) throw new Error(`tab ${tab.id} has no pane ${index}`);
    if (pane.inline) return { text: pane.inline.source, truncated: false };
    if (pane.kind !== 'html') throw new Error('only HTML pages and inline content have a source view');
    const shown = tab.shown;
    const live = tab.targets.map((target) => ({ target, root: tab.cwd }));
    const old = shown?.targets.map((target) => ({ target, root: shown.dir })) ?? [];
    const entry = (!shown ? live : tab.compare ? interleave(old, live) : old)[index];
    if (!entry) throw new Error(`tab ${tab.id} has no pane ${index}`);
    // Re-resolved on every read: a link swapped in must not leave the root.
    const [file, root] = await Promise.all([realpath(entry.target.path), realpath(entry.root)]);
    if (!insidePath(root, file)) throw new OutsideWorkingDirectoryError('target', entry.target.target);
    const handle = await openFileHandle(file, 'r');
    try {
      const size = (await handle.stat()).size;
      const buffer = Buffer.alloc(Math.min(size, MAX_VISUALIZE_SOURCE_BYTES));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      return { text: buffer.subarray(0, bytesRead).toString('utf8'), truncated: size > MAX_VISUALIZE_SOURCE_BYTES };
    } finally {
      await handle.close();
    }
  }

  return {
    /** The source text of a displayed pane (the source view). */
    paneText,
    /** Bridge entry point: one validated request → result or thrown error. */
    async execute(raw: unknown): Promise<VisualizeResult> {
      const request = parseVisualizeRequest(raw);
      if (request.action === 'open') return open(request);
      if (request.action === 'close') return close(request);
      if (request.action === 'annotate') return annotate(request);
      if (request.action === 'export') return exportToFile(request);
      if (request.action === 'check') return check(request);
      if (request.action === 'inspect') return inspect(request);
      return capture(request);
    },
    /** A console message of any frame of the main window (Electron's
     *  `console-message`); kept only when it is a problem of a displayed page. */
    reportConsole(report: PageConsoleReport & { frameUrl: string }): void {
      const classified = classifyConsole(report);
      const found = classified && paneOfUrl([report.frameUrl, report.sourceId]);
      if (!classified || !found) return;
      recordPageProblem(found, { ...classified, source: report.sourceId, line: report.lineNumber });
    },
    /** A pane's page (re)committed: its earlier problems are stale. An error
     *  response is itself a problem. */
    reportNavigation(url: string, httpResponseCode: number): void {
      const found = paneOfUrl([url]);
      if (!found) return;
      const { sessionId, tab, index } = found;
      const kept = tab.problems.filter((problem) => problem.pane !== index);
      const cleared = kept.length !== tab.problems.length;
      tab.problems = kept;
      tab.problemSeq += 1;
      if (httpResponseCode >= 400) {
        recordPageProblem(found, { kind: 'load', message: `The page responded with HTTP ${httpResponseCode}`, source: url, line: 0 });
      } else if (cleared) {
        publish(sessionId);
      }
    },
    /** A request of a displayed page's lease failed (`detail`: HTTP status or
     *  network error): a missing local stylesheet, script, image or font. */
    reportAssetFailure(url: string, detail: string, requester: RequesterFrame[]): void {
      // Only a frame of the same lease may have made the request.
      const lease = leasePrefixOf(url);
      if (!lease || ownerLease(requester) !== lease) return;
      const found = paneOfUrl([url]);
      if (found) recordPageProblem(found, { kind: 'asset-failed', message: `${url} (${detail})`, source: '', line: 0 });
    },
    /** Whether a frame navigation is refused. `chain` is the navigating frame,
     *  then its ancestors; `appInitiated` is a navigation the app itself made
     *  (it pointed the iframe), which only updates which frames are panes. A
     *  page-initiated navigation of a pane (or a frame inside one) away from
     *  its lease is cancelled and reported as `blocked-navigation`, unless its
     *  tab allowed network. */
    guardNavigation(chain: RequesterFrame[], url: string, appInitiated: boolean): boolean {
      const first = chain.length ? frameEntry(chain[0]) : undefined;
      if (appInitiated) {
        if (first?.id !== undefined) {
          const target = leasePrefixOf(url);
          if (target && leaseOwners.has(target)) setPaneFrame(first.id, target);
          else paneFrames.delete(first.id);
        }
        return false;
      }
      const owned = ownerLease(chain);
      const owner = owned ? leaseOwners.get(owned) : undefined;
      if (!owned || !owner || owner.tab.allowNetwork) return false;
      if (url.startsWith(owned) || /^about:(?:blank|srcdoc)$/.test(url)) return false;
      const found = paneOfUrl([owned]);
      if (found) {
        const shown = /^data:[^,]*/.exec(url)?.[0] ?? url.slice(0, 120);
        recordPageProblem(found, { kind: 'blocked-navigation', message: shown, source: '', line: 0 });
      }
      return true;
    },
    /** Whether to block `request`, made by a frame in `chain` (the requesting
     *  frame, then its ancestors; a bare string is a URL only, e.g. the
     *  referrer). Ownership is by frame: any frame that is, or ever was, a
     *  displayed visualize page keeps its requests judged whatever its current
     *  URL. Only those are ever blocked, and only while the tab has not allowed
     *  network: the page's own lease origin stays reachable, any other
     *  http(s)/ws address is refused and reported as a page problem. */
    guardRequest(chain: RequesterFrame[], request: { url: string; resourceType: string }): boolean {
      const owned = ownerLease(chain);
      const owner = owned ? leaseOwners.get(owned) : undefined;
      if (!owned || !owner || owner.tab.allowNetwork) return false;
      let target: URL;
      try {
        target = new URL(request.url);
      } catch {
        return true;
      }
      if (!/^(?:https?|wss?):$/.test(target.protocol)) return false;
      if (target.host === new URL(owned).host) return false;
      const found = paneOfUrl([owned]);
      if (found) {
        recordPageProblem(found, {
          kind: 'blocked-network',
          message: `${target.host} (${request.resourceType})`,
          source: '',
          line: 0,
        });
      }
      return true;
    },
    /** A pane's page could not be loaded at all. */
    reportLoadFailure(url: string, description: string): void {
      const found = paneOfUrl([url]);
      if (found) recordPageProblem(found, { kind: 'load', message: `The page failed to load: ${description}`, source: url, line: 0 });
    },
    /** Resolves once every file-change reload scheduled so far (and any it
     *  triggers) has finished: debounce, re-resolve, version snapshot, publish. */
    async settled(): Promise<void> {
      while (pendingReloads.size) {
        // A waiter keeps the (unref'd) debounce timers alive.
        for (const state of sessions.values()) for (const tab of state.tabs) tab.reloadTimer?.ref?.();
        await Promise.all(pendingReloads);
      }
    },
    /** Every session's tabs, for a renderer that (re)loads. */
    snapshot(): VisualizeSessionState[] {
      return [...sessions.keys()].map(stateOf).filter((state) => state.tabs.length > 0 || state.history?.length);
    },
    /** Every session's tabs with their resolved files, for the remote mirror. */
    hostSnapshot(): VisualizeHostState[] {
      return [...sessions.keys()].map(hostStateOf).filter((state) => state.tabs.length > 0 || state.history?.length);
    },
    /** One panel tab as the renderer draws it (feedback finds its frames). */
    tabView(sessionId: string, tabId: string): VisualizeTabView | null {
      const tab = sessions.get(sessionId)?.tabs.find((candidate) => candidate.id === tabId && !candidate.url);
      return tab ? view(tab) : null;
    },
    /** The user's tab clicks and closes in the panel, and version steps,
     *  compare and restore. */
    async command(command: DesktopVisualizeTabCommand): Promise<VisualizeCommandResult | void> {
      if (command.action === 'close') {
        closeTab(command.sessionId, command.tabId);
        return;
      }
      if (command.action === 'reopen') {
        await reopen(command.sessionId, command.targets, command.content, command.label);
        return;
      }
      if (command.action === 'history') {
        const state = sessions.get(command.sessionId);
        const entry = state?.history.find((candidate) => candidate.id === command.entry);
        if (!state || !entry) throw new Error('that visual is no longer in this session\'s list');
        const live = state.tabs.find((candidate) => candidate.key === entry.key && !candidate.url);
        if (live) {
          state.active = live.id;
          publish(command.sessionId);
          return;
        }
        await reopen(command.sessionId, entry.targets, entry.content, entry.label);
        return;
      }
      const state = sessions.get(command.sessionId);
      const tab = state?.tabs.find((candidate) => candidate.id === command.tabId && !candidate.url);
      if (!state || !tab) return;
      if (command.action === 'restore') {
        await restoreVersion(command.sessionId, tab, command.version, command.assets ?? []);
        return;
      }
      if (command.action === 'render') {
        reportInlineRender(command.sessionId, tab, command.pane, command.renderId, command.error);
        return;
      }
      if (command.action === 'export') return exportTab(command.sessionId, tab, command.format, command.pane ?? 0);
      if (command.action === 'network') {
        if (!!tab.allowNetwork === command.allow) return;
        tab.allowNetwork = command.allow;
        // Inline pages are held in memory, not reloaded from files: remount them.
        if (tab.shown || tab.inline) {
          // A kept version is on screen: remount its pages under the new policy.
          tab.revision += 1;
          tab.problems = [];
          tab.problemSeq += 1;
          publish(command.sessionId);
        } else {
          await reload(command.sessionId, tab);
        }
        return;
      }
      if (command.action === 'version') {
        await selectVersion(command.sessionId, tab, command.version, command.compare === true);
        await afterSelect(command.sessionId, tab);
        return;
      }
      state.active = command.tabId;
      publish(command.sessionId);
      thumbnailWhenMissing(command.sessionId, tab);
    },
    dispose(): void {
      for (const state of sessions.values()) for (const tab of state.tabs) dispose(tab);
      sessions.clear();
    },
  };
}

export type VisualizeService = ReturnType<typeof createVisualizeService>;
