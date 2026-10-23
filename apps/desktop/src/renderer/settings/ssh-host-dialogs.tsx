import { type ReactNode, useEffect, useRef, useState } from 'react';

import type {
  DesktopSshCleanupProgress,
  DesktopSshFailure,
  DesktopSshHost,
  DesktopSshHostSettings,
  DesktopSshModelLogin,
  DesktopSshServerLogins,
} from '../../shared/contract-ssh';
import { errorMessage } from '../editor-pane-session-errors';
import { t } from '../i18n';
import { record } from '../record-utils';
import { providerLabel, rows, type CapabilityApi } from './capability-data';
import { ConfirmDialog, ConnDialog } from './connection-dialogs';
import { SshAskpassPrompt, useSshAskpass } from './ssh-askpass-prompt';
import { guidance, toGuidance } from './ssh-guidance';
import { SshServerLoginsDialog, useServerLogins } from './ssh-server-logins-dialog';

const KEY_FILE_EXAMPLE = '~/.ssh/id_ed25519';

function CheckRow({
  checked,
  onChange,
  children,
}: {
  checked: boolean;
  onChange(checked: boolean): void;
  children: ReactNode;
}) {
  return (
    <label className="ssh-check">
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.currentTarget.checked)} />
      <span>{children}</span>
    </label>
  );
}

type Provider = { id: string; label: string };

/** The providers enabled on this PC (signed in); null while they load. */
function useEnabledProviders(api: CapabilityApi): Provider[] | null {
  const [providers, setProviders] = useState<Provider[] | null>(null);
  useEffect(() => {
    let live = true;
    void Promise.resolve(api.readCapabilities?.([{ capability: 'getProviderSetup', args: [] }]))
      .then((results) => {
        if (!live) return;
        const setup = record(results?.[0]?.ok ? results[0].value : null);
        const enabled = [...rows(setup.oauth), ...rows(setup.api)].filter(
          (provider) => provider.authenticated === true
        );
        setProviders(enabled.map((provider) => ({ id: String(provider.id), label: providerLabel(provider) })));
      })
      .catch(() => live && setProviders([]));
    return () => {
      live = false;
    };
  }, [api]);
  return providers;
}

