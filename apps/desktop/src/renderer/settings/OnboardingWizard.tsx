import React, { type FormEvent, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeft, ArrowRight, Check, Cloud, Palette, Sparkles, X } from 'lucide-react';

import type {
  DesktopApi,
  DesktopCapability,
  DesktopCapabilityReadRequest,
  DesktopCapabilityReadResult,
  DesktopModelOption,
  DesktopModelSelection,
} from '../../shared/contract';
import { applyDesktopTheme, clearDesktopThemePreference } from '../desktop-theme';
import { OpenSelect } from '../OpenSelect';
import { modelOptionLabel, providerDisplayName } from '../provider-display';
import { OAuthControl } from './CapabilitySettings';

type RecordValue = Record<string, unknown>;
const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

function record(value: unknown): RecordValue {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : {};
}

function rows(value: unknown, key?: string): RecordValue[] {
  if (Array.isArray(value)) return value.map(record);
  const source = record(value);
  return key && Array.isArray(source[key]) ? (source[key] as unknown[]).map(record) : [];
}

function title(value: RecordValue): string {
  return String(value.label || value.name || value.display || value.id || 'Unknown');
}

function providerTitle(value: RecordValue): string {
  if (value.name || value.label) return String(value.name || value.label);
  const id = String(value.id || value.provider || value.name || '');
  return providerDisplayName(id);
}

async function readCapabilityBatch(
  api: DesktopApi,
  requests: DesktopCapabilityReadRequest[],
): Promise<DesktopCapabilityReadResult[]> {
  if (typeof api.readCapabilities === 'function') return api.readCapabilities(requests);
  return Promise.all(requests.map(async (request) => {
    try {
      const result = await api.invokeCapability({ capability: request.capability, args: request.args });
      return { ok: true as const, value: result.value };
    } catch (reason) {
      return { ok: false as const, error: reason instanceof Error ? reason.message : String(reason) };
    }
  }));
}

function routeFromModel(model: DesktopModelOption): DesktopModelSelection {
  return {
    provider: model.provider,
    model: model.model,
  };
}

function routeKey(route: DesktopModelSelection | null | undefined): string {
  return route ? `${route.provider}:${route.model}` : '';
}

