import type { DesktopGitLogEntry } from "../shared/contract";
import type { ScmContextMenuItem } from "./ScmContextMenu";

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

  return [
    {
      id: "amend",
      label: "Amend commit…",
      disabled: busy || !isTipCommit || statusUnborn || conflictCount > 0 || !capabilities.amend,
      title: historyBusyReason
        || (!isTipCommit
          ? "Only the most recent commit can be amended"
          : conflictCount > 0
            ? "Resolve conflicts before amending"
            : capabilities.amend ? undefined : missingChannel("Amending a commit")),
      onSelect: actions.amend,
    },
    {
      id: "undo",
      label: "Undo commit…",
      danger: true,
      disabled: busy || !isTipCommit || entry.pushed || !capabilities.undo,
      title: historyBusyReason
        || (!isTipCommit
          ? "Only the most recent commit can be undone"
          : entry.pushed
            ? "This commit is already pushed, so it cannot be undone here"
            : capabilities.undo ? undefined : missingChannel("Undoing a commit")),
      onSelect: actions.undo,
    },
    {
      id: "reset",
      label: "Reset to commit…",
      danger: true,
      separatorBefore: true,
      disabled: busy || !capabilities.reset,
      title: unavailable(capabilities.reset, "Resetting to a commit"),
      onSelect: actions.reset,
    },
    {
      id: "checkout",
      label: "Checkout commit",
      disabled: busy || !capabilities.checkout,
      title: unavailable(capabilities.checkout, "Checking out a commit"),
      onSelect: actions.checkout,
    },
    { id: "reorder", label: "Reorder commit", disabled: true, title: missingChannel("Reordering a commit") },
    {
      id: "revert",
      label: "Revert changes in commit",
      danger: true,
      disabled: busy || !capabilities.revert,
      title: unavailable(capabilities.revert, "Reverting a commit"),
      onSelect: actions.revert,
    },
    {
      id: "create-branch",
      label: "Create branch from commit",
      separatorBefore: true,
      disabled: busy || !capabilities.createBranch,
      title: unavailable(capabilities.createBranch, "Creating a branch from a commit"),
      onSelect: actions.createBranch,
    },
    {
      id: "create-tag",
      label: "Create Tag…",
      disabled: busy || !capabilities.createTag,
      title: unavailable(capabilities.createTag, "Creating a tag"),
      onSelect: actions.createTag,
    },
    ...(tags.length
      ? tags.map((tag, tagIndex) => ({
        id: `delete-tag:${tag}`,
        label: `Delete tag ${tag}`,
        danger: true,
        separatorBefore: tagIndex === 0,
        disabled: busy || !capabilities.deleteTag,
        title: unavailable(capabilities.deleteTag, "Deleting a tag"),
        onSelect: () => actions.deleteTag(tag),
      }))
      : [{
        id: "delete-tag",
        label: "Delete tag",
        separatorBefore: true,
        disabled: true,
        title: tagsKnown ? "This commit carries no tag to delete" : "Tag data is unavailable",
      }]),
    {
      id: "cherry-pick",
      label: "Cherry-pick commit…",
      disabled: busy || !capabilities.cherryPick,
      title: unavailable(capabilities.cherryPick, "Cherry-picking a commit"),
      onSelect: actions.cherryPick,
    },
    {
      id: "copy-sha",
      label: "Copy SHA",
      separatorBefore: true,
      onSelect: actions.copySha,
    },
    {
      id: "copy-tags",
      label: tags.length > 1 ? "Copy tags" : "Copy tag",
      disabled: tags.length === 0,
      title: tagsKnown
        ? tags.length ? undefined : "This commit carries no tag to copy"
        : "Tag data is unavailable",
      onSelect: () => actions.copyTags(tags),
    },
    {
      id: "open-github",
      label: "View on GitHub",
      disabled: !commitUrl || !capabilities.openExternal,
      title: commitUrl
        ? undefined
        : "This repository has no hosted remote to open the commit on",
      onSelect: actions.openHostedCommit,
    },
  ];
}
