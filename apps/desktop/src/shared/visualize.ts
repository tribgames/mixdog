// The agent `visualize` tool's side-panel tabs, shared by main and renderer.
// Main owns the tab state; the renderer only draws it and reports the user's
// tab clicks and closes.
import { fileExtension } from './file-extension';
import { documentPreviewFormatForPath, filePreviewTypeForPath } from './file-preview';
import { type VisualizeAnnotation, visualizeAnnotations } from './visualize-annotations';

/** How one pane renders: HTML through the local page server, Office
 *  documents through their PDF conversion, the rest as native previews. */
export type VisualizePaneKind = 'html' | 'document' | 'pdf' | 'image' | 'audio' | 'video' | 'inline';

/** The pane kind a file renders as, or '' when visualize cannot show it. */
export function visualizeKindForPath(path: string): Exclude<VisualizePaneKind, 'inline'> | '' {
  const extension = fileExtension(path);
  if (extension === 'html' || extension === 'htm') return 'html';
  if (documentPreviewFormatForPath(path)) return 'document';
  return filePreviewTypeForPath(path)?.kind ?? '';
}

/** What `open` can render straight from `input.content`, with no file. */
export const VISUALIZE_INLINE_KINDS = ['mermaid', 'svg', 'chart', 'html', 'markdown'] as const;
export type VisualizeInlineKind = (typeof VISUALIZE_INLINE_KINDS)[number];

/** Direct-renderer content (`chart` = an ECharts option as JSON). */
export interface VisualizeInlineContent {
  kind: VisualizeInlineKind;
  source: string;
  title?: string;
}

/** Largest inline `source`, in UTF-8 bytes. */
export const MAX_VISUALIZE_INLINE_BYTES = 512 * 1024;

export interface VisualizePaneView {
  kind: VisualizePaneKind;
  /** Set on `inline` panes: the content drawn by the sandboxed renderer. */
  inline?: VisualizeInlineContent;
  /** Static inline panes: the one-time id its render report must carry. The
   *  desktop window's and a remote client's are signed apart (a remote
   *  state never carries the desktop's). */
  renderId?: string;
  /** Small caption over the pane (the file name). */
  label: string;
  /** The target as the agent named it. */
  target: string;
  /** What the pane loads: a local page URL or a `mixdog-media:` preview URL. */
  url: string;
  /** Set when the pane shows a kept version (read-only), not the live file. */
  version?: number;
  /** The file relative to the tab's working directory (its name when it has
   *  none): what user feedback from the pane names. Absent on remote clients,
   *  whose `target` is already that path-free form. */
  file?: string;
}

/** One kept version of a tab's files (`n` counts up per tab from 1). */
export interface VisualizeVersionView {
  n: number;
  /** When it was kept (ms since epoch). */
  at: number;
  label?: string;
  /** The agent turns (start, end; ms since epoch) that ended on this version
   *  of the tab: a turn's card reads the version its turn produced from here,
   *  on any device and after any renderer reload. Kept with the version. */
  turns?: VisualizeVersionTurn[];
}

/** One agent turn's span, as the host saw it start and end. */
export interface VisualizeVersionTurn {
  since: number;
  end: number;
}

/** Most turns one version remembers. */
export const MAX_VERSION_TURNS = 20;

/** The version of `versions` whose turn contains `at` (ms): what the card of
 *  a call made at `at` stands for; 0 when no turn of this tab ended there. */
export function versionProducedAt(versions: readonly VisualizeVersionView[] | undefined, at: number): number {
  if (!versions || !at) return 0;
  // A turn start is seen a moment after its first call was made.
  const SLACK_MS = 2000;
  let found = 0;
  let foundEnd = Infinity;
  for (const version of versions) {
    for (const turn of version.turns ?? []) {
      if (turn.end >= at && turn.since - SLACK_MS <= at && turn.end < foundEnd) {
        found = version.n;
        foundEnd = turn.end;
      }
    }
  }
  return found;
}

/** Most versions a tab keeps; older ones are evicted first. */
export const MAX_VISUALIZE_VERSIONS = 20;

/** A tab's chat-card thumbnail: a downscaled PNG at most this wide and this
 *  large, carried in the tab state as a data URL. */
export const VISUALIZE_THUMBNAIL_MAX_WIDTH = 320;
export const VISUALIZE_THUMBNAIL_MAX_BYTES = 60 * 1024;
const THUMBNAIL_PREFIX = 'data:image/png;base64,';

