// Pull Requests dock surface with a compact filtered list
// for the dock, with the metadata and tab hierarchy in the editor.
// Data and actions are backed by the gh CLI IPC chain.

import { ArrowRight, Check, FileDiff, GitPullRequestArrow, Github, Plus, RefreshCw, Search, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { DesktopPullRequestCategory, DesktopPullRequestEntry } from '../shared/contract';
import { t } from './i18n';
import { ProgressSpinner } from './ProgressSpinner';
import { OpenSelect } from './OpenSelect';
import { useSurfaceActive, useSurfaceNavigationReset } from './surface-activity';
import { RowOverflowMenu } from './RowOverflowMenu';
import { SourceControlErrorNotice } from './SourceControlErrorNotice';
import {
  PULL_REQUEST_LIST_VIEWS,
  StateIcon,
  buildPullRequestViews,
  checksState,
  createSubmitLabel,
  preferredBaseBranch,
  pullRequestMatchesFilter,
  pullRequestsWebUrl,
  relativeAge,
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
  const [categories, setCategories] = useState<DesktopPullRequestCategory[] | null>(null);
  const [readError, setReadError] = useState('');
  const [actionError, setActionError] = useState('');
  const [loading, setLoading] = useState(false);
  const [listView, setListView] = useState<PullRequestListView>('open');
  const [filter, setFilter] = useState('');
  const [localBranchNames, setLocalBranchNames] = useState<Set<string>>(new Set());
  const [baseBranchNames, setBaseBranchNames] = useState<string[]>(['main']);
  const [defaultBranchName, setDefaultBranchName] = useState('');
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
  const listEpoch = useRef(0);
  const loadedProject = useRef<string | null>(null);

  const loadList = useCallback(async () => {
    if (!projectPath || !surfaceActive) return;
    const epoch = ++listEpoch.current;
    setLoading(true);
    try {
      const [rows, branches, remoteDefaultBranch] = await Promise.all([
        api?.ghPrList?.(projectPath),
        api?.gitBranches?.(projectPath).catch(() => []),
        api?.ghPrDefaultBranch?.(projectPath).catch(() => '') ?? Promise.resolve(''),
      ]);
      if (epoch !== listEpoch.current) return;
      setCategories(rows ?? []);
      setLocalBranchNames(new Set((branches ?? []).filter((branch) => !branch.remote).map((branch) => branch.name)));
      const baseNames = [
        ...new Set(
          (branches ?? []).flatMap((branch) => {
            const name = branch.remote ? branch.name.replace(/^[^/]+\//, '') : branch.name;
            return !name || name === 'HEAD' ? [] : [name];
          })
        ),
      ];
      setBaseBranchNames(baseNames.length ? baseNames : ['main']);
      setDefaultBranchName(remoteDefaultBranch || preferredBaseBranch(baseNames));
      setReadError('');
    } catch (cause) {
      if (epoch !== listEpoch.current) return;
      setReadError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (epoch === listEpoch.current) setLoading(false);
    }
  }, [api, currentBranch, projectPath, surfaceActive]);

  useEffect(() => {
    if (!surfaceActive) {
      // Deactivation cancels: the epoch bump orphans every in-flight answer.
      listEpoch.current += 1;
      setLoading(false);
      return;
    }
    if (loadedProject.current !== projectPath) {
      loadedProject.current = projectPath;
      setCategories(null);
      setReadError('');
      setActionError('');
      setListView('open');
      setFilter('');
      setCreateOpen(false);
      setCreateError('');
      setDefaultBranchName('');
    }
    void loadList();
  }, [loadList, projectPath, surfaceActive]);

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
    else if (createHint) createButtonTitle = t(createHint);
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
    else if (createHint) emptyMessage = t(createHint);
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
            <form
              className="dock-pr-create"
              onSubmit={(event) => {
                event.preventDefault();
                void submitCreatePullRequest();
              }}
            >
              <header>
                <GitPullRequestArrow size={16} aria-hidden="true" />
                <span>
                  <b>{t('New pull request')}</b>
                  <small>
                    {currentBranch} → {createBase || 'base'}
                  </small>
                </span>
              </header>
              <label>
                <span>{t('Title')}</span>
                <input
                  type="text"
                  aria-label={t('Pull request title')}
                  value={createTitle}
                  maxLength={1024}
                  autoFocus
                  onInput={(event) => setCreateTitle(event.currentTarget.value)}
                />
              </label>
              <label>
                <span>{t('Description')}</span>
                <textarea
                  aria-label={t('Pull request description')}
                  rows={6}
                  value={createBody}
                  placeholder={t('Description (optional)')}
                  onInput={(event) => setCreateBody(event.currentTarget.value)}
                />
              </label>
              <div className="dock-pr-create-base">
                <span>{t('Base')}</span>
                <OpenSelect
                  className="dock-pr-base-select"
                  ariaLabel={t('Pull request base branch')}
                  value={createBase}
                  options={baseBranchNames.map((branch) => ({ value: branch, label: branch }))}
                  onChange={setCreateBase}
                />
              </div>
              <label className="dock-pr-create-draft">
                <input
                  type="checkbox"
                  checked={createDraft}
                  onChange={(event) => setCreateDraft(event.currentTarget.checked)}
                />
                <span>{t('Create as draft')}</span>
              </label>
              {!prUrl && (
                <p className="dock-pr-create-note">
                  {createHint ? t(createHint) : t('The branch will be pushed before creation.')}
                </p>
              )}
              {createError && (
                <SourceControlErrorNotice
                  error={createError}
                  className="dock-pr-create-error"
                  compact
                  onAuthenticationHelp={() => void api?.openExternal?.('https://cli.github.com/manual/gh_auth_login')}
                  authenticationHelpLabel={t('GitHub CLI help')}
                />
              )}
              <footer>
                <button type="button" onClick={cancelCreatePullRequest} disabled={busy === 'create'}>
                  {t('Cancel')}
                </button>
                <button type="submit" disabled={createDisabled}>
                  {busy === 'create' && <ProgressSpinner size={14} aria-hidden="true" />}
                  {createSubmitLabel(busy === 'create', prUrl, createDraft)}
                </button>
              </footer>
            </form>
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
                <div
                  className="dock-pr-results"
                  role="list"
                  aria-label={t('{{view}} pull requests', { view: viewLabels[listView] })}
                >
                  {visiblePullRequests.map((pr) => {
                    const checkedOut = Boolean(currentBranch && pr.headRefName === currentBranch);
                    const checkoutKey = `checkout:${pr.number}`;
                    return (
                      <div className="dock-pr-row" data-draft={pr.isDraft || undefined} role="listitem" key={pr.number}>
                        <button type="button" className="dock-pr-row-main" onClick={() => openPullRequest(pr)}>
                          <span className="dock-pr-row-icon" aria-hidden="true">
                            <StateIcon pr={pr} />
                          </span>
                          <span className="dock-pr-row-label">
                            <b>{pr.title}</b>
                            <small>
                              #{pr.number}
                              {relativeAge(pr.updatedAt) ? ` · ${relativeAge(pr.updatedAt)}` : ''}
                              {pr.author ? ` · @${pr.author}` : ''}
                            </small>
                          </span>
                          <span className="dock-pr-row-signals" aria-hidden="true">
                            {checkedOut && <Check size={12} className="dock-pr-row-active" />}
                            {pr.checks.total > 0 && (
                              <i className="dock-pr-row-checks" data-checks={checksState(pr.checks)} />
                            )}
                          </span>
                        </button>
                        <span className="dock-pr-row-actions">
                          <button
                            type="button"
                            aria-label={t('Open changes for pull request {{number}}', { number: pr.number })}
                            data-tooltip={t('Open Changes')}
                            onClick={() => openPullRequest(pr, 'changes')}
                          >
                            <FileDiff size={14} aria-hidden="true" />
                          </button>
                          {!checkedOut && (
                            <button
                              type="button"
                              aria-label={t('Checkout pull request {{number}}', { number: pr.number })}
                              data-tooltip={t('Checkout Pull Request')}
                              disabled={Boolean(busy) || !api?.ghPrCheckout}
                              onClick={() => void run(checkoutKey, () => api?.ghPrCheckout?.(projectPath, pr.number))}
                            >
                              {busy === checkoutKey ? (
                                <ProgressSpinner size={14} aria-hidden="true" />
                              ) : (
                                <ArrowRight size={14} aria-hidden="true" />
                              )}
                            </button>
                          )}
                          <RowOverflowMenu
                            label={t('Actions for pull request {{number}}', { number: pr.number })}
                            items={[
                              {
                                id: 'overview',
                                label: t('View Pull Request Description'),
                                onSelect: () => openPullRequest(pr),
                              },
                              {
                                id: 'overview-side',
                                label: t('Open Pull Request Description to the Side'),
                                onSelect: () => openPullRequest(pr, 'overview', true),
                              },
                              {
                                id: 'changes',
                                label: t('Open Changes'),
                                onSelect: () => openPullRequest(pr, 'changes'),
                              },
                              {
                                id: 'checkout',
                                label: checkedOut ? t('Pull Request Checked Out') : t('Checkout Pull Request'),
                                disabled: checkedOut || Boolean(busy) || !api?.ghPrCheckout,
                                onSelect: () =>
                                  void run(checkoutKey, () => api?.ghPrCheckout?.(projectPath, pr.number)),
                              },
                              {
                                id: 'open-github',
                                label: t('Open on GitHub'),
                                disabled: !pr.url,
                                onSelect: () => {
                                  if (pr.url) void api?.openExternal?.(pr.url);
                                },
                              },
                              {
                                id: 'refresh',
                                label: t('Refresh Pull Request'),
                                separatorBefore: true,
                                onSelect: refreshAll,
                              },
                            ]}
                          />
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </>
  );
}
