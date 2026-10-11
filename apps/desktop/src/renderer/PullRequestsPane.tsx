// Pull Requests dock surface with a compact filtered list
// for the dock, with the metadata and tab hierarchy in the editor.
// Data and actions are backed by the gh CLI IPC chain.

import { GitPullRequestArrow, Github, Plus, RefreshCw, Search, X } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import type { DesktopPullRequestEntry } from '../shared/contract';
import { t } from './i18n';
import { ProgressSpinner } from './ProgressSpinner';
import { OpenSelect } from './OpenSelect';
import { PullRequestCreateForm } from './PullRequestCreateForm';
import { PullRequestRow } from './PullRequestRow';
import { useSurfaceActive, useSurfaceNavigationReset } from './surface-activity';
import { RowOverflowMenu } from './RowOverflowMenu';
import { SourceControlErrorNotice } from './SourceControlErrorNotice';
import { usePullRequestList } from './use-pull-request-list';
import {
  PULL_REQUEST_LIST_VIEWS,
  buildPullRequestViews,
  preferredBaseBranch,
  pullRequestMatchesFilter,
  pullRequestsWebUrl,
  titleFromBranch,
} from './pull-requests-model';
import type { PullRequestListView, PullRequestOpenHandler, PullRequestViewMode } from './pull-requests-model';

export type { PullRequestOpenHandler } from './pull-requests-model';
export { PullRequestEditor } from './PullRequestEditor';

