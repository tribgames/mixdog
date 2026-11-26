import {
  lazy,
  Suspense,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type MutableRefObject,
  type ReactNode,
} from 'react';
import type { NavigationSelection, WorkspaceSelection } from './navigation';
import { paneActiveSelection, type PaneLeaf } from './pane-layout';
import {
  currentUtilitySurfaceHandoffs,
  hasActivePaneHandoffWorkspace,
  paneSurfaceKey,
  retainSurfaceForOneFrame,
  subscribeUtilitySurfaceHandoffs,
  usesPersistentUtilityPortal,
} from './pane-surface-model';
import type { usePaneWorkspace } from './pane-workspace-state';
import type { useWorkbenchWorkspace } from './workbench-workspace';
import { t } from './i18n';
import { navigationKey } from './text-format';
import { DeferredPersistentSurface, PersistentPanePortal } from './PaneSurfaceGate';
import {
  DIFF_STARTUP_DELAY_MS,
  EDITOR_STARTUP_DELAY_MS,
  paneUtilitySurfaceSlotId,
  ReadyEditorPane,
  ReadyGitDiffPane,
  ReadyStudioPane,
  ReadyTerminalPane,
  TERMINAL_STARTUP_DELAY_MS,
} from './app-shell-components';
import { DesktopLoadingSurface } from './RendererRecovery';
import { BrowserPane } from './lazy-widgets';

// A pull-request tab is never part of the default first screen; its editor
// loads with the tab, behind the same "Loading pull request…" surface.
const PullRequestEditor = lazy(() =>
  import('./PullRequestEditor').then((module) => ({ default: module.PullRequestEditor }))
);

type PaneWorkspace = ReturnType<typeof usePaneWorkspace>;
type WorkbenchWorkspace = ReturnType<typeof useWorkbenchWorkspace>;

type UtilitySelection = Extract<
  WorkspaceSelection,
  {
    kind: 'studio' | 'terminal' | 'browser' | 'diff' | 'pull-request';
  }
>;

const BACKGROUND_PANE_STARTUP_DELAY_MS = 1_500;
const UTILITY_STARTUP_DELAY_MS: Partial<Record<string, number>> = {
  diff: DIFF_STARTUP_DELAY_MS,
  terminal: TERMINAL_STARTUP_DELAY_MS,
};
function utilityStartupLabel(kind: string): string {
  if (kind === 'studio') return t('Preparing Studio…');
  if (kind === 'diff') return t('Loading diff…');
  if (kind === 'terminal') return t('Loading terminal…');
  if (kind === 'browser') return t('Loading browser…');
  return t('Loading pull request…');
}

/** Tabs that own a persistent utility surface (one mounted pane each). */
function isUtilitySelection(selection: WorkspaceSelection): selection is UtilitySelection {
  return (
    selection.kind === 'studio' ||
    selection.kind === 'terminal' ||
    selection.kind === 'browser' ||
    selection.kind === 'diff' ||
    selection.kind === 'pull-request'
  );
}

interface EditorNavigationLocation {
  project: string;
  rel: string;
  line: number;
  accessToken?: string;
}

export function resolveOutgoingUtilityHandoffKey(
  leaf: PaneLeaf,
  previousLeaf: PaneLeaf | undefined,
  publishedKey: string | undefined,
  hasHandoffHost: boolean
): string | null {
  const currentActive = paneActiveSelection(leaf);
  const currentKey = currentActive ? navigationKey(currentActive) : '';
  if (usesPersistentUtilityPortal(currentActive)) return null;
  if (hasHandoffHost && previousLeaf) {
    const previousActive = paneActiveSelection(previousLeaf);
    if (
      previousActive &&
      usesPersistentUtilityPortal(previousActive) &&
      navigationKey(previousActive) !== currentKey &&
      retainSurfaceForOneFrame(previousLeaf, leaf)
    ) {
      return navigationKey(previousActive);
    }
  }
  if (
    publishedKey &&
    publishedKey !== currentKey &&
    (!previousLeaf || paneSurfaceKey(previousLeaf) === paneSurfaceKey(leaf)) &&
    leaf.tabs.some((tab) => navigationKey(tab) === publishedKey)
  ) {
    return publishedKey;
  }
  return null;
}

