// Settings → Worktrees: every managed worktree with its branch, owner
// session, state and size; "Open new session here", "Delete" and the manual
// "Clean up now" (pruneWorktrees).
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

import type { DesktopManagedWorktreeRow, DesktopWorktreeSettings } from '../../shared/contract';
import { confirmAction } from '../app-confirm';
import { createGitRefreshScheduler } from '../git-refresh-scheduler';
import { t } from '../i18n';
import { subscribeProjectFileChanges } from '../project-file-changes';
import { windowSectionStore } from '../section-store';
import {
  formatByteSize,
  invokeWorktree,
  pruneReportText,
  worktreeFailure,
  worktreeFailureText,
} from '../worktree-branch-model';
import { requestNewTaskInWorktree, requestOpenSession } from '../worktree-session-events';
import { ActionButton, ListEmpty } from './capability-controls';
import { peekConfirmedWorktreeSettings, subscribeConfirmedWorktreeSettings } from './worktree-settings-store';

type RowState = { kind: 'dirty' | 'busy' | 'unmerged' | 'ok' | 'unknown'; text: string };

const projectName = (path: string) =>
  path
    .replace(/[\\/]+$/, '')
    .split(/[\\/]/)
    .pop() || path;

/** What the State column says about one row. */
export function worktreeRowState(row: DesktopManagedWorktreeRow, settings: DesktopWorktreeSettings | null): RowState {
  if (row.ownerLive) return { kind: 'busy', text: t('In use') };
  if (row.dirty == null || row.unmerged == null) return { kind: 'unknown', text: '—' };
  if (row.dirty > 0) return { kind: 'dirty', text: t('{{count}} changes', { count: row.dirty }) };
  if (row.unmerged > 0) return { kind: 'unmerged', text: t('{{count}} unmerged commits', { count: row.unmerged }) };
  const auto = settings?.autoCleanup === true && !row.sharedSessionIds?.length;
  const candidate =
    auto &&
    (row.cleanupReason ||
      (row.retained ? row.ownerArchived === true && settings?.cleanupArchived === true : row.removable));
  // A preview is not a deletion receipt. A favorite, recovery data, a young
  // checkout or the final Git check can still keep the tree.
  const text = candidate
    ? t('Merged · cleanup candidate')
    : settings === null || (auto && row.cleanupReason === undefined)
      ? t('Merged')
      : t('Merged · kept');
  return { kind: 'ok', text };
}

