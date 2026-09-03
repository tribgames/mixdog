import type { App, IpcMainInvokeEvent, Shell } from 'electron';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { DESKTOP_IPC } from '../shared/contract';
import {
  requiredCommitHash,
  requiredGitIgnoreScope,
  requiredGitResetMode,
  requiredGitRevision,
  requiredRepositoryCwd,
} from './git-contract.mjs';
import {
  attachmentImageBaseName,
  requiredAttachmentImage,
  requiredCommitMessageFiles,
  requiredGitBranchName,
  requiredGitDiscardMode,
  requiredGitGlobalConfigKey,
  requiredGitLogLimit,
  requiredGitLogOffset,
  requiredGitLogQuery,
  requiredGitOptionalMessage,
  requiredGitPatch,
  requiredGitPath,
  requiredGitPaths,
  requiredGitPreferencesInput,
  requiredString,
} from './ipc-validation';
import type { DesktopSettingsStore } from './settings-store';

type ServiceOperation = (...args: any[]) => Promise<any>;
type Handle = (
  channel: string,
  listener: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown,
) => void;

interface SourceControlIpcOptions {
  app: Partial<Pick<App, 'getPath'>>;
  handle: Handle;
  operations: Record<string, ServiceOperation>;
  settingsStore?: Pick<DesktopSettingsStore, 'readGitPreferences' | 'updateGitPreferences'>;
  invokeDesktopOperation: <T>(method: string, args: unknown[]) => Promise<T>;
  shell: Pick<Shell, 'openPath' | 'showItemInFolder'>;
  grantedFile: (
    accessToken: unknown,
    projectPath: unknown,
    relPath: unknown,
  ) => Promise<{ root: string; rel: string; absolute: string }>;
}

