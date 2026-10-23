import type { DesktopSshConfigSummary, DesktopSshPhase } from '../../shared/contract-ssh';
import { t } from '../i18n';
import { ConfirmDialog, ConnDialog } from './connection-dialogs';
import type { View } from './ssh-connect-view';
import { guidance } from './ssh-guidance';

type StepKey = 'connect' | 'check' | 'install' | 'link';
type StepState = 'done' | 'now' | 'wait';

const PHASE_STEP: Record<DesktopSshPhase, number> = { connect: 0, check: 1, install: 2, start: 3, ready: 3 };

/** The progress list (C1). The Mixdog install step is shown only when the
 *  server actually installs; later connections skip it. */
export function sshProgressSteps(
  phase: DesktopSshPhase,
  sawInstall: boolean
): Array<{ key: StepKey; state: StepState }> {
  const at = PHASE_STEP[phase];
  const keys: StepKey[] =
    at >= 3 && !sawInstall ? ['connect', 'check', 'link'] : ['connect', 'check', 'install', 'link'];
  const order: Record<StepKey, number> = { connect: 0, check: 1, install: 2, link: 3 };
  return keys.map((key) => {
    let state: StepState = 'wait';
    if (order[key] < at || phase === 'ready') state = 'done';
    else if (order[key] === at) state = 'now';
    return { key, state };
  });
}

function stepLabel(key: StepKey): string {
  if (key === 'connect') return t('Reach the server');
  if (key === 'check') return t('Check the server');
  if (key === 'install') return t('Install Mixdog');
  return t('Connect');
}

