import type React from 'react';
import type { PaneLeaf } from './pane-layout';
import { paneActiveSelection } from './pane-layout';
import { navigationKey } from './text-format';
import { paneDockActiveRoot, PaneSideDock, type PaneSideDockFile } from './pane-side-dock';
import { PaneDockToggles } from './pane-dock-toggles';
import { DeferredPersistentSurface } from './PaneSurfaceGate';
import { EDITOR_STARTUP_DELAY_MS, ReadyEditorPane } from './app-shell-components';
import { DesktopLoadingSurface } from './RendererRecovery';
import { t } from './i18n';
import { sideFileDirtyKey, type createSideFileGuard } from './side-file-guard';
import type { EditorSaveHandle } from './use-pane-tab-close';
import { sessionSideDockEntryForSession } from './session-side-surface-policy';
import { SessionBrowserSlot } from './session-browser-surfaces';
import { SessionTerminalSlot } from './session-terminal-surfaces';
import type { useSessionPaneSurfaces } from './use-session-pane-surfaces';
import type { useAppSideDocks } from './use-app-side-docks';
import type { usePaneWorkspace } from './pane-workspace-state';
import type {
  WorkbenchSideTitleDragProps,
  WorkbenchSideViewDescriptor,
  WorkbenchSideViewId,
} from './workbench-side-view-layout';

interface PaneDockContext {
  paneWorkspace: ReturnType<typeof usePaneWorkspace>;
  paneSideDocks: ReturnType<typeof useAppSideDocks>['paneSideDocks'];
  sessionSurfaces: ReturnType<typeof useSessionPaneSurfaces>;
  workbenchSideLayout: ReturnType<typeof useAppSideDocks>['workbenchSideLayout'];
  sideViewDescriptors: ReadonlyMap<WorkbenchSideViewId, WorkbenchSideViewDescriptor>;
  dockBodyWarm: boolean;
  closePaneRightRegion: (leafId: string) => void;
  selectWorkbenchSideView: (id: WorkbenchSideViewId, paneLeafId?: string) => void;
  moveWorkbenchSideGroup: ReturnType<typeof useAppSideDocks>['workbenchSideLayout']['moveGroup'];
  moveWorkbenchSideView: ReturnType<typeof useAppSideDocks>['workbenchSideLayout']['moveView'];
  openFileTab: (project: string, rel: string, line?: number, accessToken?: string) => void;
  sideFileGuard: ReturnType<typeof createSideFileGuard>;
  renderFileProblems: (file: PaneSideDockFile) => React.ReactNode;
  handleFileDirty: (key: string, dirty: boolean) => void;
  registerEditorSaveHandle: (key: string, save: EditorSaveHandle | null, released?: EditorSaveHandle) => void;
  paneProjectPathFor: (leaf: PaneLeaf) => string;
  renderRightView: (
    id: WorkbenchSideViewId,
    active: boolean,
    titleDragProps: WorkbenchSideTitleDragProps,
    pane: { leafId: string; projectPath: string; sessionId: string; prewarm: boolean }
  ) => React.ReactNode;
}

function sessionDockEntry(
  leafId: string,
  sessionId: string,
  paneSideDocks: PaneDockContext['paneSideDocks'],
  sessionSurfaces: PaneDockContext['sessionSurfaces']
) {
  return sessionSideDockEntryForSession(
    paneSideDocks.entryFor(leafId),
    sessionId,
    sessionSurfaces.sessionSideSurfaces.get(sessionId) ?? null,
    sessionSurfaces.sessionDiffs.get(sessionId) ?? null,
    sessionSurfaces.sessionPanelViews.get(sessionId) ?? null
  );
}

