import { Copy, FolderOpen, GitMerge, MoreHorizontal, Trash2 } from 'lucide-react';
import type React from 'react';
import { useCallback, useRef, useState } from 'react';
import type { DesktopBranchActionState, DesktopBranchManagementAction } from '../shared/contract';
import { showDesktopToast } from './desktop-toasts';
import { confirmAction } from './app-confirm';
import { t } from './i18n';
import { ScmContextMenu, type ScmContextMenuItem } from './ScmContextMenu';
import { invokeWorktree, worktreeFailure, worktreeFailureText } from './worktree-branch-model';

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
  const fail = (error: unknown) => showDesktopToast(worktreeFailureText(worktreeFailure(error)), 'error');
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
    const message =
      action === 'merge'
        ? t(
            'Merge "{{branch}}" into "{{target}}"? This creates a merge commit. Uncommitted changes are not included and nothing is pushed.',
            { branch, target: state.target ?? '' }
          )
        : action === 'remove-worktree'
          ? t(
              'Remove the worktree folder for "{{branch}}"? The branch and conversation history are kept. In-use or unsafe folders will not be removed.',
              { branch }
            )
          : t('Delete the local branch "{{branch}}"? Only a branch merged into "{{target}}" can be deleted.', {
              branch,
              target: state.target ?? '',
            });
    const confirmed = await confirmAction(message, {
      danger: action !== 'merge',
      key: `branch-${action}:${projectPath}:${branch}`,
    });
    if (!confirmed) return;
    setBusy(true);
    setNotice('');
    try {
      const result = await invokeWorktree<{
        merged?: boolean;
        conflicts?: string[];
        removed?: boolean;
        remaining?: Array<{ error?: string }>;
      }>('manageProjectBranch', [
        {
          projectPath,
          branch,
          action,
          commit: state.commit,
          target: state.target,
          targetCommit: state.targetCommit,
          confirmed: true,
        },
      ]);
      if (result.merged === false) {
        setNotice(t('Nothing was merged. Conflicting files: {{files}}', { files: result.conflicts?.join(', ') || '' }));
      } else if (result.removed === false) {
        const reasons = result.remaining
          ?.map((item) => item.error)
          .filter(Boolean)
          .join('\n');
        setNotice(
          reasons ||
            t(
              'The worktree could not be removed completely because a file is still in use. Close it and remove the worktree again.'
            )
        );
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
      const api = window.mixdogDesktop;
      if (!api?.openLocalFileLink) throw new Error(t('Local file links can only be opened in the desktop app.'));
      await api.openLocalFileLink(state.path, '.');
    } catch (error) {
      fail(error);
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
      title: locked ? t("Can't switch while work is running") : undefined,
      onSelect: () => void act('merge'),
    },
    {
      id: 'remove-worktree',
      label: t('Remove worktree folder'),
      icon: <Trash2 size={14} />,
      disabled: state?.kind !== 'managed' || locked || busy,
      title:
        state?.kind !== 'managed'
          ? t('Only Mixdog-managed worktree folders can be removed.')
          : locked
            ? t("Can't switch while work is running")
            : undefined,
      onSelect: () => void act('remove-worktree'),
    },
    {
      id: 'delete-branch',
      label: t('Delete branch'),
      icon: <Trash2 size={14} />,
      danger: true,
      disabled: !state || !!state.path || !state.target || state.target === branch || locked || busy,
      title: state?.path
        ? t('This branch is checked out. Remove or leave its worktree first.')
        : locked
          ? t("Can't switch while work is running")
          : undefined,
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
