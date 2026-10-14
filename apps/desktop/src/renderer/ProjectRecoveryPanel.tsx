import { useEffect, useRef, useState } from 'react';
import { recoveryFailureCode, type RecoveryErrorCode } from '../shared/project-recovery';
import type {
  ProjectRecoveryDetail,
  ProjectRecoveryFileStatus,
  ProjectRecoveryRequest,
  ProjectRecoveryResponse,
  ProjectRecoverySummary,
} from '../shared/project-recovery';

// The owning surface supplies localized labels and its normal confirmation
// dialog. This component does not grant access, parse error messages, or write
// files itself. The host must revalidate the approved revision before mutation.
export interface ProjectRecoveryLabels {
  title: string;
  refresh: string;
  empty: string;
  inspect: string;
  openFile: string;
  restore: string;
  discard: string;
  busy: string;
  observationWarning: string;
  failure: string;
  failures?: Partial<Record<RecoveryErrorCode, string>>;
  phases: Record<ProjectRecoverySummary['phase'], string>;
  statuses: Record<ProjectRecoveryFileStatus, string>;
}

export interface ProjectRecoveryPanelProps {
  projectPath: string;
  initialRecordId?: string;
  request(projectPath: string, request: ProjectRecoveryRequest): Promise<ProjectRecoveryResponse>;
  confirm(action: 'restore' | 'discard', detail: ProjectRecoveryDetail): Promise<boolean>;
  openFile(projectPath: string, relPath: string): void;
  labels: ProjectRecoveryLabels;
}

export function recoveryMayRestore(detail: ProjectRecoveryDetail): boolean {
  return (
    !detail.active &&
    !['active', 'invalid', 'completed', 'retired'].includes(detail.phase) &&
    detail.files.some((file) => file.status === 'written')
  );
}

export function ProjectRecoveryPanel({ projectPath, initialRecordId, request, confirm, openFile, labels }: ProjectRecoveryPanelProps) {
  const [records, setRecords] = useState<ProjectRecoverySummary[]>([]);
  const [detail, setDetail] = useState<ProjectRecoveryDetail | null>(null);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);
  const failed = failure !== null;
  const epoch = useRef(0);
  const lock = useRef(false);
  const currentProject = useRef(projectPath);
  currentProject.current = projectPath;

  useEffect(() => {
    const ownEpoch = ++epoch.current;
    lock.current = false;
    setRecords([]);
    setDetail(null);
    setFailure(null);
    setPending(true);
    void request(projectPath, initialRecordId ? { action: 'inspect', id: initialRecordId } : { action: 'list' })
      .then(
        (result) => {
          if (epoch.current === ownEpoch) {
            setRecords(result.records);
            setDetail(result.detail ?? null);
          }
        },
        (error) => {
          if (epoch.current === ownEpoch) setFailure(error ?? new Error());
        }
      )
      .finally(() => {
        if (epoch.current === ownEpoch) setPending(false);
      });
    return () => {
      epoch.current++;
    };
  }, [projectPath, initialRecordId, request]);

  const invoke = async (input: ProjectRecoveryRequest): Promise<void> => {
    if (lock.current) return;
    lock.current = true;
    const ownEpoch = ++epoch.current;
    setPending(true);
    setFailure(null);
    // Never retain an old approval after a failed refresh or inspect request.
    setDetail(null);
    try {
      const result = await request(projectPath, input);
      if (epoch.current !== ownEpoch || currentProject.current !== projectPath) return;
      setRecords(result.records);
      setDetail(result.detail ?? null);
    } catch (error) {
      if (epoch.current === ownEpoch) setFailure(error ?? new Error());
    } finally {
      if (epoch.current === ownEpoch) {
        lock.current = false;
        setPending(false);
      }
    }
  };

  const mutate = async (action: 'restore' | 'discard'): Promise<void> => {
    if (!detail || detail.active || pending || lock.current) return;
    if (action === 'restore' && !recoveryMayRestore(detail)) return;
    lock.current = true;
    const inspected = detail;
    const ownEpoch = ++epoch.current;
    setPending(true);
    setFailure(null);
    try {
      const approved = await confirm(action, inspected);
      if (epoch.current !== ownEpoch || currentProject.current !== projectPath) return;
      if (!approved) return;
      setDetail(null);
      const result = await request(projectPath, { action, id: inspected.id, revision: inspected.revision });
      if (epoch.current !== ownEpoch || currentProject.current !== projectPath) return;
      setRecords(result.records);
      setDetail(result.detail ?? null);
    } catch (error) {
      if (epoch.current === ownEpoch) {
        setDetail(null);
        setFailure(error ?? new Error());
      }
    } finally {
      if (epoch.current === ownEpoch) {
        lock.current = false;
        setPending(false);
      }
    }
  };

  return (
    <section aria-label={labels.title} aria-busy={pending}>
      <header>
        <h3>{labels.title}</h3>
        <button type="button" disabled={pending} onClick={() => void invoke({ action: 'list' })}>
          {labels.refresh}
        </button>
      </header>
      {pending && <p role="status">{labels.busy}</p>}
      {failed && <p role="alert">{labels.failures?.[recoveryFailureCode(failure)!] ?? labels.failure}</p>}
      {!pending && !failed && !records.length && <p>{labels.empty}</p>}
      <ul>
        {records.map((record) => (
          <li key={record.id}>
            <span>
              {labels.phases[record.phase]} · {record.fileCount}
            </span>{' '}
            {record.createdAt > 0 && (
              <time dateTime={new Date(record.createdAt).toISOString()}>
                {new Date(record.createdAt).toLocaleString()}
              </time>
            )}{' '}
            <button
              type="button"
              disabled={pending || record.phase === 'active'}
              onClick={() => void invoke({ action: 'inspect', id: record.id })}
            >
              {labels.inspect}
            </button>
          </li>
        ))}
      </ul>
      {detail && (
        <div>
          <p>{labels.observationWarning}</p>
          {detail.message && <p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{detail.message}</p>}
          <ul>
            {detail.files.map((file) => (
              <li key={file.relPath}>
                <code style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{file.relPath}</code>{' '}
                <strong>{labels.statuses[file.status]}</strong>{' '}
                {file.reason && <span style={{ overflowWrap: 'anywhere' }}>{file.reason}</span>}{' '}
                <button
                  type="button"
                  disabled={pending || file.status === 'missing' || file.status === 'unavailable'}
                  onClick={() => openFile(projectPath, file.relPath)}
                >
                  {labels.openFile}
                </button>
              </li>
            ))}
          </ul>
          <button
            type="button"
            disabled={pending || !recoveryMayRestore(detail)}
            onClick={() => void mutate('restore')}
          >
            {labels.restore}
          </button>{' '}
          <button type="button" disabled={pending || detail.active} onClick={() => void mutate('discard')}>
            {labels.discard}
          </button>
        </div>
      )}
    </section>
  );
}
