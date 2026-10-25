import type React from 'react';
import { Suspense, useMemo, useRef } from 'react';
import { isAgentChatSession } from './agent-chat-mode';
import { SideMarkdownPreview } from './lazy-widgets';
import type { PaneLeaf } from './pane-layout';
import { paneActiveSelection } from './pane-layout';
import { navigationKey } from './text-format';
import { paneDockActiveRoot, paneDockFileCloseEndsDock, PaneSideDock, type PaneSideDockFile } from './pane-side-dock';
import { PaneDockToggles } from './pane-dock-toggles';
import { agentChatStripGroups, codingStripGroups, paneRightGroupsFor } from './routines-tile';
import type { PaneDockFilesSurface as PaneDockFilesSurfaceComponent } from './pane-dock-files';
import { useDeferredModule } from './deferred-module';
import { paneDockFilesModule } from './first-screen-deferred';
import { DeferredPersistentSurface } from './PaneSurfaceGate';
import { EDITOR_STARTUP_DELAY_MS, ReadyEditorPane } from './app-shell-components';
import { DesktopLoadingSurface } from './RendererRecovery';
import { t } from './i18n';
import { sideFileDirtyKey, type createSideFileGuard } from './side-file-guard';
import { sideFileKey } from './side-file-tabs';
import type { EditorSaveHandle } from './use-pane-tab-close';
import {
  isSessionSidePanelView,
  sessionPanelViewIn,
  sessionSideDockEntryForSession,
  sessionSurfaceSessionFor,
} from './session-side-surface-policy';
import { SessionBrowserSlot } from './session-browser-surfaces';
import { SessionTerminalSlot } from './session-terminal-surfaces';
import { prewarmSessionTerminal } from './SessionTerminalTabs';
import { resolveTerminalCwd } from './session-terminal-tabs';
import { prefetchSessionChanges } from './session-changes-store';
import { sessionDiffStripHasTabs } from './use-session-diff-tabs';
import type { useSessionPaneSurfaces } from './use-session-pane-surfaces';
import type { useAppSideDocks } from './use-app-side-docks';
import type { usePaneWorkspace } from './pane-workspace-state';
import type {
  WorkbenchSideTitleDragProps,
  WorkbenchSideViewDescriptor,
  WorkbenchSideViewId,
} from './workbench-side-view-layout';

/** The Files tree (Explorer) is no first screen's surface: its chunk loads on
 *  first mount or from the idle lane, behind the delayed loading surface. */
function PaneDockFilesSurface(props: React.ComponentProps<typeof PaneDockFilesSurfaceComponent>) {
  const module = useDeferredModule(paneDockFilesModule, { bootSurface: props.active ? 'dock-files' : undefined });
  return module ? <module.PaneDockFilesSurface {...props} /> : <DesktopLoadingSurface label={t('Loading view…')} />;
}

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
  renameProjectEntry?: (projectPath: string, relPath: string, newName: string) => Promise<void>;
  renderFileProblems: (file: PaneSideDockFile) => React.ReactNode;
  handleFileDirty: (key: string, dirty: boolean) => void;
  registerEditorSaveHandle: (key: string, save: EditorSaveHandle | null, released?: EditorSaveHandle) => void;
  paneProjectPathFor: (leaf: PaneLeaf) => string;
  /** The session workspace's execution root (a managed worktree or the project folder). */
  sessionWorkspaceCwdFor?: (sessionId: string) => string | null;
  renderRightView: (
    id: WorkbenchSideViewId,
    active: boolean,
    titleDragProps: WorkbenchSideTitleDragProps,
    pane: { leafId: string; projectPath: string; sessionId: string; prewarm: boolean }
  ) => React.ReactNode;
}

/** `groups`: the tab's own right-side groups (paneRightGroupsFor); a session
 *  view they do not hold is not shown. */
function sessionDockEntry(
  leafId: string,
  sessionId: string,
  paneSideDocks: PaneDockContext['paneSideDocks'],
  sessionSurfaces: PaneDockContext['sessionSurfaces'],
  groups: readonly (readonly string[])[]
) {
  return sessionSideDockEntryForSession(
    paneSideDocks.entryFor(leafId),
    sessionId,
    sessionSurfaces.sessionSideSurfaces.get(sessionId) ?? null,
    sessionSurfaces.sessionDiffs.get(sessionId) ?? null,
    sessionPanelViewIn(groups, sessionSurfaces.sessionPanelViews.get(sessionId)),
    sessionSurfaces.panelViewFronts.has(sessionId)
  );
}

