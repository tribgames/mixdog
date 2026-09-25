import type React from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { InitialSurface } from './InitialSurface';
import { describeSourceControlError, sourceControlErrorToastText } from './SourceControlErrorNotice';
import { useErrorToast } from './notifications';
import { commitImmediateOverlay } from './immediate-overlay';
import type { DesktopGitCommitFile, DesktopGitFile, DesktopGitLogEntry, DesktopGitStatus } from '../shared/contract';
import { t } from './i18n';
import type { PullRequestOpenHandler } from './PullRequestsPane';
import { GithubDock as PullRequestsPane } from './github/GithubDock';
import {
  ScmContextMenu,
  elementMenuPoint,
  isContextMenuKey,
  pointerMenuPoint,
  type ScmContextMenuItem,
  type ScmContextMenuState,
} from './ScmContextMenu';
import { changedFileMenuItems, SourceControlFileRow } from './source-control-file-row';
import { sourceControlRemoteActions } from './source-control-remote-actions';
import { SourceControlBranchPicker } from './source-control-branch-picker';
import { SourceControlCommitDetail } from './source-control-commit-detail';
import { SourceControlCommitForm } from './SourceControlCommitForm';
import { SourceControlViewControls, type SourceControlView } from './SourceControlViewControls';
import { buildSourceControlCommitMenu } from './source-control-history-menu';
import { useSourceControlFiles } from './use-source-control-files';
import { useSurfaceActive, useSurfaceNavigationReset } from './surface-activity';
import {
  gitRemoteWebUrl,
  indexOnly,
  pathsFor,
  pullRequestUrl,
  reasonText,
  RowSpacer,
  type SourceControlDiffRequest,
} from './source-control-support';
import {
  absoluteFilePath,
  branchActions,
  commitWebUrl,
  copyText,
  discardFiles,
  discardPrompt,
  historyCommitActions,
  missingChannel,
  pullRequestCreateHint,
  repositoryBusyReason,
  stashActions,
  stashReasons,
} from './source-control-actions';
import {
  ChangedFilesHeader,
  OperationBanner,
  RemoteActionButtons,
  viewSortMenuItems,
} from './source-control-changes-header';
import { HistoryList, type MenuPoint } from './source-control-history-list';
import { useSourceControlBranches } from './use-source-control-branches';
import { useSourceControlCommit } from './use-source-control-commit';
import { useSourceControlHistory } from './use-source-control-history';
import { useSourceControlRunner } from './use-source-control-runner';
export {
  changedFilesLabel,
  gitRemoteWebUrl,
  isDirtyResetRefusal,
  pullRequestUrl,
  type ScmRowWindow,
  type SourceControlDiffRequest,
} from './source-control-support';

const VIEW_SORT_MENU = 'View & Sort';

// Keys whose landed action rewrites the history the History view shows.
const HISTORY_RELOAD_KEYS = new Set(['commit', 'push', 'pull', 'sync', 'amend', 'undo-commit']);

function emptyState(text: string, live = false) {
  return (
    <p className="utility-dock-empty" role={live ? 'status' : undefined}>
      {text}
    </p>
  );
}