function ProgressSteps({ view }: { view: Extract<View, { kind: 'steps' }> }) {
  return (
    <ol className="conn-steps">
      {sshProgressSteps(view.phase, view.sawInstall).map(({ key, state }, index) => {
        let small = '';
        if (key === 'check' && state !== 'wait' && view.details.check) small = `Node.js ${view.details.check}`;
        else if (key === 'install' && state !== 'wait') small = t('First time only');
        return (
          <li key={key} data-n={index + 1} data-state={state}>
            <span>
              {stepLabel(key)}
              {small && <small>{small}</small>}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/** What `ssh -G` resolved the address to. */
export function SummaryRows({ summary }: { summary: DesktopSshConfigSummary | null }) {
  if (!summary) return null;
  return (
    <dl className="conn-kv">
      <dt>{t('Server')}</dt>
      <dd>{summary.hostName}</dd>
      {summary.user && (
        <>
          <dt>{t('User')}</dt>
          <dd>{summary.user}</dd>
        </>
      )}
      <dt>{t('Port')}</dt>
      <dd>{summary.port}</dd>
      {(summary.proxyJump || summary.proxyCommand) && (
        <>
          <dt>{t('Via')}</dt>
          <dd>{summary.proxyJump ?? t('Proxy command')}</dd>
        </>
      )}
    </dl>
  );
}

/** Cancels the attempt and closes the dialog. */
export function CancelButton({ onCancel }: { onCancel(): void }) {
  return (
    <button type="button" className="conn-btn" onClick={onCancel}>
      {t('Cancel')}
    </button>
  );
}

/** The link back to the address field. */
export function EditAddressLink({ onEdit }: { onEdit(): void }) {
  return (
    <button type="button" className="conn-link" onClick={onEdit}>
      {t('Edit address')}
    </button>
  );
}

/** C1: the connection in progress. */
export function SshStepsDialog({
  view,
  shown,
  summary,
  onEdit,
  onCancel,
}: {
  view: Extract<View, { kind: 'steps' }>;
  shown: { target: string; name: string };
  summary: DesktopSshConfigSummary | null;
  onEdit(): void;
  onCancel(): void;
}) {
  return (
    <ConnDialog
      viewKey="steps"
      title={t('Connecting to {{name}}', { name: shown.name })}
      description={shown.target}
      scrimCloses={false}
      onEscape={onCancel}
      footer={
        <>
          <EditAddressLink onEdit={onEdit} />
          <span className="conn-grow" />
          <CancelButton onCancel={onCancel} />
          <button type="button" className="conn-btn conn-btn--primary" disabled>
            {t('Connecting…')}
          </button>
        </>
      }
    >
      <ProgressSteps view={view} />
      <SummaryRows summary={summary} />
      <div className="conn-field-msg conn-field-msg--busy" role="status">
        {view.phase === 'install' ? (
          <>
            <span className="conn-spinner" aria-hidden="true" />
            {t('The first time takes about a minute.')}
          </>
        ) : (
          '\u00a0'
        )}
      </div>
    </ConnDialog>
  );
}

/** The ssh config's own port forwards, shown once before the connection goes on. */
export function SshForwardsDialog({
  forwards,
  name,
  onContinue,
  onCancel,
}: {
  forwards: string[];
  name: string;
  onContinue(): void;
  onCancel(): void;
}) {
  return (
    <ConnDialog
      viewKey="forwards"
      title={t('Port forwards in your ssh config')}
      description={t(
        'Your ssh config forwards ports for {{name}}, and Mixdog could not set them aside for this connection. If you continue, these forwards also run while connected:',
        { name }
      )}
      role="alertdialog"
      scrimCloses={false}
      onEscape={onCancel}
      footer={
        <>
          <span className="conn-grow" />
          <CancelButton onCancel={onCancel} />
          <button type="button" className="conn-btn conn-btn--primary" onClick={onContinue}>
            {t('Continue')}
          </button>
        </>
      }
    >
      <ul className="ssh-forwards">
        {forwards.map((line) => (
          <li key={line}>
            <code>{line}</code>
          </li>
        ))}
      </ul>
    </ConnDialog>
  );
}

/** Another Mixdog is running on the server: the user confirms stopping (or restarting) it. */
export function SshDaemonDialog({
  view,
  name,
  onConfirm,
  onDismiss,
}: {
  view: Extract<View, { kind: 'daemon' }>;
  name: string;
  onConfirm(): void;
  onDismiss(): void;
}) {
  return (
    <ConfirmDialog
      title={view.busy ? t('Restart Mixdog on the server?') : t('Stop Mixdog on the server?')}
      description={
        view.busy
          ? t(
              '{{name}} runs a Mixdog of another version that is working or has other PCs connected. To connect from this PC it must be restarted, and its running work stops and other PCs are disconnected.',
              { name }
            )
          : t(
              'Another Mixdog (pid {{pid}}) is running on its own on {{name}}. To connect from this PC it must be stopped, and the work running in it stops too.',
              { pid: view.pid ?? 0, name }
            )
      }
      confirmLabel={view.busy ? t('Restart and connect') : t('Stop and connect')}
      onConfirm={onConfirm}
      onClose={onDismiss}
    />
  );
}

/** Why the connection stopped, with what to run to fix it. */
export function SshFailureDialog({
  view,
  name,
  hasLog,
  onEdit,
  onViewLog,
  onClose,
  onRetry,
}: {
  view: Extract<View, { kind: 'failure' }>;
  name: string;
  hasLog: boolean;
  onEdit(): void;
  onViewLog(): void;
  onClose(): void;
  onRetry(): void;
}) {
  const { title, description, body } = guidance(view.failure, name);
  return (
    <ConnDialog
      viewKey="failure"
      onEscape={onClose}
      title={title}
      description={description}
      footer={
        <>
          <EditAddressLink onEdit={onEdit} />
          {hasLog && (
            <button type="button" className="conn-link" onClick={onViewLog}>
              {t('View log')}
            </button>
          )}
          <span className="conn-grow" />
          <button type="button" className="conn-btn" onClick={onClose}>
            {t('Close')}
          </button>
          {view.failure.kind !== 'already-connected' && (
            <button type="button" className="conn-btn conn-btn--primary" onClick={onRetry}>
              {t('Try again')}
            </button>
          )}
        </>
      }
    >
      {body}
      {view.failure.code && (
        <p className="conn-note ssh-error-code">{t('Error code: {{code}}', { code: view.failure.code })}</p>
      )}
    </ConnDialog>
  );
}
