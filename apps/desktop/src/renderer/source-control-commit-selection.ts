import type { DesktopGitFile } from '../shared/contract';
import { t } from './i18n';
import { partiallyStaged, pathsFor } from './source-control-support';

interface CommitSelection {
  paths: string[];
  partiallyStaged: DesktopGitFile[];
}

/** Resolve a fresh Git status against the rows and checkboxes the user saw. */
export function sourceControlCommitSelection(
  visibleFiles: readonly DesktopGitFile[],
  freshFiles: readonly DesktopGitFile[],
  isIncluded: (file: DesktopGitFile) => boolean
): CommitSelection {
  const conflicts = freshFiles.filter((file) => file.conflicted);
  if (conflicts.length) {
    throw new Error(
      conflicts.length === 1
        ? t('Resolve 1 conflicted file before committing.')
        : t('Resolve {{count}} conflicted files before committing.', { count: conflicts.length })
    );
  }

  const seen = new Set(visibleFiles.flatMap(pathsFor));
  const selected = freshFiles.filter((file) => seen.has(file.path) && isIncluded(file));
  if (!selected.length) throw new Error(t('Select one or more files to commit.'));

  const paths = [...new Set(selected.flatMap(pathsFor))];
  const unseen = paths.filter((path) => !seen.has(path));
  if (unseen.length) {
    const names = unseen.slice(0, 3).join(', ');
    throw new Error(
      t('The index changed outside this list ({{names}}). Refresh the changes list and commit again.', {
        names: `${names}${unseen.length > 3 ? ', …' : ''}`,
      })
    );
  }
  return {
    paths,
    partiallyStaged: selected.filter(partiallyStaged),
  };
}
