// Create-pull-request editor surface.
import { ArrowUpRight, Check, FileText, GitMerge, ListChecks, MessageSquare, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import type { DesktopPullRequestDetail } from '../shared/contract';
import { t } from './i18n';
import { ProgressSpinner } from './ProgressSpinner';
import { ErrorNotice } from './ErrorNotice';
import { GithubReviewForm } from './github/GithubReviewForm';
import { GitFileDiff } from './ReviewPane';
import { ScmPathText } from './ScmPathText';
import { ScmStatusIcon } from './ScmStatusIcon';
import {
  AuthorIcon,
  PULL_REQUEST_DETAIL_TABS,
  StateIcon,
  mergeActionLabel,
  mergeButtonLabel,
  prFileStatusKind,
  pullRequestStateLabel,
  relativeAge,
  reviewDecisionLabel,
  reviewDecisionTone,
  reviewerStateLabel,
  splitPrDiff,
} from './pull-requests-model';
import type { PullRequestDetailTab, PullRequestViewMode } from './pull-requests-model';

export function PullRequestEditor({
  projectPath,
  number,
  mode,
  active = true,
}: {
  projectPath: string;
  number: number;
  mode: PullRequestViewMode;
  active?: boolean;
}) {
  const api = window.mixdogDesktop;
  const [detail, setDetail] = useState<DesktopPullRequestDetail | null>(null);
  const [detailError, setDetailError] = useState('');
  const [diffs, setDiffs] = useState<Map<string, string> | null>(null);
  const [currentBranch, setCurrentBranch] = useState('');
  const [openFile, setOpenFile] = useState('');
  const [detailTab, setDetailTab] = useState<PullRequestDetailTab>(mode === 'changes' ? 'files' : 'conversation');
  const [busy, setBusy] = useState('');
  const [mergeMethod, setMergeMethod] = useState<'merge' | 'squash' | 'rebase'>('merge');
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    setDetailTab(mode === 'changes' ? 'files' : 'conversation');
  }, [mode, number]);

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
        if (live) setDetailError(cause instanceof Error ? cause.message : String(cause));
      }
    })();
    return () => {
      live = false;
    };
  }, [active, api, number, projectPath, refresh]);

  const run = useCallback(async (key: string, action: () => Promise<unknown> | undefined) => {
    setBusy(key);
    try {
      await action();
      setDetailError('');
      setRefresh((value) => value + 1);
    } catch (cause) {
      setDetailError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy('');
    }
  }, []);
  const checkedOut = Boolean(detail && currentBranch && detail.headRefName === currentBranch);
  let checksTone: 'pending' | 'failing' | 'passing' = 'passing';
  if (!detail || detail.checks.pending > 0) checksTone = 'pending';
  else if (detail.checks.failing > 0) checksTone = 'failing';
  let checksLabel = t('All checks passing');
  if (!detail || detail.checks.total === 0) checksLabel = t('No checks reported');
  else if (detail.checks.failing > 0) checksLabel = t('{{count}} checks failing', { count: detail.checks.failing });
  else if (detail.checks.pending > 0) checksLabel = t('{{count}} checks pending', { count: detail.checks.pending });

  return (
    <div className="workspace-pr-editor dock-pr-detail" data-mode={mode}>
      <header className="workspace-pr-editor-header">
        <div className="workspace-pr-editor-title-row">
          <h1>
            {detail?.title || `Pull Request #${number}`}
            {detail && <small>#{detail.number}</small>}
          </h1>
          <span className="workspace-pr-editor-header-actions">
            <button
              type="button"
              aria-label={t('Refresh pull request')}
              disabled={Boolean(busy)}
              data-tooltip={t('Refresh pull request')}
              onClick={() => setRefresh((value) => value + 1)}
            >
              <RefreshCw size={14} className={!detail && !detailError ? 'spin' : undefined} aria-hidden="true" />
            </button>
            <button
              type="button"
              aria-label={t('Open pull request on GitHub')}
              disabled={!detail?.url}
              data-tooltip={t('Open on GitHub')}
              onClick={() => {
                if (detail?.url) void api?.openExternal?.(detail.url);
              }}
            >
              <ArrowUpRight size={14} aria-hidden="true" />
            </button>
          </span>
        </div>
        {detail && (
          <>
            <div className="dock-pr-editor-meta">
              <span className="dock-pr-badge" data-state={detail.isDraft ? 'DRAFT' : detail.state}>
                <StateIcon pr={detail} />
                {pullRequestStateLabel(detail)}
              </span>
              <span className="dock-pr-author">
                <AuthorIcon login={detail.author} />
                <b>@{detail.author}</b>
              </span>
              <span className="dock-pr-refs">
                <code>{detail.baseRefName}</code> ← <code>{detail.headRefName}</code>
              </span>
              <span className="dock-pr-updated">
                {t('updated {{time}} ago', { time: relativeAge(detail.updatedAt) })}
              </span>
            </div>
            <div className="dock-pr-actions dock-pr-header-actions">
              <button
                type="button"
                disabled={Boolean(busy) || checkedOut}
                onClick={() => void run('checkout', () => api?.ghPrCheckout?.(projectPath, detail.number))}
              >
                {busy === 'checkout' ? (
                  <ProgressSpinner size={14} aria-hidden="true" />
                ) : (
                  <Check size={14} aria-hidden="true" />
                )}
                {checkedOut ? t('Checked Out') : t('Checkout')}
              </button>
              {detail.state === 'OPEN' && !detail.isDraft && (
                <span className="dock-pr-merge">
                  <button
                    type="button"
                    disabled={Boolean(busy)}
                    onClick={() => {
                      const action = mergeActionLabel(mergeMethod);
                      if (!window.confirm(t('{{action}} pull request #{{number}}?', { action, number: detail.number })))
                        return;
                      void run('merge', () => api?.ghPrMerge?.(projectPath, detail.number, mergeMethod));
                    }}
                  >
                    {busy === 'merge' ? (
                      <ProgressSpinner size={14} aria-hidden="true" />
                    ) : (
                      <GitMerge size={14} aria-hidden="true" />
                    )}
                    {mergeButtonLabel(mergeMethod)}
                  </button>
                  <select
                    aria-label={t('Merge method')}
                    value={mergeMethod}
                    disabled={Boolean(busy)}
                    onChange={(event) => setMergeMethod(event.currentTarget.value as typeof mergeMethod)}
                  >
                    <option value="merge">{t('Create a merge commit')}</option>
                    <option value="squash">{t('Squash and merge')}</option>
                    <option value="rebase">{t('Rebase and merge')}</option>
                  </select>
                </span>
              )}
            </div>
          </>
        )}
      </header>
      <div
        className="dock-pr-detail-tabs"
        role="tablist"
        aria-label={t('Pull request details')}
        onKeyDown={(event) => {
          if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
          event.preventDefault();
          const currentIndex = PULL_REQUEST_DETAIL_TABS.indexOf(detailTab);
          const step = event.key === 'ArrowRight' ? 1 : -1;
          let nextIndex = (currentIndex + step + PULL_REQUEST_DETAIL_TABS.length) % PULL_REQUEST_DETAIL_TABS.length;
          if (event.key === 'Home') nextIndex = 0;
          else if (event.key === 'End') nextIndex = PULL_REQUEST_DETAIL_TABS.length - 1;
          const nextTab = PULL_REQUEST_DETAIL_TABS[nextIndex];
          setDetailTab(nextTab);
          requestAnimationFrame(() =>
            document.querySelector<HTMLButtonElement>(`[data-pr-detail-tab="${nextTab}"]`)?.focus()
          );
        }}
      >
        <button
          type="button"
          role="tab"
          data-pr-detail-tab="conversation"
          aria-selected={detailTab === 'conversation'}
          tabIndex={detailTab === 'conversation' ? 0 : -1}
          onClick={() => setDetailTab('conversation')}
        >
          <MessageSquare size={14} aria-hidden="true" /> {t('Conversation')}
          {detail && <small>{detail.timeline.length}</small>}
        </button>
        <button
          type="button"
          role="tab"
          data-pr-detail-tab="checks"
          aria-selected={detailTab === 'checks'}
          tabIndex={detailTab === 'checks' ? 0 : -1}
          onClick={() => setDetailTab('checks')}
        >
          <ListChecks size={14} aria-hidden="true" /> {t('Checks')}
          {detail && <small>{detail.checks.total}</small>}
        </button>
        <button
          type="button"
          role="tab"
          data-pr-detail-tab="files"
          aria-selected={detailTab === 'files'}
          tabIndex={detailTab === 'files' ? 0 : -1}
          onClick={() => setDetailTab('files')}
        >
          <FileText size={14} aria-hidden="true" /> {t('Files changed')}
          {detail && <small>{detail.changedFiles}</small>}
        </button>
      </div>
      <div className="workspace-pr-editor-scroll">
        {detailError && <ErrorNotice error={detailError} onRetry={() => setRefresh((value) => value + 1)} />}
        {!detail && !detailError && (
          <p className="utility-dock-empty">
            <ProgressSpinner size={14} aria-hidden="true" /> {t('Loading pull request…')}
          </p>
        )}
        {detail && (
          <>
            {detailTab === 'conversation' && (
              <div
                className="dock-pr-panel dock-pr-conversation-panel"
                role="tabpanel"
                data-pr-detail-panel="conversation"
              >
                <section className="dock-pr-description">
                  <header>
                    <AuthorIcon login={detail.author} />
                    <b>@{detail.author}</b>
                    <span>{t('opened this pull request {{time}} ago', { time: relativeAge(detail.createdAt) })}</span>
                  </header>
                  <div className="dock-pr-body">{detail.body.trim() || t('No description provided.')}</div>
                </section>
                {detail.labels.length > 0 && (
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
                    <div className="dock-pr-empty-row">{t('No conversation yet.')}</div>
                  )}
                </section>
                {detail.state === 'OPEN' && (
                  <GithubReviewForm
                    key={`${projectPath}:${number}`}
                    projectPath={projectPath}
                    number={number}
                    url={detail.url}
                    active={active}
                    onSubmitted={() => setRefresh((value) => value + 1)}
                  />
                )}
              </div>
            )}
            {detailTab === 'checks' && (
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
                    <div className="dock-pr-empty-row">{t('No reviewers requested.')}</div>
                  )}
                  {detail.reviewDecision && (
                    <p className="dock-pr-review-decision" data-checks={reviewDecisionTone(detail.reviewDecision)}>
                      {reviewDecisionLabel(detail.reviewDecision)}
                    </p>
                  )}
                </section>
              </div>
            )}
            {detailTab === 'files' && (
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
                          onClick={() => setOpenFile(open ? '' : file.path)}
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
                            {patch ? <GitFileDiff patch={patch} mode="unified" /> : <p>{t('No textual diff.')}</p>}
                          </div>
                        )}
                      </section>
                    );
                  })}
                  {detail.files.length === 0 && <div className="dock-pr-empty-row">{t('0 changed files')}</div>}
                </section>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
