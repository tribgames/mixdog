import { type FormEvent, useEffect, useRef, useState } from 'react';

import type {
  DesktopSshHost,
  DesktopSshServerLogin,
  DesktopSshServerLoginFlow,
  DesktopSshServerLogins,
} from '../../shared/contract-ssh';
import {
  sshServerLoginLogout,
  sshServerLoginRemoveCustom,
  sshServerLoginSaveKey,
  sshServerLogins,
} from '../connections-core-api';
import { t } from '../i18n';
import { ConfirmDialog, ConnDialog } from './connection-dialogs';
import { followSettingsReadConnection, startSettingsReadRecovery } from './read-recovery';
import { isConnectFirstError, sshErrorText } from './ssh-error-text';
import { useSshServerLoginFlow } from './use-ssh-server-login-flow';

const NO_SERVER_LOGINS: DesktopSshServerLogins = {
  connected: false,
  modelLogin: null,
  busySessions: null,
  providers: null,
};
const REDIRECT_EXAMPLE = 'http://localhost:…/callback?code=…';

/** The logins stored on the server and its running sessions, as main reads
 *  them from the attached daemon; null while loading. */
export function useServerLogins(hostId: string) {
  const [logins, setLogins] = useState<DesktopSshServerLogins | null>(null);
  const reread = useRef<(() => void) | null>(null);
  useEffect(() => {
    const recovery = startSettingsReadRecovery(
      async (signal) => {
        try {
          const value = await sshServerLogins(hostId);
          if (!signal.aborted && value) setLogins(value);
        } catch (reason) {
          if (!signal.aborted && isConnectFirstError(reason)) setLogins(NO_SERVER_LOGINS);
        }
      },
      10_000,
      true,
      true
    );
    const stopLink = followSettingsReadConnection(window.mixdogDesktop, recovery);
    reread.current = recovery.replace;
    window.addEventListener('focus', recovery.replace);
    return () => {
      reread.current = null;
      stopLink?.();
      window.removeEventListener('focus', recovery.replace);
      recovery.stop();
    };
  }, [hostId]);
  return { logins, refresh: () => reread.current?.() };
}

function loginDetail(provider: DesktopSshServerLogin): string {
  if (!provider.signedIn) return t('Not signed in');
  if (provider.fromEnvironment) return t('API key · from the server’s environment');
  if (provider.keyless) return t('No API key needed');
  if (provider.kind === 'api') {
    return provider.storedInPrivateFile ? t('API key · stored in a private file') : t('API key');
  }
  return provider.identity ? `${t('Subscription')} · ${provider.identity}` : t('Subscription');
}

function LoginRow({
  provider,
  disabled,
  onLogIn,
  onChangeKey,
  onLogOut,
}: {
  provider: DesktopSshServerLogin;
  disabled: boolean;
  onLogIn(): void;
  onChangeKey(): void;
  onLogOut(): void;
}) {
  let actions = null;
  // An environment key cannot be changed here; a keyless custom provider has no key but can be removed.
  if (provider.fromEnvironment) {
    actions = null;
  } else if (provider.keyless) {
    actions = provider.custom ? (
      <button type="button" className="conn-btn conn-btn--sm" disabled={disabled} onClick={onLogOut}>
        {t('Delete')}
      </button>
    ) : null;
  } else if (!provider.signedIn) {
    actions = (
      <button type="button" className="conn-btn conn-btn--sm conn-btn--primary" disabled={disabled} onClick={onLogIn}>
        {t('Log in')}
      </button>
    );
  } else {
    actions = (
      <>
        {provider.kind === 'api' && (
          <button type="button" className="conn-btn conn-btn--sm" disabled={disabled} onClick={onChangeKey}>
            {t('Change')}
          </button>
        )}
        <button type="button" className="conn-btn conn-btn--sm" disabled={disabled} onClick={onLogOut}>
          {provider.custom ? t('Delete') : t('Log out')}
        </button>
      </>
    );
  }
  return (
    <div className="ssh-login-row">
      <span className="ssh-login-dot" data-on={provider.signedIn ? 'true' : undefined} aria-hidden="true" />
      <div className="ssh-login-who">
        <b>{provider.name}</b>
        <small>{loginDetail(provider)}</small>
      </div>
      {actions}
    </div>
  );
}