/** `value` when it is a thumbnail data URL within the size cap, else ''. */
export function visualizeThumbnail(value: unknown): string {
  if (typeof value !== 'string' || !value.startsWith(THUMBNAIL_PREFIX)) return '';
  const data = value.slice(THUMBNAIL_PREFIX.length);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(data)) return '';
  return Math.floor((data.length * 3) / 4) <= VISUALIZE_THUMBNAIL_MAX_BYTES ? value : '';
}

/** What went wrong in an HTML pane: an uncaught exception, an unhandled
 *  promise rejection, a CSP violation, a failed resource load (a 404 from the
 *  local page server), a failed page load, or a page's own console output. */
export type VisualizeProblemKind =
  | 'exception'
  | 'rejection'
  | 'csp'
  | 'asset-failed'
  | 'blocked-network'
  | 'blocked-navigation'
  | 'load'
  | 'console-error'
  | 'console-warn'
  /** An inline pane's content failed to render (Mermaid parse error, bad chart JSON…). */
  | 'render';

/** One distinct runtime problem of a tab's HTML pane, captured from page load
 *  on. `source` is project-relative (never a host path or a page-server URL). */
export interface VisualizeProblem {
  kind: VisualizeProblemKind;
  message: string;
  source: string;
  line: number;
  /** How many times this exact problem occurred since the last reload. */
  count: number;
  /** Index of the pane (in the tab's displayed panes) it came from. */
  pane: number;
  /** The kept version whose snapshot page it came from; absent for live. */
  version?: number;
}

/** Distinct problems kept per tab; later new ones are dropped until a reload. */
export const MAX_VISUALIZE_PROBLEMS = 20;

/** `source:line` of a problem (the line only when known). */
export function visualizeProblemLocation(problem: Pick<VisualizeProblem, 'source' | 'line'>): string {
  if (!problem.source) return '';
  const line = problem.line > 0 ? `:${problem.line}` : '';
  return `${problem.source}${line}`;
}

/** A page-server URL (`http://127.0.0.1:<port>/<token>/rel`) reduced to the
 *  project-relative `rel`; the port and lease token are host-local. */
export function localizeLoopbackUrls(text: string): string {
  return text.replace(/https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):\d+\/[\w-]{32}\//g, '');
}

export interface VisualizeTabView {
  id: string;
  label: string;
  /** Bumped on every reload, so the renderer remounts the panes. */
  revision: number;
  /** 1-3 panes shown side by side. */
  panes: VisualizePaneView[];
  /** The live files were removed: the panel shows a notice instead of the
   *  panes until they are back (the next revision). */
  missing?: true;
  /** Runtime problems of the tab's HTML panes; absent when there are none. */
  problems?: VisualizeProblem[];
  /** Outside network for the tab's HTML pages (on when a tab opens; the
   *  desktop user can switch it off, then only the page's own files load).
   *  A paired device's page frame follows it with its CSP. */
  networkAllowed?: true;
  /** Kept versions, oldest first (absent from hosts without history). */
  versions?: VisualizeVersionView[];
  /** The version shown instead of the live files; null = live. */
  version?: number | null;
  /** The shown version sits beside the live files (panes interleave
   *  version, live, version, live…). */
  compare?: boolean;
  /** While a kept version is shown: its kept page assets (cwd-relative) that
   *  differ from the current files, which a restore also overwrites. */
  restoreAssets?: string[];
  /** The chat card's picture of the tab (see `visualizeThumbnail`); absent
   *  until one could be taken. */
  thumbnail?: string;
  /** The version `thumbnail` shows (0 for a tab without versions): a card
   *  of another version never takes it. */
  thumbnailVersion?: number;
  /** The agent's annotation marks on the displayed panes (main draws them in
   *  the desktop window; a paired device draws them from here). */
  annotations?: VisualizeAnnotation[];
}

/** Most entries a session's "All visuals" list keeps; older ones fall out. */
export const MAX_VISUALIZE_HISTORY = 50;

/** One thing opened in a session (open or since closed): what the "All
 *  visuals" list shows. Path-free: `label` is already what a client may see. */
export interface VisualizeHistoryItem {
  /** Opaque; the `history` command names it. */
  id: string;
  label: string;
  kind: VisualizePaneKind | VisualizeInlineKind | 'split';
  /** Kept versions (as of closing, for a closed tab). */
  versions: number;
  /** When it was last opened (ms since epoch). */
  at: number;
  open: boolean;
}

