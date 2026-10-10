import { useState, type ReactNode } from 'react';
import { RotateCcw, Square, Trash2, X } from 'lucide-react';
import { t } from '../i18n';
import { record } from '../record-utils';
import type { RecordValue } from './capability-data';
import { SettingsConfirmDialog } from './capability-controls';
import { ExtensionAction } from './extension-detail';
import type { LocalProviderActions } from './local-provider-actions';
import { LocalProviderContext, contextSize } from './local-provider-context';
import { installationActive, installationPercent, localProviderFileSize } from './local-provider-status';

type Confirmation = Parameters<typeof SettingsConfirmDialog>[0]['options'];
type Tone = 'ok' | 'warn' | 'danger' | 'muted';

/** One table row: an installed model, a model with an installation job, or
 *  the runtime download. Installing and failed work sits in the same list as
 *  the installed models, marked by its status. */
export interface LocalProviderTableRow {
  key: string;
  model: RecordValue | null;
  job: RecordValue | null;
}

const OPEN_JOB_STATES = ['running', 'cancelling', 'paused', 'failed'];

export function localProviderTableRows(status: RecordValue): LocalProviderTableRow[] {
  const models = Array.isArray(status.models) ? status.models.map(record) : [];
  const jobs = (Array.isArray(status.installations) ? status.installations.map(record) : []).filter((job) =>
    OPEN_JOB_STATES.includes(String(job.state))
  );
  const rows: LocalProviderTableRow[] = [];
  const runtime = jobs.find((job) => job.phase === 'runtime');
  if (runtime) rows.push({ key: 'runtime', model: null, job: runtime });
  for (const model of models) {
    const own = jobs.filter((job) => job.phase !== 'runtime' && job.modelId === model.id);
    const job = own.find(installationActive) || own[0] || null;
    if (model.installed === true || model.present === true || job) rows.push({ key: String(model.id), model, job });
  }
  return rows;
}

function rowState(row: LocalProviderTableRow, status: RecordValue, inUse: boolean): { label: string; tone: Tone } {
  const { model, job } = row;
  if (job) {
    if (job.state === 'cancelling') return { label: t('Stopping download…'), tone: 'muted' };
    if (installationActive(job)) {
      if (job.phase === 'verify') return { label: t('Verifying…'), tone: 'muted' };
      const percent = installationPercent(job);
      return { label: percent === null ? t('Installing…') : t('Installing {{percent}}%', { percent }), tone: 'muted' };
    }
    if (job.state === 'paused') return { label: t('Paused'), tone: 'warn' };
    return { label: job.phase === 'verify' ? t('Integrity check failed') : t('Installation failed'), tone: 'danger' };
  }
  if (model?.installed !== true) return { label: t('Needs repair'), tone: 'warn' };
  if (record(model.verification).valid === false) return { label: t('Integrity check failed'), tone: 'danger' };
  if (inUse && status.starting) return { label: t('Loading model…'), tone: 'muted' };
  if (inUse) return { label: t('Running'), tone: 'ok' };
  return { label: t('Installed'), tone: 'muted' };
}

function rowMeta(row: LocalProviderTableRow): string {
  const { model, job } = row;
  if (job?.state === 'paused') return t('Paused · downloaded files are kept');
  // A failure speaks through its status pill; its message is the pill's tooltip.
  if (job?.state === 'failed') return localProviderFileSize(model?.sizeBytes);
  if (job && installationActive(job)) {
    const received = localProviderFileSize(job.receivedBytes);
    const total = localProviderFileSize(job.totalBytes || model?.sizeBytes);
    return received && total ? `${received} / ${total}` : '';
  }
  if (!model) return '';
  const vram = localProviderFileSize(model.estimatedVramBytes);
  return [localProviderFileSize(model.sizeBytes), vram ? `VRAM ~${vram}` : ''].filter(Boolean).join(' · ');
}

const failureText = (error: unknown) => String(error || t('Failed')).replace(/^\[local-provider\]\s*/, '');

function IconAction({
  label,
  danger,
  disabled,
  onClick,
  children,
}: {
  label: string;
  danger?: boolean;
  disabled?: boolean;
  onClick(): void;
  children: ReactNode;
}) {
  return (
    <ExtensionAction ariaLabel={label} tooltip={label} danger={danger} disabled={disabled} onClick={onClick}>
      {children}
    </ExtensionAction>
  );
}

