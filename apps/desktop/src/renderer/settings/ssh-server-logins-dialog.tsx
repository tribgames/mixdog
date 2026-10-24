// "Manage server logins": the provider logins stored on a server whose models
// run with the server's own accounts. Every action runs on the server's
// daemon through main; a subscription login opens in this PC's browser and
// its redirect reaches the server through a forwarded callback port, or is
// pasted here.
import { type FormEvent, useEffect, useRef, useState } from 'react';

import type {
  DesktopSshHost,
  DesktopSshServerLogin,
  DesktopSshServerLoginFlow,
  DesktopSshServerLogins,
} from '../../shared/contract-ssh';
import { t } from '../i18n';
import type { CapabilityApi } from './capability-data';
import { ConfirmDialog, ConnDialog } from './connection-dialogs';
import { isConnectFirstError, sshErrorText } from './ssh-error-text';

const NO_SERVER_LOGINS: DesktopSshServerLogins = {
  connected: false,
  modelLogin: null,
  busySessions: null,
  providers: null,
};
const STATUS_POLL_MS = 1_000;
const REDIRECT_EXAMPLE = 'http://localhost:…/callback?code=…';

/** The logins stored on the server and its running sessions, as main reads
 *  them from the attached daemon; null while loading. */
export function useServerLogins(api: CapabilityApi, hostId: string) {
  const [logins, setLogins] = useState<DesktopSshServerLogins | null>(null);
  const [version, setVersion] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `version` asks for a fresh read.
  useEffect(() => {
    let live = true;
    void Promise.resolve(api.sshServerLogins?.(hostId))
      .then((value) => live && setLogins(value ?? NO_SERVER_LOGINS))
      .catch(() => live && setLogins(NO_SERVER_LOGINS));
    return () => {
      live = false;
    };
  }, [api, hostId, version]);
  return { logins, refresh: () => setVersion((current) => current + 1) };
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

export function SshServerLoginsDialog({
  api,
  host,
  onClose,
}: {
  api: CapabilityApi;
  host: DesktopSshHost;
  onClose(): void;
}) {
  const { logins, refresh } = useServerLogins(api, host.id);
  const [flow, setFlow] = useState<DesktopSshServerLoginFlow | null>(null);
  const [flowName, setFlowName] = useState('');
  const [keyFor, setKeyFor] = useState<DesktopSshServerLogin | null>(null);
  const [removing, setRemoving] = useState<DesktopSshServerLogin | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [pasteError, setPasteError] = useState('');
  const flowRef = useRef(flow);
  flowRef.current = flow;
  const mounted = useRef(true);

  const cancelFlow = (flowId: string): void => {
    void Promise.resolve(api.sshServerLoginCancel?.(host.id, flowId)).catch(() => undefined);
  };
  const cancelPending = (): void => {
    const pending = flowRef.current;
    if (pending?.state !== 'pending') return;
    flowRef.current = null;
    cancelFlow(pending.flowId);
  };
  // A login still pending when the dialog goes is cancelled: its forward
  // closes. One whose start answers only after that is cancelled then.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs once, at unmount.
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      cancelPending();
    };
  }, []);

  /** A failed call says why. A server that disconnected meanwhile is not an
   *  error to read: the list is read again and shows the connect-first note,
   *  as when the dialog opens with the server disconnected. */
  const report = (reason: unknown): void => {
    if (isConnectFirstError(reason)) {
      setKeyFor(null);
      refresh();
      return;
    }
    setError(sshErrorText(reason));
  };

  /** A status answer: done refreshes the list, a failure says why. */
  const finish = (next: DesktopSshServerLoginFlow): void => {
    setFlow(null);
    setPasteError('');
    if (next.state === 'complete') refresh();
    else if (next.state !== 'cancelled') setError(next.error || t('The sign-in did not finish.'));
  };

  /** A status or paste answer: only the active login's, in a mounted dialog. */
  const settle = (next: DesktopSshServerLoginFlow): void => {
    if (!mounted.current || flowRef.current?.flowId !== next.flowId) return;
    if (next.state === 'pending') {
      setFlow((current) => (current?.flowId === next.flowId ? { ...current, forwarded: next.forwarded } : current));
      return;
    }
    finish(next);
  };

  const pendingId = flow?.state === 'pending' ? flow.flowId : '';
  // biome-ignore lint/correctness/useExhaustiveDependencies: polls the pending login only.
  useEffect(() => {
    if (!pendingId) return undefined;
    let live = true;
    let timer = 0;
    const poll = (): void => {
      void Promise.resolve(api.sshServerLoginStatus?.(host.id, pendingId))
        .then((next) => {
          if (!live || !next) return;
          settle(next);
          if (next.state === 'pending') timer = window.setTimeout(poll, STATUS_POLL_MS);
        })
        .catch((reason: unknown) => {
          if (!live) return;
          // A login whose status cannot be read is over here: main closed its
          // forward, and the server is asked to drop it.
          cancelPending();
          setFlow(null);
          setPasteError('');
          report(reason);
        });
    };
    timer = window.setTimeout(poll, STATUS_POLL_MS);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [api, host.id, pendingId]);

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
    cancelPending();
    setFlow(null);
    setKeyFor(null);
    setBusy(true);
    setError('');
    setPasteError('');
    void Promise.resolve(api.sshServerLoginBegin?.(host.id, provider.id))
      .then((started) => {
        if (!started) return;
        if (!mounted.current) {
          if (started.state === 'pending') cancelFlow(started.flowId);
          return;
        }
        setFlowName(provider.name);
        if (started.state === 'pending') setFlow(started);
        else finish(started);
      })
      .catch(report)
      .finally(() => setBusy(false));
  };

  const paste = (address: string, form: HTMLFormElement): void => {
    const pending = flowRef.current;
    if (!pending) return;
    setPasteError('');
    void Promise.resolve(api.sshServerLoginComplete?.(host.id, pending.flowId, address))
      .then((next) => {
        if (!next) return;
        form.reset();
        settle(next);
      })
      .catch((reason: unknown) => {
        if (mounted.current && flowRef.current?.flowId === pending.flowId) setPasteError(sshErrorText(reason));
      });
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
              else act(() => Promise.resolve(api.sshServerLoginLogout?.(host.id, provider.id)));
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
        onConfirm={() => act(() => Promise.resolve(api.sshServerLoginRemoveCustom?.(host.id, removing.id)))}
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
              () => Promise.resolve(api.sshServerLoginSaveKey?.(host.id, keyFor.id, key)),
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
