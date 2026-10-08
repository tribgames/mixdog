import { t } from './i18n';
import type { DesktopGitLogEntry, DesktopGitStatus } from '../shared/contract';
import { copyText, type historyCommitActions, missingChannel } from './source-control-actions';
import { buildSourceControlCommitMenu } from './source-control-history-menu';
import type { useSourceControlRunner } from './use-source-control-runner';

/** Binds the dock's Git capabilities and guarded actions into the History
 *  row's context-menu builder. */
export function createHistoryMenuItems({
  api,
  ctx,
  status,
  conflictCount,
  historyBusyReason,
  guarded,
  commitActions,
}: {
  api: Window['mixdogDesktop'];
  ctx: Parameters<typeof copyText>[0];
  status: DesktopGitStatus | null;
  conflictCount: number;
  historyBusyReason: string;
  guarded: ReturnType<typeof useSourceControlRunner>['guarded'];
  commitActions: ReturnType<typeof historyCommitActions>;
}) {
  return (entry: DesktopGitLogEntry, entryIndex: number, hostedCommitUrl: string) =>
    buildSourceControlCommitMenu({
      entry,
      entryIndex,
      historyBusyReason,
      statusUnborn: Boolean(status?.unborn),
      conflictCount,
      commitUrl: hostedCommitUrl,
      missingChannel,
      capabilities: {
        amend: Boolean(api?.gitAmend),
        checkout: Boolean(api?.gitCheckoutCommit),
        cherryPick: Boolean(api?.gitCherryPickCommit),
        createBranch: Boolean(api?.gitCreateBranchAtCommit),
        createTag: Boolean(api?.gitCreateTag),
        deleteTag: Boolean(api?.gitDeleteTag),
        openExternal: Boolean(api?.openExternal),
        reset: Boolean(api?.gitResetToCommit),
        revert: Boolean(api?.gitRevertCommit),
        undo: Boolean(api?.gitUndoLastCommit),
      },
      actions: {
        amend: () => guarded(() => commitActions.amendCommitAt(entry)),
        checkout: () => guarded(() => commitActions.checkoutCommit(entry)),
        cherryPick: () => guarded(() => commitActions.cherryPickCommit(entry)),
        copySha: () => void copyText(ctx, entry.hash, 'SHA'),
        copyTags: (values) => void copyText(ctx, values.join(' '), values.length > 1 ? t('tags') : t('tag')),
        createBranch: () => guarded(() => commitActions.createBranchAtCommit(entry)),
        createTag: () => guarded(() => commitActions.createTagAt(entry)),
        deleteTag: (tag) => guarded(() => commitActions.deleteTagAt(entry, tag)),
        openHostedCommit: () => void api?.openExternal?.(hostedCommitUrl),
        reset: () => guarded(() => commitActions.resetToCommit(entry)),
        revert: () => guarded(() => commitActions.revertCommit(entry)),
        undo: () => guarded(() => commitActions.undoCommitAt(entry)),
      },
    });
}