/** Keeps a child mounted for one committed pass with `active=false` before
 *  unmounting so active-dependent effect cleanups (such as phone PTY
 *  size-owner release in TerminalPane) run while the view map still holds it. */
export function DeferredDeactivationGate({
  active,
  children,
}: {
  active: boolean;
  children: (active: boolean) => ReactNode;
}) {
  const [rendered, setRendered] = useState(active);
  if (active && !rendered) setRendered(true);
  useEffect(() => {
    if (!active && rendered) setRendered(false);
  }, [active, rendered]);
  if (!active && !rendered) return null;
  return <>{children(active)}</>;
}

export function useAppPersistentPaneSurfaces({
  paneWorkspace,
  workbenchWorkspace,
  fileReveal,
  handleFileDirty,
  registerEditorSaveHandle,
  openFileTab,
  openPreviewToSide,
  latestEditorLocation,
  sidebarOpen,
  toggleSidebar,
}: {
  /** Absent where there is no side dock to host the preview. */
  openPreviewToSide?(leafId: string, project: string, rel: string, accessToken?: string): void;
  paneWorkspace: PaneWorkspace;
  workbenchWorkspace: WorkbenchWorkspace;
  fileReveal: { key: string; line: number; nonce: number } | null;
  handleFileDirty(key: string, dirty: boolean): void;
  registerEditorSaveHandle(
    key: string,
    save: { save(): Promise<boolean>; discard(): Promise<void> } | null,
    released?: { save(): Promise<boolean>; discard(): Promise<void> }
  ): void;
  openFileTab(project: string, rel: string, line?: number, accessToken?: string): void;
  latestEditorLocation: MutableRefObject<EditorNavigationLocation | null>;
  sidebarOpen: boolean;
  toggleSidebar(): void;
}) {
  const pruneActivationLatch = (latched: Set<string>, owns: (selection: WorkspaceSelection) => boolean): void => {
    const openKeys = new Set<string>();
    for (const leaf of paneWorkspace.leaves) {
      for (const selection of leaf.tabs) {
        if (owns(selection)) openKeys.add(navigationKey(selection));
      }
    }
    for (const key of [...latched]) {
      if (!openKeys.has(key)) latched.delete(key);
    }
  };
  const activatedFileKeys = useRef(new Set<string>());
  pruneActivationLatch(activatedFileKeys.current, (selection) => selection.kind === 'file');
  const paneFileEditors = (leaf: PaneLeaf, focused: boolean, focusPane: () => void) => {
    const active = paneActiveSelection(leaf);
    const paneActiveFileKey = active?.kind === 'file' ? navigationKey(active) : '';
    if (paneActiveFileKey) activatedFileKeys.current.add(paneActiveFileKey);
    return leaf.tabs
      .filter(
        (paneSelection): paneSelection is Extract<NavigationSelection, { kind: 'file' }> =>
          paneSelection.kind === 'file' &&
          (navigationKey(paneSelection) === paneActiveFileKey ||
            activatedFileKeys.current.has(navigationKey(paneSelection)))
      )
      .map((fileSelection) => {
        const key = navigationKey(fileSelection);
        const fileActive = key === paneActiveFileKey;
        return (
          <div
            key={key}
            className="schedules-pane editor-tab-pane stable-surface-preserved stable-pane-surface"
            data-surface-active={fileActive ? 'true' : 'false'}
            inert={fileActive ? undefined : true}
            aria-hidden={fileActive ? undefined : true}
            // Let Monaco own the complete pointer gesture before pane routing:
            // its text caret and scrollbar both capture on pointerdown. Moving
            // the pane after pointerup preserves first-click editing and allows
            // the first scrollbar gesture to drag instead of merely focusing.
            onPointerUpCapture={
              focused
                ? undefined
                : (event) => {
                    if (event.button === 0) window.setTimeout(focusPane, 0);
                  }
            }
          >
            <DeferredPersistentSurface
              active={fileActive || activatedFileKeys.current.has(key)}
              startupDelayMs={EDITOR_STARTUP_DELAY_MS + (focused ? 0 : BACKGROUND_PANE_STARTUP_DELAY_MS)}
              fallback={<DesktopLoadingSurface label={t('Loading editor…')} />}
            >
              <ReadyEditorPane
                surfaceKey={leaf.id}
                projectPath={fileSelection.project}
                relPath={fileSelection.rel}
                accessToken={fileSelection.accessToken}
                workspaceFile={workbenchWorkspace.workspace.workspaceFile}
                active={fileActive}
                focused={focused}
                onDirty={(dirty) => handleFileDirty(key, dirty)}
                onSaveHandle={(save, released) => registerEditorSaveHandle(key, save, released)}
                reveal={fileReveal && fileReveal.key === key ? fileReveal : null}
                codeGraph={
                  fileSelection.accessToken
                    ? undefined
                    : (mode, symbol) =>
                        window.mixdogDesktop?.codeGraphQuery?.(fileSelection.project, mode, symbol) ??
                        Promise.resolve('')
                }
                onOpenAt={
                  fileSelection.accessToken ? undefined : (rel, line) => openFileTab(fileSelection.project, rel, line)
                }
                onOpenFile={openFileTab}
                onOpenPreviewToSide={
                  openPreviewToSide
                    ? (project, rel, accessToken) => openPreviewToSide(leaf.id, project, rel, accessToken)
                    : undefined
                }
                onNavigationLocation={(rel, line) => {
                  if (!fileActive || !focused) return;
                  latestEditorLocation.current = {
                    project: fileSelection.project,
                    rel,
                    line,
                    ...(fileSelection.accessToken ? { accessToken: fileSelection.accessToken } : {}),
                  };
                }}
              />
            </DeferredPersistentSurface>
          </div>
        );
      });
  };
  const activatedUtilitySurfaceKeys = useRef(new Set<string>());
  pruneActivationLatch(activatedUtilitySurfaceKeys.current, isUtilitySelection);
  const paneUtilityTabs = (leaf: PaneLeaf, focused: boolean, focusPane: () => void) => {
    const active = paneActiveSelection(leaf);
    return leaf.tabs
      .filter(
        (selection): selection is UtilitySelection =>
          isUtilitySelection(selection) &&
          (Boolean(active && navigationKey(active) === navigationKey(selection)) ||
            activatedUtilitySurfaceKeys.current.has(navigationKey(selection)))
      )
      .map((utilitySelection) => {
        const key = navigationKey(utilitySelection);
        const utilityActive = active ? navigationKey(active) === key : false;
        return (
          <div
            key={key}
            id={paneUtilitySurfaceSlotId(leaf.id, key)}
            className={`workspace-utility-tab ${utilitySelection.kind}-tab-pane stable-surface-preserved stable-pane-surface`}
            data-surface-active={utilityActive ? 'true' : 'false'}
            inert={utilityActive ? undefined : true}
            aria-hidden={utilityActive ? undefined : true}
            onPointerDownCapture={
              focused
                ? undefined
                : (event) => {
                    if (event.button === 0) focusPane();
                  }
            }
          ></div>
        );
      });
  };
  const publishedUtilityHandoffs = useSyncExternalStore(
    subscribeUtilitySurfaceHandoffs,
    currentUtilitySurfaceHandoffs,
    currentUtilitySurfaceHandoffs
  );
  const committedLeaves = useRef(new Map<string, PaneLeaf>());
  useLayoutEffect(() => {
    const next = new Map<string, PaneLeaf>();
    for (const leaf of paneWorkspace.leaves) next.set(leaf.id, leaf);
    committedLeaves.current = next;
  });
  const utilitySurfaceDescriptors = new Map<
    string,
    {
      key: string;
      leafId: string;
      focused: boolean;
      active: boolean;
      selectionActive: boolean;
      selection: UtilitySelection;
    }
  >();
  for (const leaf of paneWorkspace.leaves) {
    const active = paneActiveSelection(leaf);
    const handoffKey = paneWorkspace.restorePending
      ? null
      : resolveOutgoingUtilityHandoffKey(
          leaf,
          committedLeaves.current.get(leaf.id),
          publishedUtilityHandoffs.get(leaf.id),
          hasActivePaneHandoffWorkspace()
        );
    for (const selection of leaf.tabs) {
      if (!isUtilitySelection(selection)) continue;
      const key = navigationKey(selection);
      const selectionActive = Boolean(active && navigationKey(active) === key);
      const handoffActive = !selectionActive && handoffKey === key;
      const utilityActive = selectionActive || handoffActive;
      // Idempotent render-time latch: by the time the user leaves this tab,
      // many committed renders have already recorded the activation.
      if (selectionActive) activatedUtilitySurfaceKeys.current.add(key);
      else if (!handoffActive && !activatedUtilitySurfaceKeys.current.has(key)) continue;
      const descriptor = {
        key,
        leafId: leaf.id,
        focused: selectionActive && leaf.id === paneWorkspace.focusedLeafId,
        active: utilityActive,
        selectionActive,
        selection,
      };
      const previous = utilitySurfaceDescriptors.get(key);
      if (
        !previous ||
        (descriptor.selectionActive && !previous.selectionActive) ||
        (descriptor.active && !previous.active) ||
        (descriptor.selectionActive && descriptor.focused)
      ) {
        utilitySurfaceDescriptors.set(key, descriptor);
      }
    }
  }
  pruneActivationLatch(activatedUtilitySurfaceKeys.current, isUtilitySelection);
  const paneUtilitySurfacePortals = [...utilitySurfaceDescriptors.values()].map((descriptor) => {
    const { key, leafId, selection: utilitySelection } = descriptor;
    const utilityActive = descriptor.active;
    const baseStartupDelayMs = UTILITY_STARTUP_DELAY_MS[utilitySelection.kind] ?? 0;
    const startupDelayMs = baseStartupDelayMs + (descriptor.focused ? 0 : BACKGROUND_PANE_STARTUP_DELAY_MS);
    const startupLabel = utilityStartupLabel(utilitySelection.kind);
    let surface: ReactNode;
    if (utilitySelection.kind === 'studio') {
      surface = (
        <ReadyStudioPane
          active={utilityActive}
          tabKey={key}
          focused={descriptor.focused}
          sidebarOpen={sidebarOpen}
          onToggleSidebar={toggleSidebar}
        />
      );
    } else if (utilitySelection.kind === 'terminal') {
      surface = (
        <DeferredDeactivationGate active={utilityActive}>
          {(terminalActive) => (
            <ReadyTerminalPane
              cwd={utilitySelection.cwd || null}
              terminalId={utilitySelection.id}
              active={terminalActive}
            />
          )}
        </DeferredDeactivationGate>
      );
    } else if (utilitySelection.kind === 'browser') {
      surface = (
        <Suspense fallback={<DesktopLoadingSurface label={startupLabel} />}>
          <BrowserPane
            mode="main"
            sessionId={utilitySelection.id}
            active={utilityActive}
            foreground={utilityActive}
            focusAddressOnActivate={false}
            initialUrl={utilitySelection.url}
            onPageChange={(url, title) => {
              if (url === utilitySelection.url && title === (utilitySelection.title ?? '')) return;
              paneWorkspace.updateSelection(leafId, { ...utilitySelection, url, ...(title ? { title } : {}) });
            }}
          />
        </Suspense>
      );
    } else if (utilitySelection.kind === 'diff') {
      surface = <ReadyGitDiffPane selection={utilitySelection} active={utilityActive} onOpenFile={openFileTab} />;
    } else {
      surface = (
        <Suspense fallback={<DesktopLoadingSurface label={startupLabel} />}>
          <PullRequestEditor
            projectPath={utilitySelection.project}
            number={utilitySelection.number}
            mode={utilitySelection.mode}
            active={utilityActive}
          />
        </Suspense>
      );
    }
    return (
      <PersistentPanePortal
        key={key}
        targetId={paneUtilitySurfaceSlotId(leafId, key)}
        className={`${utilitySelection.kind}-persistent-surface`}
        onPointerDownCapture={
          descriptor.focused
            ? undefined
            : (event) => {
                if (event.button === 0) paneWorkspace.focusLeaf(leafId);
              }
        }
      >
        <DeferredPersistentSurface
          active={utilityActive || activatedUtilitySurfaceKeys.current.has(key)}
          startupDelayMs={startupDelayMs}
          fallback={<DesktopLoadingSurface label={startupLabel} />}
        >
          {surface}
        </DeferredPersistentSurface>
      </PersistentPanePortal>
    );
  });

  return { paneFileEditors, paneUtilitySurfacePortals, paneUtilityTabs };
}
