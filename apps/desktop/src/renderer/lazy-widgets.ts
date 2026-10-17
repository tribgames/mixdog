import { lazy, type ComponentProps } from 'react';

import { deferredModule } from './deferred-module';
import { preloadMarkdownBody } from './markdown-body-loader';
import type { WorkspaceSelection } from './nav-types';
import { loadMonacoLocale } from './monaco-locale';
import { isNativeDesktopWindow } from './remote-ui-projection';
import { loadStudioViewModule } from './studio-loader';

const importDiffView = () => import('./DiffView.lazy');
const importTerminalPane = () => import('./TerminalPane');
const importBrowserPane = () => import('./BrowserPane.lazy');

/** The Monaco editor pane chunk. Once loaded (the idle lane, or a hover on a
 *  file row/link), ReadyEditorPane renders it synchronously instead of
 *  through a Suspense placeholder. */
export const editorPaneModule = deferredModule(async () => {
  await loadMonacoLocale();
  return import('./EditorPane.lazy');
});
export type EditorPaneProps = ComponentProps<typeof import('./EditorPane.lazy')['default']>;
const importEditorPane = () => editorPaneModule.load();

/** The Terminal and Browser pane chunks as deferred modules: once loaded (the
 *  phone's lane, a touch-down), their surfaces render them synchronously. A
 *  React.lazy suspends its first render even when the chunk is already in,
 *  and the Suspense reveal that follows is throttled ~300ms behind the
 *  fallback, so a first open sat on a blank body. */
export const terminalPaneModule = deferredModule(importTerminalPane);
export const browserPaneModule = deferredModule(importBrowserPane);

export const DiffView = lazy(importDiffView);
export const TerminalPane = lazy(() => terminalPaneModule.load());
export const BrowserPane = lazy(() => browserPaneModule.load());
/** Read-only Markdown preview of a side-dock "Open Preview to the Side" tab. */
export const SideMarkdownPreview = lazy(async () => {
  await loadMonacoLocale();
  return import('./editor-side-markdown-preview');
});

export async function disposeTerminalPane(id: string): Promise<void> {
  const module = await terminalPaneModule.load();
  await module.disposeTerminalPane(id);
}

// First-scroll hitch fix: the DiffView chunk is ~1.7MB — when the first
// edit/diff tool card mounted mid-scroll, the on-demand chunk load+compile
// stalled the main thread for the whole hitch (user: scrolling to the top of
// a session always lags the FIRST time). A real session resume warms ONLY that
// transcript dependency; editor and terminal stay behind their own navigation
// intent so a chat never retains Monaco/xterm without using them.
/** One shared in-flight import per chunk; a failed import clears itself so the
 *  next call retries. */
function createChunkPrefetch(load: () => Promise<unknown>) {
  let pending: Promise<unknown> | null = null;
  return {
    started: () => pending !== null,
    run(): Promise<unknown> {
      pending ||= load().catch((error) => {
        pending = null;
        throw error;
      });
      return pending;
    },
  };
}
const diffPrefetch = createChunkPrefetch(importDiffView);
const terminalPrefetch = createChunkPrefetch(() => terminalPaneModule.load());
const browserPrefetch = createChunkPrefetch(() => browserPaneModule.load());
// A README opens as rendered Markdown, which waits on the Markdown renderer
// and its parser chunk; a failed Markdown warm-up never fails the editor's.
const warmMarkdownPreview = () =>
  preloadMarkdownBody()
    .then(() => import('./markdown-worker-client'))
    .then((client) => client.preloadSyncMarkdownParser())
    .catch(() => undefined);
const editorPrefetch = createChunkPrefetch(() => Promise.all([importEditorPane(), warmMarkdownPreview()]));
export const prefetchDiffView = (): Promise<unknown> => diffPrefetch.run();
export const prefetchTerminalPane = (): Promise<unknown> => terminalPrefetch.run();
export const prefetchBrowserPane = (): Promise<unknown> => browserPrefetch.run();
export const prefetchEditorPane = (): Promise<unknown> => editorPrefetch.run();
export const prefetchStudioView = (): Promise<unknown> => loadStudioViewModule();
/**
 * Start the chunk a selection is about to need, without waiting for it.
 *
 * Pointer surfaces call this from hover/focus. A phone has neither, so its
 * first open of a file/terminal/diff tab paid the ENTIRE fetch and
 * evaluate at open time — over the relay that is ~1MB brotli for Monaco alone
 * (user: 창 들어갈 때 지연). Touch-down is the phone's equivalent intent
 * signal, and because every prefetch here returns the same shared promise the
 * real open awaits, an unfinished one simply merges into that load.
 */
const SURFACE_PREFETCH: Partial<Record<WorkspaceSelection['kind'], () => Promise<unknown>>> = {
  file: prefetchEditorPane,
  diff: prefetchDiffView,
  terminal: prefetchTerminalPane,
  browser: prefetchBrowserPane,
  studio: prefetchStudioView,
};

export function prefetchSurfaceForSelection(selection: WorkspaceSelection): void {
  void SURFACE_PREFETCH[selection.kind]?.().catch(() => undefined);
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
 * eval on the first open. The boot idle lane (useAppModuleWarmup) loads the
 * same chunks on desktop surfaces, so this is the early path for a link or row
 * seen before that lane reaches it, and for a phone, whose lane never carries
 * Monaco. Startup can never carry it (both the
 * first visible frame and the boot reveal must have happened), the import is
 * queued from an idle callback so pointer/key handling never blocks, and a
 * real open awaits the same shared promise — so an unfinished prefetch just
 * merges into the normal load.
 */
export function scheduleEditorPanePrefetch(): void {
  if (editorIntentScheduled || editorPrefetch.started() || typeof window === 'undefined') return;
  const host = window as EditorIntentHost;
  // Only the Electron main process emits the window-shown handshake, so
  // requiring it here excluded every relay-served browser and phone from this
  // prefetch entirely — exactly the surfaces where the fetch costs the most.
  // The boot gate sets the reveal marker on both, and it still holds startup.
  if (host.__mixdogDesktopRevealed !== true) return;
  const nativeWindow = isNativeDesktopWindow();
  if (nativeWindow && host.__mixdogWindowShown !== true) return;
  editorIntentScheduled = true;
  const start = () => {
    void prefetchEditorPane().catch(() => {
      editorIntentScheduled = false;
    });
  };
  window.setTimeout(() => {
    if (typeof host.requestIdleCallback === 'function') {
      host.requestIdleCallback(start, { timeout: 1_000 });
    } else window.setTimeout(start, 0);
  }, EDITOR_INTENT_QUIET_MS);
}
