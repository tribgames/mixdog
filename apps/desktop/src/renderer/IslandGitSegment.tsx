import { ArrowUp, GitCommitHorizontal, GitPullRequest, Play } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';

import type { DesktopGitStatus } from '../shared/contract';
import { splitCountPhrase } from './ComposerIsland';
import { IslandSegmentPending, useComposerIslandTab } from './composer-island-state';
import { createGitRefreshScheduler, watchGitRefreshEvidence } from './git-refresh-scheduler';
import { t } from './i18n';
import { type IslandGitAction, useIslandGitRequest } from './island-git-request';
import { IslandPanelFoot, IslandPanelHead } from './IslandPanelFoot';
import { useMobileBack } from './mobile-back';
import { readCachedDockGitState, requestDockGitState, retainDockGitState } from './utility-dock-git-state';

/** The checkout's status (branch, commits ahead of upstream), re-read on Git
 *  evidence; null without a folder or before the first read. */
export function useIslandGitStatus(cwd: string): DesktopGitStatus | null {
  const [status, setStatus] = useState(() => readCachedDockGitState(cwd).status);
  useEffect(() => {
    setStatus(readCachedDockGitState(cwd).status);
    if (!cwd) return undefined;
    let active = true;
    const scheduler = createGitRefreshScheduler(async () => {
      const state = await requestDockGitState(cwd);
      if (active) setStatus(state.status);
    });
    const stop = watchGitRefreshEvidence(cwd, scheduler);
    const release = retainDockGitState(cwd);
    return () => {
      active = false;
      stop();
      release();
    };
  }, [cwd]);
  return cwd ? status : null;
}

export const GIT_ROWS: { action: IslandGitAction; label: () => string; icon: typeof GitPullRequest }[] = [
  { action: 'pr', label: () => t('Create PR'), icon: GitPullRequest },
  { action: 'commit-push', label: () => t('Commit · push'), icon: ArrowUp },
  { action: 'commit', label: () => t('Commit'), icon: GitCommitHorizontal },
];

export function IslandGitSegment({
  sessionId,
  cwd,
  onViewChanges,
}: {
  sessionId: string;
  cwd: string;
  onViewChanges?: () => void;
}) {
  const { changes, ...git } = useIslandGitRequest({ sessionId, cwd });
  const files = changes.summary.files.size + changes.untrackedOmitted;
  const [open, setOpen] = useComposerIslandTab('git');
  // A changed file already decides visibility. Only the open tab needs the branch then.
  const status = useIslandGitStatus(git.ready && (open || !files) ? cwd : '');
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLElement>(null);
  const panelId = useId();
  // Set when a close should hand focus back to the segment button; it is
  // hidden while the tab is open, so focus moves once the tab has closed.
  const refocus = useRef(false);
  const ahead = status?.repository ? status.ahead : 0;
  const shown = git.ready && (files > 0 || ahead > 0);
  const close = () => {
    refocus.current = true;
    setOpen(false);
  };
  useMobileBack(open, close);
  // Nothing left to commit or push: the segment and its open tab leave.
  // biome-ignore lint/correctness/useExhaustiveDependencies: setOpen is rebuilt each render; shown is the trigger
  useEffect(() => {
    if (!shown) setOpen(false);
  }, [shown]);
  useEffect(() => {
    if (open) {
      queueMicrotask(() => panel.current?.querySelector<HTMLElement>('.composer-island-git-run')?.focus());
      return;
    }
    if (refocus.current) trigger.current?.focus();
    refocus.current = false;
  }, [open]);
  if (!shown) {
    // Undecided while the changes read (or, with nothing to commit, the
    // ahead count) is out: the segment keeps its room in the pill.
    const decided = !sessionId || !cwd || (changes.ready && (!changes.repository || status !== null));
    return decided ? null : <IslandSegmentPending kind="git" />;
  }

  // A row's Run sends that action at once and collapses the tab.
  const runNow = (next: IslandGitAction) => {
    close();
    git.request(next);
  };
  const onKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
      return;
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const items = [...(panel.current?.querySelectorAll<HTMLElement>('.composer-island-git-run') ?? [])];
    const index = items.indexOf(document.activeElement as HTMLElement);
    const step = event.key === 'ArrowDown' ? 1 : -1;
    event.preventDefault();
    items[(index + step + items.length) % items.length]?.focus();
  };
  const filesText = t('Files {{count}}', { count: files });
  const filesParts = splitCountPhrase(filesText, files);
  const meta = (
    <>
      {status?.branch ? `${status.branch} · ` : ''}
      {filesParts ? (
        <>
          {filesParts.before}
          <b>{filesParts.num}</b>
          {filesParts.after}
        </>
      ) : (
        filesText
      )}
    </>
  );
  const footBranch = status?.branch ?? '';
  const footCounts = [files > 0 ? filesText : '', ahead > 0 ? `↑${ahead}` : ''].filter(Boolean).join(' · ');

  return (
    <>
      {/* One island segment: the whole button toggles the Git tab. */}
      <span className="composer-island-seg composer-island-git" data-open={open || undefined}>
        <button
          ref={trigger}
          type="button"
          className="composer-island-git-main"
          aria-label={t('Island: Git actions')}
          title={t('Island: Git actions')}
          aria-haspopup="true"
          aria-expanded={open}
          aria-controls={open ? panelId : undefined}
          onClick={() => {
            refocus.current = false;
            setOpen(!open);
          }}
        >
          <GitPullRequest size={14} aria-hidden="true" />
          <span>{t('Git')}</span>
        </button>
      </span>
      {open && (
        <section
          ref={panel}
          id={panelId}
          className="composer-island-panel composer-island-git-panel"
          aria-label={t('Git')}
          onKeyDown={onKeyDown}
        >
          <IslandPanelHead
            chip={
              <>
                <GitPullRequest size={14} className="composer-island-seg-icon" aria-hidden="true" />
                {t('Git')}
              </>
            }
            meta={meta}
            onClose={close}
          />
          <div className="composer-island-pbody">
            <div className="composer-island-git-rows">
              {GIT_ROWS.map(({ action: rowAction, label, icon: Icon }) => (
                <div key={rowAction} className="composer-island-git-row" data-action={rowAction}>
                  <span className="composer-island-git-label">
                    <Icon size={16} aria-hidden="true" />
                    <span>{label()}</span>
                  </span>
                  <button
                    type="button"
                    className="composer-island-button composer-island-git-run"
                    aria-label={`${t('Run')}: ${label()}`}
                    onClick={() => runNow(rowAction)}
                  >
                    <Play size={12} aria-hidden="true" />
                    <span>{t('Run')}</span>
                  </button>
                </div>
              ))}
            </div>
          </div>
          <IslandPanelFoot
            end={
              onViewChanges ? (
                <button
                  type="button"
                  className="composer-island-button"
                  onClick={() => {
                    close();
                    onViewChanges();
                  }}
                >
                  {t('Island: View changes')}
                </button>
              ) : undefined
            }
          >
            {(footBranch || footCounts) && (
              <span className="composer-island-foot-meta">
                {footBranch && (
                  <span className="composer-island-foot-branch">{footCounts ? `${footBranch} · ` : footBranch}</span>
                )}
                {footCounts}
              </span>
            )}
          </IslandPanelFoot>
        </section>
      )}
    </>
  );
}
