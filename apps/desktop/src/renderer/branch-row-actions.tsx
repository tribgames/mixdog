import { Copy, FolderOpen, GitMerge, MoreHorizontal, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { DesktopBranchActionState, DesktopBranchManagementAction } from '../shared/contract';
import { t } from './i18n';
import { invokeWorktree, worktreeFailure, worktreeFailureText } from './worktree-branch-model';

export function BranchRowActions({
  projectPath,
  branch,
  locked,
  onChanged,
}: {
  projectPath: string;
  branch: string;
  locked: boolean;
  onChanged(): Promise<unknown>;
}) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<DesktopBranchActionState | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const actions = useRef<HTMLFieldSetElement>(null);
  // The opened actions scroll into view inside the list.
  useEffect(() => {
    if (open) actions.current?.scrollIntoView?.({ block: 'nearest' });
  }, [open]);
  const fail = (error: unknown) => setNotice(worktreeFailureText(worktreeFailure(error)));
  const toggle = async () => {
    if (busy) return;
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    setState(null);
    setNotice('');
    setBusy(true);
    try {
      setState(await invokeWorktree<DesktopBranchActionState>('inspectProjectBranch', [{ projectPath, branch }]));
    } catch (error) {
      fail(error);
    } finally {
      setBusy(false);
    }
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
    if (!window.confirm(message)) return;
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
  return (
    <>
      <button
        type="button"
        className="branch-row-more"
        aria-label={t('Actions for {{branch}}', { branch })}
        aria-expanded={open}
        onClick={() => void toggle()}
        disabled={busy}
      >
        <MoreHorizontal size={14} aria-hidden="true" />
      </button>
      {open && (
        <fieldset ref={actions} className="branch-row-actions" aria-label={t('Branch actions')}>
          <button type="button" onClick={() => void copy()}>
            <Copy size={14} />
            {t('Copy branch name')}
          </button>
          <button
            type="button"
            disabled={!state?.path || busy}
            onClick={() => void openFolder()}
            title={!state?.path ? t('This branch has no working folder.') : state.path}
          >
            <FolderOpen size={14} />
            {t('Open folder')}
          </button>
          <button
            type="button"
            disabled={!state?.target || state.target === branch || locked || busy}
            onClick={() => void act('merge')}
          >
            <GitMerge size={14} />
            {t('Merge into {{target}}', { target: state?.target ?? '…' })}
          </button>
          <button
            type="button"
            disabled={state?.kind !== 'managed' || locked || busy}
            title={state?.kind !== 'managed' ? t('Only Mixdog-managed worktree folders can be removed.') : undefined}
            onClick={() => void act('remove-worktree')}
          >
            <Trash2 size={14} />
            {t('Remove worktree folder')}
          </button>
          <button
            type="button"
            data-danger
            disabled={!state || !!state.path || !state.target || state.target === branch || locked || busy}
            title={state?.path ? t('This branch is checked out. Remove or leave its worktree first.') : undefined}
            onClick={() => void act('delete-branch')}
          >
            <Trash2 size={14} />
            {t('Delete branch')}
          </button>
          {locked && <p role="status">{t("Can't switch while work is running")}</p>}
          {notice && <p role="alert">{notice}</p>}
          {busy && <p role="status">{t('Checking…')}</p>}
        </fieldset>
      )}
    </>
  );
}