export interface VisualizeSessionState {
  sessionId: string;
  tabs: VisualizeTabView[];
  active: string | null;
  /** Everything opened in the session, newest first, closed tabs included;
   *  absent from hosts without the list. */
  history?: VisualizeHistoryItem[];
}

/** What a panel command can answer. `export`: the file written (`path`; a
 *  project-relative path for `project`) or `canceled` from the save dialog;
 *  `openable` = the saved file is a kind the panel can show as a tab. */
export interface VisualizeCommandResult {
  path?: string;
  openable?: boolean;
  canceled?: boolean;
  /** `thumbnail`: the kept picture of the asked version (a data URL), absent
   *  when it has none. */
  thumbnail?: string;
}

/** A text pane's source (an HTML file; inline content travels in the tab). */
export interface VisualizePaneText {
  text: string;
  /** The file was longer than the cap; `text` is its start. */
  truncated: boolean;
}

/** Largest source a pane's source view reads, in bytes. */
export const MAX_VISUALIZE_SOURCE_BYTES = 512 * 1024;

/** A zoom gesture seen in a pane's own frame (a page, a PDF), which the panel's
 *  document never receives: Ctrl+wheel, or Ctrl/Cmd + = / − / 0. */
export type VisualizeZoomInput = 'in' | 'out' | 'reset';

/** Main → renderer: a session's visualize tabs changed (`state`), optionally
 *  asking to reveal the panel, or a web URL to hand to the browser panel. A
 *  `zoom` event names no session: with a `point` (the wheel's place in the
 *  window, CSS px) the panel there takes it, without one (a key) the panel
 *  that holds focus. */
export interface DesktopVisualizeEvent {
  sessionId: string;
  state?: VisualizeSessionState;
  /** An agent open or a content update: bring the panel up on `tab` (by the
   *  open policy in visualize-store); hosts before `tab` mean the active tab. */
  reveal?: boolean;
  tab?: string;
  /** A content update of this tab (its file changed): applied in place, it
   *  never activates a tab or reveals the panel; an inactive tab gets an
   *  "updated" mark until it is viewed. Only `reveal` brings anything up. */
  updated?: string;
  /** Sent while the session's agent turn runs: `state` is what the turn has
   *  made so far. The panel keeps showing what it showed (nothing opens,
   *  activates or reloads), and `updated` still marks its tab. The turn's
   *  end sends the final state as an ordinary event. */
  held?: boolean;
  /** With `held`: when the turn started (ms). Chat cards of opens made since
   *  then wait for the turn's end. */
  heldSince?: number;
  openUrl?: string;
  zoom?: VisualizeZoomInput;
  point?: { x: number; y: number };
  /** Ctrl/Cmd went down (true) or up while a pane frame held focus, so the
   *  panel's document saw no key event. Lets a document frame (the PDF
   *  viewer) hand Ctrl+wheel to the panel (visualize.css). */
  zoomModifier?: boolean;
}

/** Renderer → main: the user picked or closed a visualize tab, or stepped
 *  through its versions: `version` shows kept version `version` (null = back
 *  to live), beside the live files when `compare`; `restore` writes kept
 *  version `version` back to the project files, with the page assets the
 *  user confirmed (`assets`, cwd-relative): any other changed asset refuses. */
export type DesktopVisualizeTabCommand =
  | { sessionId: string; tabId: string; action: 'activate' | 'close' }
  | { sessionId: string; tabId: string; action: 'version'; version: number | null; compare?: boolean }
  | { sessionId: string; tabId: string; action: 'network'; allow: boolean }
  | { sessionId: string; tabId: string; action: 'restore'; version: number; assets?: string[] }
  /** "All visuals": select the open tab of history entry `entry`, or open it
   *  again when closed (like `reopen`, validated in main). `tabId` is unused. */
  | { sessionId: string; tabId: string; action: 'history'; entry: string }
  /** Export the tab's displayed pane `pane`: `png` / `pdf` through the OS save
   *  dialog (desktop window only), `project` = inline content saved to
   *  `design/mockups/<slug>/` in the working directory (never overwrites). */
  | { sessionId: string; tabId: string; action: 'export'; format: 'png' | 'pdf' | 'project'; pane?: number }
  /** An inline pane (displayed index `pane`) finished rendering; `error` when
   *  it failed, carrying the pane's issued `renderId` (the desktop window's
   *  or, on the remote command path, the remote one). */
  | { sessionId: string; tabId: string; action: 'render'; pane: number; renderId: string; error?: string }
  /** A paired device's page frame refused a request to the outside network
   *  (its CSP stands in for the desktop's session filter): `url` is the refused
   *  address, `resource` what asked for it (an Electron `resourceType`). It is
   *  listed as the same `blocked-network` page problem as on the desktop. */
  | { sessionId: string; tabId: string; action: 'blocked'; pane: number; url: string; resource: string }
  /** A chat card's picture of kept version `version` (taken when its turn
   *  ended), for a card of an earlier version; changes nothing. */
  | { sessionId: string; tabId: string; action: 'thumbnail'; version: number }
  /** A chat card of a closed tab: open the same file targets again in the
   *  session's working directory (validated like an agent open). */
  | {
      sessionId: string;
      tabId: string;
      action: 'reopen';
      /** Empty when `content` (a closed inline tab's stored content) is given. */
      targets: string[];
      content?: VisualizeInlineContent;
      label?: string;
    };

