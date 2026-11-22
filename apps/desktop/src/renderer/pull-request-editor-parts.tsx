// Pull request editor parts: the detail loader and the three tab panels.
import { useCallback, useEffect, useState } from 'react';
import { MessageSquare } from 'lucide-react';
import type { DesktopPullRequestDetail } from '../shared/contract';
import { errorMessage } from './editor-pane-session-errors';
import { t } from './i18n';
import { GithubReviewForm } from './github/GithubReviewForm';
import { GitFileDiff } from './ReviewPane';
import { ScmPathText } from './ScmPathText';
import { ScmStatusIcon } from './ScmStatusIcon';
import {
  AuthorIcon,
  prFileStatusKind,
  relativeAge,
  reviewDecisionLabel,
  reviewDecisionTone,
  reviewerStateLabel,
  splitPrDiff,
} from './pull-requests-model';
import { emptyStateHost } from './empty-state-host';

/** The pull request's detail, its per-file diffs and the checked-out branch,
 *  reloaded when eload is called or an action run through un succeeds. */
export function usePullRequestDetail(projectPath: string, number: number, active: boolean) {
  const api = window.mixdogDesktop;
  const [detail, setDetail] = useState<DesktopPullRequestDetail | null>(null);
  const [detailError, setDetailError] = useState('');
  const [diffs, setDiffs] = useState<Map<string, string> | null>(null);
  const [currentBranch, setCurrentBranch] = useState('');
  const [openFile, setOpenFile] = useState('');
  const [busy, setBusy] = useState('');
  const [refresh, setRefresh] = useState(0);
  const reload = useCallback(() => setRefresh((value) => value + 1), []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: api and refresh are deliberate triggers; a new api or a bumped refresh counter must reload the detail.
  useEffect(() => {
    if (!active || !projectPath || !number) return undefined;
    let live = true;
    setDetail(null);
    setDetailError('');
    setDiffs(null);
    setOpenFile('');
    void (async () => {
      try {
        const [prDetail, diffText, branches] = await Promise.all([
          api?.ghPrView?.(projectPath, number),
          api?.ghPrDiff?.(projectPath, number).catch(() => ''),
          api?.gitBranches?.(projectPath).catch(() => []),
        ]);
        if (!live) return;
        setDetail(prDetail ?? null);
        setDiffs(splitPrDiff(diffText ?? ''));
        setCurrentBranch((branches ?? []).find((branch) => branch.current)?.name ?? '');
      } catch (cause) {
        if (live) setDetailError(errorMessage(cause));
      }
    })();
    return () => {
      live = false;
    };
  }, [active, api, number, projectPath, refresh]);

  const run = useCallback(
    async (key: string, action: () => Promise<unknown> | undefined) => {
      setBusy(key);
      try {
        await action();
        setDetailError('');
        reload();
      } catch (cause) {
        setDetailError(errorMessage(cause));
      } finally {
        setBusy('');
      }
    },
    [reload]
  );
  return { detail, detailError, diffs, currentBranch, openFile, setOpenFile, busy, run, reload };
}

export function PullRequestConversationPanel({
  detail,
  projectPath,
  number,
  active,
  onSubmitted,
}: {
  detail: DesktopPullRequestDetail;
  projectPath: string;
  number: number;
  active: boolean;
  onSubmitted(): void;
}) {
  return (
    <div className="dock-pr-panel dock-pr-conversation-panel" role="tabpanel" data-pr-detail-panel="conversation">
      <section className="dock-pr-description">
        <header>
          <AuthorIcon login={detail.author} />
          <b>@{detail.author}</b>
          <span>{t('opened this pull request {{time}} ago', { time: relativeAge(detail.createdAt) })}</span>
        </header>
        <div className="dock-pr-body">{detail.body.trim() || t('No description provided.')}</div>
      </section>
      {detail.labels.length > 0 && (
        // biome-ignore lint/a11y/useAriaPropsSupportedByRole: the label list is a named visual group; its tag and role are left unchanged.
        <div className="dock-pr-labels" aria-label={t('Labels')}>
          {detail.labels.map((label) => (
            <span key={label}>{label}</span>
          ))}
        </div>
      )}
      <section className="dock-pr-section">
        <header>
          <MessageSquare size={14} aria-hidden="true" />
          <b>{t('Conversation')}</b>
          <span>{detail.timeline.length}</span>
        </header>
        {detail.timeline.length > 0 ? (
          <div className="dock-pr-timeline">
            {detail.timeline.map((item, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: timeline entries are fetched in order and never reorder; createdAt alone can repeat.
              <article className="dock-pr-comment" key={`${item.createdAt}:${index}`}>
                <img src={`https://github.com/${encodeURIComponent(item.author)}.png?size=32`} alt="" />
                <div>
                  <header>
                    <b>{item.author}</b>
                    {item.state === 'APPROVED' && <em data-state="APPROVED">{t('approved')}</em>}
                    {item.state === 'CHANGES_REQUESTED' && (
                      <em data-state="CHANGES_REQUESTED">{t('requested changes')}</em>
                    )}
                    {item.state === 'COMMENTED' && <em>{t('commented')}</em>}
                    <i>{t('{{time}} ago', { time: relativeAge(item.createdAt) })}</i>
                  </header>
                  {item.body && <p>{item.body}</p>}
                </div>
              </article>
            ))}
          </div>
        ) : (
          <div className="dock-pr-empty-row mx-empty-state" ref={emptyStateHost}>
            {t('No conversation yet.')}
          </div>
        )}
      </section>
      {detail.state === 'OPEN' && (
        <GithubReviewForm
          key={`${projectPath}:${number}`}
          projectPath={projectPath}
          number={number}
          url={detail.url}
          active={active}
          onSubmitted={onSubmitted}
        />
      )}
    </div>
  );
}

export function PullRequestChecksPanel({ detail }: { detail: DesktopPullRequestDetail }) {
  let checksTone: 'pending' | 'failing' | 'passing' = 'passing';
  if (detail.checks.pending > 0) checksTone = 'pending';
  else if (detail.checks.failing > 0) checksTone = 'failing';
  let checksLabel = t('All checks passing');
  if (detail.checks.total === 0) checksLabel = t('No checks reported');
  else if (detail.checks.failing > 0) checksLabel = t('{{count}} checks failing', { count: detail.checks.failing });
  else if (detail.checks.pending > 0) checksLabel = t('{{count}} checks pending', { count: detail.checks.pending });
  return (
    <div className="dock-pr-panel dock-pr-checks-panel" role="tabpanel" data-pr-detail-panel="checks">
      <section className="dock-pr-check-card">
        <header>
          <span className="dock-pr-check-state" data-checks={checksTone} aria-hidden="true" />
          <div>
            <b>{checksLabel}</b>
            <small>
              {detail.checks.total > 0
                ? t('{{passing}} of {{total}} completed successfully', {
                    passing: detail.checks.passing,
                    total: detail.checks.total,
                  })
                : t('This pull request has no reported checks yet.')}
            </small>
          </div>
        </header>
        <div className="dock-pr-check-grid">
          <span>
            <b>{detail.checks.total}</b>
            <small>{t('Total')}</small>
          </span>
          <span>
            <b>{detail.checks.passing}</b>
            <small>{t('Passing')}</small>
          </span>
          <span>
            <b>{detail.checks.pending}</b>
            <small>{t('Pending')}</small>
          </span>
          <span>
            <b>{detail.checks.failing}</b>
            <small>{t('Failing')}</small>
          </span>
        </div>
      </section>
      <section className="dock-pr-section">
        <header>
          <b>{t('Reviewers')}</b>
          <span>{detail.reviewers.length}</span>
        </header>
        {detail.reviewers.length > 0 ? (
          <div className="dock-pr-reviewers">
            {detail.reviewers.map((reviewer) => (
              <span
                className="dock-pr-reviewer"
                data-state={reviewer.state}
                key={reviewer.login}
                title={reviewerStateLabel(reviewer.state)}
              >
                <img src={`https://github.com/${encodeURIComponent(reviewer.login)}.png?size=32`} alt="" />
                <span>
                  <b>{reviewer.login}</b>
                  <small>{reviewer.state.toLocaleLowerCase().replaceAll('_', ' ')}</small>
                </span>
              </span>
            ))}
          </div>
        ) : (
          <div className="dock-pr-empty-row mx-empty-state" ref={emptyStateHost}>
            {t('No reviewers requested.')}
          </div>
        )}
        {detail.reviewDecision && (
          <p className="dock-pr-review-decision" data-checks={reviewDecisionTone(detail.reviewDecision)}>
            {reviewDecisionLabel(detail.reviewDecision)}
          </p>
        )}
      </section>
    </div>
  );
}

export function PullRequestFilesPanel({
  detail,
  diffs,
  openFile,
  onOpenFile,
}: {
  detail: DesktopPullRequestDetail;
  diffs: Map<string, string> | null;
  openFile: string;
  onOpenFile(path: string): void;
}) {
  return (
    <div className="dock-pr-files-panel" role="tabpanel" data-pr-detail-panel="files">
      <header className="dock-pr-files-summary">
        <div>
          <b>{t('Files changed')}</b>
          <small>{t('{{count}} files', { count: detail.changedFiles })}</small>
        </div>
        <span>
          {detail.additions > 0 && <i>+{detail.additions}</i>}
          {detail.deletions > 0 && <em>-{detail.deletions}</em>}
        </span>
      </header>
      <section className="dock-pr-files" data-group="pr-files">
        {detail.files.map((file) => {
          const patch = diffs?.get(file.path);
          const open = openFile === file.path;
          return (
            <section className="dock-scm-commit-file" data-open={open || undefined} key={file.path}>
              <button
                type="button"
                className="dock-scm-commit-file-row"
                aria-expanded={open}
                onClick={() => onOpenFile(open ? '' : file.path)}
              >
                {/* Same one-sentence path grammar as the dock's other two
          file lists. */}
                <ScmPathText path={file.path} title={file.path} />
                {/* Fixed right-aligned count column, same as the dock's
          commit-detail rows: the path keeps the rest of the width. */}
                <small className="dock-scm-commit-file-lines">
                  {file.additions > 0 && <i>+{file.additions}</i>}
                  {file.deletions > 0 && <em>-{file.deletions}</em>}
                </small>
                {/* ONE trailing control: the status icon, same grammar as the
          dock's other two file lists. */}
                <ScmStatusIcon kind={prFileStatusKind(patch)} size={12} />
              </button>
              {open && (
                <div className="dock-scm-commit-diff">
                  {patch ? (
                    <GitFileDiff patch={patch} mode="unified" />
                  ) : (
                    <p className="mx-empty-state" ref={emptyStateHost}>
                      {t('No textual diff.')}
                    </p>
                  )}
                </div>
              )}
            </section>
          );
        })}
        {detail.files.length === 0 && (
          <div className="dock-pr-empty-row mx-empty-state" ref={emptyStateHost}>
            {t('0 changed files')}
          </div>
        )}
      </section>
    </div>
  );
}
