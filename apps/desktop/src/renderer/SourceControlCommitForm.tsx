import type { KeyboardEvent } from "react";

import { ProgressSpinner } from "./ProgressSpinner";
import { t } from "./i18n";

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
  const committing = busy === "commit" || busy === "amend";
  const blocked = commitBlocked || !summary.trim();
  const branchName = detached ? "" : branch;
  const commitLabel = committing ? t("Committing…")
    : branchName
      ? selectedFileCount === 1
        ? t("Commit 1 file to {{branch}}", { branch: branchName })
        : selectedFileCount > 0
        ? t("Commit {{count}} files to {{branch}}", { count: selectedFileCount, branch: branchName })
        : t("Commit to {{branch}}", { branch: branchName })
      : selectedFileCount === 1
        ? t("Commit 1 file")
        : selectedFileCount > 0
        ? t("Commit {{count}} files", { count: selectedFileCount })
        : t("Commit");
  const title = !summary.trim()
      ? t("Summary (required)")
      : selectedFileCount === 0 && fileCount > 0
        ? t("Select one or more files to commit")
        : committing
          ? t("Committing changes…")
          : operation
            ? t("Finish the in-progress Git operation first")
            : conflictCount > 0
              ? t("Resolve conflicts before committing")
              : branchName ? t("Commit to {{branch}}", { branch: branchName }) : t("Commit");

  const submitOnAccelerator = (
    event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>,
  ) => {
    if (event.key !== "Enter" || !(event.ctrlKey || event.metaKey)) return;
    event.preventDefault();
    if (!blocked) event.currentTarget.form?.requestSubmit();
  };

  return <form className="dock-scm-commit" noValidate onSubmit={(event) => {
    event.preventDefault();
    if (!blocked) onCommit();
  }}>
    <input type="text" className="dock-scm-commit-summary" aria-label={t("Summary")}
      placeholder={t("Summary (required)")} value={summary} autoComplete="off"
      readOnly={committing}
      onInput={(event) => onSummaryChange(event.currentTarget.value)}
      onKeyDown={submitOnAccelerator} />
    <div className="dock-scm-commit-description-box">
      <textarea className="dock-scm-commit-description" aria-label={t("Description")}
        placeholder={t("Description")} value={description} rows={1} autoComplete="off"
        readOnly={committing}
        onInput={(event) => onDescriptionChange(event.currentTarget.value)}
        onKeyDown={submitOnAccelerator} />
    </div>
    <div className="dock-scm-commit-split">
      <button type="submit" className="dock-scm-commit-button"
        disabled={blocked} title={title}>
        {committing && <ProgressSpinner size={14} aria-hidden="true" />}
        <span>{commitLabel}</span>
      </button>
    </div>
  </form>;
}