/** The steps of a pending subscription login, with the paste fallback. */
function LoginSteps({
  flow,
  name,
  error,
  onPaste,
}: {
  flow: DesktopSshServerLoginFlow;
  name: string;
  error: string;
  onPaste(address: string, form: HTMLFormElement): void;
}) {
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const form = event.currentTarget;
    const address = String(new FormData(form).get('address') ?? '').trim();
    if (address) onPaste(address, form);
  };
  const manual = flow.manualCodeSupported !== false;
  return (
    <div className="ssh-login-codebox">
      <ol>
        <li>{t('When the browser opens, sign in to {{provider}}.', { provider: name })}</li>
        {flow.userCode && (
          <li data-user-code={flow.userCode}>
            {t('When the browser asks for a code, enter {{code}}.', { code: flow.userCode })}
          </li>
        )}
        {flow.forwarded && <li>{t('When the sign-in finishes, it is passed to the server automatically.')}</li>}
        {manual && (
          <li>
            {flow.forwarded
              ? t('If the browser shows “can’t connect”, paste the address from its address bar below.')
              : t('After signing in, paste the address from the browser’s address bar, or the code it shows, below.')}
          </li>
        )}
      </ol>
      {manual && (
        <form onSubmit={submit}>
          <input
            type="text"
            name="address"
            className="conn-input"
            placeholder={REDIRECT_EXAMPLE}
            aria-label={t('Paste the address after signing in')}
            aria-invalid={error ? true : undefined}
            autoComplete="off"
            spellCheck={false}
            // biome-ignore lint/a11y/noAutofocus: the paste field is the next step of the login just started.
            autoFocus
          />
        </form>
      )}
      {error && (
        <p className="conn-field-msg conn-field-msg--error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/** An API key typed for the server: stored there, never on this PC. */
function KeyForm({
  provider,
  disabled,
  onSave,
  onCancel,
}: {
  provider: DesktopSshServerLogin;
  disabled: boolean;
  onSave(key: string): void;
  onCancel(): void;
}) {
  const [key, setKey] = useState('');
  return (
    <form
      className="ssh-login-codebox"
      onSubmit={(event) => {
        event.preventDefault();
        if (key.trim()) onSave(key.trim());
      }}
    >
      <label className="conn-field">
        <span>{t('{{provider}} API key', { provider: provider.name })}</span>
        <input
          type="password"
          className="conn-input"
          autoComplete="off"
          spellCheck={false}
          value={key}
          // biome-ignore lint/a11y/noAutofocus: the key field is what the button just asked for.
          autoFocus
          onChange={(event) => setKey(event.currentTarget.value)}
        />
      </label>
      <div className="ssh-login-key-actions">
        <button type="button" className="conn-btn conn-btn--sm" onClick={onCancel}>
          {t('Cancel')}
        </button>
        <button type="submit" className="conn-btn conn-btn--sm conn-btn--primary" disabled={disabled || !key.trim()}>
          {t('Save')}
        </button>
      </div>
    </form>
  );
}

export function SshServerLoginsDialog({ host, onClose }: { host: DesktopSshHost; onClose(): void }) {
  const { logins, refresh } = useServerLogins(host.id);
  const [keyFor, setKeyFor] = useState<DesktopSshServerLogin | null>(null);
  const [removing, setRemoving] = useState<DesktopSshServerLogin | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  /** A failed call says why. A server that disconnected meanwhile is not an
   *  error to read: the list is read again and shows the connect-first note,
   *  as when the dialog opens with the server disconnected. */
  const report = (reason: unknown): void => {
    if (isConnectFirstError(reason)) {
      setKeyFor(null);
      refresh();
      return;
    }
    setError(sshErrorText(reason, host.name));
  };
  const { flow, flowName, pasteError, begin, paste } = useSshServerLoginFlow({
    hostId: host.id,
    hostName: host.name,
    refresh,
    setError,
    report,
  });

  const act = (action: () => Promise<unknown>, after?: () => void): void => {
    setBusy(true);
    setError('');
    void action()
      .then(() => {
        after?.();
        refresh();
      })
      .catch(report)
      .finally(() => setBusy(false));
  };

  const logIn = (provider: DesktopSshServerLogin): void => {
    if (provider.kind === 'api') {
      setKeyFor(provider);
      return;
    }
    setKeyFor(null);
    setBusy(true);
    setError('');
    void begin(provider)
      .catch(report)
      .finally(() => setBusy(false));
  };
  let body = <p className="conn-note">{t('Loading…')}</p>;
  if (logins && !logins.providers) {
    body = <p className="conn-note">{t('Connect to {{name}} to manage its logins.', { name: host.name })}</p>;
  } else if (logins?.providers) {
    body = (
      <div className="ssh-login-list">
        {logins.providers.map((provider) => (
          <LoginRow
            key={provider.id}
            provider={provider}
            disabled={busy}
            onLogIn={() => logIn(provider)}
            onChangeKey={() => setKeyFor(provider)}
            onLogOut={() => {
              // Removing a custom provider deletes it on the server: asked first, as in Settings.
              if (provider.custom) setRemoving(provider);
              else act(() => Promise.resolve(sshServerLoginLogout(host.id, provider.id)));
            }}
          />
        ))}
      </div>
    );
  }
  if (removing) {
    return (
      <ConfirmDialog
        title={t('Delete custom provider?')}
        description={t('Remove {{name}} and its saved API key. Its models will no longer be available.', {
          name: removing.name,
        })}
        confirmLabel={t('Delete')}
        onClose={() => setRemoving(null)}
        onConfirm={() => act(() => Promise.resolve(sshServerLoginRemoveCustom(host.id, removing.id)))}
      />
    );
  }
  return (
    <ConnDialog
      title={t('{{name}} logins', { name: host.name })}
      description={t('Logins added here are stored only on the server.')}
      viewKey="server-logins"
      onEscape={onClose}
      footer={
        <>
          <span className="conn-grow" />
          <button type="button" className="conn-btn" onClick={onClose}>
            {t('Close')}
          </button>
        </>
      }
    >
      {logins?.keychain && (
        <p
          className="conn-field-msg conn-field-msg--error"
          role="alert"
          data-keychain-state={logins.keychain.state}
          data-keychain-kind={logins.keychain.kind}
        >
          {t(logins.keychain.message)}
          {logins.keychain.path && (
            <>
              {' '}
              <code>{logins.keychain.path}</code>
            </>
          )}
        </p>
      )}
      {body}
      {flow && <LoginSteps flow={flow} name={flowName} error={pasteError} onPaste={paste} />}
      {keyFor && (
        <KeyForm
          key={keyFor.id}
          provider={keyFor}
          disabled={busy}
          onCancel={() => setKeyFor(null)}
          onSave={(key) =>
            act(
              () => Promise.resolve(sshServerLoginSaveKey(host.id, keyFor.id, key)),
              () => setKeyFor(null)
            )
          }
        />
      )}
      {error && (
        <p className="conn-field-msg conn-field-msg--error" role="alert">
          {error}
        </p>
      )}
    </ConnDialog>
  );
}
