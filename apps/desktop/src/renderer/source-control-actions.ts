// The dock's Git actions as plain functions over one explicit context: the
// bridge, the project, the action runner and the error sink. Each confirms
// or prompts first, then hands the call to run().
import type { DesktopGitBranch, DesktopGitFile, DesktopGitLogEntry, DesktopGitStatus } from '../shared/contract';
import { t } from './i18n';
import { resetModePrompt } from './source-control-confirmations';
import { EMPTY_SUMMARY, gitRemoteWebUrl, isDirtyResetRefusal } from './source-control-support';
import type { GitActionRunner } from './use-source-control-runner';

export type SourceControlActionContext = {
  api: Window['mixdogDesktop'];
  projectPath: string;
  run: GitActionRunner;
  setError: (message: string) => void;
};

function reasonText(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

/** Channels this build does not carry yet: the item stays VISIBLE (nothing
 *  becomes unreachable) but says why it cannot run. */
export function missingChannel(what: string): string {
  return `${what} is not available yet: this build has no Git channel for it.`;
}

/** Every history/stash action is refused while another Git action runs or
 *  while the repository is mid-operation — the reason the disabled item
 *  carries. */
export function repositoryBusyReason(busy: string, status: DesktopGitStatus | null): string {
  if (busy) return 'Another Git action is running';
  if (status?.operation) return `Finish the in-progress ${status.operation.replace('-', ' ')} first`;
  return '';
}

export function stashReasons({
  api,
  busy,
  status,
  fileCount,
}: {
  api: Window['mixdogDesktop'];
  busy: string;
  status: DesktopGitStatus | null;
  fileCount: number;
}) {
  let stash = repositoryBusyReason(busy, status);
  if (!stash && !api?.gitStash) stash = missingChannel('Stashing changes');
  else if (!stash && fileCount === 0) stash = 'There are no changes to stash';
  let pop = repositoryBusyReason(busy, status);
  if (!pop && !api?.gitStashPop) pop = missingChannel('Popping a stash');
  return { stash, pop };
}

export function pullRequestCreateHint(status: DesktopGitStatus | null, ahead: number): string {
  if (!status?.upstream) return 'Publish the branch to a remote before opening a pull request.';
  if (ahead > 0) return `Push ${ahead} local commit${ahead === 1 ? '' : 's'} before opening a pull request.`;
  if (status?.operation) return 'Finish the in-progress Git operation first.';
  return 'Pull requests need a pushed upstream branch.';
}

/** `Copy file path` copies the ABSOLUTE path (the reference's file context
 *  menu); `Copy relative file path` copies the repository-relative one. */
export function absoluteFilePath(projectPath: string, rel: string): string {
  const base = projectPath.replace(/[\\/]+$/, '');
  const windows = base.includes('\\') || /^[A-Za-z]:/.test(base);
  return windows ? `${base}\\${rel.replace(/\//g, '\\')}` : `${base}/${rel}`;
}

/** `View on GitHub` for one commit, derived from the remote's web URL. */
export function commitWebUrl(remoteUrl: string, hash: string): string {
  const base = gitRemoteWebUrl(remoteUrl);
  if (!base || !hash) return '';
  return /gitlab/i.test(base) ? `${base}/-/commit/${hash}` : `${base}/commit/${hash}`;
}

/** Clipboard for the row context menus. A clipboard that is absent (insecure
 *  context) or refuses is REPORTED — never a silent no-op. */
export async function copyText(ctx: SourceControlActionContext, text: string, what: string) {
  const clipboard = window.navigator?.clipboard;
  if (!clipboard?.writeText) {
    ctx.setError(`Could not copy the ${what}: this environment has no clipboard access.`);
    return;
  }
  try {
    await clipboard.writeText(text);
    ctx.setError('');
  } catch (reason) {
    ctx.setError(`Could not copy the ${what}: ${reasonText(reason)}`);
  }
}

export async function discardFiles(ctx: SourceControlActionContext, files: DesktopGitFile[]) {
  for (const file of files) {
    await ctx.api?.gitRevert?.(ctx.projectPath, file.path, file.untracked, 'worktree');
  }
}

export function discardPrompt(file: DesktopGitFile, count: number): string {
  if (count !== 1) {
    return t('Discard {{count}} selected working tree changes? This cannot be undone.', { count });
  }
  return file.untracked
    ? t('Delete untracked file "{{file}}"? This cannot be undone.', { file: file.path })
    : t('Discard changes to "{{file}}"? This cannot be undone.', { file: file.path });
}

export function stashActions(ctx: SourceControlActionContext) {
  const { api, projectPath, run } = ctx;
  return {
    stashChanges: () => {
      const message = window.prompt(t('Stash message (optional)'), '');
      if (message === null) return;
      void run('stash', () => api?.gitStash?.(projectPath, message));
    },
    popStash: () => void run('stash-pop', () => api?.gitStashPop?.(projectPath)),
  };
}

// ONE implementation per branch action, shared by the branch row's inline
// buttons and by its right-click menu. `branch-` keys make run() reload the
// branch list too.
export function branchActions(
  ctx: SourceControlActionContext,
  {
    branchQuery,
    closePicker,
    exitMergeMode,
  }: { branchQuery: string; closePicker: () => void; exitMergeMode: () => void }
) {
  const { api, projectPath, run } = ctx;
  return {
    checkoutBranch: (branch: DesktopGitBranch) =>
      void run(
        `branch-checkout:${branch.name}`,
        () => api?.gitCheckoutBranch?.(projectPath, branch.name, branch.remote),
        closePicker
      ),
    renameBranch: (branch: DesktopGitBranch) => {
      const nextName = window.prompt(t('Rename branch'), branch.name);
      if (!nextName?.trim() || nextName.trim() === branch.name) return;
      void run(`branch-rename:${branch.name}`, () => api?.gitRenameBranch?.(projectPath, branch.name, nextName.trim()));
    },
    deleteBranch: (branch: DesktopGitBranch) => {
      if (!window.confirm(t('Delete local branch "{{branch}}"?', { branch: branch.name }))) return;
      void run(`branch-delete:${branch.name}`, () => api?.gitDeleteBranch?.(projectPath, branch.name));
    },
    createBranchFromFilter: () => {
      // Seed the create-branch flow with the current filter text.
      const name = branchQuery.trim() || window.prompt(t('New branch name')) || '';
      if (!name.trim()) return;
      void run('branch-create', () => api?.gitCreateBranch?.(projectPath, name.trim()), closePicker);
    },
    mergeIntoCurrent: (branch: DesktopGitBranch) =>
      void run(
        `branch-merge:${branch.name}`,
        () => api?.gitMergeBranch?.(projectPath, branch.name),
        () => {
          closePicker();
          exitMergeMode();
        }
      ),
  };
}

function commitTitle(entry: DesktopGitLogEntry): string {
  return (entry.subject ?? '').trim() || EMPTY_SUMMARY;
}

/** Every destructive history action confirms first, and the prompt NAMES the
 *  commit it is about to touch (short SHA + subject). */
function confirmCommit(entry: DesktopGitLogEntry, question: string): boolean {
  return window.confirm(`${question}\n\n${entry.shortHash}  ${commitTitle(entry)}`);
}

function namedPrompt(entry: DesktopGitLogEntry, label: string): string | null {
  return window.prompt(t(label, { hash: entry.shortHash, subject: commitTitle(entry) }), '');
}

/** Ask for the reset mode before confirmation; `hard` states what it
 *  destroys. */
function resetToCommit(ctx: SourceControlActionContext, entry: DesktopGitLogEntry) {
  const { api, projectPath, run, setError } = ctx;
  const answer = window.prompt(resetModePrompt(entry.shortHash), 'mixed');
  if (answer === null) return;
  const modes = ['soft', 'mixed', 'hard'] as const;
  const mode = modes.find((candidate) => candidate === answer.trim().toLowerCase());
  if (!mode) {
    setError(`"${answer.trim()}" is not a reset mode — choose soft, mixed or hard.`);
    return;
  }
  const question =
    mode === 'hard'
      ? t(
          'Reset the branch to this commit with --hard? Every change after it, staged or not, is destroyed and cannot be recovered.'
        )
      : t('Reset the branch to this commit with --{{mode}}?', { mode });
  if (!confirmCommit(entry, question)) return;
  void run(`reset:${entry.hash}`, async () => {
    const reset = (confirmedDirty: boolean) => api?.gitResetToCommit?.(projectPath, entry.hash, mode, confirmedDirty);
    try {
      return await reset(false);
    } catch (reason) {
      // A `--mixed` reset REWRITES THE INDEX, so the main side refuses a dirty
      // worktree with a message that NAMES the files it would unstage
      // (git-cli.ts GIT_RESET_DIRTY_CODE) instead of doing it silently. That
      // refusal IS the warning: a confirmed reset comes back WITH the flag the
      // main side waits for. Anything else is a real Git failure and keeps
      // travelling to the error banner.
      if (!isDirtyResetRefusal(reason)) throw reason;
      if (!window.confirm(`${reasonText(reason)}\n\n${entry.shortHash}  ${commitTitle(entry)}`)) return undefined;
      return await reset(true);
    }
  });
}

export function historyCommitActions(
  ctx: SourceControlActionContext,
  { commitMessage, clearCommitDraft }: { commitMessage: string; clearCommitDraft: () => void }
) {
  const { api, projectPath, run, setError } = ctx;
  return {
    resetToCommit: (entry: DesktopGitLogEntry) => resetToCommit(ctx, entry),
    revertCommit: (entry: DesktopGitLogEntry) => {
      const question = t(
        'Revert the changes in this commit? A new commit that undoes them is created on the current branch.'
      );
      if (!confirmCommit(entry, question)) return;
      void run(`revert-commit:${entry.hash}`, () => api?.gitRevertCommit?.(projectPath, entry.hash));
    },
    cherryPickCommit: (entry: DesktopGitLogEntry) => {
      if (!confirmCommit(entry, t('Cherry-pick this commit onto the current branch?'))) return;
      void run(`cherry-pick:${entry.hash}`, () => api?.gitCherryPickCommit?.(projectPath, entry.hash));
    },
    checkoutCommit: (entry: DesktopGitLogEntry) => {
      const question = t(
        'Check this commit out? HEAD becomes DETACHED: new commits belong to no branch until one is created from them.'
      );
      if (!confirmCommit(entry, question)) return;
      void run(`checkout-commit:${entry.hash}`, () => api?.gitCheckoutCommit?.(projectPath, entry.hash));
    },
    createTagAt: (entry: DesktopGitLogEntry) => {
      const name = namedPrompt(entry, 'Create a tag at {{hash}} ({{subject}})');
      if (name === null) return;
      if (!name.trim()) {
        setError(t('A tag name is required to create a tag.'));
        return;
      }
      void run(`tag:${entry.hash}`, () => api?.gitCreateTag?.(projectPath, name.trim(), entry.hash));
    },
    /** `Delete tag <name>` — the reference names the tag in the item itself
     *  and one item per tag replaces its submenu. */
    deleteTagAt: (entry: DesktopGitLogEntry, tag: string) => {
      if (!confirmCommit(entry, t('Delete tag "{{tag}}"? The tag is removed locally.', { tag }))) return;
      void run(`tag-delete:${tag}`, () => api?.gitDeleteTag?.(projectPath, tag));
    },
    /** `Amend commit…` / `Undo commit…` belong to the MOST RECENT commit
     *  only, and undo additionally to a local one. */
    amendCommitAt: (entry: DesktopGitLogEntry) => {
      const question = commitMessage.trim()
        ? t('Amend this commit with the message in the commit form?')
        : t('Amend this commit with the currently included changes?');
      if (!confirmCommit(entry, question)) return;
      void run('amend', () => api?.gitAmend?.(projectPath, commitMessage.trim() || undefined), clearCommitDraft);
    },
    undoCommitAt: (entry: DesktopGitLogEntry) => {
      if (!confirmCommit(entry, t('Undo this commit and keep all of its changes staged?'))) return;
      void run('undo-commit', () => api?.gitUndoLastCommit?.(projectPath));
    },
    /** `branch-` prefix so run() reloads the branch list too. */
    createBranchAtCommit: (entry: DesktopGitLogEntry) => {
      const name = namedPrompt(entry, 'Create a branch at {{hash}} ({{subject}})');
      if (name === null) return;
      if (!name.trim()) {
        setError(t('A branch name is required to create a branch.'));
        return;
      }
      void run(`branch-create-at:${entry.hash}`, () =>
        api?.gitCreateBranchAtCommit?.(projectPath, name.trim(), entry.hash)
      );
    },
  };
}
