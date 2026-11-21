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

// React.lazy suspends its first render even when the chunk is in, and the Suspense reveal is
// throttled ~300ms behind the fallback; a loaded deferred module renders synchronously instead.
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
const prefetchStudioView = (): Promise<unknown> => loadStudioViewModule();
const SURFACE_PREFETCH: Partial<Record<WorkspaceSelection['kind'], () => Promise<unknown>>> = {
  file: prefetchEditorPane,
  diff: prefetchDiffView,
  terminal: prefetchTerminalPane,
  browser: prefetchBrowserPane,
  studio: prefetchStudioView,
};

/** Starts the chunk a selection is about to need, without waiting for it; a phone calls it on touch-down, having no hover or focus. */
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
/** Starts the editor chunk on explorer intent, before the open click, once the first frame and the boot reveal have happened. */
export function scheduleEditorPanePrefetch(): void {
  if (editorIntentScheduled || editorPrefetch.started() || typeof window === 'undefined') return;
  const host = window as EditorIntentHost;
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
