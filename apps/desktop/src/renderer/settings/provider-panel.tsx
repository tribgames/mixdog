import { ExternalLink, X, Plus } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import type { DesktopApi } from '../../shared/contract';
import { t } from '../i18n';
import { ErrorNotice, verificationUrlOf } from '../ErrorNotice';
import { registerMobileBack } from '../mobile-back';
import { record } from '../record-utils';
import { isRemoteHostRenderer } from '../remote-ui-projection';
import { invalidateSidebarReferenceForMutation } from '../sidebar-reference-cache';
import { useOAuthUsageRefresh } from './use-oauth-usage-refresh';
import { ProviderAccountsList, PROVIDER_ACCOUNTS_CHANGED } from '../ProviderAccountsList';
import { ActionButton, Group, ListEmpty, ResourceRow, settingsStatus } from './capability-controls';
import { CustomProvidersSection, isCustomProvider } from './custom-provider-section';
import { providerLabel, rows, sectionLoaded, type PanelContext, type RecordValue } from './capability-data';

export function ProvidersPanel({ api, data, pending, run, confirm }: PanelContext) {
  const host = (window as unknown as { mixdogDesktop?: DesktopApi }).mixdogDesktop;
  const openKeyConsole = (url: string) => void host?.openExternal?.(url).catch(() => undefined);
  const setup = record(data.providerSetup);
  const allApiProviders = rows(setup.api);
  const customProviders = allApiProviders.filter(isCustomProvider);
  const apiProviders = allApiProviders.filter((provider) => !isCustomProvider(provider));
  const openCodeGoProvider = apiProviders.find((provider) => String(provider.id) === 'opencode-go');
  const otherApiProviders = apiProviders.filter((provider) => provider !== openCodeGoProvider);
  const oauthProviders = rows(setup.oauth);
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
      status={providerStatus(provider)}
      actions={
        <>
          {!provider.authenticated && typeof provider.url === 'string' && /^https:\/\//.test(provider.url) && (
            <ActionButton disabled={busy} onClick={() => openKeyConsole(String(provider.url))}>
              {t('Get API key ↗')}
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
  return (
    <>
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
      {openCodeGoProvider && <Group>{renderApiProvider(openCodeGoProvider)}</Group>}
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
  const [flow, setFlow] = useState<RecordValue | null>(null);
  const [error, setError] = useState('');
  const completedFlowRef = useRef('');
  const onCompleteRef = useRef(onComplete);
  const runRef = useRef(run);
  const providerId = String(provider.id || '');
  const flowId = String(flow?.flowId || '');
  const flowOpen = Boolean(flow);
  const flowState = String(flow?.state || '');
  useOAuthUsageRefresh(api, flowId, flowState);
  // A remote client signs in on its own machine, so every provider that can
  // take the final redirect (or code) back gets a paste step.
  const remote = isRemoteHostRenderer();
  const manualCodeFlow = providerId === 'anthropic-oauth' || remote;
  const openSignInPage = (url: unknown) => {
    if (typeof url === 'string' && url) void window.mixdogDesktop?.openExternal?.(url).catch(() => undefined);
  };
  const loginLabel = providerId === 'cursor-oauth' ? 'Cursor OAuth' : `${providerLabel(provider)} OAuth`;
  const status = settingsStatus(flowState || 'pending');
  useEffect(() => {
    onCompleteRef.current = onComplete;
  }, [onComplete]);
  useEffect(() => {
    runRef.current = run;
  }, [run]);
  useEffect(() => {
    if (!flowId || flowState !== 'pending') return undefined;
    let cancelled = false;
    let timer = 0;
    const poll = async () => {
      const next = await runRef.current<RecordValue>(
        'getOAuthProviderLoginStatus',
        [flowId],
        `oauth-status-${providerId}`,
        false,
        true
      );
      if (cancelled) return;
      if (!next) {
        setError(
          providerId === 'cursor-oauth'
            ? t('Cursor OAuth status could not be checked.')
            : t('OAuth status could not be checked.')
        );
        return;
      }
      const nextFlow = record(next);
      setFlow(nextFlow);
      if (String(nextFlow.state || 'pending') === 'pending') {
        timer = window.setTimeout(() => void poll(), 500);
      }
    };
    timer = window.setTimeout(() => void poll(), 500);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [flowId, flowState, providerId]);
  useEffect(() => {
    if (!flowId || flowState !== 'complete' || completedFlowRef.current === flowId) return;
    completedFlowRef.current = flowId;
    // A browser-callback login completes through status polling, never through
    // completeOAuthProviderLogin, so it invalidates the provider-derived caches
    // (setup snapshot and model pickers) itself. The daemon reports `complete`
    // only after it adopted the new credentials.
    invalidateSidebarReferenceForMutation('completeOAuthProviderLogin');
    void runRef
      .current<RecordValue>('getProviderSetup', [{ force: true }], `oauth-refresh-${providerId}`, true, true)
      .then((next) => {
        if (completedFlowRef.current !== flowId) return;
        if (!next) {
          completedFlowRef.current = '';
          setError(t('Connected, but provider status could not be refreshed.'));
          return;
        }
        setFlow((current) => (String(current?.flowId || '') === flowId ? null : current));
        window.dispatchEvent(new window.Event(PROVIDER_ACCOUNTS_CHANGED));
        onCompleteRef.current?.();
      });
  }, [flowId, flowState, providerId]);
  const start = async () => {
    setError('');
    completedFlowRef.current = '';
    // The host must not open a browser nobody is sitting at for a remote client.
    const hostBrowser = remote ? { openBrowser: false } : {};
    let loginArgs: unknown[] = remote ? [providerId, hostBrowser] : [providerId];
    if (addAccount) loginArgs = [providerId, { addAccount: true, ...hostBrowser }];
    else if (accountId) loginArgs = [providerId, { accountId, ...hostBrowser }];
    try {
      const next = await run<RecordValue>(
        'beginOAuthProviderLogin',
        loginArgs,
        `oauth-begin-${providerId}`,
        false,
        false,
        'throw'
      );
      if (next) {
        const started = record(next);
        setFlow(started);
        if (remote) openSignInPage(started.manualUrl || started.url);
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };
  const close = () => {
    const currentFlowId = String(flow?.flowId || '');
    const currentState = String(flow?.state || '');
    setFlow(null);
    setError('');
    if (currentFlowId && currentState !== 'complete' && currentState !== 'cancelled') {
      void run('cancelOAuthProviderLogin', [currentFlowId], `oauth-cancel-${providerId}`, false);
    }
  };
  // Google can end the sign-in with an account check of its own: a one-time
  // verification link, after which the login has to be started over.
  const verificationUrl = flow ? verificationUrlOf(flow.error) : '';
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    if (!flowOpen) return undefined;
    return registerMobileBack(() => closeRef.current());
  }, [flowOpen]);
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
        // biome-ignore lint/a11y/noStaticElementInteractions: scrim click-to-dismiss; keyboard dismissal is the dialog's close button and Escape.
        <div
          className="settings-oauth-layer"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) close();
          }}
        >
          <section
            className="settings-oauth-dialog"
            role="dialog"
            aria-modal="true"
            data-settings-nested-dialog
            aria-labelledby={`settings-oauth-title-${providerId}`}
            aria-describedby={`settings-oauth-description-${providerId}`}
          >
            <header>
              <div>
                <h3 id={`settings-oauth-title-${providerId}`}>{loginLabel}</h3>
                <p id={`settings-oauth-description-${providerId}`}>
                  {remote && flow.manualCodeSupported
                    ? t('Sign in on the opened page. When it ends on a page that cannot load, paste that page address here.')
                    : manualCodeFlow
                      ? t('Complete the browser login, then paste the authorization code.')
                      : t('Finish signing in in your browser. This window updates automatically.')}
                </p>
              </div>
              <button
                type="button"
                aria-label={t(providerId === 'cursor-oauth' ? 'Close Cursor OAuth' : 'Close OAuth login')}
                data-settings-nested-close
                // biome-ignore lint/a11y/noAutofocus: the dialog's close button takes focus on open.
                autoFocus
                onClick={close}
              >
                <X aria-hidden="true" size={16} />
              </button>
            </header>
            <div className="settings-oauth-body">
              <div className="settings-oauth-status" role="status">
                <span>{t('Status')}</span>
                <b className={`tone-${status.tone}`}>{t(status.label)}</b>
              </div>
              {/* A remote client opens the URL on its own machine: the host's browser is not in front of it. */}
              {(manualCodeFlow || remote) && Boolean(flow.manualUrl || flow.url) && (
                <label className="settings-oauth-url">
                  {t('Manual login URL')}
                  <textarea readOnly value={String(flow.manualUrl || flow.url)} />
                </label>
              )}
              {remote && Boolean(flow.manualUrl || flow.url) && flow.state !== 'complete' && (
                <button type="button" className="primary" onClick={() => openSignInPage(flow.manualUrl || flow.url)}>
                  <ExternalLink size={14} aria-hidden="true" />
                  {t('Open sign-in page')}
                </button>
              )}
              {manualCodeFlow && Boolean(flow.manualCodeSupported) && flow.state !== 'complete' && (
                <form
                  className="settings-oauth-code"
                  onSubmit={(event) => {
                    event.preventDefault();
                    const form = event.currentTarget;
                    const code = new FormData(form).get('code');
                    form.reset();
                    setError('');
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
                        else setError(t('The authorization code could not be completed.'));
                      })
                      .catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
                  }}
                >
                  <input
                    name="code"
                    placeholder={
                      remote ? t('Paste the final redirect URL or code') : t('Authorization code or code#state')
                    }
                    aria-label={remote ? t('Sign-in redirect URL or code') : t('Anthropic authorization code')}
                    required
                  />
                  <button type="submit" className="primary" disabled={disabled}>
                    {t('Complete')}
                  </button>
                </form>
              )}
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
              <ErrorNotice errors={[flow.error, error]} />
            </div>
            <footer>
              <button type="button" disabled={disabled} onClick={close}>
                {flow.state === 'pending' ? t('Cancel') : t('Close')}
              </button>
            </footer>
          </section>
        </div>
      )}
    </>
  );
}
