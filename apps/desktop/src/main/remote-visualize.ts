// The agent `visualize` panel for paired remote clients (daemon side). Main
// owns the tabs and mirrors each change here with every pane's resolved file;
// clients only ever see the path-free state. Pane bytes ride the encrypted RPC
// lane in the same bounded ranges as remote file previews, addressed by tab
// and pane-root-relative path, and every read re-checks containment.
import { realpath } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';

import { filePreviewTypeForPath } from '../shared/file-preview';
import {
  type DesktopVisualizeEvent,
  REMOTE_PAGE_MAX_BYTES,
  remoteVisualizeState,
  type VisualizeHostEvent,
  type VisualizeHostPane,
  type VisualizeHostState,
  type VisualizeHostTab,
  type VisualizeRemoteExport,
  type VisualizeRemotePaneFile,
  type VisualizeSessionState,
  visualizeThumbnail,
} from '../shared/visualize';
import { requiredSessionId } from './desktop-state';
import { requiredString, requiredVisualizeTabCommand } from './ipc-validation';
import { pageAssetType } from './local-page-server';
import { projectEntryPathIn } from './project-files';
import { authorizedFileDigest, authorizedMediaFile, readPreviewRange, withAuthorizedFile } from './remote-file-preview';
import { assertNotSensitive } from './remote-sensitive-paths';

type RemoteMethod = (params: unknown[]) => unknown;
type HostRequest = (
  method: 'visualizeState' | 'visualizeCommand' | 'visualizeExport',
  args: unknown[]
) => Promise<unknown>;
/** Hands a rendered export file to the asking device as its download. */
type ExportDownload = (file: {
  sessionId: string;
  path: string;
  mime: string;
  /** A long document's PNG stacks only its first pages. */
  pages?: { included: number; total: number };
}) => Promise<VisualizeRemoteExport>;

/** The page counts of a cut document export, when the host reported valid ones. */
function cutPages(value: unknown): { included: number; total: number } | null {
  const { included, total } = record(value);
  return Number.isInteger(included) &&
    Number.isInteger(total) &&
    (included as number) >= 1 &&
    (total as number) > (included as number)
    ? { included: included as number, total: total as number }
    : null;
}
type InvokeDesktopOperation = (name: string, args: unknown[]) => Promise<unknown>;

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : {};

function hostState(value: unknown): VisualizeHostState | null {
  const state = record(value);
  if (typeof state.sessionId !== 'string' || !state.sessionId || !Array.isArray(state.tabs)) return null;
  return state as unknown as VisualizeHostState;
}