export function renderPaneSideDockView(leaf: PaneLeaf, focused: boolean, context: PaneDockContext): React.ReactNode {
  const active = paneActiveSelection(leaf);
  const sessionId = active?.kind === 'session' ? active.id : '';
  const groups = paneRightGroupsFor(context.workbenchSideLayout.layout.right, sessionId);
  const entry = sessionDockEntry(leaf.id, sessionId, context.paneSideDocks, context.sessionSurfaces, groups);
  const prewarm = focused && context.dockBodyWarm;
  // A child session's terminal revealed in this conversation's dock (its
  // owner chain): the slot shows the child's terminal. A child's browser
  // page shows in this session's own browser as a borrowed tab.
  const surfaceSession = (surface: 'terminal') =>
    sessionSurfaceSessionFor(context.sessionSurfaces.sessionSurfaceSources, sessionId, surface);
  const projectPath = context.paneProjectPathFor(leaf);
  // The Files tree reopens on the folder it last revealed in this
  // Project, else on the Project root.
  const filesRel = entry.folder?.project === projectPath ? entry.folder.rel : '';

  return (
    <SessionToggleDescriptors
      base={context.sideViewDescriptors}
      leafId={leaf.id}
      sessionId={sessionId}
      renderParked={context.sessionSurfaces.terminalSurfaces.prewarm}
    >
      {(descriptors) => (
        <PaneSideDock
          leafId={leaf.id}
          entry={entry}
          sessionId={sessionId}
          sessionBound={Boolean(sessionId)}
          onOpenFiles={projectPath ? () => context.paneSideDocks.openFolder(leaf.id, projectPath, filesRel) : undefined}
          groups={groups}
          // Agent mode: no Changes in the phone ⋯ switch; the changes card opens it.
          switchGroups={
            isAgentChatSession(sessionId) ? groups.filter((group) => !group.includes('session-diff')) : undefined
          }
          descriptors={descriptors}
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
          onCloseFile={() => context.sideFileGuard.closeSideFile(leaf.id, () => context.closePaneRightRegion(leaf.id))}
          onCloseFileTab={(fileKey) =>
            context.sideFileGuard.closeSideFileTab(
              leaf.id,
              fileKey,
              paneDockFileCloseEndsDock(entry, fileKey, Boolean(sessionId) && sessionDiffStripHasTabs(sessionId))
                ? () => context.closePaneRightRegion(leaf.id)
                : undefined
            )
          }
          onActivateFile={(fileKey) => context.paneSideDocks.activateFile(leaf.id, fileKey)}
          onKeepFile={(fileKey) => context.paneSideDocks.keepFile(leaf.id, fileKey)}
          onCloseFolder={() => {
            context.paneSideDocks.closeFolder(leaf.id);
            context.closePaneRightRegion(leaf.id);
          }}
          openFileTab={context.openFileTab}
          renderFilesSurface={(folder, surfaceActive, side) => (
            <PaneDockFilesSurface
              folder={folder}
              active={surfaceActive}
              // The side-dock rules: a tree file opens in this pane's side editor
              // behind the unsaved-edit guard.
              onOpenFile={(project, rel, mode) =>
                context.sideFileGuard.openFileInSideDock(
                  leaf.id,
                  project,
                  rel,
                  undefined,
                  undefined,
                  undefined,
                  undefined,
                  mode === 'pinned'
                )
              }
              onRenameEntry={context.renameProjectEntry}
              onClose={side.onClose}
            />
          )}
          renderFileProblems={context.renderFileProblems}
          renderFileSurface={(file, surfaceActive, side) => {
            const reveal = file.line ? { line: file.line, column: file.column, nonce: file.nonce } : null;
            const onOpenAt = file.accessToken
              ? undefined
              : (rel: string, line?: number) => context.openFileTab(file.project, rel, line);
            return (
              <DeferredPersistentSurface
                // A replacement file remounts, so its model, dirty state and save
                // handle never carry over from the previous one.
                key={sideFileKey(file)}
                active
                startupDelayMs={EDITOR_STARTUP_DELAY_MS}
                fallback={<DesktopLoadingSurface label={t('Loading editor…')} />}
              >
                {file.sidePreview ? (
                  <Suspense fallback={<DesktopLoadingSurface label={t('Loading editor…')} />}>
                    <SideMarkdownPreview
                      projectPath={file.project}
                      relPath={file.rel}
                      accessToken={file.accessToken}
                      onSideChrome={side.onChrome}
                      onOpenFile={(project, rel, line) =>
                        context.sideFileGuard.openFileInSideDock(
                          leaf.id,
                          project,
                          rel,
                          line,
                          undefined,
                          undefined,
                          sideFileKey(file)
                        )
                      }
                    />
                  </Suspense>
                ) : (
                  <ReadyEditorPane
                    surfaceKey={`${leaf.id}:side-file:${sideFileKey(file)}`}
                    projectPath={file.project}
                    relPath={file.rel}
                    accessToken={file.accessToken}
                    active={surfaceActive}
                    focused={surfaceActive && focused}
                    onSideChrome={side.onChrome}
                    onShowProblems={side.onShowProblems}
                    onDirty={(dirty) => {
                      context.handleFileDirty(sideFileDirtyKey(leaf.id, file), dirty);
                      // An edit makes a preview tab a normal one.
                      if (dirty) context.paneSideDocks.keepFile(leaf.id, sideFileKey(file));
                    }}
                    onSaveHandle={(save, released) =>
                      context.registerEditorSaveHandle(sideFileDirtyKey(leaf.id, file), save, released)
                    }
                    reveal={reveal}
                    onOpenAt={onOpenAt}
                    // A link followed inside this tab opens in the dock, remembering
                    // its origin tab (a fresh preview tab is kept, not replaced).
                    onOpenFile={(project, rel, line, accessToken) =>
                      context.sideFileGuard.openFileInSideDock(
                        leaf.id,
                        project,
                        rel,
                        line,
                        accessToken,
                        undefined,
                        sideFileKey(file)
                      )
                    }
                  />
                )}
              </DeferredPersistentSurface>
            );
          }}
          renderBrowserSurface={(surfaceActive, exiting) => {
            if (!sessionId) return null;
            return (
              <SessionBrowserSlot
                controller={context.sessionSurfaces.browserSurfaces}
                sessionId={sessionId}
                active={surfaceActive}
                foreground={surfaceActive && focused && !exiting}
                exiting={exiting}
              />
            );
          }}
          renderTerminalSurface={(surfaceActive, exiting) => {
            if (!sessionId) return null;
            const terminalSession = surfaceSession('terminal');
            return (
              <SessionTerminalSlot
                controller={context.sessionSurfaces.terminalSurfaces}
                sessionId={terminalSession}
                cwd={resolveTerminalCwd(context.sessionWorkspaceCwdFor?.(terminalSession), projectPath)}
                active={surfaceActive}
                foreground={surfaceActive && focused && !exiting}
                exiting={exiting}
              />
            );
          }}
          onMoveGroup={context.moveWorkbenchSideGroup}
          onMoveView={context.moveWorkbenchSideView}
          renderView={(id, viewActive, titleDragProps) =>
            context.renderRightView(
              id,
              isSessionSidePanelView(id) ? viewActive && entry.surface === '' : viewActive,
              titleDragProps,
              {
                leafId: leaf.id,
                projectPath,
                sessionId,
                prewarm,
              }
            )
          }
        />
      )}
    </SessionToggleDescriptors>
  );
}

