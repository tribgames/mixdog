// The agent `visualize` panel for paired remote clients (daemon side). Main
// owns the tabs and mirrors each change here with every pane's resolved file;
// clients only ever see the path-free state. Pane bytes ride the encrypted RPC
// lane in the same bounded ranges as remote file previews, addressed by tab
// and working-directory-relative path, and every read re-checks containment.
import { realpath, stat } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';

import { filePreviewTypeForPath } from '../shared/file-preview';
import {
  type DesktopVisualizeEvent,
  remoteVisualizeState,
  type VisualizeHostEvent,
  type VisualizeHostPane,
  type VisualizeHostState,
  type VisualizeHostTab,
  type VisualizeRemotePaneFile,
  type VisualizeSessionState,
} from '../shared/visualize';
import { requiredSessionId } from './desktop-state';
import { requiredString, requiredVisualizeTabCommand } from './ipc-validation';
import { pageAssetType } from './local-page-server';
import { projectEntryPathIn } from './project-files';
import { readPreviewRange } from './remote-file-preview';

type RemoteMethod = (params: unknown[]) => unknown;
type HostRequest = (method: 'visualizeState' | 'visualizeCommand', args: unknown[]) => Promise<unknown>;
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
        ...(state ? { state: remoteVisualizeState({ ...state, sessionId }) } : {}),
        ...(event.reveal === true ? { reveal: true } : {}),
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

/** The folder a pane's file and page assets must stay inside: the tab's cwd,
 *  or a kept version's snapshot folder. */
const rootOf = (tab: VisualizeHostTab, pane: VisualizeHostPane | undefined): string => pane?.root ?? tab.cwd;

/** The file a remote read of `rawRel` may serve for `tab`, or a thrown error.
 *  Containment is re-resolved on every call (a folder swapped for a link to
 *  outside cwd fails closed); a tab's own panes are always servable, and an
 *  HTML tab also serves the page assets the local page server would. `rel`
 *  is relative to the root of pane `scope` (the live cwd when absent), and
 *  only that root's panes count. */
async function servedFile(
  tab: VisualizeHostTab,
  rawRel: unknown,
  invokeDesktopOperation: InvokeDesktopOperation,
  scope?: VisualizeHostPane
): Promise<{ absolute: string; mime: string }> {
  const rootDir = rootOf(tab, scope);
  const root = await realpath(rootDir);
  const rel = requiredString(rawRel, 'relPath', 4_096).replace(/\\/g, '/');
  const absolute = projectEntryPathIn(root, rel);
  // Inline panes have no file (their content rides the state): never a page
  // whose folder could serve project assets.
  const group = tab.panes.filter((candidate) => rootOf(tab, candidate) === rootDir && !candidate.inline);
  const pane = group.find((candidate) => comparable(resolve(candidate.path)) === comparable(absolute));
  if (pane?.kind === 'document') {
    // The converted PDF lives in the app's conversion cache, outside cwd; its
    // source was just checked inside it.
    const converted = record(await invokeDesktopOperation('documentPreviewIn', [root, rel]));
    if (typeof converted.path !== 'string' || !converted.path) throw new Error('The document preview is unavailable.');
    return { absolute: converted.path, mime: 'application/pdf' };
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
  return { absolute, mime };
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
}): Record<string, RemoteMethod> {
  const available = (): { mirror: RemoteVisualizeMirror; hostRequest: HostRequest } => {
    if (!deps.mirror || !deps.hostRequest) throw new TypeError('The visualize panel is unavailable on this connection.');
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
      // Render reports come from the desktop window alone: a remote client
      // shows its own render errors locally and cannot file problems.
      if (valid.action === 'render') throw new TypeError('Render reports are not accepted from remote clients.');
      // PNG / PDF exports use the desktop's save dialog; a remote device
      // downloads the bytes itself. Saving into the project stays on the
      // host, through the same validated command.
      if (valid.action === 'export' && valid.format !== 'project') {
        throw new TypeError('This export is only available in the desktop window.');
      }
      // Only the export's outcome (a project-relative path) travels back.
      const result = record(await available().hostRequest('visualizeCommand', [valid]));
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
      const info = await stat(served.absolute);
      if (!info.isFile()) throw new Error('The preview target is not a file.');
      return { kind: pane.kind, mime: served.mime, size: info.size, mtimeMs: info.mtimeMs, rel };
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
      return readPreviewRange(served.absolute, served.mime, offset, length);
    },
  };
}
