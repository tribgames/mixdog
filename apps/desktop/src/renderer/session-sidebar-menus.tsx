import { Plus } from 'lucide-react';
import { useCallback, useRef, useState } from 'react';
import { agentIdOfHomeSession } from '../../../../src/runtime/agent/orchestrator/session/agent-home.mjs';
import { roomIdOfSession } from '../../../../src/runtime/agent/orchestrator/session/agent-room.mjs';
import type { DesktopSessionSummary } from '../shared/contract';
import { t } from './i18n';
import { MxIcon } from './MxIcon';
import type { ScmContextMenuItem, ScmContextMenuState } from './ScmContextMenu';
import { sessionLabel } from './session-sidebar-rows';
import type { ProjectSessionGroup } from './session-sidebar-sections';
import { isOpen, type OpenMap } from './sidebar-open-state';
import { copyTextToClipboard } from './text-format';
import { useStableEvent } from './use-stable-event';

type MenuPoint = { x: number; y: number };
type ProjectRename = { key: string; draft: string; original: string };

interface SessionMenuActions {
  onResumeSession(sessionId: string): void;
  onOpenSessionInSplit?(sessionId: string, title: string): void;
  onInheritSession?(sessionId: string): void;
  onArchiveSession(sessionId: string, archived: boolean): Promise<void>;
  onFavoriteSession(sessionId: string, favorite: boolean): Promise<void>;
  onMoveSessionToProject?(sessionId: string, projectPath: string): Promise<void>;
  onAddProject?(onAdded?: (projectPath: string) => void): void;
  openSessionEditor(session: DesktopSessionSummary, rowKey: string): void;
  closeSessionEditor(): void;
  requestDelete(sessionId: string): void;
  sessionGroupKeys: ReadonlyMap<string, string>;
  projectGroups: readonly ProjectSessionGroup[];
  moveSession(sessionId: string, projectPath: string): void;
}

interface ProjectMenuActions {
  projectOpen: OpenMap;
  onNewProjectTask?(projectPath: string): void;
  onNewTask(): void;
  toggleProject(key: string): void;
  onRevealProject?(projectPath: string): void;
  onRenameProject?(projectPath: string, alias: string): void;
  onOpenProjectSettings?(projectPath: string): void;
}

// A menu item runs after the menu has closed and handed focus back to the row,
// so an item that opens an inline editor starts it on the next tick — otherwise
// that returning focus would blur (and commit) the new editor at once.
const afterMenu = (action: () => void) => () => window.setTimeout(action, 0);

export function sessionMenuItems(
  session: DesktopSessionSummary,
  rowKey: string,
  actions: SessionMenuActions
): ScmContextMenuItem[] {
  const { onOpenSessionInSplit, onInheritSession, onArchiveSession, onFavoriteSession, onAddProject } = actions;
  const { projectGroups, moveSession } = actions;
  const label = sessionLabel(session);
  const archived = session.archived === true;
  const items: ScmContextMenuItem[] = [
    { id: 'open', label: t('Open'), onSelect: () => actions.onResumeSession(session.id) },
  ];
  if (onOpenSessionInSplit) {
    items.push({
      id: 'open-split',
      label: t('Open in split pane'),
      onSelect: () => onOpenSessionInSplit(session.id, label),
    });
  }
  // A bot's home chat and a room's log are named by the bot / room: a session
  // title edit would be overwritten (and is wrong), so they offer no Rename
  // here — the bot / room rows rename the real thing. Only archived ones list.
  if (!agentIdOfHomeSession(session.id) && !roomIdOfSession(session.id)) {
    items.push({
      id: 'rename',
      label: t('Rename'),
      separatorBefore: true,
      onSelect: afterMenu(() => actions.openSessionEditor(session, rowKey)),
    });
  }
  if (onInheritSession && !archived) {
    items.push({ id: 'inherit', label: t('Fork session'), onSelect: () => onInheritSession(session.id) });
  }
  // A deleted bot's archived chat restores the bot with it (session-sidebar.tsx).
  if (archived) {
    items.push({
      id: 'restore',
      label: t('Restore'),
      separatorBefore: true,
      onSelect: () => void onArchiveSession(session.id, false).catch(() => {}),
    });
  } else {
    items.push(
      {
        id: 'favorite',
        label: session.favorite ? t('Remove from favorites') : t('Add to favorites'),
        separatorBefore: true,
        onSelect: () => void onFavoriteSession(session.id, !session.favorite).catch(() => {}),
      },
      { id: 'archive', label: t('Archive'), onSelect: () => void onArchiveSession(session.id, true).catch(() => {}) }
    );
  }
  // Keyboard path of the drag-to-folder move: changes the session's working folder.
  const currentProjectKey = actions.sessionGroupKeys.get(session.id) ?? '';
  if (actions.onMoveSessionToProject && !archived && (projectGroups.length > 0 || onAddProject)) {
    const destinations: ScmContextMenuItem[] = projectGroups
      .filter((group) => group.key !== currentProjectKey)
      .map((group, index) => ({
        id: `move-to-${group.key}`,
        label: group.name,
        icon: <MxIcon name="folder" size={14} />,
        separatorBefore: index === 0 && Boolean(onAddProject),
        onSelect: () => moveSession(session.id, group.path),
      }));
    if (onAddProject) {
      destinations.unshift({
        id: 'move-to-new-project',
        label: t('New project…'),
        icon: <Plus size={14} aria-hidden="true" />,
        onSelect: () => onAddProject((path) => moveSession(session.id, path)),
      });
    }
    items.push({
      id: 'move-to-project',
      label: t('Move to project'),
      separatorBefore: true,
      children: destinations,
    });
    if (currentProjectKey) {
      items.push({
        id: 'remove-from-project',
        label: t('Remove from project'),
        onSelect: () => moveSession(session.id, ''),
      });
    }
  }
  // Delete never runs from the menu itself: it arms the row's inline
  // cancel/confirm pair, the same confirmation archived rows use (a busy
  // session asks in a dialog instead).
  items.push({
    id: 'delete',
    label: t('Delete'),
    danger: true,
    separatorBefore: true,
    onSelect: afterMenu(() => {
      actions.closeSessionEditor();
      actions.requestDelete(session.id);
    }),
  });
  return items;
}

