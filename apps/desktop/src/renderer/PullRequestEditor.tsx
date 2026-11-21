// Pull request editor surface: overview, conversation, files and checks.
import { ArrowUpRight, Check, FileText, GitMerge, ListChecks, MessageSquare, RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { confirmAction } from './app-confirm';
import { t } from './i18n';
import { ProgressSpinner } from './ProgressSpinner';
import { ErrorNotice } from './ErrorNotice';
import {
  PullRequestChecksPanel,
  PullRequestConversationPanel,
  PullRequestFilesPanel,
  usePullRequestDetail,
} from './pull-request-editor-parts';
import {
  AuthorIcon,
  PULL_REQUEST_DETAIL_TABS,
  StateIcon,
  mergeActionLabel,
  mergeButtonLabel,
  pullRequestStateLabel,
  relativeAge,
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
  const { detail, detailError, diffs, currentBranch, openFile, setOpenFile, busy, run, reload } = usePullRequestDetail(
    projectPath,
    number,
    active
  );
  const api = window.mixdogDesktop;
  const [detailTab, setDetailTab] = useState<PullRequestDetailTab>(mode === 'changes' ? 'files' : 'conversation');
  const [mergeMethod, setMergeMethod] = useState<'merge' | 'squash' | 'rebase'>('merge');

  // biome-ignore lint/correctness/useExhaustiveDependencies: opening a different pull request must reset the tab, so `number` is a deliberate trigger.
  useEffect(() => {
    setDetailTab(mode === 'changes' ? 'files' : 'conversation');
  }, [mode, number]);

  const checkedOut = Boolean(detail && currentBranch && detail.headRefName === currentBranch);

  return (
    <div className="workspace-pr-editor dock-pr-detail" data-mode={mode}>
      <header className="workspace-pr-editor-header">
        <div className="workspace-pr-editor-title-row">
          <h1>
            {detail?.title || t('Pull Request #{{number}}', { number })}
            {detail && <small>#{detail.number}</small>}
          </h1>
          <span className="workspace-pr-editor-header-actions">
            <button
              type="button"
              aria-label={t('Refresh pull request')}
              disabled={Boolean(busy)}
              data-tooltip={t('Refresh pull request')}
              onClick={() => reload()}
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
                      void confirmAction(t('{{action}} pull request #{{number}}?', { action, number: detail.number }), {
                        confirmLabel: action,
                      }).then((approved) => {
                        if (approved)
                          return run('merge', () => api?.ghPrMerge?.(projectPath, detail.number, mergeMethod));
                      });
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
        {detailError && <ErrorNotice error={detailError} onRetry={() => reload()} />}
        {!detail && !detailError && (
          <p className="utility-dock-empty mx-empty-state">
            <ProgressSpinner size={14} aria-hidden="true" /> {t('Loading pull request…')}
          </p>
        )}
        {detail && (
          <>
            {detailTab === 'conversation' && (
              <PullRequestConversationPanel
                detail={detail}
                projectPath={projectPath}
                number={number}
                active={active}
                onSubmitted={reload}
              />
            )}
            {detailTab === 'checks' && <PullRequestChecksPanel detail={detail} />}
            {detailTab === 'files' && (
              <PullRequestFilesPanel detail={detail} diffs={diffs} openFile={openFile} onOpenFile={setOpenFile} />
            )}
          </>
        )}
      </div>
    </div>
  );
}
