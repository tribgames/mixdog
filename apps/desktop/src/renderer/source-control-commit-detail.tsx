import { Check, ChevronLeft, Copy } from "lucide-react";
import type {
  DesktopGitCommitDetails,
  DesktopGitCommitFile,
} from "../shared/contract";
import { GitFileDiff } from "./ReviewPane";
import { ScmPathText } from "./ScmPathText";
import { ScmStatusIcon, scmStatusKind } from "./ScmStatusIcon";
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
  const detailSummary = (detail?.subject ?? "").trim();
  const headline = detail ? detailSummary || EMPTY_SUMMARY : "Loading commit…";
  const detailAuthor = (detail?.author ?? "").trim();
  const copyState = detail && shaCopy?.hash === detail.hash ? shaCopy : null;

  return <div className="dock-scm-history dock-scm-commit-detail">
    {/* ONE header block: the subject over an `author · date · sha` byline
        (the SHA is the copy control), with the back button trailing on the
        right — the same one-row grammar as the Changes list's toolbar. */}
    <header className="dock-scm-commit-header">
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
          <span className="dock-scm-commit-sha">
            <button type="button" className="dock-scm-commit-ref"
              aria-label="Copy the full SHA"
              title={copyState ? copyState.ok ? "Copied" : "Copy failed" : "Copy the full SHA"}
              onClick={() => void onCopySha(detail.hash)}>
              <code>{detail.shortHash}</code>
              {copyState?.ok
                ? <Check size={11} aria-hidden="true" />
                : <Copy size={11} aria-hidden="true" />}
            </button>
          </span>
        </div>}
      </div>
      <span className="dock-scm-copy-status" role="status" aria-live="polite">
        {copyState
          ? copyState.ok
            ? "Full SHA copied to the clipboard"
            : "Could not copy the SHA to the clipboard"
          : ""}
      </span>
      <button type="button" className="dock-scm-commit-back"
        aria-label="Back to commit history" onClick={onBack}>
        <ChevronLeft size={14} aria-hidden="true" />
      </button>
    </header>
    {detailFiles.map((file) => {
      const open = openCommitFile === file.path;
      const patch = commitDiffs[file.path];
      const slash = file.path.lastIndexOf("/");
      const fileName = slash >= 0 ? file.path.slice(slash + 1) : file.path;
      const oldSlash = file.oldPath?.lastIndexOf("/") ?? -1;
      const oldFileName = file.oldPath
        ? oldSlash >= 0 ? file.oldPath.slice(oldSlash + 1) : file.oldPath
        : "";
      const displayName = file.oldPath ? `${oldFileName} → ${fileName}` : fileName;
      return <section className="dock-scm-commit-file"
        data-open={open || undefined} key={file.path}>
        <button type="button" className="dock-scm-commit-file-row"
          title={file.path}
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
          {/* Same row as the Changes list: the path, then ONE trailing
              status icon — no +/− counts. */}
          <ScmPathText path={file.path} name={displayName} />
          <ScmStatusIcon kind={scmStatusKind(file.status)} className="dock-scm-file-state" />
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
