import type { DesktopGitFile } from '../shared/contract';
import {
  partiallyStaged,
  pathsFor,
} from './source-control-support';

interface CommitSelection {
  paths: string[];
  partiallyStaged: DesktopGitFile[];
}

/** Resolve a fresh Git status against the rows and checkboxes the user saw. */
export function sourceControlCommitSelection(
  visibleFiles: readonly DesktopGitFile[],
  freshFiles: readonly DesktopGitFile[],
  isIncluded: (file: DesktopGitFile) => boolean,
): CommitSelection {
  const conflicts = freshFiles.filter((file) => file.conflicted);
  if (conflicts.length) {
    throw new Error(`Resolve ${conflicts.length} conflicted file${
      conflicts.length === 1 ? '' : 's'} before committing.`);
  }

  const seen = new Set(visibleFiles.flatMap(pathsFor));
  const selected = freshFiles.filter((file) => seen.has(file.path) && isIncluded(file));
  if (!selected.length) throw new Error('Select one or more files to commit.');

  const paths = [...new Set(selected.flatMap(pathsFor))];
  const unseen = paths.filter((path) => !seen.has(path));
  if (unseen.length) {
    const names = unseen.slice(0, 3).join(', ');
    throw new Error(
      `The index changed outside this list (${names}${unseen.length > 3 ? ', …' : ''}). `
      + 'Refresh the changes list and commit again.',
    );
  }
  return {
    paths,
    partiallyStaged: selected.filter(partiallyStaged),
  };
}
