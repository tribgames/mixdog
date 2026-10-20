// The dock's Git actions as plain functions over one explicit context: the
// bridge, the project, the action runner and the error sink. Each confirms
// or prompts first, then hands the call to run().
import type {
  DesktopGitBranch,
  DesktopGitFile,
  DesktopGitLogEntry,
  DesktopGitStatus,
  DesktopMergeProjectBranchResult,
  DesktopSelectProjectBranchInput,
  DesktopSelectProjectBranchResult,
} from '../shared/contract';
import { confirmAction } from './app-confirm';
import { t } from './i18n';
import { resetModePrompt } from './source-control-confirmations';
import { emptySummary, gitRemoteWebUrl, isDirtyResetRefusal, reasonText } from './source-control-support';
import type { GitActionRunner } from './use-source-control-runner';
import { invokeWorktree, worktreeFailure, worktreeFailureText } from './worktree-branch-model';

type SourceControlActionContext = {
  api: Window['mixdogDesktop'];
  projectPath: string;
  run: GitActionRunner;
  setError: (message: string) => void;
};

/** Channels this build does not carry yet: the item stays VISIBLE (nothing
 *  becomes unreachable) but says why it cannot run. */
export function missingChannel(what: string): string {
  return t('{{what}} is not available yet: this build has no Git channel for it.', { what });
}

/** Every history/stash action is refused while another Git action runs or
 *  while the repository is mid-operation — the reason the disabled item
 *  carries. */
export function repositoryBusyReason(busy: string, status: DesktopGitStatus | null | undefined): string {
  if (busy) return t('Another Git action is running');
  return operationInProgressReason(status);
}

/** Why a repository mid-operation (merge, rebase, …) refuses new actions. */
export function operationInProgressReason(status: DesktopGitStatus | null | undefined): string {
  return status?.operation
    ? t('Finish the in-progress {{value0}} first', { value0: status.operation.replace('-', ' ') })
    : '';
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
  if (!stash && !api?.gitStash) stash = missingChannel(t('Stashing changes'));
  else if (!stash && fileCount === 0) stash = t('There are no changes to stash');
  let pop = repositoryBusyReason(busy, status);
  if (!pop && !api?.gitStashPop) pop = missingChannel(t('Popping a stash'));
  return { stash, pop };
}

