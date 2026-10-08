import type { DesktopGitCommitFile, DesktopGitLogEntry } from '../shared/contract';
import { describeSourceControlError } from './SourceControlErrorNotice';
import { t } from './i18n';
import { reasonText } from './source-control-support';
import type { useSourceControlHistory } from './use-source-control-history';

/** History commit detail: open a commit, copy its SHA, and expand a file's diff. */
export function useSourceControlCommitDetail({
  api,
  projectPath,
  busy,
  setBusy,
  setError,
  history,
}: {
  api: Window['mixdogDesktop'];
  projectPath: string;
  busy: string;
  setBusy: (busy: string) => void;
  setError: (message: string) => void;
  history: ReturnType<typeof useSourceControlHistory>;
}) {
  const openCommit = async (entry: DesktopGitLogEntry) => {
    if (!api?.gitShow || busy) return;
    setBusy(`show:${entry.hash}`);
    history.setSelectedCommit(entry.hash);
    history.setCommitDetail(null);
    history.setOpenCommitFile('');
    history.setCommitDiffs({});
    history.setShaCopy(null);
    try {
      history.setCommitDetail(await api.gitShow(projectPath, entry.hash));
    } catch (reason) {
      setError(reasonText(reason));
      history.setSelectedCommit('');
    } finally {
      setBusy('');
    }
  };
  /** Short SHA + copy affordance. The Clipboard API can be absent (insecure
   *  context) or refuse; either way the outcome is reported — announced
   *  through the header's live region and surfaced in the error banner —
   *  instead of claiming a copy that never happened. */
  const copyCommitSha = async (hash: string) => {
    const clipboard = window.navigator?.clipboard;
    if (!clipboard?.writeText) {
      history.setShaCopy({ hash, ok: false });
      setError(t('Could not copy the SHA: this environment has no clipboard access.'));
      return;
    }
    try {
      await clipboard.writeText(hash);
      history.setShaCopy({ hash, ok: true });
    } catch (reason) {
      history.setShaCopy({ hash, ok: false });
      setError(t('Could not copy the SHA: {{value0}}', { value0: reasonText(reason) }));
    }
  };
  const toggleCommitFile = async (file: DesktopGitCommitFile) => {
    if (history.openCommitFile === file.path) {
      history.setOpenCommitFile('');
      return;
    }
    history.setOpenCommitFile(file.path);
    if (history.commitDiffs[file.path] !== undefined || !api?.gitShowDiff || !history.selectedCommit) return;
    history.setCommitDiffs((current) => ({ ...current, [file.path]: null }));
    try {
      const patch = await api.gitShowDiff(projectPath, history.selectedCommit, file.path);
      history.setCommitDiffs((current) => ({ ...current, [file.path]: patch || '' }));
    } catch (reason) {
      history.setCommitDiffs((current) => ({
        ...current,
        [file.path]: describeSourceControlError(reason).summary,
      }));
    }
  };
  return { openCommit, copyCommitSha, toggleCommitFile };
}
