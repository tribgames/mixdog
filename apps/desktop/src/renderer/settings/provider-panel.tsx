import { X } from 'lucide-react';
import React, { useEffect, useRef, useState } from 'react';

import type { DesktopApi } from '../../shared/contract';
import { t } from '../i18n';
import { registerMobileBack } from '../mobile-back';
import { record } from '../record-utils';
import {
  ActionButton,
  FormRow,
  Group,
  ListEmpty,
  ResourceRow,
  settingsStatus,
} from './capability-controls';
import {
  providerLabel,
  rows,
  sectionLoaded,
  type PanelContext,
  type RecordValue,
} from './capability-data';

export function ProvidersPanel({ data, pending, run, confirm }: PanelContext) {
  const host = (window as unknown as { mixdogDesktop?: DesktopApi }).mixdogDesktop;
  const openKeyConsole = (url: string) => void host?.openExternal?.(url).catch(() => undefined);
  const setup = record(data.providerSetup);
  const apiProviders = rows(setup.api);
  const oauthProviders = rows(setup.oauth);
  const localProviders = rows(setup.local);
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
  return <>
    <Group title="OAuth providers">{oauthProviders.length ? oauthProviders.map((provider) => <ResourceRow key={String(provider.id)} title={providerLabel(provider)}
      description={String(provider.detail || '')}
      status={providerStatus(provider)}
      actions={<><OAuthControl provider={provider} disabled={busy} run={run} />
        {(provider.authenticated || provider.reauthRequired) && <ActionButton danger disabled={busy} onClick={() => {
          confirm({ title: 'Forget provider authentication?', description: t('Remove the saved authentication for {{name}}.', { name: providerLabel(provider) }),
            confirmLabel: 'Forget', danger: true, onConfirm: () => void run('forgetProviderAuth', [provider.id]) });
        }}>Forget</ActionButton>}</>} />) : <ListEmpty text={loading ? 'Loading providers…' : 'No OAuth providers available.'} />}</Group>
    <Group title="API-key providers">{apiProviders.length ? apiProviders.map((provider) => <ResourceRow key={String(provider.id)} title={providerLabel(provider)}
      description={String(provider.detail || provider.envName || '')}
      status={providerStatus(provider)}
      actions={<>{String(provider.id) === 'opencode-go' && <ActionButton disabled={busy}
        onClick={() => void run('loginOpenCodeGoUsage')}>Usage sign-in</ActionButton>}
        {!provider.authenticated && typeof provider.url === 'string' && /^https:\/\//.test(provider.url) &&
          <ActionButton disabled={busy} onClick={() => openKeyConsole(String(provider.url))}>Get API key ↗</ActionButton>}
        {!provider.authenticated && <form className="settings-provider-secret" onSubmit={(event) => {
          event.preventDefault();
          const form = event.currentTarget;
          const secret = new FormData(form).get('secret');
          form.reset();
          void run('saveProviderApiKey', [provider.id, secret], `provider-key-${String(provider.id)}`);
        }}>
          <input name="secret" type="password" autoComplete="off" placeholder="API key"
            aria-label={`${providerLabel(provider)} API key`} required />
          <button disabled={busy}>Save</button>
        </form>}
        {Boolean(provider.stored || (!provider.env && provider.authenticated)) &&
          <ActionButton danger disabled={busy} onClick={() => {
        confirm({ title: 'Forget provider authentication?', description: t('Remove the saved authentication for {{name}}.', { name: providerLabel(provider) }),
          confirmLabel: 'Forget', danger: true, onConfirm: () => void run('forgetProviderAuth', [provider.id]) });
        }}>Forget</ActionButton>}</>} />) : <ListEmpty text={loading ? 'Loading providers…' : 'No API-key providers available.'} />}</Group>
    <Group title="Local providers">{localProviders.length ? localProviders.map((provider) => <React.Fragment key={String(provider.id)}>
      <ResourceRow title={providerLabel(provider)} description={String(provider.baseURL || provider.detail || '')}
        status={String(provider.status || (provider.detected ? 'Detected' : 'Off'))}
        actions={<ActionButton disabled={busy} onClick={() => void run('setLocalProvider', [provider.id, {
          enabled: provider.enabled !== true, baseURL: provider.baseURL,
        }])}>{provider.enabled ? 'Disable' : 'Enable'}</ActionButton>} />
      <FormRow title={`${providerLabel(provider)} endpoint`} description="Update the OpenAI-compatible base URL."
        onSubmit={(form) => void run('setLocalProvider', [provider.id, {
          enabled: provider.enabled === true, baseURL: form.get('baseURL'),
        }], `local-${provider.id}`)}>
        <input name="baseURL" type="url" defaultValue={String(provider.baseURL || provider.defaultURL || '')}
          aria-label={`${providerLabel(provider)} endpoint`}
          placeholder={String(provider.defaultURL || 'http://127.0.0.1:11434/v1')} required />
        <button disabled={busy}>Save</button>
      </FormRow>
    </React.Fragment>) : <ListEmpty text={loading ? 'Loading providers…' : 'No local providers available.'} />}</Group>
  </>;
}