export function pullRequestCreateHint(status: DesktopGitStatus | null, ahead: number): string {
  if (!status?.upstream) return t('Publish the branch to a remote before opening a pull request.');
  if (ahead > 0) {
    return ahead === 1
      ? t('Push 1 local commit before opening a pull request.')
      : t('Push {{count}} local commits before opening a pull request.', { count: ahead });
  }
  if (status?.operation) return t('Finish the in-progress Git operation first.');
  return t('Pull requests need a pushed upstream branch.');
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
    ctx.setError(t('Could not copy the {{value0}}: this environment has no clipboard access.', { value0: what }));
    return;
  }
  try {
    await clipboard.writeText(text);
    ctx.setError('');
  } catch (reason) {
    ctx.setError(t('Could not copy the {{value0}}: {{value1}}', { value0: what, value1: reasonText(reason) }));
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

/** The guarded Project-folder checkout (selectProjectBranch); typed refusals
 *  (dirty folder, sessions working there, occupied branch, …) become their
 *  readable text. */
export function selectProjectBranch(
  projectPath: string,
  branch: string,
  options: { create?: true; remote?: true; startPoint?: string } = {}
): Promise<DesktopSelectProjectBranchResult> {
  return guardedProjectCheckout({ projectPath, branch, ...options });
}

/** A history entry checked out detached, through the same guarded checkout. */
export async function checkoutProjectCommit(projectPath: string, commit: string): Promise<string> {
  const result = await guardedProjectCheckout({ projectPath, detach: commit });
  return `HEAD is now at ${String(result.commit || commit).slice(0, 8)} (detached).`;
}

async function guardedProjectCheckout(
  input: DesktopSelectProjectBranchInput
): Promise<DesktopSelectProjectBranchResult> {
  try {
    return await invokeWorktree<DesktopSelectProjectBranchResult>('selectProjectBranch', [input]);
  } catch (reason) {
    const failure = worktreeFailure(reason);
    if (failure.code) throw new Error(worktreeFailureText(failure, { checkout: true }));
    throw reason;
  }
}

/** The dock merge through the runtime (mergeProjectBranch): `target` is the
 *  branch the user confirmed. A conflict changes nothing and is reported. */
export async function mergeProjectBranch(projectPath: string, branch: string, target: string): Promise<string> {
  let result: DesktopMergeProjectBranchResult;
  try {
    result = await invokeWorktree<DesktopMergeProjectBranchResult>('mergeProjectBranch', [
      { projectPath, branch, target },
    ]);
  } catch (reason) {
    const failure = worktreeFailure(reason);
    if (failure.code) throw new Error(worktreeFailureText(failure));
    throw reason;
  }
  if (result.upToDate) return 'Already up to date.';
  if (!result.merged) {
    throw new Error(
      worktreeFailureText({ code: 'MERGE_CONFLICT', message: '', details: { files: result.conflicts ?? [] } })
    );
  }
  return `Merged ${branch} into ${result.target} (${String(result.commit).slice(0, 8)}).`;
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
    currentBranch,
  }: { branchQuery: string; closePicker: () => void; exitMergeMode: () => void; currentBranch: string }
) {
  const { api, projectPath, run } = ctx;
  return {
    // Checkout and create switch the Project folder through the runtime's
    // guarded path (repository lock, sessions working there, no carried
    // changes); a remote branch checks out its local branch, creating it to
    // track the remote branch when missing.
    checkoutBranch: (branch: DesktopGitBranch) =>
      void run(
        `branch-checkout:${branch.name}`,
        () => selectProjectBranch(projectPath, branch.name, branch.remote ? { remote: true } : {}),
        closePicker
      ),
    renameBranch: (branch: DesktopGitBranch) => {
      const nextName = window.prompt(t('Rename branch'), branch.name);
      if (!nextName?.trim() || nextName.trim() === branch.name) return;
      void run(`branch-rename:${branch.name}`, () => api?.gitRenameBranch?.(projectPath, branch.name, nextName.trim()));
    },
    deleteBranch: (branch: DesktopGitBranch) => {
      void confirmAction(t('Delete local branch "{{branch}}"?', { branch: branch.name }), {
        key: `branch-delete:${projectPath}:${branch.name}`,
        danger: true,
        confirmLabel: t('Delete'),
      }).then((approved) => {
        if (approved) void run(`branch-delete:${branch.name}`, () => api?.gitDeleteBranch?.(projectPath, branch.name));
      });
    },
    createBranchFromFilter: () => {
      // Seed the create-branch flow with the current filter text.
      const name = branchQuery.trim() || window.prompt(t('New branch name')) || '';
      if (!name.trim()) return;
      void run('branch-create', () => selectProjectBranch(projectPath, name.trim(), { create: true }), closePicker);
    },
    // The runtime's guarded merge (mergeProjectBranch): the confirmed target
    // must still be checked out, sessions working in the folder refuse it and
    // their turns wait meanwhile; the backend preflights conflicts, merges
    // with --no-ff and never leaves a half-merged repository.
    mergeIntoCurrent: (branch: DesktopGitBranch) => {
      void confirmAction(
        t('Merge "{{branch}}" into "{{target}}" with a merge commit?', { branch: branch.name, target: currentBranch }),
        { confirmLabel: t('Merge') }
      ).then((approved) => {
        if (!approved) return;
        void run(
          `branch-merge:${branch.name}`,
          () => mergeProjectBranch(projectPath, branch.name, currentBranch),
          () => {
            closePicker();
            exitMergeMode();
          }
        );
      });
    },
  };
}

function commitTitle(entry: DesktopGitLogEntry): string {
  return (entry.subject ?? '').trim() || emptySummary();
}

/** Every destructive history action confirms first, and the prompt NAMES the
 *  commit it is about to touch (short SHA + subject). */
function confirmCommit(entry: DesktopGitLogEntry, question: string, danger = false): Promise<boolean> {
  return confirmAction(`${question}\n\n${entry.shortHash}  ${commitTitle(entry)}`, { danger });
}

/** `proceed` runs only once the commit prompt is confirmed. */
function ifConfirmed(entry: DesktopGitLogEntry, question: string, proceed: () => void, danger = false): void {
  void confirmCommit(entry, question, danger).then((approved) => {
    if (approved) proceed();
  });
}

function namedPrompt(message: string): string | null {
  return window.prompt(message, '');
}

