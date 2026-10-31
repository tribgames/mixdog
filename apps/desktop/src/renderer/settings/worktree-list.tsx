// Settings → Worktrees: every managed worktree with its branch, owner
// session, state and size; "Open new session here", "Delete" and the manual
// "Clean up now" (pruneWorktrees).
import { useCallback, useEffect, useRef, useState } from 'react';

import type { DesktopManagedWorktreeRow, DesktopWorktreeSettings } from '../../shared/contract';
import { confirmAction } from '../app-confirm';
import { t } from '../i18n';
import {
  formatByteSize,
  invokeWorktree,
  pruneReportText,
  worktreeFailure,
  worktreeFailureText,
} from '../worktree-branch-model';
import { requestNewTaskInWorktree, requestOpenSession } from '../worktree-session-events';
import { ActionButton, ListEmpty } from './capability-controls';
import { useWorktreeSettings } from './worktree-settings';

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
  const next =
    settings?.autoCleanup === true &&
    !row.sharedSessionIds?.length &&
    (!row.retained || (row.ownerArchived === true && settings.cleanupArchived));
  return { kind: 'ok', text: next ? t('Merged · deleted at next cleanup') : t('Merged · kept') };
}

export function WorktreeList({ active = true }: { active?: boolean }) {
  const settings = useWorktreeSettings(active);
  const [rows, setRows] = useState<DesktopManagedWorktreeRow[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const reads = useRef(0);
  const load = useCallback(async () => {
    const read = ++reads.current;
    try {
      const value = await invokeWorktree<DesktopManagedWorktreeRow[]>('listWorktrees');
      if (read === reads.current) setRows(Array.isArray(value) ? value : []);
    } catch (reason) {
      if (read === reads.current) {
        setRows([]);
        setNotice(worktreeFailureText(worktreeFailure(reason)));
      }
    }
  }, []);
  useEffect(() => {
    if (active) void load();
  }, [active, load]);

  /** One action; `null` from `work` means the user cancelled and nothing
   *  changed, so the list is not read again. */
  const run = async (work: () => Promise<string | null>) => {
    if (busy) return;
    setBusy(true);
    setNotice('');
    let changed = true;
    try {
      const text = await work();
      if (text === null) changed = false;
      else setNotice(text);
    } catch (reason) {
      setNotice(worktreeFailureText(worktreeFailure(reason)));
    } finally {
      setBusy(false);
    }
    if (changed) await load();
  };
  const prune = () => run(async () => pruneReportText(await invokeWorktree('pruneWorktrees')));
  const remove = (row: DesktopManagedWorktreeRow) =>
    run(async () => {
      const name = row.branch || row.id;
      if (
        !(await confirmAction(t('Delete worktree {{branch}}?\nIts folder is deleted.', { branch: name }), {
          danger: true,
          confirmLabel: t('Delete'),
          key: `worktree-delete:${row.id}`,
        }))
      ) {
        return null;
      }
      try {
        await invokeWorktree('deleteWorktree', [{ entryId: row.id }]);
      } catch (reason) {
        const failure = worktreeFailure(reason);
        if (failure.code !== 'WORKTREE_DIRTY' && failure.code !== 'WORKTREE_UNMERGED') throw reason;
        const forced = await confirmAction(
          t(
            'Delete anyway?\n{{branch}} has uncommitted or unmerged work. Uncommitted changes are lost; its last commit stays under refs/mixdog/removed/{{id}}.',
            { branch: name, id: row.id }
          ),
          { danger: true, confirmLabel: t('Delete anyway'), key: `worktree-force-delete:${row.id}` }
        );
        if (!forced) return null;
        await invokeWorktree('deleteWorktree', [{ entryId: row.id, force: true }]);
      }
      return t('Deleted worktree {{branch}}.', { branch: name });
    });

  const projects = [...new Set((rows ?? []).map((row) => row.projectPath))];
  const title =
    projects.length === 1
      ? t('Worktree list · {{project}}', { project: projectName(projects[0]) })
      : t('Worktree list');
  return (
    <section className="settings-group worktree-list">
      <header>
        <div className="settings-group-head">
          <h3>{title}</h3>
          <ActionButton disabled={busy || rows === null} onClick={() => void prune()}>
            {t('Clean up now')}
          </ActionButton>
        </div>
      </header>
      <div className="settings-group-body">
        {notice && (
          <p className="worktree-list-notice" role="status">
            {notice}
          </p>
        )}
        {rows === null ? (
          <ListEmpty text={t('Loading worktrees…')} />
        ) : rows.length === 0 ? (
          <ListEmpty text={t('No worktrees.')} />
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
                      busy={busy}
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
  onDelete,
}: {
  row: DesktopManagedWorktreeRow;
  settings: DesktopWorktreeSettings | null;
  busy: boolean;
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
          <ActionButton danger disabled={busy || row.ownerLive} onClick={onDelete}>
            {t('Delete')}
          </ActionButton>
        </div>
      </td>
    </tr>
  );
}
