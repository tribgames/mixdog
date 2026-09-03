import type { KeyboardEvent } from "react";

import { ProgressSpinner } from "./ProgressSpinner";
import { t } from "./i18n";

export function SourceControlCommitForm({
  autoCommitMessage,
  branch,
  busy,
  commitBlocked,
  conflictCount,
  conventionalWarning,
  description,
  descriptionPlaceholder,
  detached,
  fileCount,
  operation,
  selectedFileCount,
  summary,
  summaryPlaceholder,
  onCommit,
  onDescriptionChange,
  onSummaryChange,
}: {
  autoCommitMessage: boolean;
  branch: string;
  busy: string;
  commitBlocked: boolean;
  conflictCount: number;
  conventionalWarning: boolean;
  description: string;
  descriptionPlaceholder: string;
  detached: boolean;
  fileCount: number;
  operation?: string;
  selectedFileCount: number;
  summary: string;
  summaryPlaceholder: string;
  onCommit(): void;
  onDescriptionChange(value: string): void;
  onSummaryChange(value: string): void;
}) {
  const committing = busy === "commit" || busy === "amend";
  const autoDraft = !summary.trim() && autoCommitMessage;
  const branchName = detached ? "" : branch;
  const verb = committing ? "Committing…" : "Commit";
  const countText = selectedFileCount > 0
    ? `${selectedFileCount} ${selectedFileCount > 1 ? "files" : "file"} `
    : "";
  const title = autoDraft
    ? "Commit with an auto-generated message"
    : !summary.trim()
      ? "A commit summary is required to commit"
      : selectedFileCount === 0 && fileCount > 0
        ? "Select one or more files to commit"
        : committing
          ? "Committing changes…"
          : operation
            ? "Finish the in-progress Git operation first"
            : conflictCount > 0
              ? "Resolve conflicts before committing"
              : branchName ? `Commit to ${branchName}` : "Commit";

  const submitOnAccelerator = (
    event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>,
  ) => {
    if (event.key !== "Enter" || !(event.ctrlKey || event.metaKey)) return;
    event.preventDefault();
    if (summary.trim()) event.currentTarget.form?.requestSubmit();
  };

  return <form className="dock-scm-commit" noValidate onSubmit={(event) => {
    event.preventDefault();
    if (!commitBlocked) onCommit();
  }}>
    <input type="text" className="dock-scm-commit-summary" aria-label="Summary"
      placeholder={summaryPlaceholder} value={summary}
      readOnly={committing}
      onInput={(event) => onSummaryChange(event.currentTarget.value)}
      onKeyDown={submitOnAccelerator} />
    <div className="dock-scm-commit-description-box">
      <textarea className="dock-scm-commit-description" aria-label="Description"
        placeholder={descriptionPlaceholder} value={description} rows={1}
        readOnly={committing}
        onInput={(event) => onDescriptionChange(event.currentTarget.value)}
        onKeyDown={submitOnAccelerator} />
    </div>
    {conventionalWarning && <p className="dock-scm-commit-format-warning" role="status">
      {t("Expected {{format}}. You can still commit this message.", {
        format: "type(scope)!: description",
      })}
    </p>}
    <div className="dock-scm-commit-split">
      <button type="submit" className="dock-scm-commit-button"
        disabled={commitBlocked} title={title}>
        {committing && <ProgressSpinner size={14} aria-hidden="true" />}
        <span>
          {`${verb} ${countText}${branchName ? "to " : ""}`}
          {branchName ? <strong>{branchName}</strong> : null}
        </span>
      </button>
    </div>
  </form>;
}
