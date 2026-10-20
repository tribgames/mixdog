import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  ProjectRecoveryRequest,
  ProjectRecoveryDetail,
  ProjectRecoveryResponse,
} from '../shared/project-recovery';
import { ProjectRecoveryPanel, type ProjectRecoveryLabels } from './ProjectRecoveryPanel';
import { confirmAction } from './app-confirm';
import { t } from './i18n';
import { recoveryFailureCode } from '../shared/project-recovery';

export function ProjectRecoverySurface({
  projectPath,
  onOpenFile,
  initialRecordId,
  initiallyOpen = false,
}: {
  projectPath: string;
  initialRecordId?: string;
  initiallyOpen?: boolean;
  onOpenFile(project: string, rel: string, mode?: 'preview' | 'pinned'): void;
}) {
  const [open, setOpen] = useState(initiallyOpen || Boolean(initialRecordId));
  const [overview, setOverview] = useState<ProjectRecoveryResponse | null>(null);
  const [failure, setFailure] = useState<unknown>(null);
  const unavailable = failure !== null;
  const [refreshing, setRefreshing] = useState(true);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const refreshDiscovery = useRef<(() => void) | null>(null);
  const generation = useRef(0);
  const api = window.mixdogDesktop;
  const request = useCallback(
    (project: string, input: ProjectRecoveryRequest) => {
      if (!api?.projectRecovery) return Promise.reject(new Error('Recovery is not supported by this host.'));
      const ticket = ++generation.current;
      return api.projectRecovery(project, input).then(
        (result) => {
          if (ticket === generation.current) {
            setOverview(result);
            setFailure(null);
          }
          return result;
        },
        (error) => {
          if (ticket === generation.current) {
            setOverview(null);
            setFailure(error ?? new Error());
          }
          throw error;
        }
      );
    },
    [api]
  );
  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let pending = false;
    let again = false;
    setOverview(null);
    setFailure(null);
    setOpen(initiallyOpen || Boolean(initialRecordId));
    setRefreshVersion(0);
    const refresh = async () => {
      if (disposed || !api?.projectRecovery) return;
      if (pending) {
        again = true;
        return;
      }
      pending = true;
      // Unmount the open panel before discovery, invalidating its observations
      // and in-flight approvals even when the refresh fails or is still pending.
      setRefreshing(true);
      setRefreshVersion((version) => version + 1);
      try {
        await request(projectPath, { action: 'list' });
      } catch {
        /* The request publishes an unavailable state, never an empty inventory. */
      } finally {
        pending = false;
        if (!disposed) setRefreshing(false);
        if (again && !disposed) {
          again = false;
          void refresh();
        }
      }
    };
    refreshDiscovery.current = () => void refresh();
    // Discovery reads bounded manifest metadata only. It never inspects target
    // files, accepts a mutation, or takes focus away from an editor.
    void refresh();
    const focus = () => void refresh();
    window.addEventListener('focus', focus);
    const off = api?.subscribeFolderChanges?.((dir) => {
      if (dir !== projectPath) return;
      clearTimeout(timer);
      timer = setTimeout(focus, 250);
    });
    return () => {
      disposed = true;
      refreshDiscovery.current = null;
      generation.current++;
      clearTimeout(timer);
      window.removeEventListener('focus', focus);
      off?.();
    };
  }, [api, projectPath, initialRecordId, initiallyOpen, request]);
  const confirm = useCallback(
    async (action: 'restore' | 'discard', detail: ProjectRecoveryDetail) => {
      const warning =
        action === 'restore'
          ? t('Restore unchanged batch files? External changes will be preserved.')
          : t('Discard this recovery record and its backups? Project files will not be deleted.');
      const files = action === 'restore' ? detail.files.filter((file) => file.status === 'written') : detail.files;
      return confirmAction(
        `${warning}\n\n${projectPath}\n${detail.id}\n${files.length}\n${files
          .slice(0, 10)
          .map((file) => file.relPath)
          .join('\n')}${files.length > 10 ? '\n…' : ''}`,
        { danger: action === 'discard', confirmLabel: action === 'restore' ? t('Restore') : t('Discard') }
      );
    },
    [projectPath]
  );
  if (!api?.projectRecovery) return null;
  const labels: ProjectRecoveryLabels = {
    title: t('File recovery'),
    refresh: t('Refresh'),
    empty: t('No file recovery records.'),
    inspect: t('Inspect'),
    openFile: t('Open'),
    restore: t('Restore'),
    discard: t('Delete'),
    busy: t('Loading…'),
    observationWarning: t('Observed state. Recovery rechecks files; unsaved editor buffers are not replaced.'),
    failure: t('Recovery request failed. Refresh before retrying.'),
    failures: {
      RECOVERY_CHANGED: t('Recovery changed. Inspect again before confirming.'),
      RECOVERY_BUSY: t('A running operation owns this record. Retry after it finishes.'),
      RECOVERY_CAPACITY: t('Recovery storage is full. Inspect and explicitly delete records before editing again.'),
      RECOVERY_BATCH_LIMIT: t('This edit exceeds recovery limits. Split it into smaller edits.'),
      RECOVERY_STORAGE: t(
        'Recovery storage could not be read or written. Check disk space and permissions before retrying.'
      ),
      RECOVERY_NOT_RESTORABLE: t('This record cannot restore files. Inspect it before deleting its backups.'),
      RECOVERY_UNAVAILABLE: t('Recovery record unavailable. Refresh the list.'),
      RECOVERY_MANUAL_INSPECTION: t(
        'Recovery storage contains unrecognized entries. Inspect the host recovery folder manually.'
      ),
    },
    phases: {
      interrupted: t('Interrupted'),
      failed: t('Failed'),
      recovered: t('Restored'),
      completed: t('Completed'),
      active: t('Running'),
      invalid: t('Invalid'),
      retired: t('Ready to delete'),
    },
    statuses: {
      original: t('Original'),
      written: t('Unrestored'),
      restored: t('Restored'),
      external: t('External change'),
      missing: t('Missing'),
      unavailable: t('Unavailable'),
    },
  };
  const needsReview = overview?.records.some((record) => !['completed', 'recovered', 'retired'].includes(record.phase));
  return (
    <details
      style={{ padding: '8px 12px', overflowWrap: 'anywhere' }}
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        {labels.title}
        {overview?.records.length ? ` · ${overview.records.length}` : ''}
        {needsReview ? ` · ${t('Review required')}` : ''}
        {unavailable ? ` · ${t('Unavailable')}` : ''}
      </summary>
      {unavailable && <p role="status">{labels.failures?.[recoveryFailureCode(failure)!] ?? labels.failure}</p>}
      {open && refreshing && <p role="status">{labels.busy}</p>}
      {open && unavailable && !refreshing && (
        <button type="button" onClick={() => refreshDiscovery.current?.()}>
          {labels.refresh}
        </button>
      )}
      {needsReview && (
        <p role="status">{t('File recovery records need review. No files are restored automatically.')}</p>
      )}
      {open && overview?.rootAvailable === false && (
        <p role="alert">
          {t('Project folder is missing or unavailable. Backups remain; inspect the record before deleting it.')}
        </p>
      )}
      {open && overview?.storage && (
        <div className="project-recovery-inventory">
          <p>
            {t('Recovery records: {{used}} / {{limit}} · Need review: {{unresolved}} · Resolved: {{resolved}}', {
              used: overview.storage.usedRecords,
              limit: overview.storage.maxRecords,
              unresolved: overview.storage.unresolvedRecords,
              resolved: overview.storage.resolvedRecords,
            })}
          </p>
          <p>
            {t(
              'Recorded payload: {{bytes}} MiB · Unknown-size records: {{unknown}} · Per edit: {{files}} files / {{limit}} MiB',
              {
                bytes: (overview.storage.payloadBytes / 1048576).toFixed(2),
                unknown: overview.storage.unknownSizeRecords,
                files: overview.storage.maxBatchFiles,
                limit: overview.storage.maxBatchBytes / 1048576,
              }
            )}
          </p>
          {overview.storage.usedRecords >= overview.storage.maxRecords && (
            <p role="alert">{labels.failures?.RECOVERY_CAPACITY}</p>
          )}
        </div>
      )}
      {open && !refreshing && !unavailable && (
        <ProjectRecoveryPanel
          key={`${projectPath}:${refreshVersion}`}
          projectPath={projectPath}
          initialRecordId={refreshVersion === 1 ? initialRecordId : undefined}
          request={request}
          confirm={confirm}
          labels={labels}
          openFile={(project, rel) => onOpenFile(project, rel, 'pinned')}
        />
      )}
    </details>
  );
}
