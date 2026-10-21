// The composer island's git segment, last in the pill: one button that
// expands the island into its Git tab, which lists Create PR · Commit · push
// · Commit, each with its own Run that sends that request at once, plus
// Source Control. Nothing is pre-selected: the tab is three actions, not a
// setting. Shown in a git checkout while the files segment has files or the
// branch has commits ahead of its upstream; never shown outside a repository.
import { ArrowUp, GitCommitHorizontal, GitPullRequest, List, Play } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';

import type { DesktopGitStatus } from '../shared/contract';
import { IslandSegmentPending, useComposerIslandTab } from './composer-island-state';
import { createGitRefreshScheduler, watchGitRefreshEvidence } from './git-refresh-scheduler';
import { t } from './i18n';
import { type IslandGitAction, useIslandGitRequest } from './island-git-request';
import { MxIcon } from './MxIcon';
import { useMobileBack } from './mobile-back';
import { requestOpenDockTab } from './open-dock-tab-event';
import { useSessionChanges } from './session-changes-store';
import { readCachedDockGitState, requestDockGitState } from './utility-dock-git-state';

/** The Source Control dock's cadence for the shared status snapshot. */
const ISLAND_GIT_REFRESH = { safetyIntervalMs: 30_000, activityDebounceMs: 125, activityMinGapMs: 3_000 };

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
    }, ISLAND_GIT_REFRESH);
    const stop = watchGitRefreshEvidence(cwd, scheduler);
    return () => {
      active = false;
      stop();
    };
  }, [cwd]);
  return cwd ? status : null;
}

const GIT_ROWS: { action: IslandGitAction; label: () => string; icon: typeof GitPullRequest }[] = [
  { action: 'pr', label: () => t('Create PR'), icon: GitPullRequest },
  { action: 'commit-push', label: () => t('Commit · push'), icon: ArrowUp },
  { action: 'commit', label: () => t('Commit'), icon: GitCommitHorizontal },
];

export function IslandGitSegment({ sessionId, cwd }: { sessionId: string; cwd: string }) {
  const git = useIslandGitRequest({ sessionId, cwd });
  // The files segment's own count (its Changes source, the same shared read).
  const changes = useSessionChanges({ cwd, sessionId, active: true });
  const files = changes.summary.files.size;
  const status = useIslandGitStatus(git.ready ? cwd : '');
  const [open, setOpen] = useComposerIslandTab('git');
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
    const items = [
      ...(panel.current?.querySelectorAll<HTMLElement>('.composer-island-git-run, .composer-island-git-foot button') ??
        []),
    ];
    const index = items.indexOf(document.activeElement as HTMLElement);
    const step = event.key === 'ArrowDown' ? 1 : -1;
    event.preventDefault();
    items[(index + step + items.length) % items.length]?.focus();
  };
  const meta = [status?.branch, t('Files {{count}}', { count: files })].filter(Boolean).join(' · ');

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
          <div className="composer-island-phead">
            <span className="composer-island-tab" data-active="true">
              <GitPullRequest size={14} className="composer-island-seg-icon" aria-hidden="true" />
              {t('Git')}
            </span>
            <span className="composer-island-phead-meta">{meta}</span>
            <button
              type="button"
              className="composer-island-close"
              aria-label={t('Close')}
              title={t('Close')}
              onClick={close}
            >
              <MxIcon name="close-small" size={16} />
            </button>
          </div>
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
            <div className="composer-island-pfoot composer-island-git-foot">
              <button
                type="button"
                className="composer-island-button"
                onClick={() => {
                  setOpen(false);
                  requestOpenDockTab('source-control');
                }}
              >
                <List size={14} aria-hidden="true" />
                <span>{t('Island: Source Control')}</span>
              </button>
            </div>
          </div>
        </section>
      )}
    </>
  );
}
