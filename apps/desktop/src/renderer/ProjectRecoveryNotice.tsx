import { useState } from 'react';
import { recoveryFailureCode, recoveryFailureRecord } from '../shared/project-recovery';
import { ProjectRecoverySurface } from './ProjectRecoverySurface';
import { t } from './i18n';

/** Error markers locate a record for inspection, not authorization to restore. */
export function ProjectRecoveryNotice({ projectPath, message, onOpenFile }: {
  projectPath: string;
  message: string;
  onOpenFile(project: string, rel: string): void;
}) {
  const [open, setOpen] = useState(false);
  const id = recoveryFailureRecord({ message });
  const code = recoveryFailureCode({ message });
  if (!id && !code) return null;
  return <aside>
    <button type="button" onClick={() => setOpen(true)}>{t('Inspect file recovery')}</button>
    {open && <ProjectRecoverySurface initiallyOpen projectPath={projectPath} initialRecordId={id ?? undefined} onOpenFile={onOpenFile} />}
  </aside>;
}
