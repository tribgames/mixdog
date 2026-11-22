// The session panel's Worktrees category: the project's worktrees from the
// branch menu's own read, with the branch panel's actions.
import { FolderOpen, GitFork, GitMerge, Trash2 } from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import type { DesktopBranchMenu, DesktopManagedWorktreeRow, DesktopSessionWorkspace } from '../shared/contract';
import { useBranchMenuActions, WorktreeCarryDialog } from './branch-menu';
import { useBranchMenuData } from './branch-menu-data';
import { openBranchFolder, runBranchRowAction } from './branch-row-actions';
import type { ComposerIslandFlash } from './ComposerIsland';
import { t } from './i18n';
import { showDesktopToast } from './notifications';
import { RailList, RailSection } from './session-rail-parts';
import { type BranchRow, branchRows, invokeWorktree, projectFolderBranch } from './worktree-branch-model';
import { useWorktreeSessionActions } from './WorktreeIslandSegment';

export const RAIL_WORKTREE_ROWS = 3;

/** `managed`: a folder the app made (a session's worktree); only those can be removed. */
export type RailWorktree = { row: BranchRow; name: string; path: string; current: boolean; managed: boolean };

const pathKey = (path: string) => path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
const folderName = (path: string) => path.replace(/\\/g, '/').replace(/\/+$/, '').split('/').pop() || path;

/** The worktrees besides the project's main checkout: managed ones (this
 *  session's first) and those Mixdog does not manage. */
export function railWorktrees(menu: DesktopBranchMenu | null, sessionId: string): RailWorktree[] {
  if (!menu) return [];
  const held = new Map(menu.occupancy.map((entry) => [entry.branch, entry]));
  const own = menu.workspace.worktreeId ? menu.workspace.cwd : '';
  return branchRows(menu, sessionId, '')
    .filter((row) => row.group === 'worktree' || row.group === 'external' || (row.mark === 'current' && own))
    .map((row) => {
      const current = row.mark === 'current';
      const retained = menu.retainedWorktree?.branch === row.name ? menu.retainedWorktree.path : '';
      const path = (current ? own : '') || held.get(row.name)?.path || row.path || retained;
      const managed = current || held.get(row.name)?.kind === 'session';
      return { row, path, current, managed, name: path ? folderName(path) : row.name };
    })
    .sort((a, b) => Number(b.current) - Number(a.current));
}