/** The daemon's copy of main's visualize tabs. */
export function createRemoteVisualizeMirror() {
  let sessions = new Map<string, VisualizeHostState>();
  // The card picture each tab's last forwarded event carried. A change event
  // repeats a picture never: every tab's ≤60 KB picture in every publish made
  // the state the bulk of the relay traffic (a card keeps the picture it got;
  // one it missed asks the host for its version's picture).
  let forwarded = new Map<string, string>();
  const withoutRepeatedThumbnails = (state: VisualizeSessionState): VisualizeSessionState => {
    const next = new Map<string, string>();
    const tabs = state.tabs.map((tab) => {
      const key = `${state.sessionId}\0${tab.id}`;
      if (!tab.thumbnail) return tab;
      next.set(key, tab.thumbnail);
      if (forwarded.get(key) !== tab.thumbnail) return tab;
      const { thumbnail: _thumbnail, thumbnailVersion: _version, ...rest } = tab;
      return rest;
    });
    for (const key of forwarded.keys()) if (key.startsWith(`${state.sessionId}\0`)) forwarded.delete(key);
    forwarded = new Map([...forwarded, ...next]);
    return { ...state, tabs };
  };
  return {
    /** One change from main; returns the client-safe event to forward. */
    apply(value: unknown): DesktopVisualizeEvent | null {
      const event = record(value) as Partial<VisualizeHostEvent>;
      const sessionId = typeof event.sessionId === 'string' ? event.sessionId : '';
      if (!sessionId) return null;
      const state = event.state === undefined ? null : hostState(event.state);
      if (state) {
        if (state.tabs.length || state.history?.length) sessions.set(sessionId, state);
        else sessions.delete(sessionId);
      }
      const openUrl = typeof event.openUrl === 'string' && event.openUrl ? event.openUrl : '';
      if (!state && !openUrl) return null;
      return {
        sessionId,
        ...(state ? { state: withoutRepeatedThumbnails(remoteVisualizeState({ ...state, sessionId })) } : {}),
        ...(event.reveal === true ? { reveal: true } : {}),
        ...(event.reveal === true && typeof event.tab === 'string' && event.tab ? { tab: event.tab } : {}),
        ...(state && typeof event.updated === 'string' && event.updated ? { updated: event.updated } : {}),
        ...(state && event.held === true ? { held: true } : {}),
        ...(state && event.held === true && Number.isFinite(event.heldSince) ? { heldSince: event.heldSince } : {}),
        ...(openUrl ? { openUrl } : {}),
      };
    },
    /** Main's whole snapshot; returns the client-safe states. */
    replace(value: unknown): VisualizeSessionState[] {
      const states = (Array.isArray(value) ? value : []).map(hostState).filter((state) => state !== null);
      sessions = new Map(
        states.filter((state) => state.tabs.length || state.history?.length).map((state) => [state.sessionId, state])
      );
      return [...sessions.values()].map(remoteVisualizeState);
    },
    tab(sessionId: string, tabId: string): VisualizeHostTab | undefined {
      return sessions.get(sessionId)?.tabs.find((tab) => tab.id === tabId);
    },
  };
}

export type RemoteVisualizeMirror = ReturnType<typeof createRemoteVisualizeMirror>;

const comparable = (path: string): string => (process.platform === 'win32' ? path.toLowerCase() : path);

/** The folder a pane's file and page assets must stay inside: its root (the
 *  cwd, an outside page's own folder, or a kept version's snapshot folder),
 *  else the tab's cwd. */
const rootOf = (tab: VisualizeHostTab, pane: VisualizeHostPane | undefined): string => pane?.root ?? tab.cwd;

/** The file a remote read of `rawRel` may serve for `tab`, or a thrown error.
 *  Containment is re-resolved on every call (a folder swapped for a link to
 *  outside cwd fails closed); a tab's own panes are always servable, and an
 *  HTML tab also serves the page assets the local page server would. `rel`
 *  is relative to the root of pane `scope` (the live cwd when absent), and
 *  only that root's panes count (named as given or resolved). */
async function servedFile(
  tab: VisualizeHostTab,
  rawRel: unknown,
  invokeDesktopOperation: InvokeDesktopOperation,
  scope?: VisualizeHostPane
): Promise<{ absolute: string; within: string; mime: string }> {
  const rootDir = rootOf(tab, scope);
  const root = await realpath(rootDir);
  const rel = requiredString(rawRel, 'relPath', 4_096).replace(/\\/g, '/');
  const absolute = projectEntryPathIn(root, rel);
  await assertNotSensitive(absolute);
  // Inline panes have no file (their content rides the state): never a page
  // whose folder could serve project assets.
  const roots = new Set([comparable(rootDir), comparable(root)]);
  const group = tab.panes.filter((candidate) => roots.has(comparable(rootOf(tab, candidate))) && !candidate.inline);
  const pane = group.find((candidate) => comparable(resolve(candidate.path)) === comparable(absolute));
  if (pane?.kind === 'document') {
    // The converted PDF lives in the app's conversion cache, outside cwd; its
    // source is converted from the opened, authorized file inside it.
    const converted = record(
      await withAuthorizedFile(absolute, root, (file) =>
        invokeDesktopOperation('documentPreviewIn', [file.root, file.rel])
      )
    );
    if (typeof converted.path !== 'string' || !converted.path) throw new Error('The document preview is unavailable.');
    return { absolute: converted.path, within: dirname(converted.path), mime: 'application/pdf' };
  }
  let mime = '';
  if (pane?.kind === 'html') mime = pageAssetType(root, absolute, dirname(absolute));
  else if (pane) mime = filePreviewTypeForPath(absolute)?.mime ?? '';
  else {
    // Page assets: exactly the page-asset policy of the local page server
    // (hidden folders refused below the page's own folder chain). Only the
    // tab's own panes skip it.
    const pages = group.filter((candidate) => candidate.kind === 'html');
    if (!pages.length) throw new Error('This file is not part of the visualize tab.');
    for (const page of pages) {
      if (mime) break;
      mime = pageAssetType(root, absolute, dirname(resolve(page.path)));
    }
  }
  if (!mime) throw new Error('This file type does not support an in-app preview.');
  return { absolute, within: root, mime };
}

