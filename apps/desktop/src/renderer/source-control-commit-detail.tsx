import { ArrowLeft, Check, Copy } from 'lucide-react';
import { t, uiFormatLocale } from './i18n';
import type { DesktopGitCommitDetails, DesktopGitCommitFile } from '../shared/contract';
import { GitFileDiff } from './ReviewPane';
import { ScmPathText } from './ScmPathText';
import { ScmStatusIcon, scmStatusKind } from './ScmStatusIcon';
import { EMPTY_SUMMARY, UNKNOWN_AUTHOR, type SourceControlDiffRequest } from './source-control-support';
import { fileBaseName } from './text-format';

/** Compact `YYYY-MM-DD HH:mm` for the byline; the full locale string stays
 *  in the tooltip. Falls back to the raw value when git gave no ISO date. */
function formatCommitDate(iso: string): string {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return iso;
  const pad = (value: number) => String(value).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

function copyStatusText(copyState: { ok: boolean } | null | undefined): string {
  if (!copyState) return '';
  return copyState.ok ? 'Full SHA copied to the clipboard' : 'Could not copy the SHA to the clipboard';
}

function copyButtonTitle(copyState: { ok: boolean } | null | undefined): string {
  if (!copyState) return t('Copy the full SHA');
  return copyState.ok ? t('Copied') : t('Copy failed');
}

function commitPatchBody(patch: string | null | undefined) {
  if (patch === undefined || patch === null) return <p>{t('Loading diff…')}</p>;
  if (patch.startsWith('Error:')) return <p>{patch}</p>;
  if (patch) return <GitFileDiff patch={patch} mode="unified" />;
  return <p>{t('No textual diff.')}</p>;
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
  onOpenDiff?: (projectPath: string, relPath: string, request: SourceControlDiffRequest) => void;
  onBack(): void;
  onCopySha(hash: string): Promise<void>;
  onToggleFile(file: DesktopGitCommitFile): Promise<void>;
}) {
  const detailFiles = detail?.files ?? [];
  const detailSummary = (detail?.subject ?? '').trim();
  const headline = detail ? detailSummary || EMPTY_SUMMARY : 'Loading commit…';
  const detailAuthor = (detail?.author ?? '').trim();
  const copyState = detail && shaCopy?.hash === detail.hash ? shaCopy : null;

  return (
    <div className="dock-scm-history dock-scm-commit-detail">
      {/* ONE header block: the subject over a plain `author · date · sha`
        byline, with the action cluster (copy SHA, back) pinned to the
        subject's FIRST line on the right — two distinct glyphs side by side,
        never a lone chevron floating between the lines. */}
      <header className="dock-scm-commit-header">
        <div className="dock-scm-commit-headline">
          <b title={headline} data-empty={detail && !detailSummary ? true : undefined}>
            {headline}
          </b>
          {detail && (
            <div className="dock-scm-commit-meta">
              <span className="dock-scm-commit-author" title={detail.email}>
                <span>{detailAuthor || UNKNOWN_AUTHOR}</span>
              </span>
              <time dateTime={detail.authoredAt} title={new Date(detail.authoredAt).toLocaleString(uiFormatLocale())}>
                {formatCommitDate(detail.authoredAt)}
              </time>
              <span className="dock-scm-commit-sha" title={detail.hash}>
                <code>{detail.shortHash}</code>
              </span>
            </div>
          )}
        </div>
        <span className="dock-scm-copy-status" role="status" aria-live="polite">
          {copyStatusText(copyState)}
        </span>
        <div className="dock-scm-commit-actions">
          {detail && (
            <button
              type="button"
              className="dock-scm-commit-action"
              aria-label={t('Copy the full SHA')}
              title={copyButtonTitle(copyState)}
              onClick={() => void onCopySha(detail.hash)}
            >
              {copyState?.ok ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
            </button>
          )}
          <button
            type="button"
            className="dock-scm-commit-action dock-scm-commit-back"
            aria-label={t('Back to commit history')}
            title={t('Back to commit history')}
            onClick={onBack}
          >
            <ArrowLeft size={14} aria-hidden="true" />
          </button>
        </div>
      </header>
      {detailFiles.map((file) => {
        const open = openCommitFile === file.path;
        const patch = commitDiffs[file.path];
        const fileName = fileBaseName(file.path);
        const oldFileName = file.oldPath ? fileBaseName(file.oldPath) : '';
        const displayName = file.oldPath ? `${oldFileName} → ${fileName}` : fileName;
        return (
          <section className="dock-scm-commit-file" data-open={open || undefined} key={file.path}>
            <button
              type="button"
              className="dock-scm-commit-file-row"
              title={file.path}
              aria-expanded={onOpenDiff ? undefined : open}
              onClick={() => {
                if (onOpenDiff) {
                  onOpenDiff(projectPath, file.path, {
                    source: 'commit',
                    hash: selectedCommit,
                  });
                } else {
                  void onToggleFile(file);
                }
              }}
            >
              {/* Same row as the Changes list: the path, then ONE trailing
              status icon — no +/− counts. */}
              <ScmPathText path={file.path} name={displayName} />
              <ScmStatusIcon kind={scmStatusKind(file.status)} className="dock-scm-file-state" />
            </button>
            {open && <div className="dock-scm-commit-diff">{commitPatchBody(patch)}</div>}
          </section>
        );
      })}
      {detail && detailFiles.length === 0 && (
        <p className="utility-dock-empty">{t('No file changes in this commit.')}</p>
      )}
    </div>
  );
}