export function OnboardingWizard({ api, onDone }: {
  api: DesktopApi;
  onDone(): void;
}) {
  const [step, setStep] = useState(0);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState('');
  const [error, setError] = useState('');
  const [providerSetup, setProviderSetup] = useState<RecordValue>({});
  const [models, setModels] = useState<DesktopModelOption[]>([]);
  const [searchModels, setSearchModels] = useState<RecordValue[]>([]);
  const [agents, setAgents] = useState<RecordValue[]>([]);
  const [themes, setThemes] = useState<RecordValue[]>([]);
  const [styles, setStyles] = useState<RecordValue[]>([]);
  const [theme, setTheme] = useState('');
  const [style, setStyle] = useState('');
  const [mainRoute, setMainRoute] = useState<DesktopModelSelection | null>(null);
  const [searchRoute, setSearchRoute] = useState<DesktopModelSelection | null>({ provider: 'default', model: 'default' });
  const [agentRoutes, setAgentRoutes] = useState<Record<string, DesktopModelSelection>>({});
  const [mainRouteTouched, setMainRouteTouched] = useState(false);
  const [searchRouteTouched, setSearchRouteTouched] = useState(false);
  const [confirmSkip, setConfirmSkip] = useState(false);
  const layerRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const skipTriggerRef = useRef<HTMLButtonElement | null>(null);
  const priorFocus = useRef<HTMLElement | null>(null);

  const run = useCallback(async <T,>(
    capability: DesktopCapability,
    args: unknown[] = [],
    key: string = capability,
    _refresh = false,
  ): Promise<T | undefined> => {
    if (pending) return undefined;
    setPending(key);
    setError('');
    try {
      return (await api.invokeCapability<T>({ capability, args })).value;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      return undefined;
    } finally {
      setPending('');
    }
  }, [api, pending]);

  const load = useCallback(async (force = false) => {
    setLoading(true);
    setError('');
    try {
      const readRequests: DesktopCapabilityReadRequest[] = [
        { capability: 'getProviderSetup' },
        { capability: 'listSearchModels', args: [{ quick: false, ...(force ? { force: true } : {}) }] },
        { capability: 'listAgents' },
        { capability: 'listThemes' },
        { capability: 'getTheme' },
        { capability: 'listOutputStyles' },
        { capability: 'getSearchRoute' },
      ];
      const [readResults, modelResult, snapshotResult] = await Promise.all([
        readCapabilityBatch(api, readRequests),
        api.listProviderModels({ quick: false, ...(force ? { force: true } : {}) }),
        api.getSnapshot(),
      ]);
      const values = readResults.map((result) => result.ok ? result.value : null);
      const readErrors = readResults.flatMap((result) => result.ok ? [] : [result.error]);
      if (readErrors.length) setError(readErrors.join(' · '));
      setProviderSetup(record(values[0]));
      setModels(modelResult);
      setSearchModels(rows(values[1]));
      setAgents(rows(values[2]));
      setThemes(rows(values[3]));
      setTheme(String(values[4] || ''));
      const output = record(values[5]);
      setStyles(rows(output.styles));
      setStyle(String(record(output.current).id || output.configured || 'default'));
      const snapshot = record(snapshotResult);
      if (snapshot.provider && snapshot.model) {
        setMainRoute({
          provider: String(snapshot.provider),
          model: String(snapshot.model),
          ...(snapshot.effort ? { effort: String(snapshot.effort) } : {}),
          ...(typeof snapshot.fast === 'boolean' ? { fast: snapshot.fast } : {}),
        });
      }
      const currentSearch = record(values[6]);
      if (currentSearch.provider && currentSearch.model) {
        setSearchRoute({
          provider: String(currentSearch.provider),
          model: String(currentSearch.model),
          ...(currentSearch.effort ? { effort: String(currentSearch.effort) } : {}),
          ...(typeof currentSearch.fast === 'boolean' ? { fast: currentSearch.fast } : {}),
        });
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => { void load(); }, [load]);

  const searchOptions = useMemo(() => searchModels.flatMap((entry): DesktopModelOption[] => {
    const provider = String(entry.provider || '');
    const model = String(entry.id || entry.model || '');
    if (!provider || !model) return [];
    const effortOptions = rows(entry.effortOptions).flatMap((option) => option.value
      ? [{ value: String(option.value), label: String(option.label || option.value) }]
      : []);
    return [{
      provider,
      model,
      display: String(entry.display || entry.name || model),
      effortOptions,
      fastCapable: entry.fastCapable === true,
      fastPreferred: entry.fastPreferred === true || entry.savedFast === true,
      ...(entry.savedEffort ? { savedEffort: String(entry.savedEffort) } : {}),
    }];
  }), [searchModels]);

  const saveApiKey = async (event: FormEvent<HTMLFormElement>, provider: string) => {
    event.preventDefault();
    const form = event.currentTarget;
    const secret = new FormData(form).get('secret');
    const result = await run('saveProviderApiKey', [provider, secret], `api-${provider}`);
    if (result !== undefined) {
      form.reset();
      await load(true);
    }
  };

  const finish = async () => {
    const defaultRoute = mainRouteTouched ? mainRoute : null;
    const explicitSearchRoute = searchRouteTouched ? searchRoute : null;
    const hasAgentRoutes = Object.keys(agentRoutes).length > 0;
    const result = defaultRoute || explicitSearchRoute || hasAgentRoutes
      ? await run('completeOnboarding', [{
        ...(defaultRoute ? { defaultRoute, defaultProvider: defaultRoute.provider } : {}),
        ...(explicitSearchRoute ? { searchRoute: explicitSearchRoute } : {}),
        ...(hasAgentRoutes ? { agentRoutes } : {}),
      }], 'finish-onboarding')
      : await run('skipOnboarding', [], 'finish-onboarding');
    if (result !== undefined) onDone();
  };

  const skip = async () => {
    const result = await run('skipOnboarding', [], 'skip-onboarding');
    if (result !== undefined) onDone();
  };

  const requestSkip = (trigger?: HTMLButtonElement | null) => {
    skipTriggerRef.current = trigger || closeRef.current;
    setConfirmSkip(true);
  };

  const closeSkipConfirmation = () => {
    setConfirmSkip(false);
    queueMicrotask(() => skipTriggerRef.current?.isConnected && skipTriggerRef.current.focus());
  };

  const confirmSkipOnboarding = () => {
    setConfirmSkip(false);
    void skip();
  };

  useLayoutEffect(() => {
    priorFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const layer = layerRef.current;
    const background = Array.from(document.body.children)
      .filter((element): element is HTMLElement => element instanceof HTMLElement
        && !element.matches('.mx-toast-region')
        && element !== layer)
      .map((element) => ({ element, inert: element.inert, ariaHidden: element.getAttribute('aria-hidden') }));
    for (const { element } of background) {
      element.inert = true;
      element.setAttribute('aria-hidden', 'true');
    }
    closeRef.current?.focus();
    return () => {
      for (const { element, inert, ariaHidden } of background) {
        element.inert = inert;
        if (ariaHidden === null) element.removeAttribute('aria-hidden');
        else element.setAttribute('aria-hidden', ariaHidden);
      }
      if (priorFocus.current?.isConnected) priorFocus.current.focus();
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const dialog = dialogRef.current;
      if (!dialog) return;
      const nested = dialog.querySelector<HTMLElement>('[data-settings-nested-dialog]');
      if (event.key === 'Escape') {
        const openPortaledMenu = Array.from(
          dialog.querySelectorAll<HTMLElement>('[role="combobox"][aria-expanded="true"][aria-controls]'),
        ).some((trigger) => {
          const menu = document.getElementById(trigger.getAttribute('aria-controls') || '');
          return menu?.matches('.mx-menu[role="listbox"]');
        });
        if (openPortaledMenu) return;
        event.preventDefault();
        event.stopPropagation();
        if (nested) nested.querySelector<HTMLButtonElement>('[aria-label^="Close"]')?.click();
        else requestSkip(closeRef.current);
        return;
      }
      if (event.key !== 'Tab') return;
      const root = nested || dialog;
      const controls = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (!controls.length) {
        event.preventDefault();
        root.focus();
        return;
      }
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (event.shiftKey && (document.activeElement === first || !root.contains(document.activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !root.contains(document.activeElement))) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [skip]);

  const steps = [
    { label: 'Providers', icon: <Cloud size={14} /> },
    { label: 'Models', icon: <Sparkles size={14} /> },
    { label: 'Theme', icon: <Palette size={14} /> },
    { label: 'Output', icon: <Check size={14} /> },
  ];

  return createPortal(<div ref={layerRef} className="onboarding-layer">
    <section ref={dialogRef} className="onboarding-dialog" role="dialog" aria-modal="true" aria-labelledby="onboarding-title" tabIndex={-1}>
      <header>
        <div><span className="onboarding-mark">M</span><div><h1 id="onboarding-title">Set up Mixdog</h1>
          <p>Connect your existing backend features to the desktop workspace.</p></div></div>
        <button ref={closeRef} type="button" aria-label="Skip setup" disabled={Boolean(pending)}
          onClick={(event) => requestSkip(event.currentTarget)}><X size={16} /></button>
      </header>
      <nav aria-label="Setup progress">{steps.map((entry, index) => <span key={entry.label}
        className={index === step ? 'active' : index < step ? 'complete' : ''}>{entry.icon}{entry.label}</span>)}</nav>
      <div className="onboarding-body">
        {loading ? <p className="onboarding-loading" role="status"><span aria-hidden="true" />Loading your Mixdog configuration…</p> : <>
          {step === 0 && <ProviderStep setup={providerSetup} pending={pending} run={run}
            onSaveApiKey={(event, provider) => void saveApiKey(event, provider)}
            onReload={() => void load(true)} />}
          {step === 1 && <ModelStep models={models} searchModels={searchOptions} agents={agents}
            mainRoute={mainRoute} searchRoute={searchRoute} agentRoutes={agentRoutes}
            onMain={(route) => { setMainRouteTouched(true); setMainRoute(route); }}
            onSearch={(route) => { setSearchRouteTouched(true); setSearchRoute(route); }}
            onAgents={setAgentRoutes} />}
          {step === 2 && <ChoiceStep title="Desktop theme" description="Choose the palette used across Mixdog Desktop."
            rows={themes} selected={theme} onSelect={(entry) => {
              const id = String(entry.id || '');
              setTheme(id);
              clearDesktopThemePreference();
              applyDesktopTheme(id);
              void run('setTheme', [id, { persist: true }], 'onboarding-theme');
            }} />}
          {step === 3 && <ChoiceStep title="Output style" description="Choose how the Lead agent structures responses."
            rows={styles} selected={style} onSelect={(entry) => {
              const id = String(entry.id || 'default');
              setStyle(id);
              void run('setOutputStyle', [id], 'onboarding-output');
            }} />}
        </>}
        {error && <p className="onboarding-error" role="alert">{error}</p>}
      </div>
      <footer>
        <button type="button" className="secondary" disabled={Boolean(pending)}
          onClick={(event) => requestSkip(event.currentTarget)}>Skip setup</button>
        <div>{step > 0 && <button type="button" disabled={Boolean(pending)} onClick={() => setStep((value) => value - 1)}>
          <ArrowLeft size={14} /> Back</button>}
          {step < steps.length - 1
            ? <button type="button" className="primary" disabled={Boolean(pending)} onClick={() => setStep((value) => value + 1)}>
              Next <ArrowRight size={14} /></button>
            : <button type="button" className="primary" disabled={Boolean(pending)} onClick={() => void finish()}>
              <Check size={14} /> Finish</button>}</div>
      </footer>
      {confirmSkip && <OnboardingSkipConfirmation onCancel={closeSkipConfirmation} onConfirm={confirmSkipOnboarding} />}
    </section>
  </div>, document.body);
}

function OnboardingSkipConfirmation({ onCancel, onConfirm }: {
  onCancel(): void;
  onConfirm(): void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { cancelRef.current?.focus(); }, []);
  return <div className="settings-confirm-layer">
    <section className="settings-confirm-dialog" role="alertdialog" aria-modal="true"
      aria-labelledby="onboarding-skip-title" aria-describedby="onboarding-skip-description"
      data-settings-nested-dialog>
      <header><h3 id="onboarding-skip-title">Skip Mixdog setup?</h3>
        <button type="button" aria-label="Close skip confirmation" onClick={onCancel}>
          <X aria-hidden="true" size={15} />
        </button></header>
      <p id="onboarding-skip-description">
        You can configure providers, models, themes, and output style later in Settings.
      </p>
      <footer><button ref={cancelRef} type="button" onClick={onCancel}>Cancel</button>
        <button type="button" className="danger" onClick={onConfirm}>Skip setup</button></footer>
    </section>
  </div>;
}

function ProviderStep({ setup, pending, run, onSaveApiKey, onReload }: {
  setup: RecordValue;
  pending: string;
  run<T = unknown>(capability: DesktopCapability, args?: unknown[], key?: string, refresh?: boolean): Promise<T | undefined>;
  onSaveApiKey(event: FormEvent<HTMLFormElement>, provider: string): void;
  onReload(): void;
}) {
  const apiProviders = rows(setup.api);
  const oauthProviders = rows(setup.oauth);
  const localProviders = rows(setup.local);
  return <div className="onboarding-step"><div className="onboarding-step-heading"><div><h2>Connect providers</h2>
    <p>Use the same API-key, OAuth, and local-provider backend as Mixdog TUI.</p></div></div>
    <div className="onboarding-provider-list">
      {apiProviders.map((provider) => <form key={String(provider.id)} onSubmit={(event) => onSaveApiKey(event, String(provider.id))}>
        <div><b>{providerTitle(provider)}</b><small>{provider.authenticated ? 'Connected' : String(provider.detail || provider.status || 'API key required')}</small></div>
        <input name="secret" type="password" autoComplete="off" placeholder={provider.authenticated ? 'Replace API key' : 'API key'} required />
        <button disabled={Boolean(pending)}>{provider.authenticated ? 'Replace' : 'Connect'}</button>
        {String(provider.id) === 'opencode-go' && <button type="button" disabled={Boolean(pending)} onClick={() => {
          void run('loginOpenCodeGoUsage', [], 'opencode-go-usage').then((result) => {
            if (result !== undefined) onReload();
          });
        }}>Usage sign-in</button>}
        {Boolean(provider.stored || (!provider.env && provider.authenticated)) &&
          <button type="button" disabled={Boolean(pending)} onClick={() => {
          void run('forgetProviderAuth', [provider.id], `forget-${provider.id}`).then((result) => {
            if (result !== undefined) onReload();
          });
        }}>Forget</button>}
      </form>)}
      {oauthProviders.map((provider) => <div className="onboarding-provider-row" key={String(provider.id)}><div><b>{providerTitle(provider)}</b>
        <small>{String(provider.detail || provider.status || '')}</small></div><span>{provider.authenticated ? 'Connected' : 'OAuth'}</span>
        <OAuthControl provider={{ ...provider, label: providerTitle(provider) }} disabled={Boolean(pending)} run={run} onComplete={onReload} />
        {Boolean(provider.authenticated) && <button type="button" disabled={Boolean(pending)} onClick={() => {
          void run('forgetProviderAuth', [provider.id], `forget-${provider.id}`).then((result) => {
            if (result !== undefined) onReload();
          });
        }}>Forget</button>}</div>)}
      {localProviders.map((provider) => <form key={String(provider.id)} onSubmit={(event) => {
        event.preventDefault();
        const baseURL = new FormData(event.currentTarget).get('baseURL');
        void run('setLocalProvider', [provider.id, { enabled: true, baseURL }], `local-${provider.id}`)
          .then((result) => { if (result !== undefined) onReload(); });
      }}><div><b>{providerTitle(provider)}</b><small>{String(provider.status || 'Local OpenAI-compatible endpoint')}</small></div>
        <input name="baseURL" type="url" defaultValue={String(provider.baseURL || provider.defaultURL || '')} required />
        <button disabled={Boolean(pending)}>{provider.enabled ? 'Update' : 'Enable'}</button>
        {Boolean(provider.enabled) && <button type="button" disabled={Boolean(pending)} onClick={() => {
          void run('setLocalProvider', [provider.id, { enabled: false, baseURL: provider.baseURL }], `local-disable-${provider.id}`)
            .then((result) => { if (result !== undefined) onReload(); });
        }}>Disable</button>}</form>)}
    </div>
  </div>;
}

function ModelStep({ models, searchModels, agents, mainRoute, searchRoute, agentRoutes, onMain, onSearch, onAgents }: {
  models: DesktopModelOption[];
  searchModels: DesktopModelOption[];
  agents: RecordValue[];
  mainRoute: DesktopModelSelection | null;
  searchRoute: DesktopModelSelection | null;
  agentRoutes: Record<string, DesktopModelSelection>;
  onMain(route: DesktopModelSelection | null): void;
  onSearch(route: DesktopModelSelection | null): void;
  onAgents(routes: Record<string, DesktopModelSelection>): void;
}) {
  const selectModel = (value: string, options: DesktopModelOption[]) => {
    const model = options.find((entry) => `${entry.provider}:${entry.model}` === value);
    return model ? routeFromModel(model) : null;
  };
  return <div className="onboarding-step"><div className="onboarding-step-heading"><div><h2>Assign models</h2>
    <p>Agents follow Main unless you set an explicit override.</p></div></div>
    <div className="onboarding-model-grid">
      <label><span><b>Main</b><small>Main chat, planning, and agent default</small></span><OpenSelect ariaLabel="Main model"
        value={routeKey(mainRoute)} options={[{ value: '', label: 'Select model…' }, ...modelOptions(models)]}
        onChange={(value) => onMain(selectModel(value, models))} /></label>
      <label><span><b>Search</b><small>Native web-search model</small></span><OpenSelect ariaLabel="Search model"
        value={searchRoute?.provider === 'default' && searchRoute?.model === 'default' ? '__default__' : routeKey(searchRoute)} onChange={(value) => {
        onSearch(value === '__default__'
          ? { provider: 'default', model: 'default' }
          : selectModel(value, searchModels));
      }} options={[{ value: '__default__', label: 'Default · follows Main' }, ...modelOptions(searchModels)]} /></label>
      {agents.map((agent) => <label key={String(agent.id)}><span><b>{title(agent)}</b>
        <small>{String(agent.description || record(agent.definition).description || '')}</small></span>
        <OpenSelect ariaLabel={`${title(agent)} model`} value={routeKey(agentRoutes[String(agent.id)])} onChange={(value) => {
          const next = { ...agentRoutes };
          const selected = selectModel(value, models);
          if (selected) next[String(agent.id)] = selected; else delete next[String(agent.id)];
          onAgents(next);
        }} options={[{ value: '', label: 'Default · follows Main' }, ...modelOptions(models)]} /></label>)}
    </div>
  </div>;
}

function modelOptions(models: DesktopModelOption[]) {
  return models.map((model) => ({
    value: `${model.provider}:${model.model}`,
    label: modelOptionLabel(model),
  }));
}

function ChoiceStep({ title: heading, description, rows: entries, selected, onSelect }: {
  title: string;
  description: string;
  rows: RecordValue[];
  selected: string;
  onSelect(entry: RecordValue): void;
}) {
  return <div className="onboarding-step"><div className="onboarding-step-heading"><div><h2>{heading}</h2><p>{description}</p></div></div>
    <div className="onboarding-choice-grid">{entries.map((entry) => {
      const id = String(entry.id || '');
      return <button type="button" key={id} className={selected === id ? 'selected' : ''} onClick={() => onSelect(entry)}>
        <span>{selected === id ? <Check size={14} /> : null}</span><b>{title(entry)}</b><small>{String(entry.description || '')}</small>
      </button>;
    })}</div></div>;
}
