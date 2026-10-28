import { ExternalLink, Plus } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import type { DesktopApi } from '../../shared/contract';
import { t } from '../i18n';
import { ErrorNotice, verificationUrlOf } from '../ErrorNotice';
import { record } from '../record-utils';
import { startVisibleRefreshCadence } from '../visible-refresh-cadence';
import { invalidateSidebarReferenceForMutation } from '../sidebar-reference-cache';
import { OAuthLoginDialog, pasteErrorText, useOAuthLoginFlow } from './oauth-login-flow';
import { useOAuthUsageRefresh } from './use-oauth-usage-refresh';
import {
  ProviderAccountsList,
  PROVIDER_ACCOUNTS_CHANGED,
  preloadProviderAccounts,
  useProviderPoolsReady,
  useProvidersWithoutAccounts,
} from '../ProviderAccountsList';
import { ProviderIcon } from '../provider-display';
import { ActionButton, Group, ListEmpty, ResourceRow } from './capability-controls';
import { ClientManagedProviders } from './client-managed-providers';
import { QuotaAutoResumeToggle } from './quota-auto-resume-toggle';
import { CustomProvidersSection, providerPageGroups } from './custom-provider-section';
import {
  preloadCapabilitySettings,
  providerLabel,
  rows,
  sectionLoaded,
  type PanelContext,
  type RecordValue,
} from './capability-data';

export function preloadProviderPanel(api: PanelContext['api']): Promise<unknown> {
  return preloadCapabilitySettings(api).then((next) =>
    record(next.data.providerSetup).managedByClient === true
      ? undefined
      : preloadProviderAccounts(
          api,
          rows(record(next.data.providerSetup).oauth).map((provider) => String(provider.id))
        )
  );
}

// A Vertex AI location id, shown as-is (never translated).
const VERTEX_DEFAULT_LOCATION = 'global';

/** The storage note of an API-key row, from the setup's structured credential source. */
export function credentialNote(provider: RecordValue): string | undefined {
  if (provider.credentialSource === 'private-file') return t('Stored in a private file');
  if (provider.credentialSource === 'environment') {
    const name = typeof provider.envName === 'string' && provider.envName ? ` · ${provider.envName}` : '';
    return `${t('From an environment variable')}${name}`;
  }
  return undefined;
}

/** Poll while mounted: the daemon re-checks the keyring (without prompting) on
 *  every ready read, so the alert appears/disappears live, including when the
 *  keyring locks or is unlocked while this page is open. */
function useKeychainRefresh(run: PanelContext['run']) {
  const runRef = useRef(run);
  runRef.current = run;
  useEffect(() => {
    const refresh = (recheckKeychain: boolean) => () =>
      void runRef.current(
        'getProviderSetup',
        [recheckKeychain ? { recheckKeychain } : {}],
        'keychain-refresh',
        true,
        true
      );
    const poll = refresh(false);
    const onFocus = refresh(true);
    // Visible-only cadence; an unfocused window skips ticks (the focus event
    // below refreshes as soon as it returns).
    const stopCadence = startVisibleRefreshCadence({
      win: window,
      intervalMs: 7000,
      refresh: (reason) => {
        if (reason === 'interval' && !window.document.hasFocus()) return;
        poll();
      },
    });
    // Returning to the window re-snapshots the keyring right away instead of
    // waiting for the daemon's TTL (secret-tool may have changed it meanwhile).
    window.addEventListener('focus', onFocus);
    return () => {
      stopCadence();
      window.removeEventListener('focus', onFocus);
    };
  }, []);
}

function KeychainAlert({ issue, busy, run }: { issue: RecordValue; busy: boolean; run: PanelContext['run'] }) {
  const state = String(issue.state || '');
  return (
    <p className="settings-error" role="alert" data-keychain-state={state}>
      {t(String(issue.message))}
      {typeof issue.path === 'string' && issue.path !== '' && (
        <>
          {' '}
          <code>{issue.path}</code>{' '}
        </>
      )}
      {(state === 'locked' || state === 'error' || state === 'unreachable') && (
        <ActionButton
          disabled={busy}
          onClick={() => void run('getProviderSetup', [{ force: true, unlockKeychain: true }])}
        >
          {t('Unlock keyring')}
        </ActionButton>
      )}
    </p>
  );
}