/** Which of this PC's models the server may use. */
function useModelAccess(api: CapabilityApi, settings: DesktopSshHostSettings | undefined) {
  const providers = useEnabledProviders(api);
  const [allowAll, setAllowAll] = useState(settings?.allowedProviders == null);
  const [allowed, setAllowed] = useState<Set<string>>(() => new Set(settings?.allowedProviders ?? []));
  const toggleProvider = (id: string, on: boolean): void => {
    setAllowed((current) => {
      const next = new Set(current);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  };
  return { providers, allowAll, setAllowAll, allowed, toggleProvider };
}

type ModelAccess = ReturnType<typeof useModelAccess>;

function ProviderChoices({ access }: { access: ModelAccess }) {
  const { providers } = access;
  if (access.allowAll) return null;
  if (providers === null) return <p className="conn-note">{t('Loading providers…')}</p>;
  if (providers.length === 0) return <p className="conn-note">{t('No provider is enabled on this PC.')}</p>;
  return providers.map((provider) => (
    <CheckRow
      key={provider.id}
      checked={access.allowed.has(provider.id)}
      onChange={(on) => access.toggleProvider(provider.id, on)}
    >
      {provider.label}
    </CheckRow>
  ));
}

function ModelAccessFieldset({ access }: { access: ModelAccess }) {
  return (
    <fieldset className="ssh-providers">
      <legend>{t('Models this server can use')}</legend>
      <CheckRow checked={access.allowAll} onChange={access.setAllowAll}>
        {t('Every provider enabled on this PC')}
      </CheckRow>
      <ProviderChoices access={access} />
      <p className="conn-note">{t('The server uses your accounts through this PC only while it is connected.')}</p>
    </fieldset>
  );
}

/** "2 server logins · Claude, OpenAI", or why the logins cannot be shown yet. */
function serverLoginsNote(host: DesktopSshHost, logins: DesktopSshServerLogins | null): string {
  if (!logins) return t('Loading…');
  if (logins.providers) {
    const signedIn = logins.providers.filter((provider) => provider.signedIn);
    if (!signedIn.length) return t('No server logins yet.');
    return t('{{count}} server logins · {{names}}', {
      count: signedIn.length,
      names: signedIn.map((provider) => provider.name).join(', '),
    });
  }
  if (logins.connected)
    return t('After saving, the server restarts with its own accounts and its logins can be managed here.');
  return t('Connect to {{name}} to manage its logins.', { name: host.name });
}

/** "Model login": this PC's accounts (the default, with the provider list
 *  this server may use) or the accounts signed in on the server. */
function ModelLoginFieldset({
  host,
  value,
  onChange,
  access,
  logins,
  onManage,
}: {
  host: DesktopSshHost;
  value: DesktopSshModelLogin;
  onChange(value: DesktopSshModelLogin): void;
  access: ModelAccess;
  logins: DesktopSshServerLogins | null;
  onManage(): void;
}) {
  const name = `ssh-model-login-${host.id}`;
  return (
    <fieldset className="ssh-login-choice">
      <legend>{t('Model login')}</legend>
      <label className="ssh-choice">
        <input type="radio" name={name} value="pc" checked={value === 'pc'} onChange={() => onChange('pc')} />
        <b>{t('This PC’s accounts')}</b>
        <small>{t('Model requests go out through this PC. They work only while it is connected.')}</small>
      </label>
      {value === 'pc' && (
        <div className="ssh-choice-sub">
          <ModelAccessFieldset access={access} />
        </div>
      )}
      <label className="ssh-choice">
        <input
          type="radio"
          name={name}
          value="server"
          checked={value === 'server'}
          onChange={() => onChange('server')}
        />
        <b>{t('Server accounts')}</b>
        <small>
          {t('Requests go straight out with the accounts signed in on the server. This PC needs no account.')}
        </small>
      </label>
      {value === 'server' && (
        <div className="ssh-choice-sub">
          <p className="conn-note">{serverLoginsNote(host, logins)}</p>
          <div>
            <button type="button" className="conn-btn conn-btn--sm" disabled={!logins?.providers} onClick={onManage}>
              {t('Manage server logins')}
            </button>
          </div>
        </div>
      )}
    </fieldset>
  );
}

/** Asked once when a save changes the model login: the server's Mixdog
 *  restarts in the other mode and its running sessions stop. */
function ModelLoginSwitchDialog({
  host,
  to,
  busySessions,
  onConfirm,
  onClose,
}: {
  host: DesktopSshHost;
  to: DesktopSshModelLogin;
  busySessions: number | null;
  onConfirm(): void;
  onClose(): void;
}) {
  const consequence =
    busySessions && busySessions > 0
      ? t('The server’s Mixdog restarts, and {{count}} running sessions stop.', { count: busySessions })
      : t('The server’s Mixdog restarts, and any running sessions stop.');
  return (
    <ConnDialog
      title={to === 'server' ? t('Switch to server accounts?') : t('Switch to this PC’s accounts?')}
      description={
        to === 'server'
          ? t('Sessions on {{name}} use the accounts signed in on the server for models.', { name: host.name })
          : t('Sessions on {{name}} use this PC’s accounts for models.', { name: host.name })
      }
      viewKey="model-login-switch"
      role="alertdialog"
      onEscape={onClose}
      footer={
        <>
          <span className="conn-grow" />
          <button type="button" className="conn-btn" onClick={onClose}>
            {t('Cancel')}
          </button>
          <button type="button" className="conn-btn conn-btn--primary" onClick={onConfirm}>
            {t('Change')}
          </button>
        </>
      }
    >
      <p className="ssh-warn">
        <b>{t('Running work stops.')}</b> {consequence}
      </p>
    </ConnDialog>
  );
}

const savedModelLogin = (host: DesktopSshHost): DesktopSshModelLogin =>
  host.settings?.modelLogin === 'server' ? 'server' : 'pc';

/** Per-server settings: the folder the session opens in, the login key file,
 *  whether a dropped connection is re-dialed, and whose accounts its models
 *  run on. They apply from the next connection; a changed model login
 *  restarts an attached server's Mixdog after one confirmation. */
export function SshHostSettingsDialog({
  api,
  host,
  onSaved,
  onClose,
}: {
  api: CapabilityApi;
  host: DesktopSshHost;
  onSaved(): void;
  onClose(): void;
}) {
  const [remoteCwd, setRemoteCwd] = useState(host.settings?.remoteCwd ?? '');
  const [identityFile, setIdentityFile] = useState(host.settings?.identityFile ?? '');
  const [autoReconnect, setAutoReconnect] = useState(host.settings?.autoReconnect !== false);
  const [graceMinutes, setGraceMinutes] = useState(String(host.settings?.graceMinutes ?? 30));
  const [modelLogin, setModelLogin] = useState<DesktopSshModelLogin>(savedModelLogin(host));
  const access = useModelAccess(api, host.settings);
  const { logins, refresh: refreshLogins } = useServerLogins(api, host.id);
  const [view, setView] = useState<'settings' | 'confirm' | 'logins'>('settings');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const save = (): void => {
    setView('settings');
    setSaving(true);
    setError('');
    const { providers } = access;
    void Promise.resolve(
      api.sshUpdateHostSettings?.(host.id, {
        remoteCwd,
        identityFile,
        autoReconnect,
        graceMinutes: graceMinutes.trim() === '' ? undefined : Number(graceMinutes),
        // Only providers still enabled here stay allowed.
        allowedProviders: access.allowAll
          ? null
          : [...access.allowed].filter((id) => !providers || providers.some((provider) => provider.id === id)),
        modelLogin,
      })
    )
      .then(() => {
        onSaved();
        onClose();
      })
      .catch((reason: unknown) => {
        setError(errorMessage(reason));
        setSaving(false);
      });
  };
  const requestSave = (): void => {
    if (modelLogin !== savedModelLogin(host)) setView('confirm');
    else save();
  };
  if (view === 'confirm') {
    return (
      <ModelLoginSwitchDialog
        host={host}
        to={modelLogin}
        busySessions={logins?.busySessions ?? null}
        onConfirm={save}
        onClose={() => setView('settings')}
      />
    );
  }
  if (view === 'logins') {
    return (
      <SshServerLoginsDialog
        api={api}
        host={host}
        onClose={() => {
          refreshLogins();
          setView('settings');
        }}
      />
    );
  }
  return (
    <ConnDialog
      title={t('{{name}} settings', { name: host.name })}
      description={t('Changes apply from the next connection.')}
      onEscape={onClose}
      footer={
        <>
          <span className="conn-grow" />
          <button type="button" className="conn-btn" onClick={onClose}>
            {t('Cancel')}
          </button>
          <button type="button" className="conn-btn conn-btn--primary" disabled={saving} onClick={requestSave}>
            {t('Save')}
          </button>
        </>
      }
    >
      <div className="conn-stack ssh-settings">
        <label className="conn-field">
          <span>{t('Default server folder')}</span>
          <input
            type="text"
            className="conn-input"
            data-autofocus
            placeholder="~"
            autoComplete="off"
            spellCheck={false}
            value={remoteCwd}
            onChange={(event) => setRemoteCwd(event.currentTarget.value)}
          />
        </label>
        <label className="conn-field">
          <span>{t('Login key file')}</span>
          <input
            type="text"
            className="conn-input"
            placeholder={KEY_FILE_EXAMPLE}
            autoComplete="off"
            spellCheck={false}
            value={identityFile}
            onChange={(event) => setIdentityFile(event.currentTarget.value)}
          />
        </label>
        <CheckRow checked={autoReconnect} onChange={setAutoReconnect}>
          {t('Reconnect automatically when the connection drops')}
        </CheckRow>
        <label className="conn-field">
          <span>{t('Keep the server’s work after the connection drops (minutes)')}</span>
          <input
            type="number"
            className="conn-input"
            min={1}
            max={10080}
            step={1}
            inputMode="numeric"
            value={graceMinutes}
            onChange={(event) => setGraceMinutes(event.currentTarget.value)}
          />
        </label>
        <ModelLoginFieldset
          host={host}
          value={modelLogin}
          onChange={setModelLogin}
          access={access}
          logins={logins}
          onManage={() => setView('logins')}
        />
        <div className="conn-field-msg conn-field-msg--error" role={error ? 'alert' : undefined}>
          {error || '\u00a0'}
        </div>
      </div>
    </ConnDialog>
  );
}

const CLEANUP_STEPS: Array<Exclude<DesktopSshCleanupProgress['phase'], 'done'>> = ['connect', 'stop', 'remove'];

function cleanupStepLabel(step: (typeof CLEANUP_STEPS)[number]): string {
  if (step === 'connect') return t('Reach the server');
  if (step === 'stop') return t('Stop the Mixdog daemon');
  return t('Remove the Mixdog files');
}

function cleanupStepState(index: number, at: number): 'done' | 'now' | 'wait' {
  if (index < at) return 'done';
  if (index === at) return 'now';
  return 'wait';
}

type CleanupPhase = 'confirm' | 'running' | 'done' | { failure: DesktopSshFailure };

function CleanupRunningDialog({ host, step }: { host: DesktopSshHost; step: DesktopSshCleanupProgress['phase'] }) {
  const at = step === 'done' ? CLEANUP_STEPS.length : CLEANUP_STEPS.indexOf(step);
  return (
    <ConnDialog
      title={t('Cleaning up {{name}}', { name: host.name })}
      description={host.target}
      viewKey="cleanup-running"
      scrimCloses={false}
      onEscape={() => undefined}
      footer={
        <>
          <span className="conn-grow" />
          <button type="button" className="conn-btn conn-btn--primary" disabled>
            {t('Cleaning up…')}
          </button>
        </>
      }
    >
      <ol className="conn-steps">
        {CLEANUP_STEPS.map((key, index) => (
          <li key={key} data-n={index + 1} data-state={cleanupStepState(index, at)}>
            <span>{cleanupStepLabel(key)}</span>
          </li>
        ))}
      </ol>
      <div className="conn-field-msg conn-field-msg--busy" role="status">
        <span className="conn-spinner" aria-hidden="true" />
        {t('Removing Mixdog from the server.')}
      </div>
    </ConnDialog>
  );
}

function CleanupDoneDialog({
  host,
  forget,
  detail,
  onClose,
}: {
  host: DesktopSshHost;
  forget: boolean;
  detail: string;
  onClose(): void;
}) {
  return (
    <ConnDialog
      title={t('Cleaned up {{name}}', { name: host.name })}
      description={forget ? t('The server was removed from the list.') : t('The server is still in the list.')}
      viewKey="cleanup-done"
      onEscape={onClose}
      footer={
        <>
          <span className="conn-grow" />
          <button type="button" className="conn-btn conn-btn--primary" onClick={onClose}>
            {t('Close')}
          </button>
        </>
      }
    >
      {detail && <p className="conn-note conn-note--raw">{detail}</p>}
    </ConnDialog>
  );
}

function CleanupFailedDialog({
  failure,
  name,
  onRetry,
  onClose,
}: {
  failure: DesktopSshFailure;
  name: string;
  onRetry(): void;
  onClose(): void;
}) {
  const { title, description, body } = guidance(toGuidance(failure), name);
  return (
    <ConnDialog
      title={title}
      description={description}
      viewKey="cleanup-failed"
      onEscape={onClose}
      footer={
        <>
          <span className="conn-grow" />
          <button type="button" className="conn-btn" onClick={onClose}>
            {t('Close')}
          </button>
          <button type="button" className="conn-btn conn-btn--primary" onClick={onRetry}>
            {t('Try again')}
          </button>
        </>
      }
    >
      {body}
    </ConnDialog>
  );
}

/** "Clean up Mixdog on the server…": remove what Mixdog put on the server, with
 *  the work history only when asked, then optionally forget the saved entry. */
export function SshCleanupDialog({
  api,
  host,
  onDone,
  onClose,
}: {
  api: CapabilityApi;
  host: DesktopSshHost;
  onDone(): void;
  onClose(): void;
}) {
  const [phase, setPhase] = useState<CleanupPhase>('confirm');
  const [removeUserData, setRemoveUserData] = useState(false);
  const [forget, setForget] = useState(false);
  const [detail, setDetail] = useState('');
  const [step, setStep] = useState<DesktopSshCleanupProgress['phase']>('connect');
  const operationId = useRef(globalThis.crypto.randomUUID());
  const { question, answer } = useSshAskpass(api, (id) => id === operationId.current);
  useEffect(() => {
    const unsubscribe = api.subscribeSshCleanupProgress?.((progress) => {
      if (progress.operationId === operationId.current) setStep(progress.phase);
    });
    return unsubscribe;
  }, [api]);
  // ConfirmDialog closes before it confirms, in the same click: leaving waits one tick.
  const phaseRef = useRef<CleanupPhase>('confirm');
  phaseRef.current = phase;

  const start = (): void => {
    phaseRef.current = 'running';
    setStep('connect');
    setPhase('running');
    void Promise.resolve(api.sshCleanupHost?.(host.id, { operationId: operationId.current, removeUserData, forget }))
      .then((result) => {
        if (!result) return;
        if (result.ok) {
          setDetail(result.detail ?? '');
          setPhase('done');
          onDone();
        } else if (result.failure.kind === 'cancelled') {
          onClose();
        } else {
          setPhase({ failure: result.failure });
        }
      })
      .catch((reason: unknown) => setPhase({ failure: { kind: 'failed', message: errorMessage(reason) } }));
  };

  if (phase === 'confirm') {
    return (
      <ConfirmDialog
        title={t('Clean up Mixdog on {{name}}', { name: host.name })}
        description={t(
          'Mixdog and its files are removed from the server. The server window closes first, and the work running in it stops.'
        )}
        confirmLabel={t('Clean up')}
        onConfirm={start}
        onClose={() =>
          queueMicrotask(() => {
            if (phaseRef.current === 'confirm') onClose();
          })
        }
      >
        <div className="conn-stack">
          <CheckRow checked={removeUserData} onChange={setRemoveUserData}>
            {t('Delete the work history too')}
          </CheckRow>
          <CheckRow checked={forget} onChange={setForget}>
            {t('Remove this server from the list afterwards')}
          </CheckRow>
        </div>
      </ConfirmDialog>
    );
  }
  if (phase === 'running') {
    if (question && question.kind !== 'close') {
      return <SshAskpassPrompt question={{ ...question, kind: question.kind }} name={host.name} onAnswer={answer} />;
    }
    return <CleanupRunningDialog host={host} step={step} />;
  }
  if (phase === 'done') return <CleanupDoneDialog host={host} forget={forget} detail={detail} onClose={onClose} />;
  return <CleanupFailedDialog failure={phase.failure} name={host.name} onRetry={start} onClose={onClose} />;
}