/** 3 panes, doubled while a kept version is compared with live. */
const MAX_PANES = 6;

function paneIndex(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value >= MAX_PANES) {
    throw new TypeError('pane index is invalid.');
  }
  return value;
}

export function createRemoteVisualizeMethods(deps: {
  mirror?: RemoteVisualizeMirror;
  hostRequest?: HostRequest;
  invokeDesktopOperation: InvokeDesktopOperation;
  /** Absent when this connection has no download lane: PNG/PDF exports are
   *  then refused. */
  exportDownload?: ExportDownload;
}): Record<string, RemoteMethod> {
  const available = (): { mirror: RemoteVisualizeMirror; hostRequest: HostRequest } => {
    if (!deps.mirror || !deps.hostRequest)
      throw new TypeError('The visualize panel is unavailable on this connection.');
    return { mirror: deps.mirror, hostRequest: deps.hostRequest };
  };
  const refresh = async (): Promise<VisualizeSessionState[]> => {
    const { mirror, hostRequest } = available();
    return mirror.replace(await hostRequest('visualizeState', []));
  };
  /** The tab from the mirror; a miss re-reads main once (a restarted daemon
   *  starts with an empty mirror). */
  const tabOf = async (rawSessionId: unknown, rawTabId: unknown): Promise<VisualizeHostTab> => {
    const sessionId = requiredSessionId(rawSessionId);
    const tabId = requiredString(rawTabId, 'visualize tab id', 64);
    const { mirror } = available();
    let tab = mirror.tab(sessionId, tabId);
    if (!tab) {
      await refresh();
      tab = mirror.tab(sessionId, tabId);
    }
    if (!tab) throw new Error('This visualize tab is closed.');
    return tab;
  };
  return {
    visualizeState: () => refresh(),
    visualizeCommand: async ([command]) => {
      const valid = requiredVisualizeTabCommand(command);
      // Outside network for a page is the desktop user's decision alone.
      if (valid.action === 'network') throw new TypeError('Outside network can only be allowed on the desktop.');
      // Render reports pass validated: the host files one only with the
      // remote render id it issued for exactly that render instance.
      // PNG / PDF exports use the desktop's save dialog; a remote device asks
      // `visualizeExport` for a download instead. Saving into the project
      // stays on the host, through the same validated command.
      if (valid.action === 'export' && valid.format !== 'project') {
        throw new TypeError('This export is only available in the desktop window.');
      }
      // Only the export's outcome (a project-relative path) travels back.
      const result = record(await available().hostRequest('visualizeCommand', [valid]));
      if (valid.action === 'thumbnail') {
        const thumbnail = visualizeThumbnail(result.thumbnail);
        return thumbnail ? { thumbnail } : null;
      }
      if (valid.action !== 'export' || typeof result.path !== 'string') return null;
      return { path: result.path, ...(result.openable === true ? { openable: true } : {}) };
    },
    // Metadata first, then the bytes through the range method.
    visualizePaneFile: async ([sessionId, tabId, rawIndex]): Promise<VisualizeRemotePaneFile> => {
      const tab = await tabOf(sessionId, tabId);
      const pane = tab.panes[paneIndex(rawIndex)];
      if (!pane) throw new Error('This visualize pane is closed.');
      const root = await realpath(rootOf(tab, pane));
      const rel = relative(root, pane.path).split(sep).join('/');
      const served = await servedFile(tab, rel, deps.invokeDesktopOperation, pane);
      if (pane.kind === 'html') {
        // A page's content identity (its root's version + the bytes' hash)
        // keys the device's page cache.
        // A page larger than a client builds gets none.
        const page = await authorizedFileDigest(served.absolute, served.within, REMOTE_PAGE_MAX_BYTES);
        return {
          kind: pane.kind,
          mime: served.mime,
          size: page.size,
          mtimeMs: page.mtimeMs,
          rel,
          ...(page.sha256
            ? { contentId: `${pane.version === undefined ? 'live' : `v${pane.version}`}:${page.sha256}` }
            : {}),
        };
      }
      // Media also gets a lease the encrypted media lane streams (seekable,
      // no whole-file read); a client without the lane reads ranges.
      const streamable = pane.kind === 'image' || pane.kind === 'audio' || pane.kind === 'video';
      const file = await authorizedMediaFile(served.absolute, served.within, streamable ? served.mime : null);
      return {
        kind: pane.kind,
        mime: served.mime,
        size: file.size,
        mtimeMs: file.mtimeMs,
        rel,
        ...(file.mediaAssetId ? { mediaAssetId: file.mediaAssetId } : {}),
      };
    },
    // A PDF or Office pane as page images (phones cannot show a PDF in a
    // frame): the same rasterizer as the editor's remote document preview,
    // on the pane's own file inside its root.
    visualizePanePages: async ([sessionId, tabId, rawIndex, options]) => {
      const tab = await tabOf(sessionId, tabId);
      const pane = tab.panes[paneIndex(rawIndex)];
      if (!pane) throw new Error('This visualize pane is closed.');
      if (pane.kind !== 'pdf' && pane.kind !== 'document') throw new Error('Only PDF and Office panes have pages.');
      const root = await realpath(rootOf(tab, pane));
      const rel = relative(root, pane.path).split(sep).join('/');
      const request = record(options);
      return withAuthorizedFile(projectEntryPathIn(root, rel), root, (file) =>
        deps.invokeDesktopOperation('documentPreviewPagesIn', [
          file.root,
          file.rel,
          { pages: request.pages, maxWidth: request.maxWidth },
        ])
      );
    },
    // PNG / PDF of displayed pane `pane`, rendered on the host into a temp
    // file and offered to this device as a one-device download.
    visualizeExport: async ([rawSessionId, rawTabId, format, pane]) => {
      const valid = requiredVisualizeTabCommand({
        sessionId: rawSessionId,
        tabId: rawTabId,
        action: 'export',
        format,
        ...(pane === undefined || pane === null ? {} : { pane }),
      });
      if (valid.action !== 'export' || valid.format === 'project') throw new TypeError('export format is invalid.');
      if (!deps.exportDownload) throw new TypeError('Downloads are unavailable on this connection.');
      await tabOf(valid.sessionId, valid.tabId);
      const result = record(await available().hostRequest('visualizeExport', [valid]));
      if (typeof result.path !== 'string' || !result.path) throw new Error('The export did not produce a file.');
      const pages = cutPages(result.pages);
      return deps.exportDownload({
        sessionId: valid.sessionId,
        path: result.path,
        mime: valid.format === 'png' ? 'image/png' : 'application/pdf',
        ...(pages ? { pages } : {}),
      });
    },
    // `rawIndex` (newer clients) names the pane whose root `rel` is under: a
    // kept version's snapshot folder or the live cwd.
    visualizePaneRange: async ([sessionId, tabId, rel, offset, length, rawIndex]) => {
      const tab = await tabOf(sessionId, tabId);
      let scope: VisualizeHostPane | undefined;
      if (rawIndex !== undefined && rawIndex !== null) {
        scope = tab.panes[paneIndex(rawIndex)];
        if (!scope) throw new Error('This visualize pane is closed.');
      }
      const served = await servedFile(tab, rel, deps.invokeDesktopOperation, scope);
      return readPreviewRange(served.absolute, served.within, served.mime, offset, length);
    },
  };
}