/** One card PER connected provider: sharing a single card ran "OpenAI's
 *  accounts → Anthropic header" as one continuous list (user: 프로바이더별
 *  분리된 느낌이 없다). Providers without an account share one compact card
 *  after them. */
function OAuthProvidersCard({
  api,
  providers,
  withoutAccounts,
  busy,
  run,
  confirm,
}: Pick<PanelContext, 'api' | 'run' | 'confirm'> & {
  providers: RecordValue[];
  withoutAccounts: ReadonlySet<string>;
  busy: boolean;
}) {
  return (
    <section className="settings-group settings-provider-cards">
      <header>
        <h3>{t('OAuth providers')}</h3>
      </header>
      {providers
        .filter((provider) => !withoutAccounts.has(String(provider.id)))
        .map((provider) => (
          <div className="settings-group-body" key={String(provider.id)}>
            <ProviderAccountsList
              api={api}
              provider={String(provider.id)}
              title={providerLabel(provider)}
              onChange={() => void run('getProviderSetup', [{ force: true }])}
              renderActions={(account) => (
                <>
                  {(!account.authenticated || account.reauthRequired) && (
                    <OAuthControl api={api} provider={provider} disabled={busy} run={run} accountId={account.id} />
                  )}
                  <ActionButton
                    danger
                    disabled={busy}
                    onClick={() => {
                      confirm({
                        title: t('Disconnect account?'),
                        description: t('Remove the saved authentication for {{name}}.', { name: account.label }),
                        confirmLabel: t('Disconnect'),
                        danger: true,
                        onConfirm: async () => {
                          await run('forgetProviderAuth', [provider.id, account.id]);
                          window.dispatchEvent(new window.Event(PROVIDER_ACCOUNTS_CHANGED));
                        },
                      });
                    }}
                  >
                    {t('Disconnect')}
                  </ActionButton>
                </>
              )}
              headerAction={<OAuthControl api={api} provider={provider} disabled={busy} run={run} addAccount />}
            />
          </div>
        ))}
      {withoutAccounts.size > 0 && (
        <>
          <p className="provider-accounts-sublabel">{t('Providers without a connected account')}</p>
          <div className="settings-group-body provider-accounts-empty-card">
            {providers
              .filter((provider) => withoutAccounts.has(String(provider.id)))
              .map((provider) => (
                <div className="provider-accounts-empty-row" key={String(provider.id)}>
                  <span className="provider-accounts-icon">
                    <ProviderIcon provider={String(provider.id)} />
                  </span>
                  <b>{providerLabel(provider)}</b>
                  <OAuthControl api={api} provider={provider} disabled={busy} run={run} addAccount />
                </div>
              ))}
          </div>
        </>
      )}
      {providers.length === 0 && (
        <div className="settings-group-body">
          <ListEmpty text={t('No OAuth providers available.')} />
        </div>
      )}
    </section>
  );
}

