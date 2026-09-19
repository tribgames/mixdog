// The commit form's draft and the ONE commit entry point every trigger
// (button, split menu, title menu) goes through.
import { useState } from 'react';
import type { DesktopGitFile, DesktopGitStatus } from '../shared/contract';
import { sourceControlCommitSelection } from './source-control-commit-selection';
import { partialStagingWarning } from './source-control-confirmations';
import type { GitActionRunner } from './use-source-control-runner';

export function useSourceControlCommit({
  api,
  projectPath,
  status,
  files,
  isIncluded,
  includedCount,
  conflictCount,
  busy,
  run,
  setError,
}: {
  api: Window['mixdogDesktop'];
  projectPath: string;
  status: DesktopGitStatus | null;
  files: DesktopGitFile[];
  isIncluded: (file: DesktopGitFile) => boolean;
  includedCount: number;
  conflictCount: number;
  busy: string;
  run: GitActionRunner;
  setError: (message: string) => void;
}) {
  // Commit messages keep summary and description as separate fields.
  const [summary, setSummary] = useState('');
  const [description, setDescription] = useState('');
  // Commit message = summary, blank line, description.
  const commitMessage = description.trim() ? `${summary.trim()}\n\n${description.trim()}` : summary.trim();
  const clearDraft = () => {
    setSummary('');
    setDescription('');
  };
  // Re-read Git status immediately before committing; the rendered status is
  // polled and may no longer describe the index.
  const prepareCommitPaths = async (): Promise<string[] | null> => {
    if (!api?.gitStatus || !api.gitCommitPaths) {
      throw new Error('This build cannot commit selected files.');
    }
    const fresh = await api.gitStatus(projectPath);
    if (fresh.operation) {
      throw new Error(`Finish the in-progress ${fresh.operation.replace('-', ' ')} before committing.`);
    }
    const selection = sourceControlCommitSelection(files, fresh.files, isIncluded);
    if (selection.partiallyStaged.length && !window.confirm(partialStagingWarning(selection.partiallyStaged)))
      return null;
    return selection.paths;
  };
  /** The draft is cleared only after the commit lands, and a failing
   *  follow-up (push/sync) is reported without aborting run()'s refresh. */
  const runCommitFlow = (key: string, followUp?: () => Promise<unknown> | undefined) => {
    void run(key, async () => {
      if (!summary.trim()) throw new Error('A commit summary is required to commit.');
      const prepared = await prepareCommitPaths();
      if (!prepared) return;
      // A rejected commit must never clear the draft: it throws out of run(),
      // which reports it and leaves the composer untouched.
      if (!api?.gitCommitPaths) throw new Error('This build cannot commit selected files.');
      await api.gitCommitPaths(projectPath, commitMessage, prepared);
      clearDraft();
      if (!followUp) return;
      try {
        await followUp();
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : String(reason));
      }
    });
  };
  /** Commit is refused while git is mid-operation or conflicts are unresolved,
   *  at EVERY entry point (the operation banner's Continue owns that path). */
  const commitBlocked =
    Boolean(busy) || !summary.trim() || includedCount === 0 || Boolean(status?.operation) || conflictCount > 0;
  return { summary, setSummary, description, setDescription, commitMessage, clearDraft, runCommitFlow, commitBlocked };
}
