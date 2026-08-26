import { lazy } from "react";

import type { WorkspaceSelection } from "./nav-types";
import { loadMonacoLocale } from "./monaco-locale";

const importDiffView = () => import("./DiffView.lazy");
const importTerminalPane = () => import("./TerminalPane");
const importEditorPane = async () => {
  await loadMonacoLocale();
  return import("./EditorPane.lazy");
};
const importFolderPane = () => import("./FolderPane.lazy");

export const DiffView = lazy(importDiffView);
export const TerminalPane = lazy(importTerminalPane);
export const EditorPane = lazy(importEditorPane);
export const FolderPane = lazy(importFolderPane);

export async function disposeTerminalPane(id: string): Promise<void> {
  const module = await importTerminalPane();
  await module.disposeTerminalPane(id);
}

// First-scroll hitch fix: the DiffView chunk is ~1.7MB — when the first
// edit/diff tool card mounted mid-scroll, the on-demand chunk load+compile
// stalled the main thread for the whole hitch (user: scrolling to the top of
// a session always lags the FIRST time). A real session resume warms ONLY that
// transcript dependency; editor and terminal stay behind their own navigation
// intent so a chat never retains Monaco/xterm without using them.
let prefetched = false;
let diffPrefetch: Promise<unknown> | null = null;
let terminalPrefetch: Promise<unknown> | null = null;
let editorPrefetch: Promise<unknown> | null = null;
let folderPrefetch: Promise<unknown> | null = null;
export function prefetchDiffView(): Promise<unknown> {
  diffPrefetch ||= importDiffView().catch((error) => {
    diffPrefetch = null;
    throw error;
  });
  return diffPrefetch;
}
export function prefetchTerminalPane(): Promise<unknown> {
  terminalPrefetch ||= importTerminalPane().catch((error) => {
    terminalPrefetch = null;
    throw error;
  });
  return terminalPrefetch;
}
export function prefetchFolderPane(): Promise<unknown> {
  folderPrefetch ||= importFolderPane().catch((error) => {
    folderPrefetch = null;
    throw error;
  });
  return folderPrefetch;
}
export function prefetchEditorPane(): Promise<unknown> {
  editorPrefetch ||= importEditorPane().catch((error) => {
    editorPrefetch = null;
    throw error;
  });
  return editorPrefetch;
}

/**
 * Start the chunk a selection is about to need, without waiting for it.
 *
 * Pointer surfaces call this from hover/focus. A phone has neither, so its
 * first open of a file/terminal/diff/folder tab paid the ENTIRE fetch and
 * evaluate at open time — over the relay that is ~1MB brotli for Monaco alone
 * (user: 창 들어갈 때 지연). Touch-down is the phone's equivalent intent
 * signal, and because every prefetch here returns the same shared promise the
 * real open awaits, an unfinished one simply merges into that load.
 */
export function prefetchSurfaceForSelection(selection: WorkspaceSelection): void {
  const promise = selection.kind === "file"
    ? prefetchEditorPane()
    : selection.kind === "diff"
      ? prefetchDiffView()
      : selection.kind === "terminal"
        ? prefetchTerminalPane()
        : selection.kind === "folder"
          ? prefetchFolderPane()
          : null;
  void promise?.catch(() => undefined);
}

type EditorIntentHost = typeof window & {
  requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
  __mixdogWindowShown?: boolean;
  __mixdogDesktopRevealed?: boolean;
};
let editorIntentScheduled = false;
const EDITOR_INTENT_QUIET_MS = 150;
/**
 * Files-pane intent (hover/selection inside the explorer) starts the editor
 * chunk BEFORE the open click, which otherwise pays ~187ms of fetch + link +
 * eval on the first open. This stays CONTEXTUAL on purpose: the global idle
 * warmup still excludes Monaco because idle evaluation cost a 51ms long task
 * in apps that may never open a file. Startup can never carry it (both the
 * first visible frame and the boot reveal must have happened), the import is
 * queued from an idle callback so pointer/key handling never blocks, and a
 * real open awaits the same shared promise — so an unfinished prefetch just
 * merges into the normal load.
 */
export function scheduleEditorPanePrefetch(): void {
  if (editorIntentScheduled || editorPrefetch || typeof window === "undefined") return;
  const host = window as EditorIntentHost;
  // Only the Electron main process emits the window-shown handshake, so
  // requiring it here excluded every relay-served browser and phone from this
  // prefetch entirely — exactly the surfaces where the fetch costs the most.
  // The boot gate sets the reveal marker on both, and it still holds startup.
  if (host.__mixdogDesktopRevealed !== true) return;
  const nativeWindow = Boolean(window.mixdogDesktop?.bootContext?.bootId);
  if (nativeWindow && host.__mixdogWindowShown !== true) return;
  editorIntentScheduled = true;
  const start = () => {
    void prefetchEditorPane().catch(() => { editorIntentScheduled = false; });
  };
  window.setTimeout(() => {
    if (typeof host.requestIdleCallback === "function") {
      host.requestIdleCallback(start, { timeout: 1_000 });
    } else window.setTimeout(start, 0);
  }, EDITOR_INTENT_QUIET_MS);
}

export function prefetchLazyWidgets(): void {
  if (prefetched) return;
  prefetched = true;
  // Scheduling belongs to the session resume path. Keep this narrow: imports
  // are permanent for the renderer lifetime.
  void prefetchDiffView().catch(() => { prefetched = false; });
}