export function registerSourceControlIpc({
  app,
  handle,
  operations,
  settingsStore,
  invokeDesktopOperation,
  shell,
  grantedFile,
}: SourceControlIpcOptions): void {
  const {
    gitCliStatus,
    installGitCli,
    githubCliStatus,
    installGithubCli,
    githubCliLoginStart,
    githubCliLoginStatus,
    cancelGithubCliLogin,
    githubCliLogout,
    githubCliAccount,
    gitGlobalConfig,
    setGitGlobalConfig,
    gitAbortOperation,
    gitAmend,
    gitApplyPatch,
    gitBranches,
    gitCheckoutBranch,
    gitCheckoutCommit,
    gitCherryPickCommit,
    gitCommit,
    gitCommitPaths,
    gitContinue,
    gitCreateBranch,
    gitCreateBranchAtCommit,
    gitCreateTag,
    gitDeleteBranch,
    gitDeleteTag,
    gitDiff,
    gitFetch,
    gitIgnore,
    gitLog,
    gitMergeBranch,
    gitPull,
    gitPush,
    gitRenameBranch,
    gitResetToCommit,
    gitRevertCommit,
    gitRevertFile,
    gitReview,
    gitReviewDiff,
    gitShow,
    gitShowDiff,
    gitShowFile,
    gitStage,
    gitStash,
    gitStashApply,
    gitStashDrop,
    gitStashList,
    gitStashPop,
    gitStatus,
    gitSync,
    gitUndoLastCommit,
    gitUnstage,
    ghPrCheckout,
    ghPrCreate,
    ghPrDefaultBranch,
    ghPrDiff,
    ghPrList,
    ghPrMerge,
    ghPrView,
  } = operations;

  handle(DESKTOP_IPC.gitCliStatus, () => gitCliStatus());
  handle(DESKTOP_IPC.installGitCli, () => installGitCli());
  handle(DESKTOP_IPC.githubCliStatus, () => githubCliStatus());
  handle(DESKTOP_IPC.installGithubCli, () => installGithubCli());
  handle(DESKTOP_IPC.githubCliLoginStart, () => githubCliLoginStart());
  handle(DESKTOP_IPC.githubCliLoginStatus, (_event, flowId) =>
    githubCliLoginStatus(requiredString(flowId, 'flowId', 200)));
  handle(DESKTOP_IPC.githubCliLoginCancel, (_event, flowId) =>
    cancelGithubCliLogin(requiredString(flowId, 'flowId', 200)));
  handle(DESKTOP_IPC.githubCliLogout, () => githubCliLogout());
  handle(DESKTOP_IPC.githubCliAccount, () => githubCliAccount());
  handle(DESKTOP_IPC.gitGlobalConfig, () => gitGlobalConfig());
  handle(DESKTOP_IPC.setGitGlobalConfig, (_event, key, value) => {
    // Empty unsets the key, so requiredString's non-empty contract does not apply.
    if (typeof value !== 'string' || value.length > 500) {
      throw new TypeError('value must be a string of at most 500 characters.');
    }
    return setGitGlobalConfig(requiredGitGlobalConfigKey(key), value);
  });
  handle(DESKTOP_IPC.readGitPreferences, () =>
    settingsStore?.readGitPreferences() ?? invokeDesktopOperation('readGitPreferences', []));
  handle(DESKTOP_IPC.updateGitPreferences, (_event, preferences) => {
    const value = requiredGitPreferencesInput(preferences);
    return settingsStore
      ? settingsStore.updateGitPreferences(value)
      : invokeDesktopOperation('updateGitPreferences', [value]);
  });

  handle(DESKTOP_IPC.gitStatus, (_event, cwd, options) => {
    const record = options && typeof options === 'object'
      ? options as { reuseLineStats?: unknown; skipLineStats?: unknown }
      : {};
    return gitStatus(requiredRepositoryCwd(cwd), {
      reuseLineStats: record.reuseLineStats === true,
      skipLineStats: record.skipLineStats === true,
    });
  });
  handle(DESKTOP_IPC.gitBranches, (_event, cwd) => gitBranches(requiredRepositoryCwd(cwd)));
  handle(DESKTOP_IPC.gitCheckoutBranch, (_event, cwd, branch, remote) =>
    gitCheckoutBranch(
      requiredRepositoryCwd(cwd),
      requiredGitBranchName(branch),
      remote === true,
    ));
  handle(DESKTOP_IPC.gitCreateBranch, (_event, cwd, branch) =>
    gitCreateBranch(requiredRepositoryCwd(cwd), requiredGitBranchName(branch)));
  handle(DESKTOP_IPC.gitRenameBranch, (_event, cwd, branch, nextBranch) =>
    gitRenameBranch(
      requiredRepositoryCwd(cwd),
      requiredGitBranchName(branch),
      requiredGitBranchName(nextBranch),
    ));
  handle(DESKTOP_IPC.gitDeleteBranch, (_event, cwd, branch) =>
    gitDeleteBranch(requiredRepositoryCwd(cwd), requiredGitBranchName(branch)));
  handle(DESKTOP_IPC.gitMergeBranch, (_event, cwd, branch) =>
    gitMergeBranch(requiredRepositoryCwd(cwd), requiredGitBranchName(branch)));
  handle(DESKTOP_IPC.gitDiff, (_event, cwd, path, staged, worktreeOnly, untracked) =>
    gitDiff(
      requiredRepositoryCwd(cwd),
      requiredGitPath(path),
      staged === true,
      worktreeOnly === true,
      untracked === true,
    ));
  handle(DESKTOP_IPC.gitApplyPatch, (_event, cwd, path, patch, reverse) => {
    if (reverse !== undefined && typeof reverse !== 'boolean') {
      throw new TypeError('git patch direction is invalid.');
    }
    return gitApplyPatch(
      requiredRepositoryCwd(cwd),
      requiredGitPath(path),
      requiredGitPatch(patch),
      reverse === true,
    );
  });
  handle(DESKTOP_IPC.gitStage, (_event, cwd, paths) =>
    gitStage(requiredRepositoryCwd(cwd), requiredGitPaths(paths)));
  handle(DESKTOP_IPC.gitUnstage, (_event, cwd, paths) =>
    gitUnstage(requiredRepositoryCwd(cwd), requiredGitPaths(paths)));
  handle(DESKTOP_IPC.gitCommit, (_event, cwd, message) =>
    gitCommit(requiredRepositoryCwd(cwd), requiredString(message, 'commit message', 20_000)));
  handle(DESKTOP_IPC.gitCommitPaths, (_event, cwd, message, paths) =>
    gitCommitPaths(
      requiredRepositoryCwd(cwd),
      requiredString(message, 'commit message', 20_000),
      requiredGitPaths(paths),
    ));
  handle(DESKTOP_IPC.gitGenerateCommitMessage, async (_event, cwd, files) => {
    const repository = requiredRepositoryCwd(cwd);
    const entries = requiredCommitMessageFiles(files);
    const preferences = settingsStore
      ? await settingsStore.readGitPreferences().catch(() => null)
      : await invokeDesktopOperation('readGitPreferences', []).catch(() => null);
    const message = await invokeDesktopOperation<string>(
      'gitGenerateCommitMessage',
      [repository, entries, preferences],
    );
    return { message };
  });
  handle(DESKTOP_IPC.gitAmend, (_event, cwd, message) =>
    gitAmend(requiredRepositoryCwd(cwd), requiredGitOptionalMessage(message)));
  handle(DESKTOP_IPC.gitUndoLastCommit, (_event, cwd) =>
    gitUndoLastCommit(requiredRepositoryCwd(cwd)));
  handle(DESKTOP_IPC.gitStash, (_event, cwd, message) =>
    gitStash(requiredRepositoryCwd(cwd), requiredGitOptionalMessage(message)));
  handle(DESKTOP_IPC.gitStashPop, (_event, cwd) =>
    gitStashPop(requiredRepositoryCwd(cwd)));
  handle(DESKTOP_IPC.gitStashList, (_event, cwd) =>
    gitStashList(requiredRepositoryCwd(cwd)));
  handle(DESKTOP_IPC.gitStashApply, (_event, cwd, ref) =>
    gitStashApply(requiredRepositoryCwd(cwd), requiredString(ref, 'stash ref', 64)));
  handle(DESKTOP_IPC.gitStashDrop, (_event, cwd, ref) =>
    gitStashDrop(requiredRepositoryCwd(cwd), requiredString(ref, 'stash ref', 64)));
  handle(DESKTOP_IPC.ghPrList, (_event, cwd) => ghPrList(requiredRepositoryCwd(cwd)));
  handle(DESKTOP_IPC.ghPrDefaultBranch, (_event, cwd) =>
    ghPrDefaultBranch(requiredRepositoryCwd(cwd)));
  handle(DESKTOP_IPC.ghPrCreate, (_event, cwd, input) =>
    ghPrCreate(requiredRepositoryCwd(cwd), input));
  handle(DESKTOP_IPC.ghPrView, (_event, cwd, number) =>
    ghPrView(requiredRepositoryCwd(cwd), number));
  handle(DESKTOP_IPC.ghPrCheckout, (_event, cwd, number) =>
    ghPrCheckout(requiredRepositoryCwd(cwd), number));
  handle(DESKTOP_IPC.ghPrMerge, (_event, cwd, number, method) =>
    ghPrMerge(requiredRepositoryCwd(cwd), number, method));
  handle(DESKTOP_IPC.ghPrDiff, (_event, cwd, number) =>
    ghPrDiff(requiredRepositoryCwd(cwd), number));
  handle(DESKTOP_IPC.gitPush, (_event, cwd) => gitPush(requiredRepositoryCwd(cwd)));
  handle(DESKTOP_IPC.gitFetch, (_event, cwd) => gitFetch(requiredRepositoryCwd(cwd)));
  handle(DESKTOP_IPC.gitPull, (_event, cwd) => gitPull(requiredRepositoryCwd(cwd)));
  handle(DESKTOP_IPC.gitSync, (_event, cwd) => gitSync(requiredRepositoryCwd(cwd)));
  handle(DESKTOP_IPC.gitContinue, (_event, cwd) => gitContinue(requiredRepositoryCwd(cwd)));
  handle(DESKTOP_IPC.gitAbortOperation, (_event, cwd) =>
    gitAbortOperation(requiredRepositoryCwd(cwd)));
  handle(DESKTOP_IPC.gitIgnore, (_event, cwd, path, scope) =>
    gitIgnore(
      requiredRepositoryCwd(cwd),
      requiredGitPath(path),
      requiredGitIgnoreScope(scope),
    ));
  handle(DESKTOP_IPC.gitRevert, (_event, cwd, path, untracked, mode) =>
    gitRevertFile(
      requiredRepositoryCwd(cwd),
      requiredGitPath(path),
      untracked === true,
      requiredGitDiscardMode(mode),
    ));
  handle(DESKTOP_IPC.gitLog, (_event, cwd, query, skip, limit) => gitLog(
    requiredRepositoryCwd(cwd),
    requiredGitLogQuery(query),
    requiredGitLogOffset(skip),
    requiredGitLogLimit(limit),
  ));
  handle(DESKTOP_IPC.gitShow, (_event, cwd, hash) =>
    gitShow(requiredRepositoryCwd(cwd), requiredCommitHash(hash)));
  handle(DESKTOP_IPC.gitShowDiff, (_event, cwd, hash, path) =>
    gitShowDiff(requiredRepositoryCwd(cwd), requiredCommitHash(hash), requiredGitPath(path)));
  handle(DESKTOP_IPC.gitShowFile, (_event, cwd, rev, path) =>
    gitShowFile(requiredRepositoryCwd(cwd), requiredGitRevision(rev), requiredGitPath(path)));
  // `confirmedDirty` only acknowledges a mixed-reset warning. Hard reset keeps
  // enforcing its own dirty-worktree refusal in the service implementation.
  handle(DESKTOP_IPC.gitResetToCommit, (_event, cwd, hash, mode, confirmedDirty) =>
    gitResetToCommit(
      requiredRepositoryCwd(cwd),
      requiredCommitHash(hash),
      requiredGitResetMode(mode),
      confirmedDirty === true,
    ));
  handle(DESKTOP_IPC.gitRevertCommit, (_event, cwd, hash) =>
    gitRevertCommit(requiredRepositoryCwd(cwd), requiredCommitHash(hash)));
  handle(DESKTOP_IPC.gitCherryPickCommit, (_event, cwd, hash) =>
    gitCherryPickCommit(requiredRepositoryCwd(cwd), requiredCommitHash(hash)));
  handle(DESKTOP_IPC.gitCreateTag, (_event, cwd, tag, hash) => gitCreateTag(
    requiredRepositoryCwd(cwd),
    requiredString(tag, 'git tag', 512),
    requiredCommitHash(hash),
  ));
  handle(DESKTOP_IPC.gitDeleteTag, (_event, cwd, tag) =>
    gitDeleteTag(requiredRepositoryCwd(cwd), requiredString(tag, 'git tag', 512)));
  handle(DESKTOP_IPC.gitCheckoutCommit, (_event, cwd, hash) =>
    gitCheckoutCommit(requiredRepositoryCwd(cwd), requiredCommitHash(hash)));
  handle(DESKTOP_IPC.gitCreateBranchAtCommit, (_event, cwd, branch, hash) =>
    gitCreateBranchAtCommit(
      requiredRepositoryCwd(cwd),
      requiredGitBranchName(branch),
      requiredCommitHash(hash),
    ));
  handle(DESKTOP_IPC.gitReview, (_event, cwd) => gitReview(requiredRepositoryCwd(cwd)));
  handle(DESKTOP_IPC.gitReviewDiff, (_event, cwd, path, untracked) =>
    gitReviewDiff(requiredRepositoryCwd(cwd), requiredGitPath(path), untracked === true));

  const resolveInsideProject = (cwd: unknown, path: unknown): string => {
    const root = resolve(requiredRepositoryCwd(cwd));
    const absolute = resolve(root, requiredString(path, 'file path', 4_096));
    if (absolute !== root && !absolute.startsWith(root + sep)) {
      throw new TypeError('The file path escapes the project directory.');
    }
    return absolute;
  };
  handle(DESKTOP_IPC.revealFile, async (_event, cwd, path, accessToken) => {
    const absolute = typeof accessToken === 'string' && accessToken
      ? (await grantedFile(accessToken, cwd, path)).absolute
      : resolveInsideProject(cwd, path);
    shell.showItemInFolder(absolute);
  });
  handle(DESKTOP_IPC.openFilePath, async (_event, cwd, path, accessToken) => {
    const absolute = typeof accessToken === 'string' && accessToken
      ? (await grantedFile(accessToken, cwd, path)).absolute
      : resolveInsideProject(cwd, path);
    const failure = await shell.openPath(absolute);
    if (failure) throw new Error(`Unable to open file: ${failure}`);
  });
  handle(DESKTOP_IPC.openAttachmentImage, async (_event, dataUrl, name) => {
    const image = requiredAttachmentImage(dataUrl);
    const temp = typeof app.getPath === 'function' ? app.getPath('temp') : '';
    if (!temp) throw new Error('Unable to open image: no temporary directory.');
    const directory = join(temp, 'mixdog-attachments');
    await mkdir(directory, { recursive: true });
    const digest = createHash('sha256').update(image.bytes).digest('hex').slice(0, 16);
    const file = join(
      directory,
      `${attachmentImageBaseName(name)}-${digest}.${image.extension}`,
    );
    await writeFile(file, image.bytes, { mode: 0o600 });
    const failure = await shell.openPath(file);
    if (failure) throw new Error(`Unable to open image: ${failure}`);
  });
}