export function ProvidersPanel({ api, data, pending, run, confirm }: PanelContext) {
  const host = (window as unknown as { mixdogDesktop?: DesktopApi }).mixdogDesktop;
  const openKeyConsole = (url: string) => void host?.openExternal?.(url).catch(() => undefined);
  const setup = record(data.providerSetup);
  const { custom: customProviders, otherApi: otherApiProviders, oauth: oauthProviders } = providerPageGroups(setup);
  const busy = Boolean(pending);
  // The one API-key row whose key form is open.
  const [openKeyId, setOpenKeyId] = useState<string | null>(null);
  // Where focus goes once the row has re-rendered: the revealed key input, or
  // the row's Connect button after the form closes.
  const pendingFocus = useRef<{ id: string; target: 'key' | 'connect' } | null>(null);
  const openKeyForm = (id: string) => {
    pendingFocus.current = { id, target: 'key' };
    setOpenKeyId(id);
  };
  const closeKeyForm = (id: string) => {
    pendingFocus.current = { id, target: 'connect' };
    setOpenKeyId(null);
  };
  useEffect(() => {
    const next = pendingFocus.current;
    if (!next) return;
    pendingFocus.current = null;
    const attribute = next.target === 'key' ? 'data-provider-key' : 'data-provider-connect';
    document.querySelector<HTMLElement>(`[${attribute}="${next.id}"]`)?.focus();
  });
  const loading = !sectionLoaded(data, 'providerSetup');
  const secretsPending = setup.pendingSecrets === true;
  const providerStatus = (provider: RecordValue) => {
    if (secretsPending && !provider.authenticated) return 'Checking…';
    const status = String(provider.status || '');
    if (provider.reauthRequired === true) return status || 'Reauth required';
    if (provider.authenticated && /^(valid|set|access only)$/i.test(status)) return 'Connected';
    return status || (provider.authenticated ? 'Connected' : 'Not connected');
  };
  const renderApiProvider = (provider: RecordValue) => (
    <ResourceRow
      key={String(provider.id)}
      title={providerLabel(provider)}
      // Where the effective key comes from (a private file when there is no OS
      // keychain, or an environment variable) is shown as the row's secondary text.
      meta={credentialNote(provider)}
      status={providerStatus(provider)}
      actions={
        <>
          {!provider.authenticated && openKeyId !== String(provider.id) && (
            <button
              type="button"
              className="settings-action"
              data-provider-connect={String(provider.id)}
              disabled={busy}
              onClick={() => openKeyForm(String(provider.id))}
            >
              {t('Connect')}
            </button>
          )}
          {typeof provider.url === 'string' &&
            /^https:\/\//.test(provider.url) &&
            (provider.authenticated || openKeyId === String(provider.id)) && (
              <ActionButton disabled={busy} onClick={() => openKeyConsole(String(provider.url))}>
                {provider.authenticated ? `${t('API keys')} ↗` : t('Get API key ↗')}
              </ActionButton>
            )}
          {!provider.authenticated && openKeyId === String(provider.id) && provider.id === 'vertex-ai' && (
            <>
              <form
                className="settings-provider-secret"
                onSubmit={(event) => {
                  event.preventDefault();
                  const form = event.currentTarget;
                  const fields = new FormData(form);
                  const file = fields.get('secretFile');
                  if (!(file instanceof File)) return;
                  const location = String(fields.get('location') || VERTEX_DEFAULT_LOCATION).trim();
                  const projectId = String(fields.get('projectId') || '').trim();
                  void file.text().then(async (secret) => {
                    const result = await run(
                      'saveProviderApiKey',
                      [provider.id, secret, { location, projectId }],
                      'provider-key-vertex-ai'
                    );
                    if (result !== undefined) {
                      form.reset();
                      closeKeyForm(String(provider.id));
                    }
                  });
                }}
              >
                <input
                  name="secretFile"
                  data-provider-key={String(provider.id)}
                  type="file"
                  accept="application/json,.json"
                  aria-label={t('Vertex AI service-account JSON key')}
                  required
                />
                <input
                  name="location"
                  type="text"
                  defaultValue={String(provider.location || VERTEX_DEFAULT_LOCATION)}
                  placeholder={VERTEX_DEFAULT_LOCATION}
                  aria-label={t('Vertex AI location')}
                  required
                />
                <input
                  name="projectId"
                  type="text"
                  defaultValue={String(provider.projectId || '')}
                  placeholder={t('Project ID override (optional)')}
                  aria-label={t('Vertex AI project ID override')}
                />
                <button type="submit" disabled={busy}>
                  {t('Save')}
                </button>
              </form>
              <ActionButton onClick={() => closeKeyForm(String(provider.id))}>{t('Cancel')}</ActionButton>
            </>
          )}
          {!provider.authenticated && openKeyId === String(provider.id) && provider.id !== 'vertex-ai' && (
            <>
              <form
                className="settings-provider-secret"
                onSubmit={(event) => {
                  event.preventDefault();
                  const form = event.currentTarget;
                  const secret = new FormData(form).get('secret');
                  form.reset();
                  closeKeyForm(String(provider.id));
                  void run('saveProviderApiKey', [provider.id, secret], `provider-key-${String(provider.id)}`);
                }}
              >
                <input
                  name="secret"
                  data-provider-key={String(provider.id)}
                  type="password"
                  autoComplete="off"
                  placeholder={t('API key')}
                  aria-label={`${providerLabel(provider)} ${t('API key')}`}
                  required
                />
                <button type="submit" disabled={busy}>
                  {t('Save')}
                </button>
              </form>
              <ActionButton onClick={() => closeKeyForm(String(provider.id))}>{t('Cancel')}</ActionButton>
            </>
          )}
          {Boolean(provider.stored || (!provider.env && provider.authenticated)) && (
            <ActionButton
              danger
              disabled={busy}
              onClick={() => {
                confirm({
                  title: t('Forget provider authentication?'),
                  description: t('Remove the saved authentication for {{name}}.', { name: providerLabel(provider) }),
                  confirmLabel: t('Forget'),
                  danger: true,
                  onConfirm: () => void run('forgetProviderAuth', [provider.id]),
                });
              }}
            >
              {t('Forget')}
            </ActionButton>
          )}
        </>
      }
    />
  );
  const keychainIssue = record(setup.keychain);
  const keychainBlocked = typeof keychainIssue.message === 'string' && keychainIssue.message !== '';
  useKeychainRefresh(run);
  // Cold open: one same-size block until the setup and every account roster
  // are in, then the whole page at once — nothing on screen has to move.
  const oauthIds = setup.managedByClient === true ? [] : oauthProviders.map((provider) => String(provider.id));
  const poolsReady = useProviderPoolsReady(api, oauthIds);
  const withoutAccounts = useProvidersWithoutAccounts(api, oauthIds);
  if (loading || !poolsReady) {
    return (
      <div className="settings-panel-placeholder" role="status" aria-busy="true">
        <span>{t('Loading providers…')}</span>
      </div>
    );
  }
  if (setup.managedByClient === true) {
    return (
      <>
        <ClientManagedProviders setup={setup} />
        <QuotaAutoResumeToggle />
      </>
    );
  }
  return (
    <>
      {keychainBlocked && <KeychainAlert issue={keychainIssue} busy={busy} run={run} />}
      <OAuthProvidersCard
        api={api}
        providers={oauthProviders}
        withoutAccounts={withoutAccounts}
        busy={busy}
        run={run}
        confirm={confirm}
      />
      <Group title={t('API-key providers')}>
        {otherApiProviders.map(renderApiProvider)}
        {otherApiProviders.length === 0 && <ListEmpty text={t('No API-key providers available.')} />}
      </Group>
      <CustomProvidersSection providers={customProviders} loading={loading} run={run} confirm={confirm} busy={busy} />
      <QuotaAutoResumeToggle />
    </>
  );
}

