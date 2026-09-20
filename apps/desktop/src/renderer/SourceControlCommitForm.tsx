import type { KeyboardEvent } from 'react';

import { ProgressSpinner } from './ProgressSpinner';
import { t } from './i18n';

function commitButtonLabel(committing: boolean, branchName: string, count: number): string {
  if (committing) return t('Committing…');
  if (branchName) {
    if (count === 1) return t('Commit 1 file to {{branch}}', { branch: branchName });
    if (count > 0) return t('Commit {{count}} files to {{branch}}', { count, branch: branchName });
    return t('Commit to {{branch}}', { branch: branchName });
  }
  if (count === 1) return t('Commit 1 file');
  if (count > 0) return t('Commit {{count}} files', { count });
  return t('Commit');
}

export function SourceControlCommitForm({
  branch,
  busy,
  commitBlocked,
  conflictCount,
  description,
  detached,
  fileCount,
  operation,
  selectedFileCount,
  summary,
  onCommit,
  onDescriptionChange,
  onSummaryChange,
}: {
  branch: string;
  busy: string;
  commitBlocked: boolean;
  conflictCount: number;
  description: string;
  detached: boolean;
  fileCount: number;
  operation?: string;
  selectedFileCount: number;
  summary: string;
  onCommit(): void;
  onDescriptionChange(value: string): void;
  onSummaryChange(value: string): void;
}) {
  const committing = busy === 'commit' || busy === 'amend';
  const blocked = commitBlocked || !summary.trim();
  const branchName = detached ? '' : branch;
  const commitLabel = commitButtonLabel(committing, branchName, selectedFileCount);
  let title = branchName ? t('Commit to {{branch}}', { branch: branchName }) : t('Commit');
  if (!summary.trim()) title = t('Summary (required)');
  else if (selectedFileCount === 0 && fileCount > 0) title = t('Select one or more files to commit');
  else if (committing) title = t('Committing changes…');
  else if (operation) title = t('Finish the in-progress Git operation first');
  else if (conflictCount > 0) title = t('Resolve conflicts before committing');

  const submitOnAccelerator = (event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    if (event.key !== 'Enter' || !(event.ctrlKey || event.metaKey)) return;
    event.preventDefault();
    if (!blocked) event.currentTarget.form?.requestSubmit();
  };

  return (
    <form
      className="dock-scm-commit"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        if (!blocked) onCommit();
      }}
    >
      <input
        type="text"
        className="dock-scm-commit-summary"
        aria-label={t('Summary')}
        placeholder={t('Summary (required)')}
        value={summary}
        autoComplete="off"
        readOnly={committing}
        onInput={(event) => onSummaryChange(event.currentTarget.value)}
        onKeyDown={submitOnAccelerator}
      />
      <div className="dock-scm-commit-description-box">
        <textarea
          className="dock-scm-commit-description"
          aria-label={t('Description')}
          placeholder={t('Description')}
          value={description}
          rows={1}
          autoComplete="off"
          readOnly={committing}
          onInput={(event) => onDescriptionChange(event.currentTarget.value)}
          onKeyDown={submitOnAccelerator}
        />
      </div>
      <div className="dock-scm-commit-split">
        <button type="submit" className="dock-scm-commit-button" disabled={blocked} title={title}>
          {committing && <ProgressSpinner size={14} aria-hidden="true" />}
          <span>{commitLabel}</span>
        </button>
      </div>
    </form>
  );
}