export function OAuthControl({ provider, disabled, run, onComplete }: {
  provider: RecordValue;
  disabled: boolean;
  run: PanelContext['run'];
  onComplete?: () => void;
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
  const manualCodeFlow = providerId === 'anthropic-oauth';
  const loginLabel = providerId === 'cursor-oauth' ? 'Cursor OAuth' : `${providerLabel(provider)} OAuth`;
  const status = settingsStatus(flowState || 'pending');
  useEffect(() => { onCompleteRef.current = onComplete; }, [onComplete]);
  useEffect(() => { runRef.current = run; }, [run]);
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
        true,
      );
      if (cancelled) return;
      if (!next) {
        setError(providerId === 'cursor-oauth'
          ? t('Cursor OAuth status could not be checked.')
          : t('OAuth status could not be checked.'));
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
    void runRef.current<RecordValue>(
      'getProviderSetup',
      [{ force: true }],
      `oauth-refresh-${providerId}`,
      true,
    ).then((next) => {
      if (completedFlowRef.current !== flowId) return;
      if (!next) {
        completedFlowRef.current = '';
        setError('Connected, but provider status could not be refreshed.');
        return;
      }
      setFlow((current) => String(current?.flowId || '') === flowId ? null : current);
      onCompleteRef.current?.();
    });
  }, [flowId, flowState, providerId]);
  const start = async () => {
    setError('');
    completedFlowRef.current = '';
    const next = await run<RecordValue>('beginOAuthProviderLogin', [providerId], `oauth-begin-${providerId}`, false);
    if (next) setFlow(record(next));
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
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    if (!flowOpen) return undefined;
    return registerMobileBack(() => closeRef.current());
  }, [flowOpen]);
  return <>
    <ActionButton disabled={disabled} onClick={() => void start()}>{provider.authenticated || provider.reauthRequired ? 'Reconnect' : 'Connect'}</ActionButton>
    {flow && <div className="settings-oauth-layer" onMouseDown={(event) => {
      if (event.target === event.currentTarget) close();
    }}><section className="settings-oauth-dialog" role="dialog" aria-modal="true" data-settings-nested-dialog
      aria-labelledby={`settings-oauth-title-${providerId}`} aria-describedby={`settings-oauth-description-${providerId}`}>
      <header><div><h3 id={`settings-oauth-title-${providerId}`}>{loginLabel}</h3>
        <p id={`settings-oauth-description-${providerId}`}>{manualCodeFlow
          ? t('Complete the browser login, then paste the authorization code.')
          : t('Finish signing in in your browser. This window updates automatically.')}</p></div>
        <button type="button" aria-label={t(providerId === 'cursor-oauth' ? 'Close Cursor OAuth' : 'Close OAuth login')} data-settings-nested-close autoFocus onClick={close}>
          <X aria-hidden="true" size={16} />
        </button></header>
      <div className="settings-oauth-body">
        <div className="settings-oauth-status" role="status"><span>{t('Status')}</span>
          <b className={`tone-${status.tone}`}>{t(status.label)}</b></div>
        {String(flow.error || '') && <p className="settings-oauth-error" role="alert">{String(flow.error)}</p>}
        {manualCodeFlow && Boolean(flow.manualUrl || flow.url) && <label className="settings-oauth-url">{t('Manual login URL')}
          <textarea readOnly value={String(flow.manualUrl || flow.url)} /></label>}
        {manualCodeFlow && Boolean(flow.manualCodeSupported) && flow.state !== 'complete' && <form className="settings-oauth-code" onSubmit={(event) => {
        event.preventDefault();
        const form = event.currentTarget;
        const code = new FormData(form).get('code');
        form.reset();
        void run<RecordValue>('completeOAuthProviderLogin', [flow.flowId, code], `oauth-complete-${providerId}`, false)
          .then((next) => {
            if (next) setFlow(record(next));
            else setError('The authorization code could not be completed.');
          });
      }}><input name="code" placeholder={t('Authorization code or code#state')} aria-label={t('Anthropic authorization code')} required />
          <button type="submit" className="primary" disabled={disabled}>{t('Complete')}</button></form>}
        {error && <p className="settings-oauth-error" role="alert">{error}</p>}
      </div>
      <footer><button type="button" disabled={disabled} onClick={close}>
        {flow.state === 'pending' ? t('Cancel') : t('Close')}
      </button></footer>
    </section></div>}
  </>;
}