// ── Paired remote clients ────────────────────────────────────────────────
// A paired phone or PC runs this renderer over the relay. It cannot load the
// host's loopback page server or `mixdog-media:` URLs, so main hands the
// daemon each pane's resolved file (never sent to a client) and the client
// pulls pane bytes over the encrypted RPC lane by tab and pane index.

/** Main → daemon: a pane with the symlink-resolved file it shows. */
export interface VisualizeHostPane {
  kind: VisualizePaneKind;
  label: string;
  target: string;
  /** '' for an `inline` pane, which has no file. */
  path: string;
  inline?: VisualizeInlineContent;
  /** What a remote client is told the target is: the cwd-relative path, or
   *  the file name when it has none. Never the raw (possibly absolute) input. */
  remoteTarget: string;
  /** The folder this pane's file and page assets must stay inside, when not
   *  the tab's cwd (a kept version's snapshot folder). */
  root?: string;
  version?: number;
  /** Inline panes: the render id a remote client's report must carry (signed
   *  apart from the desktop window's, see `renderId`). */
  remoteRenderId?: string;
}

export interface VisualizeHostTab {
  id: string;
  label: string;
  /** The label a remote client sees: the agent's label unless it names a
   *  host path, else the panes' remote targets. */
  remoteLabel: string;
  revision: number;
  /** The working directory every pane and page asset must stay inside. */
  cwd: string;
  panes: VisualizeHostPane[];
  missing?: true;
  /** Already project-relative (see `VisualizeProblem`). */
  problems?: VisualizeProblem[];
  networkAllowed?: true;
  /** Path-free already. */
  versions?: VisualizeVersionView[];
  version?: number | null;
  compare?: boolean;
  /** cwd-relative already. */
  restoreAssets?: string[];
  /** A data URL (path-free). */
  thumbnail?: string;
  thumbnailVersion?: number;
  /** Selectors and labels only (path-free). */
  annotations?: VisualizeAnnotation[];
}

export interface VisualizeHostState {
  sessionId: string;
  tabs: VisualizeHostTab[];
  active: string | null;
  /** Path-free already (labels are the remote-safe ones). */
  history?: VisualizeHistoryItem[];
}

/** Main → daemon: the same change `DesktopVisualizeEvent` carries, with paths. */
export interface VisualizeHostEvent {
  sessionId: string;
  state?: VisualizeHostState;
  reveal?: boolean;
  /** With `reveal`: the tab the open or update was for. */
  tab?: string;
  /** See `DesktopVisualizeEvent.updated` / `held` / `heldSince`. */
  updated?: string;
  held?: boolean;
  heldSince?: number;
  openUrl?: string;
}

/** Daemon desktop event carrying a client-safe `DesktopVisualizeEvent`; the
 *  relay forwards it on the visualize lane as REMOTE_VISUALIZE_CHANGED_EVENT. */
export const VISUALIZE_REMOTE_DESKTOP_EVENT = 'visualize-remote-changed';
export const REMOTE_VISUALIZE_CHANGED_EVENT = 'visualizeChanged';
/** The push lane a remote client registers to receive visualize changes. */
export const REMOTE_VISUALIZE_LANE = 'visualize';

/** Largest page file a remote client builds into a document; the host gives
 *  no content identity (no client cache) to a larger one. */
export const REMOTE_PAGE_MAX_BYTES = 4 * 1024 * 1024;

/** `visualizePaneFile`: what a remote pane loads (`rel` is relative to the
 *  tab's working directory; page assets resolve against it). */