function projectMenuItems(
  group: ProjectSessionGroup,
  actions: ProjectMenuActions,
  setProjectRename: (rename: ProjectRename) => void
): ScmContextMenuItem[] {
  const { onNewProjectTask, onRevealProject, onRenameProject, onOpenProjectSettings } = actions;
  const expanded = isOpen(actions.projectOpen, group.key);
  const items: ScmContextMenuItem[] = [
    {
      id: 'new-task',
      label: t('New task'),
      onSelect: () => (onNewProjectTask ? onNewProjectTask(group.path) : actions.onNewTask()),
    },
    {
      id: 'toggle',
      label: expanded ? t('Collapse {{label}}', { label: group.name }) : t('Expand {{label}}', { label: group.name }),
      onSelect: () => actions.toggleProject(group.key),
    },
  ];
  if (onRevealProject) {
    items.push({
      id: 'reveal',
      label: t('Reveal in Explorer'),
      separatorBefore: true,
      onSelect: () => onRevealProject(group.path),
    });
  }
  items.push({
    id: 'copy-path',
    label: t('Copy path'),
    separatorBefore: !onRevealProject,
    onSelect: () => void copyTextToClipboard(group.path).catch(() => {}),
  });
  if (onRenameProject) {
    items.push({
      id: 'rename',
      label: t('Rename'),
      separatorBefore: true,
      onSelect: afterMenu(() => setProjectRename({ key: group.key, draft: group.name, original: group.name })),
    });
  }
  if (onOpenProjectSettings) {
    items.push({
      id: 'settings',
      label: t('Project settings'),
      separatorBefore: !onRenameProject,
      onSelect: () => onOpenProjectSettings(group.path),
    });
  }
  return items;
}

/** Right-click menus: one shared menu surface, items per target (session row
 *  or project folder), plus the inline project rename a folder menu starts. */
export function useSidebarMenus(actions: SessionMenuActions & ProjectMenuActions) {
  const [contextMenu, setContextMenu] = useState<ScmContextMenuState | null>(null);
  // The session whose row opened the last session menu (right-click, long-press,
  // Menu key). A windowed list keeps that row mounted: the menu hands focus
  // back to it on close, and Rename/Delete run on it after the menu is gone,
  // so the pin outlives the menu until another menu opens.
  const [menuOriginId, setMenuOriginId] = useState('');
  const closeContextMenu = useCallback(() => setContextMenu(null), []);
  // One identity for the memoised rows; the menu reads the current actions.
  const openSessionMenu = useStableEvent((session: DesktopSessionSummary, point: MenuPoint, rowKey: string) => {
    setMenuOriginId(session.id);
    setContextMenu({ label: sessionLabel(session), ...point, items: sessionMenuItems(session, rowKey, actions) });
  });
  const [projectRename, setProjectRename] = useState<ProjectRename | null>(null);
  const projectRenameRef = useRef(projectRename);
  projectRenameRef.current = projectRename;
  // Enter commits and the input's removal may still blur it: the ref makes the
  // second call a no-op.
  const commitProjectRename = (group: ProjectSessionGroup) => {
    const current = projectRenameRef.current;
    if (!current || current.key !== group.key) return;
    projectRenameRef.current = null;
    setProjectRename(null);
    const alias = current.draft.trim();
    if (alias && alias !== current.original) actions.onRenameProject?.(group.path, alias);
  };
  const openProjectMenu = (group: ProjectSessionGroup, point: MenuPoint) => {
    setMenuOriginId('');
    setContextMenu({ label: group.name, ...point, items: projectMenuItems(group, actions, setProjectRename) });
  };
  /** Any other row's menu on the same surface (a bot row's contact menu). */
  const openMenu = useCallback((menu: ScmContextMenuState) => {
    setMenuOriginId('');
    setContextMenu(menu);
  }, []);
  const projectRenameEditor = projectRename && {
    key: projectRename.key,
    draft: projectRename.draft,
    onDraft: (draft: string) => setProjectRename((current) => current && { ...current, draft }),
    onCommit: commitProjectRename,
    onCancel: () => {
      projectRenameRef.current = null;
      setProjectRename(null);
    },
  };
  return {
    contextMenu,
    menuOriginId,
    closeContextMenu,
    openSessionMenu,
    openProjectMenu,
    openMenu,
    projectRenameEditor,
  };
}
