import { ExternalLink, Plus } from 'lucide-react';
import { useEffect, useRef } from 'react';

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
} from '../ProviderAccountsList';
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

export function ProvidersPanel({ api, data, pending, run, confirm }: PanelContext) {
  const host = (window as unknown as { mixdogDesktop?: DesktopApi }).mixdogDesktop;
  const openKeyConsole = (url: string) => void host?.openExternal?.(url).catch(() => undefined);
  const setup = record(data.providerSetup);
  const { custom: customProviders, otherApi: otherApiProviders, oauth: oauthProviders } = providerPageGroups(setup);
  const busy = Boolean(pending);
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
      description={String(provider.detail || provider.envName || '')}
      // ResourceRow drops `description`; where the key is kept (a private file when
      // there is no OS keychain) is shown as the row's secondary text.
      meta={provider.detail === 'stored in private file' ? t('Stored in a private file') : undefined}
      status={providerStatus(provider)}
      actions={
        <>
          {typeof provider.url === 'string' && /^https:\/\//.test(provider.url) && (
            <ActionButton disabled={busy} onClick={() => openKeyConsole(String(provider.url))}>
              {provider.authenticated ? `${t('API keys')} ↗` : t('Get API key ↗')}
            </ActionButton>
          )}
          {!provider.authenticated && (
            <form
              className="settings-provider-secret"
              onSubmit={(event) => {
                event.preventDefault();
                const form = event.currentTarget;
                const secret = new FormData(form).get('secret');
                form.reset();
                void run('saveProviderApiKey', [provider.id, secret], `provider-key-${String(provider.id)}`);
              }}
            >
              <input
                name="secret"
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
  const runRef = useRef(run);
  runRef.current = run;
  // Poll while mounted: the daemon re-checks the keyring (without prompting) on
  // every ready read, so the alert appears/disappears live, including when the
  // keyring locks or is unlocked while this page is open.
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
  const keychainState = String(keychainIssue.state || '');
  // Cold open: one same-size block until the setup and every account roster
  // are in, then the whole page at once — nothing on screen has to move.
  const poolsReady = useProviderPoolsReady(
    api,
    setup.managedByClient === true ? [] : oauthProviders.map((provider) => String(provider.id))
  );
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
        <QuotaAutoResumeToggle />
        <ClientManagedProviders setup={setup} />
      </>
    );
  }
  return (
    <>
      {keychainBlocked && (
        <p className="settings-error" role="alert" data-keychain-state={String(keychainIssue.state || '')}>
          {t(String(keychainIssue.message))}
          {(keychainState === 'locked' || keychainState === 'error' || keychainState === 'unreachable') && (
            <ActionButton
              disabled={busy}
              onClick={() => void run('getProviderSetup', [{ force: true, unlockKeychain: true }])}
            >
              {t('Unlock keyring')}
            </ActionButton>
          )}
        </p>
      )}
      <QuotaAutoResumeToggle />
      {/* One card PER provider: sharing a single card ran "OpenAI's accounts →
        Anthropic header" as one continuous list (user: 프로바이더별 분리된
        느낌이 없다). The section keeps the shared heading; each provider owns
        its own bordered body. */}
      <section className="settings-group settings-provider-cards">
        <header>
          <h3>{t('OAuth providers')}</h3>
        </header>
        {oauthProviders.length > 0 &&
          oauthProviders.map((provider) => (
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
        {oauthProviders.length === 0 && (
          <div className="settings-group-body">
            <ListEmpty text={loading ? t('Loading providers…') : t('No OAuth providers available.')} />
          </div>
        )}
      </section>
      <Group title={t('API-key providers')}>
        {otherApiProviders.length > 0 && otherApiProviders.map(renderApiProvider)}
        {otherApiProviders.length === 0 && (
          <ListEmpty text={loading ? t('Loading providers…') : t('No API-key providers available.')} />
        )}
      </Group>
      <CustomProvidersSection providers={customProviders} loading={loading} run={run} confirm={confirm} busy={busy} />
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