function TableRow({
  row,
  status,
  actions,
  confirm,
}: {
  row: LocalProviderTableRow;
  status: RecordValue;
  actions: LocalProviderActions;
  confirm(options: Confirmation): void;
}) {
  const { model, job } = row;
  const id = model ? String(model.id) : '';
  const name = model ? String(model.name || id) : t('Runtime');
  const inUse = Boolean(model) && status.activeModel === id && (status.running === true || status.starting === true);
  // A loaded model with no request in flight is unloaded by the deletion itself.
  const answering = inUse && (Number(status.activeRequests) > 0 || Number(status.queuedRequests) > 0);
  const state = rowState(row, status, inUse);
  const active = job ? installationActive(job) : false;
  const phase = String(job?.phase || '');
  const percent = job ? installationPercent(job) : null;
  const failure = job?.state === 'failed' ? failureText(job.error) : '';
  const meta = rowMeta(row);
  const usable = Boolean(model) && !job && model?.installed === true && record(model.verification).valid !== false;
  const requestDelete = async () => {
    const receipt = record(await actions.details(id));
    if (!receipt.confirmationToken || !Array.isArray(receipt.files)) return;
    const paths = receipt.files
      .map(record)
      .map((file) => String(file.path))
      .join('\n');
    confirm({
      title: t('Delete model?'),
      danger: true,
      confirmLabel: t('Delete'),
      description: [
        name,
        paths,
        t('Permanently deletes these files. Recovery requires downloading the model again.'),
        ...(inUse ? [t('The loaded model is unloaded first.')] : []),
      ].join('\n'),
      onConfirm: () => actions.deleteModel(String(receipt.confirmationToken)),
    });
  };
  const requestDiscard = () =>
    confirm({
      title: t('Discard installation?'),
      danger: true,
      confirmLabel: t('Discard'),
      description: `${name}\n${
        phase === 'verify'
          ? t('Removes this failed check from the list. Model files are not changed.')
          : t(
              'Removes this installation and deletes its partially downloaded files. Installing again starts the download over.'
            )
      }`,
      onConfirm: () => actions.discard(phase, id || undefined),
    });
  let controls: ReactNode = null;
  if (active) {
    controls = (
      <IconAction
        label={phase === 'verify' ? t('Stop') : t('Stop download')}
        disabled={actions.busy || job?.state === 'cancelling' || !job?.jobId}
        onClick={() => actions.cancel(String(job?.jobId))}
      >
        <Square aria-hidden="true" />
      </IconAction>
    );
  } else if (job) {
    controls = (
      <>
        <IconAction
          label={job.state === 'paused' ? t('Resume installation') : t('Retry')}
          disabled={actions.busy}
          onClick={() => actions.resume(phase, id || undefined)}
        >
          <RotateCcw aria-hidden="true" />
        </IconAction>
        <IconAction label={t('Discard')} danger disabled={actions.busy} onClick={requestDiscard}>
          <X aria-hidden="true" />
        </IconAction>
      </>
    );
  } else if (model) {
    controls = (
      <IconAction label={t('Delete')} danger disabled={actions.busy || answering} onClick={() => void requestDelete()}>
        <Trash2 aria-hidden="true" />
      </IconAction>
    );
  }
  return (
    <tr data-extension-item={name}>
      <td className="usage-provider-cell">
        <b title={name}>{name}</b>
        {meta ? <span title={meta}>{meta}</span> : null}
        {active && (
          <div
            className="local-provider-progress"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent ?? undefined}
            aria-valuetext={
              phase === 'verify' ? t('Verifying {{name}}…', { name }) : t('Installing {{name}}…', { name })
            }
            data-indeterminate={percent === null ? 'true' : undefined}
          >
            <i style={percent === null ? undefined : { width: `${percent}%` }} />
          </div>
        )}
      </td>
      <td>
        <span
          className="extensions-item-status local-provider-status"
          data-tone={state.tone}
          data-tooltip={failure || undefined}
          aria-description={failure || undefined}
        >
          <i aria-hidden="true" />
          {state.label}
        </span>
      </td>
      <td>
        {usable && model ? <LocalProviderContext model={model} actions={actions} /> : contextSize(model?.contextWindow)}
      </td>
      <td>
        <span className="local-provider-actions">{controls}</span>
      </td>
    </tr>
  );
}

/** Models and their installation work in one table, styled as the app's
 *  usage table: an emphasized header band over plain rows. */
export function LocalProviderTable({
  rows,
  status,
  actions,
}: {
  rows: LocalProviderTableRow[];
  status: RecordValue;
  actions: LocalProviderActions;
}) {
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  return (
    <>
      <div className="usage-table-shell local-provider-table-shell">
        <table className="usage-table local-provider-table" aria-label={t('Models')}>
          <thead>
            <tr>
              <th scope="col">{t('Model')}</th>
              <th scope="col">{t('Status')}</th>
              <th scope="col">{t('Context')}</th>
              <th scope="col" aria-label={t('Actions')} />
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <TableRow key={row.key} row={row} status={status} actions={actions} confirm={setConfirmation} />
            ))}
          </tbody>
        </table>
      </div>
      {confirmation && <SettingsConfirmDialog options={confirmation} onClose={() => setConfirmation(null)} />}
    </>
  );
}