/** Uncommitted paths per managed worktree folder (listWorktrees), read while `active`. */
function useWorktreeDirtyCounts(active: boolean, refreshKey: string): ReadonlyMap<string, number> {
  const [counts, setCounts] = useState<ReadonlyMap<string, number>>(new Map());
  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey is the deliberate re-read trigger
  useEffect(() => {
    if (!active) return undefined;
    let live = true;
    invokeWorktree<DesktopManagedWorktreeRow[]>('listWorktrees')
      .then((rows) => {
        if (!live || !Array.isArray(rows)) return;
        setCounts(new Map(rows.map((row) => [pathKey(row.path), Number(row.dirty) || 0])));
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [active, refreshKey]);
  return counts;
}

function IconAction({
  label,
  title,
  icon,
  danger = false,
  disabled = false,
  onClick,
}: {
  label: string;
  /** Why it is unavailable, or where it goes; the label by default. */
  title?: string;
  icon: ReactNode;
  danger?: boolean;
  disabled?: boolean;
  onClick(): void;
}) {
  return (
    <button
      type="button"
      className="session-rail-icon"
      data-danger={danger || undefined}
      aria-label={label}
      title={title || label}
      disabled={disabled}
      onClick={onClick}
    >
      {icon}
    </button>
  );
}

export function WorktreesSection({
  sessionId,
  workspace,
  projectPath,
  locked,
  refreshKey,
  open,
  onToggle,
  onFlash,
}: {
  sessionId: string;
  workspace: DesktopSessionWorkspace | null;
  projectPath: string;
  locked: boolean;
  refreshKey: string;
  open: boolean;
  onToggle(): void;
  onFlash(flash: ComposerIslandFlash): void;
}) {
  const trigger = useRef<HTMLElement>(null);
  const { menu, load, setNotice } = useBranchMenuData({
    draft: false,
    projectPath,
    sessionId,
    intentKey: '',
    refreshKey,
    eager: Boolean(workspace?.repoCommonDir),
  });
  const notify = (text: string) => {
    if (text) showDesktopToast(text, 'info');
    setNotice(text);
  };
  const actions = useBranchMenuActions({
    draft: false,
    intent: false,
    intentKey: '',
    sessionId,
    projectPath,
    menu,
    query: '',
    locked,
    menuOpen: open,
    load,
    setNotice: notify,
    close: () => {},
    reopen: () => {},
    trigger,
  });
  const own = useWorktreeSessionActions({ sessionId, onFlash: (flash) => onFlash(flash) });
  const worktrees = railWorktrees(menu, sessionId);
  const dirty = useWorktreeDirtyCounts(open && worktrees.length > 0, refreshKey);
  // "New worktree" with uncommitted project-folder files asks, as the island's branch tab does.
  const carry = actions.carry && (
    <WorktreeCarryDialog count={actions.carry.count} paths={actions.carry.paths} onChoose={actions.carry.choose} />
  );
  if (worktrees.length === 0) {
    return (
      <>
        {own.dialog}
        {carry}
      </>
    );
  }
  const shown = worktrees.find((tree) => tree.current) ?? worktrees[0];
  const management = actions.management;
  const branchAction = async (branch: string, action: 'merge' | 'remove-worktree') => {
    const { done, target } = await runBranchRowAction(projectPath, branch, action);
    if (!done) return;
    if (action === 'merge') {
      onFlash({ key: `branch-merge:${branch}:${Date.now()}`, text: t('Merged {{source}} into {{target}}', { source: branch, target }) });
    }
    await load();
  };
  const revision = workspace?.revision ?? menu?.workspace.revision ?? 0;
  // The session's own worktree merges where the island merges it: its target, else the project folder's branch.
  const mergeInto = workspace?.mergeTarget || menu?.workspace.mergeTarget || projectFolderBranch(menu);
  // The island's lock: no merge or removal while anything of the session works.
  const lockTitle = locked ? t("Can't switch while work is running") : undefined;
  return (
    <>
      <RailSection
        category="worktrees"
        title={t('Worktrees')}
        open={open}
        onToggle={onToggle}
        summary={
          <>
            <span className="session-rail-cut">{shown?.name}</span>
            <span aria-hidden="true">·</span>
            <span>{t('{{count}} worktrees', { count: worktrees.length })}</span>
          </>
        }
        tidy={
          management.prune
            ? {
                kind: 'prune',
                description: t('Clean up worktrees'),
                disabled: actions.busy || management.nothingToClean === true,
                onClick: () => void management.prune?.(),
              }
            : undefined
        }
        menu={[
          {
            id: 'new-worktree',
            label: t('New worktree'),
            disabled: actions.worktreeUnavailable || actions.busy || locked || Boolean(menu?.workspace.worktreeId),
            onSelect: () => void actions.pickWorktree(),
          },
        ]}
      >
        <RailList
          budget={RAIL_WORKTREE_ROWS}
          rows={worktrees.map((tree) => {
            const changes = tree.path ? dirty.get(pathKey(tree.path)) : undefined;
            const figure = [
              tree.current ? t('Current') : '',
              changes === undefined ? '' : changes ? t('{{count}} changed', { count: changes }) : t('No changes'),
            ]
              .filter(Boolean)
              .join(' · ');
            return (
              <div
                key={tree.row.name}
                className="session-rail-row session-rail-hover"
                data-current={tree.current || undefined}
                title={tree.path || tree.row.name}
              >
                <GitFork size={14} className="session-rail-ic" aria-hidden="true" />
                <span className="session-rail-cut session-rail-name">{tree.name}</span>
                <span className="session-rail-cut session-rail-grow session-rail-muted">{tree.row.name}</span>
                {figure && <span className="session-rail-num session-rail-under-act">{figure}</span>}
                <span className="session-rail-act">
                  {!tree.current && (
                    <IconAction
                      label={t('Open folder')}
                      title={tree.path || t('This branch has no working folder.')}
                      icon={<FolderOpen size={14} aria-hidden="true" />}
                      disabled={!tree.path}
                      onClick={() => void openBranchFolder(tree.path)}
                    />
                  )}
                  <IconAction
                    label={t('Merge')}
                    title={lockTitle}
                    icon={<GitMerge size={14} aria-hidden="true" />}
                    disabled={own.running || locked || (tree.current && !mergeInto)}
                    onClick={() =>
                      tree.current
                        ? own.askMerge(tree.row.name, mergeInto, revision)
                        : void branchAction(tree.row.name, 'merge')
                    }
                  />
                  <IconAction
                    label={t('Remove')}
                    title={tree.managed ? lockTitle : t('Only app-managed worktree folders can be removed.')}
                    icon={<Trash2 size={14} aria-hidden="true" />}
                    danger
                    disabled={own.running || locked || !tree.managed}
                    onClick={() =>
                      tree.current ? own.askRemove(revision) : void branchAction(tree.row.name, 'remove-worktree')
                    }
                  />
                </span>
              </div>
            );
          })}
        />
      </RailSection>
      {own.dialog}
      {carry}
    </>
  );
}