export function PullRequestsPane({
  projectPath,
  prUrl,
  repositoryUrl,
  currentBranch,
  createHint,
  headerSlot,
  onOpenPullRequest,
}: {
  projectPath: string;
  /** Hosted compare URL when the branch is pushed and PR-ready (else ""). */
  prUrl: string;
  /** Hosted repository page used by the view-title overflow actions. */
  repositoryUrl: string;
  currentBranch: string;
  /** Guidance when a PR cannot be created yet (publish/push first). */
  createHint: string;
  /** View/title action host owned by the utility dock header. */
  headerSlot?: HTMLElement | null;
  /** Opens the extension-style overview or changes surface in an editor group. */
  onOpenPullRequest?: PullRequestOpenHandler;
}) {
  const api = window.mixdogDesktop;
  const [actionError, setActionError] = useState('');
  const [listView, setListView] = useState<PullRequestListView>('open');
  const [filter, setFilter] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [createTitle, setCreateTitle] = useState('');
  const [createBody, setCreateBody] = useState('');
  const [createBase, setCreateBase] = useState('main');
  const [createDraft, setCreateDraft] = useState(false);
  const [createError, setCreateError] = useState('');
  const [busy, setBusy] = useState('');
  // The Dock retains this pane while another tab is presented. Retained is not
  // running: no ghPrList/gitBranches may be issued while inactive, and any
  // in-flight list is invalidated on deactivate or project change so a late
  // answer cannot repaint a surface the user has left. The rows already loaded
  // stay on screen, so re-entry is instant.
  const surfaceActive = useSurfaceActive();
  useSurfaceNavigationReset(surfaceActive, () => {
    setListView('open');
    setCreateOpen(false);
  });
  const { categories, readError, loading, localBranchNames, baseBranchNames, defaultBranchName, loadList } =
    usePullRequestList(api, projectPath, currentBranch, surfaceActive, () => {
      setActionError('');
      setListView('open');
      setFilter('');
      setCreateOpen(false);
      setCreateError('');
    });

  const run = useCallback(
    async (key: string, action: () => Promise<unknown> | undefined) => {
      setBusy(key);
      setActionError('');
      try {
        await action();
        await loadList();
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        setActionError(message);
      } finally {
        setBusy('');
      }
    },
    [loadList]
  );

  const refreshAll = useCallback(() => {
    void loadList();
  }, [loadList]);

  const pullRequestViews = useMemo(() => {
    if (categories === null) return null;
    return buildPullRequestViews(categories, localBranchNames);
  }, [categories, localBranchNames]);
  const visiblePullRequests = useMemo(
    () => (pullRequestViews?.[listView] ?? []).filter((entry) => pullRequestMatchesFilter(entry, filter)),
    [filter, listView, pullRequestViews]
  );

  const repositoryPullsUrl = useMemo(() => pullRequestsWebUrl(repositoryUrl), [repositoryUrl]);
  const defaultBaseBranch = defaultBranchName || preferredBaseBranch(baseBranchNames);
  const onDefaultBranch = Boolean(
    currentBranch && defaultBaseBranch && currentBranch.toLocaleLowerCase() === defaultBaseBranch.toLocaleLowerCase()
  );
  const beginCreatePullRequest = () => {
    setCreateTitle(titleFromBranch(currentBranch));
    setCreateBody('');
    setCreateBase(defaultBaseBranch);
    setCreateDraft(false);
    setCreateError('');
    setCreateOpen(true);
  };
  const cancelCreatePullRequest = () => {
    if (busy === 'create') return;
    setCreateOpen(false);
    setCreateError('');
  };
  const submitCreatePullRequest = async () => {
    const title = createTitle.trim();
    const base = createBase.trim();
    if (!title || !base || !currentBranch || base.toLocaleLowerCase() === currentBranch.toLocaleLowerCase()) return;
    if (!api?.ghPrCreate) {
      setCreateError('Pull request creation is unavailable in this host.');
      return;
    }
    setBusy('create');
    setCreateError('');
    try {
      if (!prUrl) {
        if (!api.gitPush) throw new Error(createHint || 'Publish or push this branch before creating a pull request.');
        await api.gitPush(projectPath);
      }
      const created = await api.ghPrCreate(projectPath, {
        base,
        head: currentBranch,
        title,
        body: createBody,
        draft: createDraft,
      });
      setCreateOpen(false);
      await loadList();
      onOpenPullRequest?.(projectPath, created, 'overview', false);
    } catch (cause) {
      setCreateError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy('');
    }
  };
  const openPullRequest = (
    pullRequest: DesktopPullRequestEntry,
    mode: PullRequestViewMode = 'overview',
    toSide = false
  ) => {
    if (onOpenPullRequest) {
      onOpenPullRequest(projectPath, pullRequest, mode, toSide);
      return;
    }
    if (pullRequest.url) void api?.openExternal?.(pullRequest.url);
  };
  const checkoutByNumber = () => {
    const raw = window.prompt(t('Pull request number'), '');
    if (raw === null) return;
    const match = /^#?(\d+)$/.exec(raw.trim());
    if (!match) {
      setActionError(t('Enter a valid pull request number.'));
      return;
    }
    const number = Number(match[1]);
    void run(`checkout:${number}`, () => api?.ghPrCheckout?.(projectPath, number));
  };
  const renderHeaderActions = () => {
    let createButtonTitle = t('Create pull request');
    if (onDefaultBranch) createButtonTitle = t('Create or check out a feature branch first.');
    else if (createHint) createButtonTitle = createHint;
    return (
      <>
        <button
          type="button"
          aria-label={t('Create pull request')}
          disabled={
            createOpen ||
            onDefaultBranch ||
            !currentBranch ||
            !api?.ghPrCreate ||
            (!prUrl && !api?.gitPush) ||
            Boolean(busy)
          }
          title={createButtonTitle}
          data-tooltip={createButtonTitle}
          onClick={beginCreatePullRequest}
        >
          <Plus size={14} aria-hidden="true" />
        </button>
        <button
          type="button"
          aria-label={t('Refresh pull requests')}
          disabled={loading || Boolean(busy)}
          data-tooltip={t('Refresh pull requests')}
          onClick={refreshAll}
        >
          <RefreshCw size={14} className={loading ? 'spin' : undefined} aria-hidden="true" />
        </button>
        <RowOverflowMenu
          label={t('More pull request actions')}
          items={[
            {
              id: 'open-github',
              label: t('Open Pull Requests on GitHub'),
              disabled: !repositoryPullsUrl,
              onSelect: () => {
                if (repositoryPullsUrl) void api?.openExternal?.(repositoryPullsUrl);
              },
            },
            {
              id: 'checkout',
              label: t('Checkout Pull Request…'),
              disabled: Boolean(busy) || !api?.ghPrCheckout,
              onSelect: checkoutByNumber,
            },
          ]}
        />
      </>
    );
  };
  const headerPortal = headerSlot ? createPortal(renderHeaderActions(), headerSlot) : null;
  const inlineHeader = !headerSlot && <div className="dock-pr-toolbar">{renderHeaderActions()}</div>;
  const viewLabels: Record<PullRequestListView, string> = {
    open: t('Open'),
    mine: t('Mine'),
    review: t('Review'),
  };
  const activeViewCount = pullRequestViews?.[listView].length ?? 0;
  let emptyTitle = t('No pull requests awaiting your review');
  let emptyMessage = t('Review requests assigned to you will appear here.');
  if (filter) {
    emptyTitle = t('No matching pull requests');
    emptyMessage = t('Try a different search.');
  } else if (listView === 'open') {
    emptyTitle = t('No open pull requests');
    if (onDefaultBranch) emptyMessage = t('Create or check out a feature branch to open a pull request.');
    else if (prUrl) emptyMessage = t('Create a pull request from the current branch.');
    else if (createHint) emptyMessage = createHint;
    else emptyMessage = t('This repository has no open pull requests.');
  } else if (listView === 'mine') {
    emptyTitle = t('No pull requests from you');
    emptyMessage = t('Pull requests you create or check out will appear here.');
  }
  const scopeOptions = PULL_REQUEST_LIST_VIEWS.map((view) => ({
    value: view,
    label: `${viewLabels[view]} (${pullRequestViews?.[view].length ?? 0})`,
  }));
  const createDisabled =
    !createTitle.trim() ||
    !createBase.trim() ||
    !currentBranch ||
    createBase.trim().toLocaleLowerCase() === currentBranch.toLocaleLowerCase() ||
    busy === 'create';

  return (
    <>
      {headerPortal}
      <div className="dock-pr-surface">
        {inlineHeader}
        {!createOpen && (
          <>
            <div className="dock-pr-view-controls workbench-explorer-search">
              <label className="dock-pr-search workbench-search-input">
                <Search size={14} aria-hidden="true" />
                <input
                  type="search"
                  value={filter}
                  aria-label={t('Filter pull requests')}
                  placeholder={t('Filter pull requests')}
                  onInput={(event) => setFilter(event.currentTarget.value)}
                />
                {filter && (
                  <button type="button" aria-label={t('Clear pull request filter')} onClick={() => setFilter('')}>
                    <X size={14} aria-hidden="true" />
                  </button>
                )}
              </label>
            </div>
            <div className="dock-pr-list-header">
              <OpenSelect
                className="dock-pr-scope-select"
                ariaLabel={t('Pull request list')}
                value={listView}
                options={scopeOptions}
                displayValue={`${viewLabels[listView]} ${t('pull requests')} · ${activeViewCount}`}
                onChange={(value) => setListView(value as PullRequestListView)}
              />
            </div>
          </>
        )}
        <div className="dock-scm-scroll dock-pr-list">
          {createOpen && (
            <PullRequestCreateForm
              currentBranch={currentBranch}
              title={createTitle}
              body={createBody}
              base={createBase}
              draft={createDraft}
              baseBranchNames={baseBranchNames}
              prUrl={prUrl}
              createHint={createHint}
              error={createError}
              creating={busy === 'create'}
              submitDisabled={createDisabled}
              onTitleChange={setCreateTitle}
              onBodyChange={setCreateBody}
              onBaseChange={setCreateBase}
              onDraftChange={setCreateDraft}
              onSubmit={() => void submitCreatePullRequest()}
              onCancel={cancelCreatePullRequest}
              onAuthenticationHelp={() => void api?.openExternal?.('https://cli.github.com/manual/gh_auth_login')}
            />
          )}
          {!createOpen && (
            <>
              {actionError && (
                <SourceControlErrorNotice
                  error={actionError}
                  className="dock-pr-error-state"
                  onAuthenticationHelp={() => void api?.openExternal?.('https://cli.github.com/manual/gh_auth_login')}
                  authenticationHelpLabel={t('GitHub CLI help')}
                />
              )}
              {categories === null && readError && (
                <div className="dock-pr-empty" role="status">
                  <Github size={24} aria-hidden="true" />
                  <b>{t('Pull requests are temporarily unavailable')}</b>
                  <span>{t('Refresh when the project is ready.')}</span>
                </div>
              )}
              {categories === null && !readError && (
                <p className="utility-dock-empty">
                  <ProgressSpinner size={14} aria-hidden="true" /> {t('Loading pull requests…')}
                </p>
              )}
              {pullRequestViews && visiblePullRequests.length === 0 && (
                <div className="dock-pr-empty" role="status">
                  <GitPullRequestArrow size={24} aria-hidden="true" />
                  <b>{emptyTitle}</b>
                  <span>{emptyMessage}</span>
                  {!filter && listView === 'open' && !onDefaultBranch && currentBranch && api?.ghPrCreate && (
                    <button type="button" onClick={beginCreatePullRequest}>
                      {t('Create pull request')}
                    </button>
                  )}
                </div>
              )}
              {pullRequestViews && visiblePullRequests.length > 0 && (
                // biome-ignore lint/a11y/useSemanticElements: tag must stay a div; <ul> would bring list styling into the results container.
                <div
                  className="dock-pr-results"
                  role="list"
                  aria-label={t('{{view}} pull requests', { view: viewLabels[listView] })}
                >
                  {visiblePullRequests.map((pr) => (
                    <PullRequestRow
                      key={pr.number}
                      pr={pr}
                      checkedOut={Boolean(currentBranch && pr.headRefName === currentBranch)}
                      busy={busy}
                      canCheckout={Boolean(api?.ghPrCheckout)}
                      onOpen={openPullRequest}
                      onCheckout={(entry) =>
                        void run(`checkout:${entry.number}`, () => api?.ghPrCheckout?.(projectPath, entry.number))
                      }
                      onOpenExternal={(url) => void api?.openExternal?.(url)}
                      onRefresh={refreshAll}
                    />
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </>
  );
}