export function WorktreeList({ active = true }: { active?: boolean }) {
  const [settings, setSettings] = useState(peekConfirmedWorktreeSettings);
  const [rows, setRows] = useState<DesktopManagedWorktreeRow[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [readError, setReadError] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const [shownEpoch, setShownEpoch] = useState<number | null>(null);
  const readEpoch = useRef(0);
  const action = useRef<AbortController | null>(null);
  const requestRefresh = useRef<() => void>(() => {});
  const refresh = useCallback(() => requestRefresh.current(), []);
  const paths = JSON.stringify([...new Set((rows ?? []).flatMap((row) => [row.projectPath, row.path]))].sort());
  useLayoutEffect(() => {
    if (!active) return;
    let live = true;
    let before = peekConfirmedWorktreeSettings();
    setSettings(before);
    const scheduler = createGitRefreshScheduler(async () => {
      if (!live) return;
      if (action.current) return;
      const epoch = readEpoch.current;
      setReading(true);
      try {
        const value = await invokeWorktree<DesktopManagedWorktreeRow[]>('listWorktrees');
        if (!live || epoch !== readEpoch.current) return;
        setRows(value);
        setReadError(null);
        setShownEpoch(epoch);
      } catch (reason) {
        if (live && epoch === readEpoch.current) setReadError(worktreeFailureText(worktreeFailure(reason)));
      } finally {
        if (live) setReading(false);
      }
    });
    const signal = () => {
      readEpoch.current++;
      setShownEpoch(null);
      action.current?.abort();
      if (!action.current) scheduler.signal();
    };
    requestRefresh.current = signal;
    const settingsChanged = subscribeConfirmedWorktreeSettings(() => {
      const next = peekConfirmedWorktreeSettings();
      setSettings(next);
      if (
        before &&
        next &&
        (before.autoCleanup !== next.autoCleanup ||
          before.maxWorktrees !== next.maxWorktrees ||
          before.unusedDays !== next.unusedDays ||
          before.cleanupArchived !== next.cleanupArchived ||
          before.deleteBranch !== next.deleteBranch)
      ) {
        signal();
      }
      before = next;
    });
    const sections = windowSectionStore();
    const gitChanged = sections?.subscribe('gitStatus', signal);
    const storedPolicy = () => {
      const agent = sections?.get('config', 'agent')?.value as { worktree?: unknown } | undefined;
      return JSON.stringify(agent?.worktree);
    };
    let policy = storedPolicy();
    const configChanged = sections?.subscribe('config', () => {
      const next = storedPolicy();
      if (next === policy) return;
      policy = next;
      signal();
    });
    const sessionsChanged = window.mixdogDesktop?.subscribeSessions?.(signal);
    window.addEventListener('mixdog:git-changed', signal);
    window.addEventListener('focus', signal);
    setShownEpoch(null);
    scheduler.resume();
    return () => {
      live = false;
      readEpoch.current++;
      action.current?.abort();
      requestRefresh.current = () => {};
      scheduler.dispose();
      settingsChanged();
      gitChanged?.();
      configChanged?.();
      sessionsChanged?.();
      window.removeEventListener('mixdog:git-changed', signal);
      window.removeEventListener('focus', signal);
    };
  }, [active]);
  useEffect(() => {
    if (!active) return;
    const stops = (JSON.parse(paths) as string[]).map((path) => subscribeProjectFileChanges(path, refresh));
    return () => {
      for (const stop of stops) stop();
    };
  }, [active, paths, refresh]);

  /** The action's receipt and the read error are independent. */
  const run = async (work: (signal: AbortSignal) => Promise<string | null>) => {
    if (!active || action.current || shownEpoch !== readEpoch.current) return;
    const controller = new AbortController();
    action.current = controller;
    setBusy(true);
    setNotice('');
    let changed = true;
    try {
      const text = await work(controller.signal);
      if (action.current !== controller) return;
      if (text === null) changed = false;
      else setNotice(text);
    } catch (reason) {
      if (action.current === controller) setNotice(worktreeFailureText(worktreeFailure(reason)));
    } finally {
      if (action.current === controller) {
        action.current = null;
        setBusy(false);
        if (changed || controller.signal.aborted) refresh();
      }
    }
  };
  const prune = () => run(async () => pruneReportText(await invokeWorktree('pruneWorktrees')));
  const remove = (row: DesktopManagedWorktreeRow) =>
    run(async (signal) => {
      const name = row.branch || row.id;
      if (
        !(await confirmAction(t('Delete worktree {{branch}}?\nIts folder is deleted.', { branch: name }), {
          danger: true,
          confirmLabel: t('Delete'),
          key: `worktree-delete:${row.id}`,
          signal,
        })) ||
        signal.aborted
      ) {
        return null;
      }
      type Deleted = {
        removed?: {
          branchDeleted?: boolean;
          preservedBranch?: { name: string; head: string };
          recoveryRefs?: string[];
        };
      };
      let deleted: Deleted;
      try {
        deleted = await invokeWorktree<Deleted>('deleteWorktree', [{ entryId: row.id }]);
      } catch (reason) {
        const failure = worktreeFailure(reason);
        if (failure.code !== 'WORKTREE_DIRTY' && failure.code !== 'WORKTREE_UNMERGED') throw reason;
        if (signal.aborted) return null;
        const forced = await confirmAction(
          t(
            'Delete anyway?\n{{branch}} has uncommitted or unmerged work. Uncommitted changes are lost. A branch created by the app is deleted once git considers it merged, and its commits stay reachable; any other branch is kept.',
            { branch: name }
          ),
          { danger: true, confirmLabel: t('Delete anyway'), key: `worktree-force-delete:${row.id}`, signal }
        );
        if (!forced || signal.aborted) return null;
        deleted = await invokeWorktree<Deleted>('deleteWorktree', [{ entryId: row.id, force: true }]);
      }
      const kept = deleted?.removed?.preservedBranch;
      const message = kept
        ? t(
            'Deleted worktree {{branch}}. Its branch {{kept}} was kept: only a branch created by the app is deleted automatically, once git considers it merged. Delete it from the branch menu.',
            { branch: name, kept: kept.name }
          )
        : deleted?.removed?.branchDeleted
          ? t(
              'Deleted worktree {{branch}} and the branch created for it, which git considers merged; its commits stay reachable.',
              { branch: name }
            )
          : t('Deleted worktree {{branch}}.', { branch: name });
      const refs = deleted?.removed?.recoveryRefs ?? [];
      return refs.length ? `${message} ${t('Its commits are kept at {{refs}}.', { refs: refs.join(', ') })}` : message;
    });

  const projects = [...new Set((rows ?? []).map((row) => row.projectPath))];
  const destructiveDisabled = !active || busy || shownEpoch !== readEpoch.current;
  const title =
    projects.length === 1
      ? t('Worktree list · {{project}}', { project: projectName(projects[0]) })
      : t('Worktree list');
  return (
    <section className="settings-group worktree-list">
      <header>
        <div className="settings-group-head">
          <h3>{title}</h3>
          <ActionButton disabled={busy || reading} onClick={refresh}>
            {t('Refresh')}
          </ActionButton>
          <ActionButton disabled={destructiveDisabled} onClick={() => void prune()}>
            {t('Clean up now')}
          </ActionButton>
        </div>
      </header>
      <div className="settings-group-body">
        {readError !== null && (
          <p className="settings-error" role="status">
            {t('Could not refresh the worktree list.')} {readError}
          </p>
        )}
        {notice && (
          <p className="worktree-list-notice" role="status">
            {notice}
          </p>
        )}
        {rows === null ? (
          readError === null && <ListEmpty text={t('Loading worktrees…')} />
        ) : rows.length === 0 ? (
          readError === null && <ListEmpty text={t('No worktrees.')} />
        ) : (
          <table className="worktree-table" aria-label={title}>
            <thead>
              <tr>
                <th>{t('Branch')}</th>
                <th>{t('Session')}</th>
                <th>{t('State')}</th>
                <th className="num">{t('Size')}</th>
                <th className="num">{t('Actions')}</th>
              </tr>
            </thead>
            {projects.map((project) => (
              <tbody key={project}>
                {projects.length > 1 && (
                  <tr className="worktree-table-project">
                    <th colSpan={5} scope="rowgroup" title={project}>
                      {projectName(project)}
                    </th>
                  </tr>
                )}
                {(rows ?? [])
                  .filter((row) => row.projectPath === project)
                  .map((row) => (
                    <WorktreeRow
                      key={row.id}
                      row={row}
                      settings={settings}
                      busy={busy || reading || readError !== null}
                      deleteDisabled={destructiveDisabled}
                      onDelete={() => void remove(row)}
                    />
                  ))}
              </tbody>
            ))}
          </table>
        )}
      </div>
    </section>
  );
}

function WorktreeRow({
  row,
  settings,
  busy,
  deleteDisabled,
  onDelete,
}: {
  row: DesktopManagedWorktreeRow;
  settings: DesktopWorktreeSettings | null;
  busy: boolean;
  deleteDisabled: boolean;
  onDelete(): void;
}) {
  const state = worktreeRowState(row, settings);
  const size =
    typeof row.sizeBytes === 'number'
      ? `${row.sizeComplete === false ? '≥ ' : ''}${formatByteSize(row.sizeBytes) || '0 B'}`
      : '—';
  const owner = row.retained ? row.ownerSessionId : null;
  return (
    <tr>
      <td className="worktree-branch" title={row.path}>
        {row.branch || row.id}
      </td>
      <td>
        {owner && row.ownerArchived ? (
          <span className="worktree-session-other">{t('Archived')}</span>
        ) : owner ? (
          <button type="button" className="worktree-session-link" onClick={() => requestOpenSession(owner)}>
            {row.ownerTitle || t('Untitled session')}
          </button>
        ) : (
          <span className="worktree-session-other">{t('Ended session')}</span>
        )}
      </td>
      <td className={`worktree-state is-${state.kind}`}>{state.text}</td>
      <td className="num">{size}</td>
      <td>
        <div className="worktree-actions">
          <ActionButton
            disabled={busy || row.state !== 'ready' || !row.branch}
            onClick={() => requestNewTaskInWorktree({ projectPath: row.projectPath, branch: row.branch })}
          >
            {t('Open new session here')}
          </ActionButton>
          <ActionButton danger disabled={deleteDisabled || row.ownerLive} onClick={onDelete}>
            {t('Delete')}
          </ActionButton>
        </div>
      </td>
    </tr>
  );
}
