import { Check, ChevronLeft, Copy, GitCommit } from "lucide-react";
import type {
  DesktopGitCommitDetails,
  DesktopGitCommitFile,
} from "../shared/contract";
import { GitFileDiff } from "./ReviewPane";
import { ScmPathText } from "./ScmPathText";
import {
  EMPTY_SUMMARY,
  UNKNOWN_AUTHOR,
  type SourceControlDiffRequest,
} from "./source-control-support";

/** Compact `YYYY-MM-DD HH:mm` for the byline; the full locale string stays
 *  in the tooltip. Falls back to the raw value when git gave no ISO date. */
function formatCommitDate(iso: string): string {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return iso;
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

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
    {/* Two-tier header: a toolbar strip (back button, then the short SHA with
        its copy control and the +adds/−dels totals trailing) over the subject
        and an `author · date` byline that gets the full width. */}
    <header className="dock-scm-commit-header">
      <div className="dock-scm-commit-toolbar">
        <button type="button" className="dock-scm-commit-back"
          aria-label="Back to commit history" onClick={onBack}>
          <ChevronLeft size={14} aria-hidden="true" />
        </button>
        {detail && <span className="dock-scm-commit-ref">
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
        </span>}
        {detail && <span className="dock-scm-commit-lines"
          title={`+${additions.toLocaleString()} additions, −${deletions.toLocaleString()} deletions`}>
          <i>+{additions.toLocaleString()}</i><em>−{deletions.toLocaleString()}</em>
        </span>}
      </div>
      <div className="dock-scm-commit-headline">
        <b title={headline}
          data-empty={detail && !detailSummary ? true : undefined}>{headline}</b>
        {detail && <div className="dock-scm-commit-meta">
          <span className="dock-scm-commit-author" title={detail.email}>
            <span>{detailAuthor || UNKNOWN_AUTHOR}</span>
          </span>
          <time dateTime={detail.authoredAt} title={new Date(detail.authoredAt).toLocaleString()}>
            {formatCommitDate(detail.authoredAt)}
          </time>
        </div>}
      </div>
    </header>
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
          {/* No status glyph here: with no checkbox column the square icon
              only doubled the +/− signs of the counts beside it. */}
          <small className="dock-scm-commit-file-lines"
            title={`${file.additions} additions, ${file.deletions} deletions`}>
            {file.additions > 0 && <i>+{file.additions}</i>}
            {file.deletions > 0 && <em>−{file.deletions}</em>}
          </small>
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
