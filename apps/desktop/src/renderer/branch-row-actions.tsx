import { Copy, FolderOpen, GitMerge, MoreHorizontal, Trash2 } from 'lucide-react';
import type React from 'react';
import { useCallback, useRef, useState } from 'react';
import type { DesktopBranchActionState, DesktopBranchManagementAction } from '../shared/contract';
import { showDesktopToast } from './desktop-toasts';
import { confirmAction } from './app-confirm';
import { t } from './i18n';
import { ScmContextMenu, type ScmContextMenuItem } from './ScmContextMenu';
import { invokeWorktree, worktreeFailure, worktreeFailureText } from './worktree-branch-model';

function actionPrompt(action: DesktopBranchManagementAction, branch: string, target: string): string {
  if (action === 'merge') {
    return t(
      'Merge "{{branch}}" into "{{target}}"? This creates a merge commit. Uncommitted changes are not included and nothing is pushed.',
      { branch, target }
    );
  }
  if (action === 'remove-worktree') {
    return t(
      'Remove the worktree folder for "{{branch}}"? The branch and conversation history are kept. In-use or unsafe folders will not be removed.',
      { branch }
    );
  }
  return t('Delete the local branch "{{branch}}"? Only a branch merged into "{{target}}" can be deleted.', {
    branch,
    target,
  });
}

type BranchActionResult = {
  merged?: boolean;
  conflicts?: string[];
  removed?: boolean;
  remaining?: Array<{ error?: string }>;
};

/** Runs one confirmed branch action. Null when the user declined the forced
 *  delete; `notice` is set when the runtime did not finish the job. */
async function manageBranch(
  projectPath: string,
  branch: string,
  action: DesktopBranchManagementAction,
  state: DesktopBranchActionState
): Promise<{ notice: string } | null> {
  const run = (force?: true) =>
    invokeWorktree<BranchActionResult>('manageProjectBranch', [
      {
        projectPath,
        branch,
        action,
        commit: state.commit,
        target: state.target,
        targetCommit: state.targetCommit,
        confirmed: true,
        ...(force ? { force } : {}),
      },
    ]);
  let result: BranchActionResult;
  try {
    result = await run();
  } catch (reason) {
    // An unmerged branch (one a worktree removal kept) is deleted on a
    // second confirmation, only while it is still at the inspected commit.
    if (action !== 'delete-branch' || worktreeFailure(reason).code !== 'WORKTREE_UNMERGED') throw reason;
    const forced = await confirmAction(
      t(
        'Delete "{{branch}}" anyway? Its commits are not merged into "{{target}}" and are lost unless another branch has them.',
        { branch, target: state.target ?? '' }
      ),
      { danger: true, confirmLabel: t('Delete anyway'), key: `branch-force-delete:${projectPath}:${branch}` }
    );
    if (!forced) return null;
    result = await run(true);
  }
  if (result.merged === false) {
    return {
      notice: t('Nothing was merged. Conflicting files: {{files}}', { files: result.conflicts?.join(', ') || '' }),
    };
  }
  if (result.removed === false) {
    const reasons = result.remaining
      ?.map((item) => item.error)
      .filter(Boolean)
      .join('\n');
    return {
      notice:
        reasons ||
        t(
          'The worktree could not be removed completely because a file is still in use. Close it and remove the worktree again.'
        ),
    };
  }
  return { notice: '' };
}

function confirmBranchAction(
  projectPath: string,
  branch: string,
  action: DesktopBranchManagementAction,
  target: string
): Promise<boolean> {
  return confirmAction(actionPrompt(action, branch, target), {
    danger: action !== 'merge',
    key: `branch-${action}:${projectPath}:${branch}`,
  });
}

const failBranchAction = (error: unknown) => showDesktopToast(worktreeFailureText(worktreeFailure(error)), 'error');

/** A branch row menu's Merge or Remove worktree folder for `branch`, read and
 *  confirmed as the menu does (a notice or a refusal is a toast; a branch
 *  with nothing to merge into, or a folder the app does not manage, says so).
 *  `done` once the action went through, with the branch it merged into. */
export async function runBranchRowAction(
  projectPath: string,
  branch: string,
  action: Exclude<DesktopBranchManagementAction, 'delete-branch'>
): Promise<{ done: boolean; target: string }> {
  try {
    const state = await invokeWorktree<DesktopBranchActionState>('inspectProjectBranch', [{ projectPath, branch }]);
    const target = state.target ?? '';
    if (action === 'remove-worktree' && state.kind !== 'managed') {
      showDesktopToast(t('Only app-managed worktree folders can be removed.'), 'info');
      return { done: false, target };
    }
    if (action === 'merge' && (!target || target === branch)) return { done: false, target };
    if (!(await confirmBranchAction(projectPath, branch, action, target))) return { done: false, target };
    const outcome = await manageBranch(projectPath, branch, action, state);
    if (outcome?.notice) showDesktopToast(outcome.notice, 'info');
    return { done: outcome !== null && !outcome.notice, target };
  } catch (error) {
    failBranchAction(error);
    return { done: false, target: '' };
  }
}

