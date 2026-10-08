import type { DesktopGitLogEntry } from '../shared/contract';
import { t } from './i18n';
import type { ScmContextMenuItem } from './ScmContextMenu';

interface CommitMenuCapabilities {
  amend: boolean;
  checkout: boolean;
  cherryPick: boolean;
  createBranch: boolean;
  createTag: boolean;
  deleteTag: boolean;
  openExternal: boolean;
  reset: boolean;
  revert: boolean;
  undo: boolean;
}

interface CommitMenuActions {
  amend(): void;
  checkout(): void;
  cherryPick(): void;
  copySha(): void;
  copyTags(tags: string[]): void;
  createBranch(): void;
  createTag(): void;
  deleteTag(tag: string): void;
  openHostedCommit(): void;
  reset(): void;
  revert(): void;
  undo(): void;
}

export function buildSourceControlCommitMenu({
  actions,
  capabilities,
  commitUrl,
  conflictCount,
  entry,
  entryIndex,
  historyBusyReason,
  missingChannel,
  statusUnborn,
}: {
  actions: CommitMenuActions;
  capabilities: CommitMenuCapabilities;
  commitUrl: string;
  conflictCount: number;
  entry: DesktopGitLogEntry;
  entryIndex: number;
  historyBusyReason: string;
  missingChannel(action: string): string;
  statusUnborn: boolean;
}): ScmContextMenuItem[] {
  const tagsKnown = Array.isArray(entry.tags);
  const tags = entry.tags ?? [];
  const isTipCommit = entryIndex === 0;
  const busy = Boolean(historyBusyReason);
  const unavailable = (capable: boolean, action: string) =>
    historyBusyReason || (capable ? undefined : missingChannel(action));
  let amendBlocked: string | undefined;
  if (!isTipCommit) amendBlocked = t('Only the most recent commit can be amended');
  else if (conflictCount > 0) amendBlocked = t('Resolve conflicts before amending');
  let undoBlocked: string | undefined;
  if (!isTipCommit) undoBlocked = t('Only the most recent commit can be undone');
  else if (entry.pushed) undoBlocked = t('This commit is already pushed, so it cannot be undone here');
  const noTagTitle = tagsKnown ? t('This commit carries no tag to delete') : t('Tag data is unavailable');
  let copyTagsTitle: string | undefined = t('Tag data is unavailable');
  if (tagsKnown) copyTagsTitle = tags.length ? undefined : t('This commit carries no tag to copy');

  return [
    {
      id: 'amend',
      label: t('Amend commit…'),
      disabled: busy || !isTipCommit || statusUnborn || conflictCount > 0 || !capabilities.amend,
      title: historyBusyReason || amendBlocked || unavailable(capabilities.amend, t('Amending a commit')),
      onSelect: actions.amend,
    },
    {
      id: 'undo',
      label: t('Undo commit…'),
      danger: true,
      disabled: busy || !isTipCommit || entry.pushed || !capabilities.undo,
      title: historyBusyReason || undoBlocked || unavailable(capabilities.undo, t('Undoing a commit')),
      onSelect: actions.undo,
    },
    {
      id: 'reset',
      label: t('Reset to commit…'),
      danger: true,
      separatorBefore: true,
      disabled: busy || !capabilities.reset,
      title: unavailable(capabilities.reset, t('Resetting to a commit')),
      onSelect: actions.reset,
    },
    {
      id: 'checkout',
      label: t('Checkout commit'),
      disabled: busy || !capabilities.checkout,
      title: unavailable(capabilities.checkout, t('Checking out a commit')),
      onSelect: actions.checkout,
    },
    { id: 'reorder', label: t('Reorder commit'), disabled: true, title: missingChannel(t('Reordering a commit')) },
    {
      id: 'revert',
      label: t('Revert changes in commit'),
      danger: true,
      disabled: busy || !capabilities.revert,
      title: unavailable(capabilities.revert, t('Reverting a commit')),
      onSelect: actions.revert,
    },
    {
      id: 'create-branch',
      label: t('Create branch from commit'),
      separatorBefore: true,
      disabled: busy || !capabilities.createBranch,
      title: unavailable(capabilities.createBranch, t('Creating a branch from a commit')),
      onSelect: actions.createBranch,
    },
    {
      id: 'create-tag',
      label: t('Create Tag…'),
      disabled: busy || !capabilities.createTag,
      title: unavailable(capabilities.createTag, t('Creating a tag')),
      onSelect: actions.createTag,
    },
    ...(tags.length
      ? tags.map((tag, tagIndex) => ({
          id: `delete-tag:${tag}`,
          label: t('Delete tag {{value0}}', { value0: tag }),
          danger: true,
          separatorBefore: tagIndex === 0,
          disabled: busy || !capabilities.deleteTag,
          title: unavailable(capabilities.deleteTag, t('Deleting a tag')),
          onSelect: () => actions.deleteTag(tag),
        }))
      : [
          {
            id: 'delete-tag',
            label: t('Delete tag'),
            separatorBefore: true,
            disabled: true,
            title: noTagTitle,
          },
        ]),
    {
      id: 'cherry-pick',
      label: t('Cherry-pick commit…'),
      disabled: busy || !capabilities.cherryPick,
      title: unavailable(capabilities.cherryPick, t('Cherry-picking a commit')),
      onSelect: actions.cherryPick,
    },
    {
      id: 'copy-sha',
      label: t('Copy SHA'),
      separatorBefore: true,
      onSelect: actions.copySha,
    },
    {
      id: 'copy-tags',
      label: tags.length > 1 ? t('Copy tags') : t('Copy tag'),
      disabled: tags.length === 0,
      title: copyTagsTitle,
      onSelect: () => actions.copyTags(tags),
    },
    {
      id: 'open-github',
      label: t('View on GitHub'),
      disabled: !commitUrl || !capabilities.openExternal,
      title: commitUrl ? undefined : t('This repository has no hosted remote to open the commit on'),
      onSelect: actions.openHostedCommit,
    },
  ];
}