export function renderPaneSideDockView(leaf: PaneLeaf, focused: boolean, context: PaneDockContext): React.ReactNode {
  const active = paneActiveSelection(leaf);
  const sessionId = active?.kind === 'session' ? active.id : '';
  const entry = sessionDockEntry(leaf.id, sessionId, context.paneSideDocks, context.sessionSurfaces);
  const prewarm = focused && context.dockBodyWarm;

  return (
    <PaneSideDock
      leafId={leaf.id}
      entry={entry}
      groups={context.workbenchSideLayout.layout.right}
      descriptors={context.sideViewDescriptors}
      focused={focused}
      prewarm={prewarm}
      onFocusPane={() => context.paneWorkspace.focusLeaf(leaf.id)}
      onSelect={(id) => context.selectWorkbenchSideView(id, leaf.id)}
      onClose={() => context.closePaneRightRegion(leaf.id)}
      onCloseDiff={() => {
        // A session's own diff closes in its session map; the pane entry
        // never held it.
        if (entry.diff?.source === 'session' && sessionId) {
          context.sessionSurfaces.setSessionDiff(sessionId, null);
          return;
        }
        context.paneSideDocks.closeDiff(leaf.id);
      }}
      onCloseFile={() =>
        context.sideFileGuard.closeSideFile(leaf.id, () => context.closePaneRightRegion(leaf.id))
      }
      openFileTab={context.openFileTab}
      renderFileProblems={context.renderFileProblems}
      renderFileSurface={(file, surfaceActive, side) => (
        <DeferredPersistentSurface
          // A replacement file remounts, so its model, dirty state and save
          // handle never carry over from the previous one.
          key={`${file.project}\0${file.rel}\0${file.accessToken ?? ''}`}
          active
          startupDelayMs={EDITOR_STARTUP_DELAY_MS}
          fallback={<DesktopLoadingSurface label={t('Loading editor…')} />}
        >
          <ReadyEditorPane
            surfaceKey={`${leaf.id}:side-file`}
            projectPath={file.project}
            relPath={file.rel}
            accessToken={file.accessToken}
            active={surfaceActive}
            focused={surfaceActive && focused}
            onSideChrome={side.onChrome}
            onShowProblems={side.onShowProblems}
            onDirty={(dirty) => context.handleFileDirty(sideFileDirtyKey(leaf.id), dirty)}
            onSaveHandle={(save, released) =>
              context.registerEditorSaveHandle(sideFileDirtyKey(leaf.id), save, released)
            }
            reveal={file.line ? { line: file.line, column: file.column, nonce: file.nonce } : null}
            onOpenAt={file.accessToken ? undefined : (rel, line) => context.openFileTab(file.project, rel, line)}
            onOpenFile={context.openFileTab}
          />
        </DeferredPersistentSurface>
      )}
      renderBrowserSurface={(surfaceActive) => {
        if (!sessionId) return null;
        return (
          <SessionBrowserSlot
            controller={context.sessionSurfaces.browserSurfaces}
            sessionId={sessionId}
            active={surfaceActive}
            foreground={surfaceActive && focused}
          />
        );
      }}
      renderTerminalSurface={(surfaceActive) => {
        if (!sessionId) return null;
        return (
          <SessionTerminalSlot
            controller={context.sessionSurfaces.terminalSurfaces}
            sessionId={sessionId}
            cwd={context.paneProjectPathFor(leaf) || null}
            active={surfaceActive}
            foreground={surfaceActive && focused}
          />
        );
      }}
      onMoveGroup={context.moveWorkbenchSideGroup}
      onMoveView={context.moveWorkbenchSideView}
      renderView={(id, viewActive, titleDragProps) =>
        context.renderRightView(
          id,
          id === 'session-diff' ? viewActive && entry.surface === '' : viewActive,
          titleDragProps,
          {
            leafId: leaf.id,
            projectPath: context.paneProjectPathFor(leaf),
            sessionId,
            prewarm,
          }
        )
      }
    />
  );
}

export function renderPaneDockStripTrailing(
  leaf: PaneLeaf,
  {
    workbenchSideLayout,
    paneSideDocks,
    sessionSurfaces,
    sideViewDescriptors,
    selectWorkbenchSideView,
    closePaneRightRegion,
    focusLeaf,
  }: {
    workbenchSideLayout: ReturnType<typeof useAppSideDocks>['workbenchSideLayout'];
    paneSideDocks: ReturnType<typeof useAppSideDocks>['paneSideDocks'];
    sessionSurfaces: ReturnType<typeof useSessionPaneSurfaces>;
    sideViewDescriptors: ReadonlyMap<WorkbenchSideViewId, WorkbenchSideViewDescriptor>;
    selectWorkbenchSideView: (id: WorkbenchSideViewId, paneLeafId?: string) => void;
    closePaneRightRegion: (leafId: string) => void;
    focusLeaf: (leafId: string) => void;
  }
): React.ReactNode {
  const active = leaf.tabs.find((tab) => navigationKey(tab) === leaf.activeKey);
  if (!active || (active.kind !== 'session' && active.kind !== 'new')) return null;
  const groups = workbenchSideLayout.layout.right;
  if (groups.length === 0) return null;
  const sessionId = active.kind === 'session' ? active.id : '';
  const entry = sessionDockEntry(leaf.id, sessionId, paneSideDocks, sessionSurfaces);
  return (
    <PaneDockToggles
      groups={groups}
      descriptors={sideViewDescriptors}
      activeRoot={paneDockActiveRoot(entry)}
      sessionBound={Boolean(sessionId)}
      onSelect={(id) => {
        focusLeaf(leaf.id);
        selectWorkbenchSideView(id, leaf.id);
      }}
      onClose={() => {
        focusLeaf(leaf.id);
        closePaneRightRegion(leaf.id);
      }}
    />
  );
}