/** Opens a branch's working folder in the system's file manager (the row menu's Open folder). */
export async function openBranchFolder(path: string): Promise<void> {
  try {
    const api = window.mixdogDesktop;
    if (!api?.openLocalFileLink) throw new Error(t('Local file links can only be opened in the desktop app.'));
    await api.openLocalFileLink(path, '.');
  } catch (error) {
    failBranchAction(error);
  }
}

/** A branch row's shell: the row itself, its "…" trigger, and the same menu on
 *  right-click or a touch long-press (touch screens show no "…"). */
export function BranchRowActions({
  projectPath,
  branch,
  locked,
  onChanged,
  children,
}: {
  projectPath: string;
  branch: string;
  locked: boolean;
  onChanged(): Promise<unknown>;
  children?: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<DesktopBranchActionState | null>(null);
  const [busy, setBusy] = useState(false);
  const [anchor, setAnchor] = useState({ x: 0, y: 0, flipY: 0, alignEnd: true });
  const trigger = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => setOpen(false), []);
  const setNotice = (text: string) => {
    if (text) showDesktopToast(text, 'info');
  };
  const fail = failBranchAction;
  const show = async (at: { x: number; y: number; flipY: number; alignEnd: boolean }) => {
    if (busy) return;
    setAnchor(at);
    setOpen(true);
    setState(null);
    setBusy(true);
    try {
      setState(await invokeWorktree<DesktopBranchActionState>('inspectProjectBranch', [{ projectPath, branch }]));
    } catch (error) {
      fail(error);
      setOpen(false);
    } finally {
      setBusy(false);
    }
  };
  const toggle = () => {
    if (open) {
      setOpen(false);
      return;
    }
    const rect = trigger.current?.getBoundingClientRect();
    void show({ x: rect?.right ?? 0, y: (rect?.bottom ?? 0) + 2, flipY: (rect?.top ?? 0) - 2, alignEnd: true });
  };
  const openAtPoint = (event: React.MouseEvent) => {
    event.preventDefault();
    void show({ x: event.clientX, y: event.clientY, flipY: event.clientY, alignEnd: false });
  };
  const act = async (action: DesktopBranchManagementAction) => {
    if (!state || busy || locked) return;
    if (!(await confirmBranchAction(projectPath, branch, action, state.target ?? ''))) return;
    setBusy(true);
    setNotice('');
    try {
      const outcome = await manageBranch(projectPath, branch, action, state);
      if (outcome === null) return;
      if (outcome.notice) {
        setNotice(outcome.notice);
      } else {
        await onChanged();
        setOpen(false);
      }
    } catch (error) {
      fail(error);
    } finally {
      setBusy(false);
    }
  };
  const openFolder = async () => {
    if (!state?.path || busy) return;
    setBusy(true);
    try {
      await openBranchFolder(state.path);
    } finally {
      setBusy(false);
    }
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(branch);
      setNotice(t('Copied'));
    } catch (error) {
      fail(error);
    }
  };
  const lockedTitle = locked ? t("Can't switch while work is running") : undefined;
  const items: ScmContextMenuItem[] = [
    { id: 'copy', label: t('Copy branch name'), icon: <Copy size={14} />, onSelect: () => void copy() },
    {
      id: 'open-folder',
      label: t('Open folder'),
      icon: <FolderOpen size={14} />,
      disabled: !state?.path || busy,
      title: !state?.path ? t('This branch has no working folder.') : state.path,
      onSelect: () => void openFolder(),
    },
    {
      id: 'merge',
      label: t('Merge into {{target}}', { target: state?.target ?? '…' }),
      icon: <GitMerge size={14} />,
      disabled: !state?.target || state.target === branch || locked || busy,
      title: lockedTitle,
      onSelect: () => void act('merge'),
    },
    {
      id: 'remove-worktree',
      label: t('Remove worktree folder'),
      icon: <Trash2 size={14} />,
      disabled: state?.kind !== 'managed' || locked || busy,
      title: state?.kind !== 'managed' ? t('Only app-managed worktree folders can be removed.') : lockedTitle,
      onSelect: () => void act('remove-worktree'),
    },
    {
      id: 'delete-branch',
      label: t('Delete branch'),
      icon: <Trash2 size={14} />,
      danger: true,
      disabled: !state || !!state.path || !state.target || state.target === branch || locked || busy,
      title: state?.path ? t('This branch is checked out. Remove or leave its worktree first.') : lockedTitle,
      onSelect: () => void act('delete-branch'),
    },
  ];
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: right-click/long-press is a shortcut; keyboard users have the "…" button
    <div className="branch-row-shell" onContextMenu={openAtPoint}>
      {children}
      <button
        ref={trigger}
        type="button"
        className="branch-row-more"
        aria-label={t('Actions for {{branch}}', { branch })}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={toggle}
      >
        <MoreHorizontal size={14} aria-hidden="true" />
      </button>
      <ScmContextMenu
        state={open ? { label: t('Branch actions'), ...anchor, items } : null}
        onClose={close}
        anchorRef={trigger}
      />
    </div>
  );
}