export interface VisualizeRemotePaneFile {
  kind: VisualizePaneKind;
  mime: string;
  size: number;
  mtimeMs: number;
  rel: string;
  /** HTML panes: `<live|v<version>>:<sha256 hex of the file's bytes>`, what
   *  a device's page cache is keyed on (absent from older hosts: no cache). */
  contentId?: string;
  /** Image/audio/video panes: a lease the encrypted media lane streams
   *  (absent from older hosts and other kinds). */
  mediaAssetId?: string;
}

/** A remote pane ready to draw: a blob or media-lane URL, or a
 *  self-contained page. */
export interface VisualizePaneSource {
  kind: VisualizePaneKind;
  url?: string;
  srcdoc?: string;
  /** A page's own path (relative to its root), what its requests resolve against. */
  page?: string;
  /** A page's host content identity (see VisualizeRemotePaneFile). */
  contentId?: string;
  /** Serves the page's own `fetch`/XHR of a project file (`reference` as the
   *  page wrote it, resolved against `page`); rejects anything else. */
  fetch?(reference: string): Promise<{ bytes: Uint8Array; mime: string }>;
}

/** Remote PNG/PDF export (`visualizeExport`): the rendered file as a download
 *  source the device's download path redeems, and its file name. */
export interface VisualizeRemoteExport {
  source: { kind: 'export'; sessionId: string; exportId: string };
  name: string;
}

/** The client view of a host state: no host paths (only cwd-relative targets
 *  and file names), and no URL a client could load (remote panes fetch their
 *  bytes by tab id and pane index). */
export function remoteVisualizeState(state: VisualizeHostState): VisualizeSessionState {
  return {
    sessionId: state.sessionId,
    active: state.active,
    ...(Array.isArray(state.history)
      ? {
          history: state.history.slice(0, MAX_VISUALIZE_HISTORY).map((item) => ({
            id: String(item.id),
            label: localizeLoopbackUrls(String(item.label)),
            kind: item.kind,
            versions: item.versions,
            at: item.at,
            open: item.open === true,
          })),
        }
      : {}),
    tabs: state.tabs.map((tab) => {
      const problems = (tab.problems ?? []).slice(0, MAX_VISUALIZE_PROBLEMS).map((problem) => ({
        kind: problem.kind,
        message: localizeLoopbackUrls(String(problem.message)),
        source: localizeLoopbackUrls(String(problem.source)),
        line: problem.line,
        count: problem.count,
        pane: problem.pane,
        ...(typeof problem.version === 'number' ? { version: problem.version } : {}),
      }));
      const annotations = visualizeAnnotations(tab.annotations);
      const remoteVersion = (version: NonNullable<typeof tab.versions>[number]) => {
        const turns = version.turns?.length ? { turns: version.turns.map(({ since, end }) => ({ since, end })) } : {};
        return { n: version.n, at: version.at, ...(version.label ? { label: version.label } : {}), ...turns };
      };
      const versionFields = (versions: NonNullable<typeof tab.versions>) => ({
        versions: versions.map(remoteVersion),
        version: tab.version ?? null,
        ...(tab.compare ? { compare: true } : {}),
        ...(tab.restoreAssets?.length ? { restoreAssets: tab.restoreAssets.map(String) } : {}),
      });
      return {
        id: tab.id,
        label: tab.remoteLabel,
        revision: tab.revision,
        panes: tab.panes.map((pane) => ({
          kind: pane.kind,
          label: pane.label,
          target: pane.remoteTarget,
          url: '',
          // Inline content has no host file: it travels with the state.
          ...(pane.inline ? { inline: pane.inline } : {}),
          ...(pane.inline && typeof pane.remoteRenderId === 'string' ? { renderId: pane.remoteRenderId } : {}),
          ...(typeof pane.version === 'number' ? { version: pane.version } : {}),
        })),
        ...(tab.missing === true ? { missing: true as const } : {}),
        ...(problems.length ? { problems } : {}),
        // The device's frame drops its no-outside-network CSP only on this flag.
        ...(tab.networkAllowed === true ? { networkAllowed: true as const } : {}),
        ...(tab.versions ? versionFields(tab.versions) : {}),
        ...(visualizeThumbnail(tab.thumbnail) ? { thumbnail: visualizeThumbnail(tab.thumbnail) } : {}),
        ...(visualizeThumbnail(tab.thumbnail) && Number.isInteger(tab.thumbnailVersion)
          ? { thumbnailVersion: tab.thumbnailVersion }
          : {}),
        ...(annotations.length ? { annotations } : {}),
      };
    }),
  };
}
