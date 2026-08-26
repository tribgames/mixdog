import { Check, ChevronLeft, Copy, GitCommit } from "lucide-react";
import type {
  DesktopGitCommitDetails,
  DesktopGitCommitFile,
} from "../shared/contract";
import { GitFileDiff } from "./ReviewPane";
import { ScmPathText } from "./ScmPathText";
import { ScmStatusIcon, scmStatusKind } from "./ScmStatusIcon";
import {
  changedFilesLabel,
  EMPTY_SUMMARY,
  UNKNOWN_AUTHOR,
  type SourceControlDiffRequest,
} from "./source-control-support";

export function SourceControlCommitDetail({
  detail,
  selectedCommit,
  shaCopy,
  openCommitFile,
  commitDiffs,
  projectPath,
  onOpenDiff,
  onBack,
  onCopySha,
  onToggleFile,
}: {
  detail: DesktopGitCommitDetails | null;
  selectedCommit: string;
  shaCopy: { hash: string; ok: boolean } | null;
  openCommitFile: string;
  commitDiffs: Record<string, string | null>;
  projectPath: string;
  onOpenDiff?: (
    projectPath: string,
    relPath: string,
    request: SourceControlDiffRequest,
  ) => void;
  onBack(): void;
  onCopySha(hash: string): Promise<void>;
  onToggleFile(file: DesktopGitCommitFile): Promise<void>;
}) {
  const detailFiles = detail?.files ?? [];
  const additions = detailFiles.reduce((sum, file) => sum + file.additions, 0);
  const deletions = detailFiles.reduce((sum, file) => sum + file.deletions, 0);
  const detailSummary = (detail?.subject ?? "").trim();
  const headline = detail ? detailSummary || EMPTY_SUMMARY : "Loading commit…";
  const detailAuthor = (detail?.author ?? "").trim();
  const copyState = detail && shaCopy?.hash === detail.hash ? shaCopy : null;

  return <div className="dock-scm-history dock-scm-commit-detail">
    <header className="dock-scm-commit-header">
      <div className="dock-scm-commit-headline">
        <button type="button" className="dock-scm-commit-back"
          aria-label="Back to commit history" onClick={onBack}>
          <ChevronLeft size={14} aria-hidden="true" />
        </button>
        <b title={headline}
          data-empty={detail && !detailSummary ? true : undefined}>{headline}</b>
      </div>
      {detail && <div className="dock-scm-commit-meta">
        <span className="dock-scm-commit-author" title={detail.email}>
          <span>{detailAuthor || UNKNOWN_AUTHOR}</span>
        </span>
        <span className="dock-scm-commit-ref">
          <GitCommit size={12} aria-hidden="true" />
          <code>{detail.shortHash}</code>
          <button type="button" className="dock-scm-commit-copy"
            aria-label="Copy the full SHA"
            title={copyState ? copyState.ok ? "Copied" : "Copy failed" : "Copy the full SHA"}
            onClick={() => void onCopySha(detail.hash)}>
            {copyState?.ok
              ? <Check size={12} aria-hidden="true" />
              : <Copy size={12} aria-hidden="true" />}
          </button>
          <span className="dock-scm-copy-status" role="status" aria-live="polite">
            {copyState
              ? copyState.ok
                ? "Full SHA copied to the clipboard"
                : "Could not copy the SHA to the clipboard"
              : ""}
          </span>
        </span>
        <span className="dock-scm-commit-lines">
          <i>+{additions}</i><em>−{deletions}</em>
        </span>
        <time dateTime={detail.authoredAt}>
          {new Date(detail.authoredAt).toLocaleString()}
        </time>
      </div>}
    </header>
    {detail && <div className="dock-scm-commit-files-header">
      {changedFilesLabel(detailFiles.length, detailFiles.length)}
    </div>}
    {detailFiles.map((file) => {
      const open = openCommitFile === file.path;
      const patch = commitDiffs[file.path];
      return <section className="dock-scm-commit-file"
        data-open={open || undefined} key={file.path}>
        <button type="button" className="dock-scm-commit-file-row"
          aria-expanded={onOpenDiff ? undefined : open} onClick={() => {
            if (onOpenDiff) {
              onOpenDiff(projectPath, file.path, {
                source: "commit",
                hash: selectedCommit,
              });
            } else {
              void onToggleFile(file);
            }
          }}>
          <ScmPathText title={file.path}
            path={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path} />
          <small className="dock-scm-commit-file-lines">
            {file.additions > 0 && <i>+{file.additions}</i>}
            {file.deletions > 0 && <em>-{file.deletions}</em>}
          </small>
          <ScmStatusIcon kind={scmStatusKind(file.status)} size={12} />
        </button>
        {open && <div className="dock-scm-commit-diff">
          {patch === undefined || patch === null
            ? <p>Loading diff…</p>
            : patch.startsWith("Error:")
              ? <p>{patch}</p>
              : patch
                ? <GitFileDiff patch={patch} mode="unified" />
                : <p>No textual diff.</p>}
        </div>}
      </section>;
    })}
    {detail && detailFiles.length === 0 &&
      <p className="utility-dock-empty">No file changes in this commit.</p>}
  </div>;
}