/** Ask for the reset mode before confirmation; `hard` states what it
 *  destroys. */
function resetToCommit(ctx: SourceControlActionContext, entry: DesktopGitLogEntry) {
  const { setError } = ctx;
  const answer = window.prompt(resetModePrompt(entry.shortHash), 'mixed');
  if (answer === null) return;
  const modes = ['soft', 'mixed', 'hard'] as const;
  const mode = modes.find((candidate) => candidate === answer.trim().toLowerCase());
  if (!mode) {
    setError(t('"{{value0}}" is not a reset mode — choose soft, mixed or hard.', { value0: answer.trim() }));
    return;
  }
  const question =
    mode === 'hard'
      ? t(
          'Reset the branch to this commit with --hard? Every change after it, staged or not, is destroyed and cannot be recovered.'
        )
      : t('Reset the branch to this commit with --{{mode}}?', { mode });
  ifConfirmed(entry, question, () => resetConfirmed(ctx, entry, mode), mode === 'hard');
}

function resetConfirmed(ctx: SourceControlActionContext, entry: DesktopGitLogEntry, mode: 'soft' | 'mixed' | 'hard') {
  const { api, projectPath, run } = ctx;
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
      if (
        !(await confirmAction(`${reasonText(reason)}\n\n${entry.shortHash}  ${commitTitle(entry)}`, { danger: true }))
      )
        return undefined;
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
      ifConfirmed(
        entry,
        question,
        () => void run(`revert-commit:${entry.hash}`, () => api?.gitRevertCommit?.(projectPath, entry.hash))
      );
    },
    cherryPickCommit: (entry: DesktopGitLogEntry) => {
      ifConfirmed(
        entry,
        t('Cherry-pick this commit onto the current branch?'),
        () => void run(`cherry-pick:${entry.hash}`, () => api?.gitCherryPickCommit?.(projectPath, entry.hash))
      );
    },
    checkoutCommit: (entry: DesktopGitLogEntry) => {
      const question = t(
        'Check this commit out? HEAD becomes DETACHED: new commits belong to no branch until one is created from them.'
      );
      // The guarded project checkout: dirty folder, sessions working there, repo lock.
      ifConfirmed(
        entry,
        question,
        () => void run(`checkout-commit:${entry.hash}`, () => checkoutProjectCommit(projectPath, entry.hash))
      );
    },
    createTagAt: (entry: DesktopGitLogEntry) => {
      const name = namedPrompt(
        t('Create a tag at {{hash}} ({{subject}})', { hash: entry.shortHash, subject: commitTitle(entry) })
      );
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
      ifConfirmed(
        entry,
        t('Delete tag "{{tag}}"? The tag is removed locally.', { tag }),
        () => void run(`tag-delete:${tag}`, () => api?.gitDeleteTag?.(projectPath, tag)),
        true
      );
    },
    /** `Amend commit…` / `Undo commit…` belong to the MOST RECENT commit
     *  only, and undo additionally to a local one. */
    amendCommitAt: (entry: DesktopGitLogEntry) => {
      const question = commitMessage.trim()
        ? t('Amend this commit with the message in the commit form?')
        : t('Amend this commit with the currently included changes?');
      ifConfirmed(
        entry,
        question,
        () => void run('amend', () => api?.gitAmend?.(projectPath, commitMessage.trim() || undefined), clearCommitDraft)
      );
    },
    undoCommitAt: (entry: DesktopGitLogEntry) => {
      ifConfirmed(
        entry,
        t('Undo this commit and keep all of its changes staged?'),
        () => void run('undo-commit', () => api?.gitUndoLastCommit?.(projectPath))
      );
    },
    /** `branch-` prefix so run() reloads the branch list too. */
    createBranchAtCommit: (entry: DesktopGitLogEntry) => {
      const name = namedPrompt(
        t('Create a branch at {{hash}} ({{subject}})', { hash: entry.shortHash, subject: commitTitle(entry) })
      );
      if (name === null) return;
      if (!name.trim()) {
        setError(t('A branch name is required to create a branch.'));
        return;
      }
      // Creating it checks it out: the same guarded project checkout as the
      // branch picker (dirty folder, occupancy, sessions working there).
      void run(`branch-create-at:${entry.hash}`, () =>
        selectProjectBranch(projectPath, name.trim(), { create: true, startPoint: entry.hash })
      );
    },
  };
}
