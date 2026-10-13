import { useCallback, useState } from 'react';
import type { ProjectRecoveryRequest, ProjectRecoveryDetail } from '../shared/project-recovery';
import { ProjectRecoveryPanel, type ProjectRecoveryLabels } from './ProjectRecoveryPanel';
import { t } from './i18n';

export function ProjectRecoverySurface({
  projectPath,
  onOpenFile,
}: {
  projectPath: string;
  onOpenFile(project: string, rel: string, mode?: 'preview' | 'pinned'): void;
}) {
  const [open, setOpen] = useState(false);
  const api = window.mixdogDesktop;
  const request = useCallback(
    (project: string, input: ProjectRecoveryRequest) => {
      if (!api?.projectRecovery) return Promise.reject(new Error('Recovery is not supported by this host.'));
      return api.projectRecovery(project, input);
    },
    [api]
  );
  const confirm = useCallback(
    async (action: 'restore' | 'discard', detail: ProjectRecoveryDetail) => {
      const warning =
        action === 'restore'
          ? t('Restore unchanged batch files? External changes will be preserved.')
          : t('Discard this recovery record and its backups? Project files will not be deleted.');
      const files = action === 'restore' ? detail.files.filter((file) => file.status === 'written') : detail.files;
      return window.confirm(
        `${warning}\n\n${projectPath}\n${detail.id}\n${files.length}\n${files
          .slice(0, 10)
          .map((file) => file.relPath)
          .join('\n')}${files.length > 10 ? '\n…' : ''}`
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
  return (
    <details
      style={{ padding: '8px 12px', overflowWrap: 'anywhere' }}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>{labels.title}</summary>
      {open && (
        <ProjectRecoveryPanel
          key={projectPath}
          projectPath={projectPath}
          request={request}
          confirm={confirm}
          labels={labels}
          openFile={(project, rel) => onOpenFile(project, rel, 'pinned')}
        />
      )}
    </details>
  );
}
