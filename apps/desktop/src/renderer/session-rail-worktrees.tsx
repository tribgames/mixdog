// The session panel's Worktrees category: the project's worktrees from the
// branch menu's own read, with the branch panel's actions.
import { FolderGit2, FolderOpen, GitFork, GitMerge, Plus, Search, Trash2 } from 'lucide-react';
import { type ReactNode, useId, useRef, useState } from 'react';
import type { DesktopBranchMenu, DesktopSessionWorkspace } from '../shared/contract';
import { BranchNameDialog, startNewBranch, useBranchMenuActions, WorktreeCarryDialog } from './branch-menu';
import { useBranchMenuData } from './branch-menu-data';
import { openBranchFolder, runBranchRowAction } from './branch-row-actions';
import type { ComposerIslandFlash } from './ComposerIsland';
import { t } from './i18n';
import { showDesktopToast } from './notifications';
import { RailSection } from './session-rail-parts';
import { type BranchRow, branchRows, projectFolderBranch } from './worktree-branch-model';
import { useWorktreeSessionActions } from './WorktreeIslandSegment';

/** `managed`: a folder the app made (a session's worktree); only those can be removed. */
export type RailWorktree = { row: BranchRow; name: string; path: string; current: boolean; managed: boolean };

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
  const trigger = useRef<HTMLButtonElement>(null);
  const dialogId = useId();
  // The search narrows the rows and names the branch "New branch" creates.
  const [query, setQuery] = useState('');
  const [namingBranch, setNamingBranch] = useState(false);
  const { menu, load, notice, setNotice } = useBranchMenuData({
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
    query,
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
  const needle = query.trim().toLowerCase();
  const listed = needle
    ? worktrees.filter((tree) => `${tree.name}\n${tree.row.name}`.toLowerCase().includes(needle))
    : worktrees;
  const transitionOff = actions.busy || locked;
  const worktreeOff = transitionOff || actions.worktreeUnavailable || Boolean(menu?.workspace.worktreeId);
  return (
    <>
      <RailSection
        category="worktrees"
        title={t('Worktrees')}
        count={worktrees.length}
        open={open}
        onToggle={onToggle}
        summary={<span className="session-rail-cut">{shown?.name}</span>}
        scroll
        top={
          <label className="session-rail-search">
            <Search size={14} aria-hidden="true" />
            <input
              type="search"
              value={query}
              placeholder={t('Search branches')}
              aria-label={t('Search branches')}
              onChange={(event) => setQuery(event.currentTarget.value)}
            />
          </label>
        }
        foot={
          <>
            <button
              ref={trigger}
              type="button"
              className="composer-island-button"
              data-kind="create"
              aria-disabled={transitionOff || undefined}
              title={lockTitle}
              onClick={() => startNewBranch({ actions, query, locked, setNotice: notify, setNamingBranch })}
            >
              <Plus size={14} aria-hidden="true" />
              <span>{t('New branch')}</span>
            </button>
            <button
              type="button"
              className="composer-island-button"
              data-kind="worktree"
              aria-disabled={worktreeOff || undefined}
              title={actions.worktreeUnavailable ? t('This folder does not support worktrees.') : lockTitle}
              onClick={() => {
                if (!worktreeOff) void actions.pickWorktree();
              }}
            >
              <FolderGit2 size={14} aria-hidden="true" />
              <span>{t('New worktree')}</span>
            </button>
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
      >
        {listed.map((tree) => {
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
                {tree.current && <span className="session-rail-num session-rail-under-act">{t('Current')}</span>}
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
      </RailSection>
      {namingBranch && (
        <BranchNameDialog
          panelId={dialogId}
          anchor={trigger}
          name={query}
          onName={setQuery}
          busy={actions.busy}
          notice={notice}
          onCreate={actions.createBranch}
          onClose={() => setNamingBranch(false)}
        />
      )}
      {own.dialog}
      {carry}
    </>
  );
}