/** A session pane's toggle descriptors: its Terminal toggle's prefetch also
 *  warms that session's terminal (prewarmSessionTerminal), and its Changes
 *  toggle's starts that session's first screen of diffs
 *  (prefetchSessionChanges, for the dock of pane `leafId`). */
function sessionToggleDescriptors(
  base: ReadonlyMap<WorkbenchSideViewId, WorkbenchSideViewDescriptor>,
  leafId: string,
  sessionId: string,
  renderParked: (sessionId: string) => void
): ReadonlyMap<WorkbenchSideViewId, WorkbenchSideViewDescriptor> {
  const terminal = base.get('terminal');
  const changes = base.get('session-diff');
  if (!sessionId || (!terminal && !changes)) return base;
  const descriptors = new Map(base);
  if (terminal) {
    descriptors.set('terminal', {
      ...terminal,
      onPrefetch: () => {
        terminal.onPrefetch?.();
        prewarmSessionTerminal(sessionId, renderParked);
      },
    });
  }
  if (changes) {
    descriptors.set('session-diff', {
      ...changes,
      onPrefetch: () => {
        changes.onPrefetch?.();
        prefetchSessionChanges(sessionId, { paneKey: leafId });
      },
    });
  }
  return descriptors;
}

/** Hands its children the pane's session descriptors. They live in this pane
 *  dock's own render: one stable map per base map, pane and session while it
 *  is mounted, dropped with it (a session change builds the next). */
function SessionToggleDescriptors({
  base,
  leafId,
  sessionId,
  renderParked,
  children,
}: {
  base: ReadonlyMap<WorkbenchSideViewId, WorkbenchSideViewDescriptor>;
  leafId: string;
  sessionId: string;
  renderParked: (sessionId: string) => void;
  children: (descriptors: ReadonlyMap<WorkbenchSideViewId, WorkbenchSideViewDescriptor>) => React.ReactNode;
}) {
  // The caller's callback may be rebuilt every render; the map keeps calling the latest.
  const latest = useRef(renderParked);
  latest.current = renderParked;
  const descriptors = useMemo(
    () => sessionToggleDescriptors(base, leafId, sessionId, (id) => latest.current(id)),
    [base, leafId, sessionId]
  );
  return <>{children(descriptors)}</>;
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
  const sessionId = active.kind === 'session' ? active.id : '';
  const agentChat = isAgentChatSession(sessionId);
  const paneGroups = paneRightGroupsFor(workbenchSideLayout.layout.right, sessionId);
  const groups = agentChat ? agentChatStripGroups(paneGroups) : codingStripGroups(paneGroups);
  if (groups.length === 0) return null;
  const entry = sessionDockEntry(leaf.id, sessionId, paneSideDocks, sessionSurfaces, paneGroups);
  return (
    <SessionToggleDescriptors
      base={sideViewDescriptors}
      leafId={leaf.id}
      sessionId={sessionId}
      renderParked={sessionSurfaces.terminalSurfaces.prewarm}
    >
      {(descriptors) => (
        <PaneDockToggles
          groups={groups}
          descriptors={descriptors}
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
      )}
    </SessionToggleDescriptors>
  );
}