export function OAuthControl({
  api,
  provider,
  disabled,
  run,
  onComplete,
  addAccount = false,
  accountId,
}: {
  api: PanelContext['api'];
  provider: RecordValue;
  disabled: boolean;
  run: PanelContext['run'];
  onComplete?: () => void;
  addAccount?: boolean;
  accountId?: string;
}) {
  const providerId = String(provider.id || '');
  const {
    flow,
    setFlow,
    error,
    pasteError,
    setPasteError,
    remote,
    start: beginFlow,
    close,
  } = useOAuthLoginFlow({
    run,
    keyId: providerId,
    statusCapability: 'getOAuthProviderLoginStatus',
    cancelCapability: 'cancelOAuthProviderLogin',
    statusError:
      providerId === 'cursor-oauth'
        ? t('Cursor OAuth status could not be checked.')
        : t('OAuth status could not be checked.'),
    // A browser-callback login completes through status polling, never through
    // completeOAuthProviderLogin, so it invalidates the provider-derived caches
    // (setup snapshot and model pickers) itself. The daemon reports `complete`
    // only after it adopted the new credentials.
    refresh: async () => {
      invalidateSidebarReferenceForMutation('completeOAuthProviderLogin');
      const next = await run<RecordValue>(
        'getProviderSetup',
        [{ force: true }],
        `oauth-refresh-${providerId}`,
        true,
        true
      );
      return next ? undefined : t('Connected, but provider status could not be refreshed.');
    },
    onDone: () => {
      window.dispatchEvent(new window.Event(PROVIDER_ACCOUNTS_CHANGED));
      onComplete?.();
    },
  });
  const flowId = String(flow?.flowId || '');
  const flowState = String(flow?.state || '');
  useOAuthUsageRefresh(api, flowId, flowState);
  // A remote client signs in on its own machine, so every provider that can
  // take the final redirect (or code) back gets a paste step.
  const manualCodeFlow =
    providerId === 'anthropic-oauth' || providerId === 'mimo-oauth' || providerId === 'command-code-oauth' || remote;
  const start = () =>
    beginFlow((isRemote) => {
      // The host must not open a browser nobody is sitting at for a remote client.
      const hostBrowser = isRemote ? { openBrowser: false } : {};
      let loginArgs: unknown[] = isRemote ? [providerId, hostBrowser] : [providerId];
      if (addAccount) loginArgs = [providerId, { addAccount: true, ...hostBrowser }];
      else if (accountId) loginArgs = [providerId, { accountId, ...hostBrowser }];
      return run<RecordValue>('beginOAuthProviderLogin', loginArgs, `oauth-begin-${providerId}`, false, false, 'throw');
    });
  // Google can end the sign-in with an account check of its own: a one-time
  // verification link, after which the login has to be started over.
  const verificationUrl = flow ? verificationUrlOf(flow.error) : '';
  return (
    <>
      {addAccount && (
        <button
          type="button"
          className="provider-account-add-button"
          disabled={disabled}
          aria-label={t('Add account')}
          title={t('Add account')}
          onClick={() => void start()}
        >
          <Plus size={16} aria-hidden="true" />
        </button>
      )}
      {!addAccount && (
        <ActionButton disabled={disabled} onClick={() => void start()}>
          {accountId ? t('Reconnect') : t('Connect')}
        </ActionButton>
      )}
      {!flow && error && <ErrorNotice error={error} />}
      {flow && (
        <OAuthLoginDialog
          id={providerId}
          closeLabel={t(providerId === 'cursor-oauth' ? 'Close Cursor OAuth' : 'Close OAuth login')}
          flow={flow}
          error={error}
          paste={
            manualCodeFlow && flow.manualCodeSupported
              ? {
                  title: remote ? t('Sign-in redirect URL or code') : t('Anthropic authorization code'),
                  placeholder: remote
                    ? t('Paste the final redirect URL or code')
                    : t('Authorization code or code#state'),
                  ariaLabel: remote ? t('Sign-in redirect URL or code') : t('Anthropic authorization code'),
                  error: pasteError,
                  onSubmit: (code, form) => {
                    form.reset();
                    setPasteError('');
                    void run<RecordValue>(
                      'completeOAuthProviderLogin',
                      [flow.flowId, code],
                      `oauth-complete-${providerId}`,
                      false,
                      false,
                      'throw'
                    )
                      .then((next) => {
                        if (next) setFlow(record(next));
                        else setPasteError(t('The authorization code could not be completed.'));
                      })
                      .catch((reason) => setPasteError(pasteErrorText(reason)));
                  },
                }
              : undefined
          }
          disabled={disabled}
          onClose={close}
        >
          {verificationUrl && (
            <section className="settings-oauth-verify" role="alert">
              <b>{t('Additional verification required')}</b>
              <p>
                {t(
                  'Google asks for an extra check on this account before Antigravity can be used. Open the verification page, finish the steps there, then sign in again.'
                )}
              </p>
              <div className="settings-oauth-verify-actions">
                <button
                  type="button"
                  className="primary"
                  onClick={() => void window.mixdogDesktop?.openExternal?.(verificationUrl).catch(() => undefined)}
                >
                  <ExternalLink size={14} aria-hidden="true" />
                  {t('Open verification page')}
                </button>
                <button type="button" disabled={disabled} onClick={() => void start()}>
                  {t('Sign in again')}
                </button>
              </div>
            </section>
          )}
        </OAuthLoginDialog>
      )}
    </>
  );
}