export function SourceControlDock({
  projectPath,
  status,
  statusReady,
  loading: _loading,
  statusError,
  onRefreshStatus,
  headerSlot,
  active,
  readinessKey,
  onReadyChange,
  onOpenFile,
  onOpenDiff,
  onOpenPullRequest,
  projectSelect,
  surface = 'changes',
}: {
  projectPath: string;
  status: DesktopGitStatus | null;
  statusReady: boolean;
  loading: boolean;
  statusError: string;
  onRefreshStatus(showLoading?: boolean): Promise<void> | void;
  headerSlot?: HTMLElement | null;
  active: boolean;
  readinessKey: string;
  onReadyChange(key: string, ready: boolean): void;
  onOpenFile?(project: string, rel: string): void;
  onOpenDiff?(project: string, rel: string, request: SourceControlDiffRequest): void;
  onOpenPullRequest?: PullRequestOpenHandler;
  /** Project picker hosted in its own row above the fixed Git toolbar. */
  projectSelect?: React.ReactNode;
  /** `changes` is the Git panel; `prs` is the separate pull-request panel. */
  surface?: 'changes' | 'prs';
}) {
  const api = window.mixdogDesktop;
  const prOnly = surface === 'prs';
  const [error, setError] = useState('');
  // ONE error surface: a failed Git action reports where every other failure
  // in the app reports — the workspace toast region — instead of a panel-local
  // banner that pushed the changed-file list down. State-owned, so the next
  // success (or leaving the project) clears it.
  useErrorToast(error ? sourceControlErrorToastText(error) : '', `scm:${projectPath}`);
  /** ONE right-click / Menu-key menu shared by every row grammar in the dock
   *  (changed file, history commit, branch) and by the file list's View & Sort
   *  button. */
  const [contextMenu, setContextMenu] = useState<ScmContextMenuState | null>(null);
  const [view, setView] = useState<SourceControlView>('changes');
  // Both the row context menu and the branch picker are document.body PORTALS,
  // and the Dock keeps this pane MOUNTED (inert + aria-hidden) while another
  // tab is presented — inert cannot reach a portal that left the pane. The
  // owning surface's active signal therefore drives their VISIBLE open state,
  // so deactivation unmounts both in the same commit, before a stale Escape /
  // pointerdown handler, focus move or guarded menu action can run against a
  // surface the user has left. Outside a provider (standalone SourceControlDock
  // mounts, tests) the default is active, so nothing changes.
  const surfaceActive = useSurfaceActive();
  const visibleContextMenu = surfaceActive ? contextMenu : null;
  const history = useSourceControlHistory({
    api,
    projectPath,
    active,
    listing: active && view === 'history',
    windowed: !prOnly && view === 'history',
    setError,
  });
  const branches = useSourceControlBranches({
    api,
    projectPath,
    status,
    surfaceActive,
    contextMenu: visibleContextMenu,
    setError,
  });
  useSurfaceNavigationReset(active && surfaceActive, () => {
    setView('changes');
    history.setSelectedCommit('');
    history.setOpenCommitFile('');
    setContextMenu(null);
    branches.closePicker();
    branches.setMergeMode(false);
  });
  useEffect(() => {
    if (surfaceActive) return;
    setContextMenu(null);
    branches.closePicker();
  }, [surfaceActive, branches.closePicker]);
  const {
    files,
    conflicts,
    includedFiles,
    filteredFiles,
    visibleFiles,
    fileWindow,
    filesScrollRef,
    fileFilter,
    setFileFilter,
    sortKey,
    chooseSortKey,
    selected,
    selectedCount,
    clearSelected,
    isIncluded,
    setIncluded,
    setAllIncluded,
    toggleSelected,
    selectedActionFiles,
    includedVisible,
    includableVisible,
    checkAllLabel,
  } = useSourceControlFiles({
    projectPath,
    status,
    active: !prOnly && view === 'changes',
  });
  const closeContextMenu = useCallback(() => setContextMenu(null), []);
  const refresh = useCallback(
    async (showLoading = false) => {
      if (!projectPath) return;
      await onRefreshStatus(showLoading);
    },
    [onRefreshStatus, projectPath]
  );
  /** Everything a landed action has to re-read: the status, the branch list
   *  for branch actions, and the history for the surfaces that rewrite it. */
  const { loadBranches } = branches;
  const { loadHistory } = history;
  const reload = useCallback(
    async (key: string) => {
      await refresh();
      if (key.startsWith('branch-')) await loadBranches();
      if (view === 'history' || HISTORY_RELOAD_KEYS.has(key)) await loadHistory(true);
    },
    [loadBranches, loadHistory, refresh, view]
  );
  const { busy, setBusy, guarded, run } = useSourceControlRunner({ status, reload, setError });
  /** An open menu STOPS OFFERING what it can no longer do: the guard state
   *  changing (an action starts, an operation appears) closes it. */
  const guardState = `${busy}\u0000${status?.operation ?? ''}`;
  const guardStateRef = useRef(guardState);
  useEffect(() => {
    if (guardStateRef.current === guardState) return;
    guardStateRef.current = guardState;
    setContextMenu(null);
  }, [guardState]);
  useEffect(() => {
    setView('changes');
  }, [projectPath]);
  useEffect(() => {
    onReadyChange(readinessKey, !projectPath || statusReady);
  }, [onReadyChange, projectPath, readinessKey, statusReady]);
  /** Right-click AND the keyboard's context key open the SAME menu; the
   *  keyboard has no pointer, so it anchors under the row instead. */
  const rowContextMenu = (label: string, items: () => ScmContextMenuItem[]) => ({
    onContextMenu: (event: React.MouseEvent<HTMLElement>) => {
      event.preventDefault();
      event.stopPropagation();
      commitImmediateOverlay(() => setContextMenu({ label, items: items(), ...pointerMenuPoint(event) }));
    },
    onKeyDown: (event: React.KeyboardEvent<HTMLElement>) => {
      if (!isContextMenuKey(event)) return;
      event.preventDefault();
      commitImmediateOverlay(() => setContextMenu({ label, items: items(), ...elementMenuPoint(event.currentTarget) }));
    },
  });

  const commit = useSourceControlCommit({
    api,
    projectPath,
    status,
    files,
    isIncluded,
    includedCount: includedFiles.length,
    conflictCount: conflicts.length,
    busy,
    run,
    setError,
  });
  const ctx = { api, projectPath, run, setError };
  const commitActions = historyCommitActions(ctx, {
    commitMessage: commit.commitMessage,
    clearCommitDraft: commit.clearDraft,
  });
  const branchActionSet = branchActions(ctx, {
    branchQuery: branches.query,
    closePicker: branches.closePicker,
    exitMergeMode: () => branches.setMergeMode(false),
  });
  const { stashChanges, popStash } = stashActions(ctx);
  const historyBusyReason = repositoryBusyReason(busy, status);
  const stashReason = stashReasons({ api, busy, status, fileCount: files.length });

  const openCommit = async (entry: DesktopGitLogEntry) => {
    if (!api?.gitShow || busy) return;
    setBusy(`show:${entry.hash}`);
    history.setSelectedCommit(entry.hash);
    history.setCommitDetail(null);
    history.setOpenCommitFile('');
    history.setCommitDiffs({});
    history.setShaCopy(null);
    try {
      history.setCommitDetail(await api.gitShow(projectPath, entry.hash));
    } catch (reason) {
      setError(reasonText(reason));
      history.setSelectedCommit('');
    } finally {
      setBusy('');
    }
  };
  /** Short SHA + copy affordance. The Clipboard API can be absent (insecure
   *  context) or refuse; either way the outcome is reported — announced
   *  through the header's live region and surfaced in the error banner —
   *  instead of claiming a copy that never happened. */
  const copyCommitSha = async (hash: string) => {
    const clipboard = window.navigator?.clipboard;
    if (!clipboard?.writeText) {
      history.setShaCopy({ hash, ok: false });
      setError(t('Could not copy the SHA: this environment has no clipboard access.'));
      return;
    }
    try {
      await clipboard.writeText(hash);
      history.setShaCopy({ hash, ok: true });
    } catch (reason) {
      history.setShaCopy({ hash, ok: false });
      setError(`Could not copy the SHA: ${reasonText(reason)}`);
    }
  };
  const toggleCommitFile = async (file: DesktopGitCommitFile) => {
    if (history.openCommitFile === file.path) {
      history.setOpenCommitFile('');
      return;
    }
    history.setOpenCommitFile(file.path);
    if (history.commitDiffs[file.path] !== undefined || !api?.gitShowDiff || !history.selectedCommit) return;
    history.setCommitDiffs((current) => ({ ...current, [file.path]: null }));
    try {
      const patch = await api.gitShowDiff(projectPath, history.selectedCommit, file.path);
      history.setCommitDiffs((current) => ({ ...current, [file.path]: patch || '' }));
    } catch (reason) {
      history.setCommitDiffs((current) => ({
        ...current,
        [file.path]: describeSourceControlError(reason).summary,
      }));
    }
  };

  const fileRow = (file: DesktopGitFile) => {
    const actionFiles = selectedActionFiles(file);
    const openChange = () => {
      if (!onOpenDiff) return onOpenFile?.(projectPath, file.path);
      return onOpenDiff(projectPath, file.path, {
        source: indexOnly(file) ? 'staged' : 'unstaged',
        ...(file.untracked ? { untracked: true } : {}),
      });
    };
    const discardActionFiles = () => {
      if (!window.confirm(discardPrompt(file, actionFiles.length))) return;
      void run(`revert:${file.path}`, () => discardFiles(ctx, actionFiles), clearSelected);
    };
    const fileMenuItems = () =>
      changedFileMenuItems({
        file,
        busy: Boolean(busy),
        canRevert: Boolean(api?.gitRevert),
        canIgnore: Boolean(api?.gitIgnore),
        canReveal: Boolean(api?.revealFile),
        canOpenDefault: Boolean(api?.openFilePath),
        missingChannel,
        guarded,
        onDiscard: discardActionFiles,
        onIgnore: (path, scope) => {
          const extension = scope ? path.slice(path.lastIndexOf('.')) : '';
          void run(scope ? `ignore-extension:${extension}` : `ignore:${path}`, () =>
            api?.gitIgnore?.(projectPath, path, scope)
          );
        },
        onCopyFilePath: () => {
          void copyText(ctx, absoluteFilePath(projectPath, file.path), 'file path');
        },
        onCopyRelativePath: () => {
          void copyText(ctx, file.path, 'relative file path');
        },
        onReveal: () => {
          void api?.revealFile?.(projectPath, file.path);
        },
        onOpenDefault: () => {
          void api?.openFilePath?.(projectPath, file.path);
        },
      });
    return (
      <SourceControlFileRow
        key={file.path}
        file={file}
        included={isIncluded(file)}
        selected={selected.has(file.path)}
        busy={Boolean(busy)}
        contextMenuProps={rowContextMenu(`Actions for ${file.path}`, fileMenuItems)}
        onSetIncluded={(next) => setIncluded(file, next)}
        onToggleSelected={(additive) => toggleSelected(file, additive)}
        onOpenChange={openChange}
        onOpenFile={() => onOpenFile?.(projectPath, file.path)}
        onResolve={() => {
          void run(`resolve:${file.path}`, () => api?.gitStage?.(projectPath, pathsFor(file)));
        }}
        onDiscard={discardActionFiles}
      />
    );
  };

  const discardAllChanges = () => {
    const targets = files.filter((file) => !file.conflicted);
    if (
      !targets.length ||
      !window.confirm(
        t('Discard all {{count}} working tree changes? This cannot be undone.', { count: targets.length })
      )
    )
      return;
    void run('discard-all', () => discardFiles(ctx, targets), clearSelected);
  };
  const toggleViewSortMenu = (point: MenuPoint) => {
    commitImmediateOverlay(() =>
      setContextMenu(
        visibleContextMenu?.label === VIEW_SORT_MENU
          ? null
          : { label: VIEW_SORT_MENU, items: viewSortMenuItems(sortKey, chooseSortKey), ...point }
      )
    );
  };
  const { remoteName, aheadCount, behindCount, fetchEntry, pushEntry, rowPushReason, rowPushBlocked } =
    sourceControlRemoteActions({
      status,
      busy,
      canFetch: Boolean(api?.gitFetch),
      canPush: Boolean(api?.gitPush),
      missingChannel,
      onFetch: () => void run('fetch', () => api?.gitFetch?.(projectPath)),
      onPush: () => void run('push', () => api?.gitPush?.(projectPath)),
    });
  const pushNow = () => void run('push', () => api?.gitPush?.(projectPath));
  // PR eligibility, shared by the review tab's Pull Request pane. The button
  // itself lives ONLY there now (user: PR은 완전히 분리).
  const prAhead = status?.ahead ?? 0;
  const prUrl =
    status?.upstream && prAhead === 0 && !status.operation && !status.detached
      ? pullRequestUrl(status.remoteUrl || '', status.branch)
      : '';

  const historyMenuItems = (entry: DesktopGitLogEntry, entryIndex: number, hostedCommitUrl: string) =>
    buildSourceControlCommitMenu({
      entry,
      entryIndex,
      historyBusyReason,
      statusUnborn: Boolean(status?.unborn),
      conflictCount: conflicts.length,
      commitUrl: hostedCommitUrl,
      missingChannel,
      capabilities: {
        amend: Boolean(api?.gitAmend),
        checkout: Boolean(api?.gitCheckoutCommit),
        cherryPick: Boolean(api?.gitCherryPickCommit),
        createBranch: Boolean(api?.gitCreateBranchAtCommit),
        createTag: Boolean(api?.gitCreateTag),
        deleteTag: Boolean(api?.gitDeleteTag),
        openExternal: Boolean(api?.openExternal),
        reset: Boolean(api?.gitResetToCommit),
        revert: Boolean(api?.gitRevertCommit),
        undo: Boolean(api?.gitUndoLastCommit),
      },
      actions: {
        amend: () => guarded(() => commitActions.amendCommitAt(entry)),
        checkout: () => guarded(() => commitActions.checkoutCommit(entry)),
        cherryPick: () => guarded(() => commitActions.cherryPickCommit(entry)),
        copySha: () => void copyText(ctx, entry.hash, 'SHA'),
        copyTags: (values) => void copyText(ctx, values.join(' '), values.length > 1 ? 'tags' : 'tag'),
        createBranch: () => guarded(() => commitActions.createBranchAtCommit(entry)),
        createTag: () => guarded(() => commitActions.createTagAt(entry)),
        deleteTag: (tag) => guarded(() => commitActions.deleteTagAt(entry, tag)),
        openHostedCommit: () => void api?.openExternal?.(hostedCommitUrl),
        reset: () => guarded(() => commitActions.resetToCommit(entry)),
        revert: () => guarded(() => commitActions.revertCommit(entry)),
        undo: () => guarded(() => commitActions.undoCommitAt(entry)),
      },
    });
  const historyRowProps = (entry: DesktopGitLogEntry, entryIndex: number) => {
    const hostedCommitUrl = commitWebUrl(status?.remoteUrl || '', entry.hash);
    return {
      remoteName,
      pushBlocked: rowPushBlocked,
      pushReason: rowPushReason,
      onOpen: () => void openCommit(entry),
      onOpenMenu: (point: MenuPoint) =>
        setContextMenu({
          label: `Actions for commit ${entry.shortHash}`,
          items: historyMenuItems(entry, entryIndex, hostedCommitUrl),
          ...point,
        }),
      onPush: pushNow,
    };
  };

  if (!projectPath) return emptyState(t('Open a project to use Source Control.'));
  if (!statusReady && !prOnly) return <InitialSurface />;
  // Git status is a background read. A cold host/repository can miss the
  // first pass, so keep that failure in the panel's neutral empty-state
  // grammar instead of flashing the red action-error bar.
  if (!status && statusError && !prOnly) return emptyState(t('Source Control is temporarily unavailable.'), true);
  if (status && !status.repository && !prOnly) return emptyState(t('The selected project is not a Git repository.'));

  return (
    <div className="dock-source-control">
      {/* ONE portaled context menu for every row grammar in the dock. */}
      <ScmContextMenu state={visibleContextMenu} onClose={closeContextMenu} />
      {status && !prOnly && projectSelect && <div className="utility-dock-project-row">{projectSelect}</div>}
      {/* Fixed toolbar: current branch, Push, and Fetch. Git action names and
        their supporting labels intentionally stay in English. */}
      {status && !prOnly && (
        <div className="dock-scm-toolbar" data-i18n-skip>
          <SourceControlBranchPicker
            status={status}
            busy={busy}
            open={branches.pickerVisible}
            query={branches.query}
            loading={branches.loading}
            visibleBranches={branches.visibleBranches}
            defaultBranch={branches.defaultBranch}
            otherBranches={branches.otherBranches}
            mergeMode={branches.mergeMode}
            capabilities={{
              list: Boolean(api?.gitBranches),
              create: Boolean(api?.gitCreateBranch),
              checkout: Boolean(api?.gitCheckoutBranch),
              rename: Boolean(api?.gitRenameBranch),
              delete: Boolean(api?.gitDeleteBranch),
              merge: Boolean(api?.gitMergeBranch),
            }}
            rootRef={branches.rootRef}
            triggerRef={branches.triggerRef}
            panelRef={branches.panelRef}
            panelStyle={branches.panelStyle}
            clickGuard={branches.clickGuard}
            rowContextMenu={rowContextMenu}
            missingChannel={missingChannel}
            guarded={guarded}
            onOpen={branches.openPicker}
            onClose={branches.closePicker}
            onQueryChange={branches.setQuery}
            onCreate={branchActionSet.createBranchFromFilter}
            onCheckout={branchActionSet.checkoutBranch}
            onRename={branchActionSet.renameBranch}
            onDelete={branchActionSet.deleteBranch}
            onMerge={branchActionSet.mergeIntoCurrent}
            onToggleMergeMode={() => branches.setMergeMode((current) => !current)}
          />
          <RemoteActionButtons
            entries={[pushEntry, fetchEntry]}
            aheadCount={aheadCount}
            behindCount={behindCount}
            hasUpstream={Boolean(status.upstream)}
            busy={busy}
            operation={status.operation}
          />
        </div>
      )}
      <div className="dock-scm-view-stage">
        {!prOnly && (
          <SourceControlViewControls
            fileCount={files.length}
            fileFilter={fileFilter}
            historyQuery={history.query}
            view={view}
            onFileFilterChange={setFileFilter}
            onHistoryQueryChange={history.setQuery}
            onViewChange={(next) => {
              if (next === view) return;
              if (next === 'history') history.setLoading(true);
              setView(next);
              clearSelected();
            }}
          />
        )}
        {!prOnly && status?.operation && (
          <OperationBanner
            operation={status.operation}
            conflictCount={conflicts.length}
            busy={busy}
            onContinue={() => void run('continue', () => api?.gitContinue?.(projectPath))}
            onAbort={() => void run('abort-operation', () => api?.gitAbortOperation?.(projectPath))}
          />
        )}
        {prOnly && (
          <PullRequestsPane
            projectPath={projectPath}
            prUrl={prUrl}
            repositoryUrl={gitRemoteWebUrl(status?.remoteUrl || '')}
            headerSlot={headerSlot}
            onOpenPullRequest={onOpenPullRequest}
            currentBranch={status?.branch ?? ''}
            createHint={pullRequestCreateHint(status, prAhead)}
          />
        )}
        {!prOnly && view === 'changes' && (
          <>
            <ChangedFilesHeader
              files={files}
              busy={busy}
              includedVisible={includedVisible}
              includableVisible={includableVisible}
              checkAllLabel={checkAllLabel}
              stashReason={stashReason.stash}
              popStashReason={stashReason.pop}
              viewSortOpen={visibleContextMenu?.label === VIEW_SORT_MENU}
              onSetAllIncluded={setAllIncluded}
              onDiscardAll={discardAllChanges}
              onStash={stashChanges}
              onPopStash={popStash}
              onToggleViewSort={toggleViewSortMenu}
            />
            <div
              className="dock-scm-scroll"
              ref={filesScrollRef}
              onKeyDown={(event) => {
                // Esc anywhere in the list clears the checkbox selection (user: 셀렉트
                // 하면 어떻게 언셀렉함) — the toolbar Clear button is the mouse path.
                if (event.key !== 'Escape' || selectedCount === 0) return;
                event.stopPropagation();
                clearSelected();
              }}
            >
              {/* Windowed rows: the spacers carry the height of every row that is not
                  mounted, so the scrollbar measures the WHOLE changed-file set and
                  scrolling — not a button — is what reaches the end of it. */}
              <RowSpacer edge="leading" height={fileWindow.leading} />
              {visibleFiles.map((file) => fileRow(file))}
              <RowSpacer edge="trailing" height={fileWindow.trailing} />
              {files.length === 0 && <p className="dock-scm-clean">{t('No changes in this project.')}</p>}
              {files.length > 0 && filteredFiles.length === 0 && (
                <p className="dock-scm-clean">{t('No changed files match the filter.')}</p>
              )}
            </div>
            <SourceControlCommitForm
              branch={status?.branch || ''}
              busy={busy}
              commitBlocked={commit.commitBlocked}
              conflictCount={conflicts.length}
              description={commit.description}
              detached={Boolean(status?.detached)}
              fileCount={files.length}
              operation={status?.operation}
              selectedFileCount={includedFiles.length}
              summary={commit.summary}
              onCommit={() => commit.runCommitFlow('commit')}
              onDescriptionChange={commit.setDescription}
              onSummaryChange={commit.setSummary}
            />
          </>
        )}
        {!prOnly && view !== 'changes' && history.selectedCommit && (
          <SourceControlCommitDetail
            detail={history.commitDetail}
            selectedCommit={history.selectedCommit}
            shaCopy={history.shaCopy}
            openCommitFile={history.openCommitFile}
            commitDiffs={history.commitDiffs}
            projectPath={projectPath}
            onOpenDiff={onOpenDiff}
            onBack={history.closeCommit}
            onCopySha={copyCommitSha}
            onToggleFile={toggleCommitFile}
          />
        )}
        {!prOnly && view !== 'changes' && !history.selectedCommit && (
          <HistoryList
            scrollRef={history.scrollRef}
            rowWindow={history.rowWindow}
            entries={history.visibleEntries}
            total={history.entries.length}
            loading={history.loading}
            rowProps={historyRowProps}
          />
        )}
      </div>
    </div>
  );
}
