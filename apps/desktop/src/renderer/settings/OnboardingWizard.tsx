// Guided first-run setup (orca-style welcome flow): a full-window hero card
// with clickable progress bars, per-step hero titles, and Ctrl+Enter to
// advance. The capability wiring (completeOnboarding / skipOnboarding and the
// provider/model reads) is shared with Settings and stays authoritative.
import { ArrowLeft, ArrowRight, Check, ExternalLink, Github, Star, UserRound, Users, X } from 'lucide-react';
import { type FormEvent, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import type {
  DesktopApi,
  DesktopCapability,
  DesktopCapabilityReadRequest,
  DesktopCapabilityReadResult,
  DesktopGithubCliAccount,
  DesktopGithubCliLoginFlow,
  DesktopGithubCliStatus,
  DesktopModelOption,
  DesktopModelSelection,
  DesktopRemoteAccessInfo,
} from '../../shared/contract';
import {
  getDesktopThemePreference,
  setDesktopThemePreference,
  themePreviewPalette,
  type DesktopThemePreference,
} from '../desktop-theme';
import { t } from '../i18n';
import { OpenSelect } from '../OpenSelect';
import { PaneSurfaceGate } from '../PaneSurfaceGate';
import { modelOptionLabel, providerDisplayName } from '../provider-display';
import { invalidateSidebarReferenceForMutation } from '../sidebar-reference-cache';
import { acquireTitleBarDim } from '../titlebar-dim';
import { OAuthControl } from './CapabilitySettings';
import {
  connectionInfoReady,
  getCachedConnectionInfo,
  preloadConnectionInfo,
} from './connection-info';
import {
  getCachedGitPanelInfo,
  patchCachedGitPanelInfo,
  preloadGitPanelInfo,
} from './git-panel-info';

type RecordValue = Record<string, unknown>;
type RunCapability = <T = unknown>(
  capability: DesktopCapability,
  args?: unknown[],
  key?: string,
  refresh?: boolean,
  silent?: boolean,
) => Promise<T | undefined>;
const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

const MIXDOG_REPO_URL = 'https://github.com/tribgames/mixdog';
const CLI_DOWNLOAD_URL = 'https://cli.github.com';
// Resume marker: reopening the wizard continues from the last step reached.
const ONBOARDING_STEP_KEY = 'mixdog.onboarding.step';

const STEPS = [
  {
    id: 'profile',
    label: () => t('Profile'),
    title: () => t('Make it yours'),
    subtitle: () => t('Tell Mixdog what to call you and which language to answer in.'),
  },
  {
    id: 'providers',
    label: () => t('Providers'),
    title: () => t('Connect your providers'),
    subtitle: () => t('Sign in with API keys, OAuth, or a local endpoint — the same provider as the Mixdog TUI.'),
  },
  {
    id: 'models',
    label: () => t('Models'),
    title: () => t('Assign your models'),
    subtitle: () => t('Pick the Main model. Search and every agent follow Main unless you set an explicit override.'),
  },
  {
    id: 'workflow',
    label: () => t('Workflow'),
    title: () => t('Pick your workflow'),
    subtitle: () => t('Workflows decide how much Mixdog delegates to agents. Pick one now — you can switch any time.'),
  },
  {
    id: 'git',
    label: () => t('Git'),
    title: () => t('Set up Git & GitHub'),
    subtitle: () => t('Connect the GitHub CLI and you are set — commits and pull requests just work.'),
  },
  {
    id: 'memory',
    label: () => t('Context'),
    title: () => t('Keep context under control'),
    subtitle: () => t('Auto-compact long chats, auto-clear idle sessions, and keep curated memories across projects.'),
  },
  {
    id: 'channels',
    label: () => t('Channels'),
    title: () => t('Chat from anywhere'),
    subtitle: () => t('Hook up Discord or Telegram to reach Mixdog away from your desk.'),
  },
  {
    id: 'theme',
    label: () => t('Theme'),
    title: () => t('Make it feel like home'),
    subtitle: () => t('System follows your OS. Fine-tune colors any time in Settings.'),
  },
  {
    id: 'output',
    label: () => t('Output style'),
    title: () => t('Choose how Mixdog answers'),
    subtitle: () => t('The output style shapes how the Lead agent structures its responses.'),
  },
  {
    id: 'connection',
    label: () => t('Remote'),
    title: () => t('Pair a remote'),
    subtitle: () => t('Scan with your phone camera — the web app works on any network, nothing to install.'),
  },
  {
    id: 'star',
    label: () => t('Star'),
    title: () => t('One last thing'),
    subtitle: () => t('Mixdog is free and open source — a GitHub star genuinely helps it grow.'),
  },
] as const;

function savedStep(): number {
  try {
    const value = Number(window.localStorage.getItem(ONBOARDING_STEP_KEY));
    return Number.isInteger(value) && value > 0 && value < STEPS.length ? value : 0;
  } catch {
    return 0;
  }
}

function record(value: unknown): RecordValue {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : {};
}

function rows(value: unknown, key?: string): RecordValue[] {
  if (Array.isArray(value)) return value.map(record);
  const source = record(value);
  return key && Array.isArray(source[key]) ? (source[key] as unknown[]).map(record) : [];
}

function title(value: RecordValue): string {
  return t(String(value.label || value.name || value.display || value.id || 'Unknown'));
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
  const [step, setStep] = useState(savedStep);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState('');
  const [error, setError] = useState('');
  const [providerSetup, setProviderSetup] = useState<RecordValue>({});
  const [models, setModels] = useState<DesktopModelOption[]>([]);
  const [searchModels, setSearchModels] = useState<RecordValue[]>([]);
  const [agents, setAgents] = useState<RecordValue[]>([]);
  const [styles, setStyles] = useState<RecordValue[]>([]);
  const [profile, setProfile] = useState<RecordValue>({});
  const [workflows, setWorkflows] = useState<RecordValue[]>([]);
  const [autoClearOn, setAutoClearOn] = useState(true);
  const [compactAuto, setCompactAuto] = useState(true);
  const [channelSetup, setChannelSetup] = useState<RecordValue>({});
  const [themeMode, setThemeMode] = useState<DesktopThemePreference>(
    () => getDesktopThemePreference() || 'system');
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
  const capabilityPendingRef = useRef(false);
  const loadedRef = useRef(false);
  const advanceRef = useRef<() => void>(() => {});
  // The wizard's fullscreen scrim cannot cover the NATIVE caption controls —
  // hold the titlebar dim claim while the wizard is mounted.
  useEffect(() => acquireTitleBarDim(), []);

  // Resume: remember the furthest UI position; the marker clears on close.
  useEffect(() => {
    try {
      if (step > 0) window.localStorage.setItem(ONBOARDING_STEP_KEY, String(step));
      else window.localStorage.removeItem(ONBOARDING_STEP_KEY);
    } catch { /* resume is a convenience only */ }
  }, [step]);
  const clearResume = () => {
    try {
      window.localStorage.removeItem(ONBOARDING_STEP_KEY);
    } catch { /* resume is a convenience only */ }
  };

  const run = useCallback(async <T,>(
    capability: DesktopCapability,
    args: unknown[] = [],
    key: string = capability,
    _refresh = false,
    silent = false,
  ): Promise<T | undefined> => {
    if (!silent && capabilityPendingRef.current) return undefined;
    if (!silent) {
      capabilityPendingRef.current = true;
      setPending(key);
      setError('');
    }
    try {
      const result = (await api.invokeCapability<T>({ capability, args })).value;
      // Onboarding is the other provider/route mutation owner (completeOnboarding
      // writes the search route, agent routes and default provider); invalidate
      // only after the capability resolved.
      invalidateSidebarReferenceForMutation(capability);
      return result;
    } catch (reason) {
      if (!silent) setError(reason instanceof Error ? reason.message : String(reason));
      return undefined;
    } finally {
      if (!silent) {
        capabilityPendingRef.current = false;
        setPending('');
      }
    }
  }, [api]);

  const load = useCallback(async (force = false) => {
    if (!loadedRef.current) setLoading(true);
    setError('');
    try {
      const readRequests: DesktopCapabilityReadRequest[] = [
        { capability: 'getProviderSetup' },
        { capability: 'listSearchModels', args: [{ quick: false, ...(force ? { force: true } : {}) }] },
        { capability: 'listAgents' },
        { capability: 'listOutputStyles' },
        { capability: 'getSearchRoute' },
        { capability: 'getProfile' },
        { capability: 'listWorkflows' },
        { capability: 'getChannelSetup' },
        { capability: 'getAutoClear' },
        { capability: 'getCompactionSettings' },
      ];
      // The provider-model catalog is the slow read (remote catalogs); it must
      // not hold the reveal gate — the Models step sits two steps in and its
      // options fill in as they arrive (user: 처음 들어가면 검정 빈 화면).
      void api.listProviderModels({ quick: false })
        .then(setModels)
        .catch(() => { /* the Models step keeps its empty select; reload retries */ });
      const [readResults, snapshotResult] = await Promise.all([
        readCapabilityBatch(api, readRequests),
        api.getSnapshot(),
      ]);
      const values = readResults.map((result) => result.ok ? result.value : null);
      const readErrors = readResults.flatMap((result) => result.ok ? [] : [result.error]);
      if (readErrors.length) setError(readErrors.join(' · '));
      setProviderSetup(record(values[0]));
      setSearchModels(rows(values[1]));
      setAgents(rows(values[2]));
      const output = record(values[3]);
      setStyles(rows(output.styles));
      setStyle(String(record(output.current).id || output.configured || 'default'));
      setProfile(record(values[5]));
      setWorkflows(rows(values[6]));
      setChannelSetup(record(values[7]));
      setAutoClearOn(record(values[8]).enabled !== false);
      setCompactAuto(record(values[9]).auto !== false);
      const snapshot = record(snapshotResult);
      if (snapshot.provider && snapshot.model) {
        setMainRoute({
          provider: String(snapshot.provider),
          model: String(snapshot.model),
          ...(snapshot.effort ? { effort: String(snapshot.effort) } : {}),
          ...(typeof snapshot.fast === 'boolean' ? { fast: snapshot.fast } : {}),
        });
      }
      const currentSearch = record(values[4]);
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
      loadedRef.current = true;
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
        ...(defaultRoute ? { defaultRoute } : {}),
        ...(explicitSearchRoute ? { searchRoute: explicitSearchRoute } : {}),
        ...(hasAgentRoutes ? { agentRoutes } : {}),
      }], 'finish-onboarding')
      : await run('skipOnboarding', [], 'finish-onboarding');
    if (result !== undefined) {
      clearResume();
      onDone();
    }
  };

  const skip = async () => {
    const result = await run('skipOnboarding', [], 'skip-onboarding');
    if (result !== undefined) {
      clearResume();
      onDone();
    }
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

  advanceRef.current = () => {
    if (capabilityPendingRef.current) return;
    if (step < STEPS.length - 1) setStep(step + 1);
    else void finish();
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
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
        // Screen-local submit (orca grammar): never advance underneath a
        // nested dialog (OAuth login, skip confirmation).
        if (nested) return;
        event.preventDefault();
        event.stopPropagation();
        advanceRef.current();
        return;
      }
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

  const meta = STEPS[step];

  return createPortal(<div ref={layerRef} className="onboarding-layer"
    onMouseDown={(event) => {
      // Click-off dismissal stays available on every step (orca grammar):
      // only a press on the scrim itself asks for skip confirmation.
      if (event.target !== event.currentTarget || pending || confirmSkip) return;
      requestSkip(closeRef.current);
    }}>
    <section ref={dialogRef} className="onboarding-dialog" role="dialog" aria-modal="true" aria-labelledby="onboarding-title" tabIndex={-1}>
      <header>
        <div className="onboarding-hero">
          <h1 id="onboarding-title">{meta.title()}</h1>
          <p>{meta.subtitle()}</p>
        </div>
        <div className="onboarding-top-actions">
          <nav aria-label={t('Setup progress')}>
            {STEPS.map((entry, index) => <button key={entry.id} type="button" title={entry.label()}
              className={`onboarding-progress-bar${index === step ? ' active' : index < step ? ' complete' : ''}`}
              aria-label={t('Go to step {{step}}: {{label}}', { step: index + 1, label: entry.label() })}
              aria-current={index === step ? 'step' : undefined}
              disabled={Boolean(pending)}
              onClick={() => setStep(index)} />)}
            <span className="onboarding-progress-count">{t('{{current}} of {{total}}', {
              current: step + 1,
              total: STEPS.length,
            })}</span>
          </nav>
          <button ref={closeRef} type="button" aria-label={t('Skip setup')} disabled={Boolean(pending)}
            onClick={(event) => requestSkip(event.currentTarget)}><X size={16} /></button>
        </div>
      </header>
      <div className="onboarding-body">
        <PaneSurfaceGate ready={!loading} label={t('Loading your Mixdog configuration…')}>
          <div className="onboarding-ready-content">
          <div className="onboarding-step-view" key={meta.id}>
          {meta.id === 'profile' && <ProfileStep profile={profile} pending={pending} run={run}
            onProfile={setProfile} />}
          {meta.id === 'providers' && <ProviderStep setup={providerSetup} pending={pending} run={run}
            onSaveApiKey={(event, provider) => void saveApiKey(event, provider)}
            onReload={() => void load(true)} />}
          {meta.id === 'models' && <ModelStep models={models} searchModels={searchOptions} agents={agents}
            mainRoute={mainRoute} searchRoute={searchRoute} agentRoutes={agentRoutes}
            onMain={(route) => { setMainRouteTouched(true); setMainRoute(route); }}
            onSearch={(route) => { setSearchRouteTouched(true); setSearchRoute(route); }}
            onAgents={setAgentRoutes} />}
          {meta.id === 'workflow' && <WorkflowStep workflows={workflows} pending={pending} run={run}
            onChange={(id) => setWorkflows((list) => list.map((workflow) =>
              ({ ...workflow, active: String(workflow.id) === id })))} />}
          {meta.id === 'git' && <GitStep api={api} />}
          {meta.id === 'memory' && <ContextStep autoClearOn={autoClearOn} compactAuto={compactAuto}
            pending={pending} run={run} onAutoClear={setAutoClearOn} onCompact={setCompactAuto} />}
          {meta.id === 'channels' && <ChannelsStep setup={channelSetup} pending={pending} run={run}
            onReload={() => void load(true)} />}
          {meta.id === 'theme' && <ThemeStep mode={themeMode} onSelect={(next) => {
            setThemeMode(next);
            // Desktop-local preference (Settings → General grammar): persists
            // to desktop storage and applies instantly, never the TUI theme.
            setDesktopThemePreference(next);
          }} />}
          {meta.id === 'output' && <ChoiceStep rows={styles} selected={style} onSelect={(entry) => {
            const id = String(entry.id || 'default');
            setStyle(id);
            void run('setOutputStyle', [id], 'onboarding-output');
          }} />}
          {meta.id === 'connection' && <PairStep api={api} />}
          {meta.id === 'star' && <StarStep api={api} />}
          </div>
          {error && <p className="onboarding-error" role="alert">{error}</p>}
          </div>
        </PaneSurfaceGate>
      </div>
      <footer>
        <button type="button" className="secondary" disabled={Boolean(pending)}
          onClick={(event) => requestSkip(event.currentTarget)}>{t('Skip setup')}</button>
        <div>{step > 0 && <button type="button" disabled={Boolean(pending)} onClick={() => setStep((value) => value - 1)}>
          <ArrowLeft size={14} /> {t('Back')}</button>}
          {step < STEPS.length - 1
            ? <button type="button" className="primary" disabled={Boolean(pending)} onClick={() => advanceRef.current()}>
              {t('Next')} <ArrowRight size={14} /></button>
            : <button type="button" className="primary" disabled={Boolean(pending)} onClick={() => void finish()}>
              <Check size={14} /> {t('Finish')}</button>}</div>
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
  // This scrim stacks on the wizard's: the native caption band has to darken
  // by the same amount the DOM does.
  useEffect(() => acquireTitleBarDim(), []);
  return <div className="settings-confirm-layer">
    <section className="settings-confirm-dialog" role="alertdialog" aria-modal="true"
      aria-labelledby="onboarding-skip-title" aria-describedby="onboarding-skip-description"
      data-settings-nested-dialog>
      <header><h3 id="onboarding-skip-title">{t('Skip Mixdog setup?')}</h3>
        <button type="button" aria-label={t('Close skip confirmation')} onClick={onCancel}>
          <X aria-hidden="true" size={16} />
        </button></header>
      <p id="onboarding-skip-description">
        {t('You can configure providers, models, Git, themes, and output style later in Settings.')}
      </p>
      <footer><button ref={cancelRef} type="button" onClick={onCancel}>{t('Cancel')}</button>
        <button type="button" className="danger" onClick={onConfirm}>{t('Skip setup')}</button></footer>
    </section>
  </div>;
}

function ProviderStep({ setup, pending, run, onSaveApiKey, onReload }: {
  setup: RecordValue;
  pending: string;
  run<T = unknown>(
    capability: DesktopCapability,
    args?: unknown[],
    key?: string,
    refresh?: boolean,
    silent?: boolean,
  ): Promise<T | undefined>;
  onSaveApiKey(event: FormEvent<HTMLFormElement>, provider: string): void;
  onReload(): void;
}) {
  // OpenCode Go leads the API list (user decision).
  const apiProviders = [...rows(setup.api)]
    .sort((left, right) => Number(String(right.id) === 'opencode-go') - Number(String(left.id) === 'opencode-go'));
  const oauthProviders = rows(setup.oauth);
  const localProviders = rows(setup.local);
  return <>
    {oauthProviders.length > 0 && <div className="onboarding-model-section"><h3>{t('OAuth')}</h3>
    <div className="onboarding-provider-list">
      {/* One status slot for every provider kind: the state reads under the
          name, never above the row's actions (user: 커넥티드 위치가 제각각).
          The token file/store location is plumbing, not setup guidance. */}
      {oauthProviders.map((provider) => <div className="onboarding-provider-row" key={String(provider.id)}><div><b>{providerTitle(provider)}</b>
        <small className={`onboarding-provider-state${provider.authenticated ? ' connected' : ''}`}>
          {provider.authenticated ? t('Connected') : t('Not connected')}</small></div>
        <span className="onboarding-provider-action">
          <OAuthControl provider={{ ...provider, label: providerTitle(provider) }} disabled={Boolean(pending)} run={run} onComplete={onReload} />
        </span>
        {Boolean(provider.authenticated) && <button type="button" className="ghost" disabled={Boolean(pending)} onClick={() => {
          void run('forgetProviderAuth', [provider.id], `forget-${provider.id}`).then((result) => {
            if (result !== undefined) onReload();
          });
        }}>{t('Forget')}</button>}</div>)}
    </div></div>}
    {apiProviders.length > 0 && <div className="onboarding-model-section"><h3>{t('API keys')}</h3>
    <div className="onboarding-provider-list">
      {apiProviders.map((provider) => <form key={String(provider.id)} onSubmit={(event) => onSaveApiKey(event, String(provider.id))}>
        <div><b>{providerTitle(provider)}</b>
          <small className={`onboarding-provider-state${provider.authenticated ? ' connected' : ''}`}>
            {provider.authenticated ? t('Connected') : t(String(provider.detail || provider.status || 'API key required'))}</small></div>
        {String(provider.id) === 'opencode-go' && <button type="button" className="ghost" disabled={Boolean(pending)} onClick={() => {
          void run('loginOpenCodeGoUsage', [], 'opencode-go-usage').then((result) => {
            if (result !== undefined) onReload();
          });
        }}>{t('Usage sign-in')}</button>}
        <input name="secret" type="password" autoComplete="off" placeholder={provider.authenticated ? t('Replace API key') : t('API key')} required />
        <button disabled={Boolean(pending)}>{provider.authenticated ? t('Replace') : t('Connect')}</button>
        {Boolean(provider.stored || (!provider.env && provider.authenticated)) &&
          <button type="button" className="ghost" disabled={Boolean(pending)} onClick={() => {
          void run('forgetProviderAuth', [provider.id], `forget-${provider.id}`).then((result) => {
            if (result !== undefined) onReload();
          });
        }}>{t('Forget')}</button>}
      </form>)}
    </div></div>}
    {localProviders.length > 0 && <div className="onboarding-model-section"><h3>{t('Local')}</h3>
    <div className="onboarding-provider-list">
      {localProviders.map((provider) => <form key={String(provider.id)} onSubmit={(event) => {
        event.preventDefault();
        const baseURL = new FormData(event.currentTarget).get('baseURL');
        void run('setLocalProvider', [provider.id, { enabled: true, baseURL }], `local-${provider.id}`)
          .then((result) => { if (result !== undefined) onReload(); });
      }}><div><b>{providerTitle(provider)}</b><small>{t(String(provider.status || 'Local OpenAI-compatible endpoint'))}</small></div>
        <input name="baseURL" type="url" defaultValue={String(provider.baseURL || provider.defaultURL || '')} required />
        <button disabled={Boolean(pending)}>{provider.enabled ? t('Update') : t('Enable')}</button>
        {Boolean(provider.enabled) && <button type="button" className="ghost" disabled={Boolean(pending)} onClick={() => {
          void run('setLocalProvider', [provider.id, { enabled: false, baseURL: provider.baseURL }], `local-disable-${provider.id}`)
            .then((result) => { if (result !== undefined) onReload(); });
        }}>{t('Disable')}</button>}</form>)}
    </div></div>}
  </>;
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
  const agentRow = (agent: RecordValue) => <label key={String(agent.id)}><span><b>{title(agent)}</b>
    <small>{t(String(agent.description || record(agent.definition).description || ''))}</small></span>
    <OpenSelect ariaLabel={t('{{name}} model', { name: title(agent) })} value={routeKey(agentRoutes[String(agent.id)])} onChange={(value) => {
      const next = { ...agentRoutes };
      const selected = selectModel(value, models);
      if (selected) next[String(agent.id)] = selected; else delete next[String(agent.id)];
      onAgents(next);
    }} options={[{ value: '', label: t('Default · follows Main') }, ...modelOptions(models)]} /></label>;
  // Three sections (user decision): Main → required defaults (web search +
  // the slot-backed Explore/Maintainer) → the remaining custom roles.
  const defaultAgents = agents.filter((agent) => Boolean(agent.workflowSlot));
  const customAgents = agents.filter((agent) => !agent.workflowSlot);
  return <>
    <div className="onboarding-model-section">
      <h3>{t('Main model')}</h3>
      <div className="onboarding-model-grid">
        <label><span><b>{t('Main')}</b><small>{t('Main chat, planning, and agent default')}</small></span><OpenSelect ariaLabel={t('Main model')}
          value={routeKey(mainRoute)} options={[{ value: '', label: t('Select model…') }, ...modelOptions(models)]}
          onChange={(value) => onMain(selectModel(value, models))} /></label>
      </div>
    </div>
    <div className="onboarding-model-section">
      <h3>{t('Default models')}</h3>
      <div className="onboarding-model-grid">
        <label><span><b>{t('Search')}</b><small>{t('Native web-search model')}</small></span><OpenSelect ariaLabel={t('Search model')}
          value={searchRoute?.provider === 'default' && searchRoute?.model === 'default' ? '__default__' : routeKey(searchRoute)} onChange={(value) => {
          onSearch(value === '__default__'
            ? { provider: 'default', model: 'default' }
            : selectModel(value, searchModels));
        }} options={[{ value: '__default__', label: t('Default · follows Main') }, ...modelOptions(searchModels)]} /></label>
        {defaultAgents.map(agentRow)}
      </div>
    </div>
    {customAgents.length > 0 && <div className="onboarding-model-section">
      <h3>{t('Custom models')}</h3>
      <div className="onboarding-model-grid">
        {customAgents.map(agentRow)}
      </div>
    </div>}
  </>;
}

function modelOptions(models: DesktopModelOption[]) {
  return models.map((model) => ({
    value: `${model.provider}:${model.model}`,
    label: modelOptionLabel(model),
  }));
}

// Settings → Git in onboarding clothes: GitHub CLI status, guided install, and
// the device-flow Connect. A completed Connect adopts the account as the git
// commit identity — the same rule the settings panel follows.
function GitStep({ api }: { api: DesktopApi }) {
  const supported = typeof api.githubCliStatus === 'function';
  const cached = getCachedGitPanelInfo(api);
  const [status, setStatus] = useState<DesktopGithubCliStatus | null>(cached?.status ?? null);
  const [account, setAccount] = useState<DesktopGithubCliAccount | null>(cached?.account ?? null);
  const [flow, setFlow] = useState<DesktopGithubCliLoginFlow | null>(null);
  const [busy, setBusy] = useState('');
  const [gitError, setGitError] = useState('');
  const [avatarFailed, setAvatarFailed] = useState(false);
  const identityFlow = useRef('');

  const refresh = useCallback(async () => {
    if (!api.githubCliStatus) return;
    try {
      const next = await api.githubCliStatus();
      setStatus(next);
      patchCachedGitPanelInfo(api, { status: next });
    } catch (reason) {
      setGitError(reason instanceof Error ? reason.message : String(reason));
    }
  }, [api]);

  useEffect(() => {
    if (!supported) return undefined;
    let live = true;
    void preloadGitPanelInfo(api).then((info) => {
      if (!live || !info) return;
      setStatus(info.status);
      setAccount(info.account);
    });
    return () => { live = false; };
  }, [api, supported]);

  const flowId = flow?.flowId || '';
  const flowState = flow?.state || '';
  useEffect(() => {
    if (!flowId || (flowState !== 'pending' && flowState !== 'code')) return undefined;
    let cancelled = false;
    const timer = window.setInterval(() => {
      void api.githubCliLoginStatus?.(flowId).then((next) => {
        if (cancelled || !next) return;
        setFlow(next);
        if (next.state === 'success') void refresh();
      }).catch(() => { /* transient; the next tick retries */ });
    }, 1_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [api, flowId, flowState, refresh]);

  const authenticated = status?.authenticated === true;
  useEffect(() => {
    if (!supported || !authenticated) return undefined;
    let live = true;
    void api.githubCliAccount?.().then((next) => {
      if (!live) return;
      setAccount(next || null);
      patchCachedGitPanelInfo(api, { account: next || null });
    }).catch(() => { /* the status row still shows the login */ });
    return () => { live = false; };
  }, [api, authenticated, supported]);

  useEffect(() => {
    if (flowState !== 'success' || !flowId || !account) return;
    if (identityFlow.current === flowId) return;
    identityFlow.current = flowId;
    void (async () => {
      try {
        await api.setGitGlobalConfig?.('user.name', account.name);
        await api.setGitGlobalConfig?.('user.email', account.email);
      } catch { /* git config stays as it was */ }
    })();
  }, [account, api, flowId, flowState]);

  if (!supported) {
    return <p className="onboarding-note">
      {t('Git and GitHub connect from the desktop app. You can set this up any time in Settings → Git.')}
    </p>;
  }

  const act = (key: string, action: () => Promise<unknown> | undefined) => {
    setBusy(key);
    setGitError('');
    void Promise.resolve(action())
      .catch((reason) => setGitError(reason instanceof Error ? reason.message : String(reason)))
      .finally(() => setBusy(''));
  };
  const open = (url: string) => void api.openExternal?.(url).catch(() => undefined);
  const loading = status === null;
  const busyAny = Boolean(busy);
  const flowLive = flowState === 'pending' || flowState === 'code';

  const pill: [string, string] = loading ? ['neutral', t('Checking…')]
    : !status?.installed ? ['warn', t('CLI not installed')]
      : authenticated ? ['ok', t('Connected')] : ['warn', t('Not connected')];
  const login = String(status?.login || account?.name || '');
  const showAvatar = authenticated && Boolean(login) && !avatarFailed;
  return <div className="onboarding-star-card onboarding-connect-card">
    <span className={`onboarding-connect-icon${showAvatar ? ' avatar' : ''}`} aria-hidden="true">
      {showAvatar
        ? <img src={`https://github.com/${login}.png?size=128`} alt="" onError={() => setAvatarFailed(true)} />
        : <Github size={26} />}
    </span>
    <div>
      <span className="onboarding-connect-title">{authenticated && login ? login : t('Connect GitHub')}</span>
      <span className="onboarding-connect-pills">
        <span className={`onboarding-pill ${pill[0]}`}>{pill[1]}</span>
        {Boolean(status?.version) && <span className="onboarding-pill neutral">gh {status?.version}</span>}
      </span>
      {authenticated
        ? <>
          {Boolean(account?.email) && <p className="onboarding-connect-mail">{account?.email}</p>}
          <p>{t('Commits and pull requests are ready to go.')}</p>
        </>
        : <p>{!status?.installed && !loading
          ? t('Mixdog installs the GitHub CLI and signs you in — one click, no terminal needed.')
          : t('Sign in opens github.com with a one-time code — Mixdog links your commits automatically.')}</p>}
    </div>
    {authenticated
      ? <small>{t('Manage in Settings → Git.')}</small>
      : <div className="onboarding-star-actions">
      {!loading && !status?.installed && <>
        <button type="button" className="primary" disabled={busyAny} onClick={() => act('install', () => api.installGithubCli?.()
          .then((next) => {
            if (!next) return;
            setStatus(next);
            patchCachedGitPanelInfo(api, { status: next });
          }))}>{busy === 'install' ? t('Installing…') : t('Install GitHub CLI')}</button>
        <button type="button" className="ghost" disabled={busyAny} onClick={() => open(CLI_DOWNLOAD_URL)}>
          <ExternalLink size={14} /> {t('Manual download')}</button>
      </>}
      {status?.installed && !status.authenticated && !flowLive &&
        <button type="button" className="primary" disabled={busyAny} onClick={() => act('connect', () =>
          api.githubCliLoginStart?.().then((started) => { if (started) setFlow(started); }))}>
          <Github size={14} /> {t('Sign in with GitHub')}</button>}
      {flowLive && <button type="button" className="ghost" disabled={busyAny} onClick={() => {
        const id = flowId;
        setFlow(null);
        act('cancel', () => api.githubCliLoginCancel?.(id));
      }}>{t('Cancel')}</button>}
    </div>}
    {flowLive && <p className="onboarding-note" role="status">
      {flow?.code
        ? <>{t('Enter code')} <code className="onboarding-code">{flow.code}</code> {t('at github.com/login/device — the browser should open by itself.')} <button type="button" className="onboarding-link"
            onClick={() => open(flow.url || 'https://github.com/login/device')}>{t('Open github.com ↗')}</button></>
        : t('Starting GitHub sign-in…')}
    </p>}
    {flowState === 'error' && <p className="onboarding-error" role="alert">
      {t('Sign-in failed: {{message}}', { message: flow?.message || t('unknown error') })}
    </p>}
    {gitError && <p className="onboarding-error" role="alert">{gitError}</p>}
  </div>;
}

// Desktop surface modes only (user decision): System / Dark / White, the same
// desktop-local preference Settings → General writes. Gray IS Dark now.
const THEME_MODES: ReadonlyArray<{
  id: DesktopThemePreference;
  label(): string;
  hint(): string;
}> = [
  { id: 'system', label: () => t('System'), hint: () => t('Match OS') },
  { id: 'dark', label: () => t('Dark'), hint: () => t('Neutral charcoal') },
  { id: 'white', label: () => t('White'), hint: () => t('Bright & crisp') },
];

/** The desktop surface ramps, mirrored from desktop.css for the mini preview
 *  (the TUI registry palette knows nothing about the desktop ramps). */
const SURFACE_PREVIEW: Record<string, { deep: string; base: string; text: string; border: string }> = {
  dark: { deep: '#101013', base: '#222225', text: '#e9e9e9', border: 'rgba(255,255,255,.16)' },
  white: { deep: '#f5f5f5', base: '#ffffff', text: '#17181a', border: 'rgba(0,0,0,.14)' },
};

function ThemeStep({ mode, onSelect }: {
  mode: DesktopThemePreference;
  onSelect(next: DesktopThemePreference): void;
}) {
  return <div className="onboarding-theme-grid">{THEME_MODES.map((entry) => (
    <button type="button" key={entry.id} className={mode === entry.id ? 'selected' : ''}
      onClick={() => onSelect(entry.id)}>
      <span className="onboarding-theme-preview" aria-hidden="true">
        {entry.id === 'system'
          ? <span className="onboarding-theme-split">
            <ThemeChromeMock id="basic" surface="dark" /><ThemeChromeMock id="light" surface="white" />
          </span>
          : <ThemeChromeMock id={entry.id === 'white' ? 'light' : 'basic'} surface={String(entry.id)} />}
      </span>
      <span className="onboarding-theme-name"><b>{entry.label()}</b>
        {mode === entry.id ? <Check size={14} /> : null}
        <small>{entry.hint()}</small></span>
    </button>
  ))}</div>;
}

// Tiny Mixdog chrome (sidebar, tab, transcript, composer) painted with the
// theme's own registry palette so every card previews its real colors.
function ThemeChromeMock({ id, surface }: { id: string; surface?: string }) {
  const palette = themePreviewPalette(id);
  if (!palette) return <span className="onboarding-theme-preview-empty" />;
  const ramp = surface ? SURFACE_PREVIEW[surface] : undefined;
  const deep = ramp?.deep
    ?? (palette.background === 'transparent' ? palette.inverseText : palette.background);
  const base = ramp?.base ?? palette.mdCodeBlockBg;
  const text = ramp?.text ?? palette.text;
  const line = `color-mix(in srgb, ${text} 24%, transparent)`;
  const lineDim = `color-mix(in srgb, ${text} 11%, transparent)`;
  const border = ramp?.border ?? `color-mix(in srgb, ${palette.promptBorder} 55%, transparent)`;
  return <span className="onboarding-theme-chrome" style={{ background: deep }}>
    <span className="onboarding-theme-side" style={{ background: base, borderRight: `1px solid ${border}` }}>
      <span style={{ background: line }} />
      <span style={{ background: lineDim }} />
      <span style={{ background: lineDim, width: '70%' }} />
      <span style={{ background: lineDim, width: '85%' }} />
      <span style={{ background: lineDim, width: '55%' }} />
    </span>
    <span className="onboarding-theme-main">
      <span className="onboarding-theme-tab" style={{ background: base, boxShadow: `inset 0 0 0 1px ${border}` }} />
      <span style={{ background: lineDim }} />
      <span style={{ background: lineDim, width: '83%' }} />
      <span style={{ background: lineDim, width: '58%' }} />
      <span style={{ background: lineDim, width: '90%' }} />
      <span style={{ background: lineDim, width: '40%' }} />
      <span className="onboarding-theme-composer" style={{ background: base, boxShadow: `inset 0 0 0 1px ${border}` }}>
        <span style={{ background: palette.success }} />
        <span style={{ background: lineDim }} />
      </span>
    </span>
  </span>;
}

// Relative reply volume per output style (Simple = 100% baseline, user
// decision) plus a transcript mock whose line count mirrors that volume.
function outputVolume(id: string): { badge: string; lines: string[] } {
  const slug = id.toLowerCase();
  if (slug.includes('extreme')) return { badge: '~20%', lines: ['64%'] };
  if (slug.includes('minimal')) return { badge: '~50%', lines: ['88%', '52%'] };
  if (slug.includes('detail')) {
    return { badge: '~200%', lines: ['96%', '88%', '92%', '80%', '86%', '70%', '90%', '62%', '45%'] };
  }
  return { badge: '100%', lines: ['94%', '86%', '72%', '48%'] };
}

function ChoiceStep({ rows: entries, selected, onSelect }: {
  rows: RecordValue[];
  selected: string;
  onSelect(entry: RecordValue): void;
}) {
  return <div className="onboarding-choice-grid">{entries.map((entry) => {
    const id = String(entry.id || '');
    const volume = outputVolume(id);
    return <button type="button" key={id} className={selected === id ? 'selected' : ''} onClick={() => onSelect(entry)}>
      <span className="onboarding-choice-check">{selected === id ? <Check size={14} /> : null}</span>
      <b>{title(entry)}</b>
      <span className="onboarding-choice-preview" aria-hidden="true">
        {volume.lines.map((width, index) => <i key={index} style={{ width }} />)}
      </span>
      <small>{t(String(entry.description || ''))}</small>
      <span className="onboarding-choice-meta">{t('Output {{volume}}', { volume: volume.badge })}</span>
    </button>;
  })}</div>;
}

// Final step: the About panel's star action (gh CLI when signed in, repo page
// otherwise) framed as the closing ask before Finish.
function StarStep({ api }: { api: DesktopApi }) {
  const [ghReady, setGhReady] = useState(false);
  const [starred, setStarred] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    void api.githubStarStatus?.()
      ?.then((status) => {
        if (!live || !status) return;
        setGhReady(status.available === true);
        setStarred(status.starred === true);
      })
      .catch(() => { /* the button stays a plain repo link */ });
    return () => { live = false; };
  }, [api]);
  const open = (url: string) => void api.openExternal?.(url).catch(() => undefined);
  const star = () => {
    if (starred || !ghReady || !api.starGithub) {
      open(MIXDOG_REPO_URL);
      return;
    }
    setBusy(true);
    void api.starGithub()
      .then((result) => setStarred(result?.starred === true))
      .catch(() => open(MIXDOG_REPO_URL))
      .finally(() => setBusy(false));
  };
  // A GitHub-repo-card composition (familiar, concrete) instead of a glowing
  // poster tile (user: AI slop 같다).
  return <div className="onboarding-repo-card">
    <div className="onboarding-repo-head">
      <Github size={18} aria-hidden="true" />
      <b><span>mixdog</span></b>
      <span className="onboarding-pill neutral">{t('Public')}</span>
    </div>
        <p>{t('Standalone coding agent — multi-provider agent workflows across CLI, desktop, and phone.')} {starred
        ? t('Thank you for the star — it genuinely helps mixdog grow!')
        : t('Built in the open; a star helps other developers find it.')}</p>
    <div className="onboarding-repo-meta">
      <span><i aria-hidden="true" /> {t('Free & open source')}</span>
      <span>{t('Runs on your machine')}</span>
      <span>{t('No sign-up')}</span>
    </div>
    <div className="onboarding-star-actions onboarding-repo-actions">
      <button type="button" className="ghost" disabled={busy} onClick={() => open(MIXDOG_REPO_URL)}>
        <ExternalLink size={14} /> {t('Open on GitHub')}</button>
      {/* Star sits at the card's bottom-right — the easiest spot to hit. */}
      <button type="button" className={starred ? 'primary starred' : 'primary'}
        disabled={busy || starred} onClick={star}>
        <Star size={14} fill={starred ? 'currentColor' : 'none'} />
        {starred ? t('Starred') : busy ? t('Starring…') : t('Star')}
      </button>
    </div>
  </div>;
}

function ProfileStep({ profile, pending, run, onProfile }: {
  profile: RecordValue;
  pending: string;
  run: RunCapability;
  onProfile(next: RecordValue): void;
}) {
  const titleFromProfile = String(profile.title || '');
  const [draft, setDraft] = useState(titleFromProfile);
  const [touched, setTouched] = useState(false);
  // The gate mounts this step before the profile read lands; adopt the saved
  // title once it arrives unless the user already started typing.
  useEffect(() => {
    if (!touched) setDraft(titleFromProfile);
  }, [titleFromProfile, touched]);
  const trimmed = draft.trim();
  const initial = Array.from(trimmed)[0] || '';
  const languages = rows(profile.languages).map((entry) => ({
    value: String(entry.id || entry.value || 'system'),
    label: title(entry),
  }));
  const commitTitle = () => {
    if (trimmed === String(profile.title || '')) return;
    onProfile({ ...profile, title: trimmed });
    void run('setProfile', [{ title: trimmed }], 'onboarding-profile-title');
  };
  return <div className="onboarding-star-card onboarding-profile-card">
    <span className={`onboarding-connect-icon onboarding-profile-avatar${initial ? ' has-initial' : ''}`}
      aria-hidden="true">
      {initial ? <b>{initial}</b> : <UserRound size={26} />}
    </span>
    <p className="onboarding-profile-greeting" aria-live="polite">
      {trimmed ? t('Hello, {{name}} 👋', { name: trimmed }) : t('Hello there 👋')}
    </p>
    <div className="onboarding-profile-fields">
      <label>
        <span>{t('Title')}</span>
        <input name="title" value={draft} placeholder={t('Your name or role')}
          aria-label={t('Profile title')} disabled={Boolean(pending)}
          onChange={(event) => { setTouched(true); setDraft(event.currentTarget.value); }}
          onBlur={commitTitle}
          onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur(); }} />
        <small>{t('How Mixdog addresses you.')}</small>
      </label>
      <label>
        <span>{t('Language')}</span>
        <OpenSelect ariaLabel={t('Response language')} value={String(profile.language || 'system')}
          options={languages.length ? languages : [{ value: 'system', label: t('System') }]}
          onChange={(language) => {
            onProfile({ ...profile, language });
            void run('setProfile', [{ language }], 'onboarding-profile-language');
          }} />
        <small>{t('Every reply follows this language.')}</small>
      </label>
    </div>
  </div>;
}

// Beginner guide copy for the built-in workflow packs; custom packs fall back
// to their own provider description.
const WORKFLOW_GUIDE: Record<string, {
  icon: typeof Users;
  tagline(): string;
  points(): string[];
}> = {
  cowork: {
    icon: Users,
    tagline: () => t('Lead coordinates a team of agents working in parallel.'),
    points: () => [
      t('Lead plans the task and splits the work'),
      t('Workers implement changes side by side'),
    ],
  },
  solo: {
    icon: UserRound,
    tagline: () => t('Lead does everything itself — simple and predictable.'),
    points: () => [
      t('One agent, no delegation overhead'),
      t('Fastest turnaround for small tasks'),
      t('Great for quick fixes, reviews, and Q&A'),
    ],
  },
};
// The built-in cowork pack ships under the id `default`.
WORKFLOW_GUIDE.default = WORKFLOW_GUIDE.cowork;

function WorkflowStep({ workflows, pending, run, onChange }: {
  workflows: RecordValue[];
  pending: string;
  run: RunCapability;
  onChange(id: string): void;
}) {
  if (!workflows.length) return <p className="onboarding-note">{t('No workflow profiles available yet.')}</p>;
  return <div className="onboarding-workflow-grid">{workflows.map((workflow) => {
    const id = String(workflow.id || '');
    const active = workflow.active === true;
    const guide = WORKFLOW_GUIDE[id.toLowerCase()];
    const Icon = guide?.icon || Users;
    return <button type="button" key={id} className={active ? 'selected' : ''} disabled={Boolean(pending)}
      onClick={() => {
        if (active) return;
        void run('setWorkflow', [id], 'onboarding-workflow').then((result) => {
          if (result !== undefined) onChange(id);
        });
      }}>
      <span className="onboarding-choice-check">{active ? <Check size={14} /> : null}</span>
      <span className="onboarding-workflow-icon" aria-hidden="true"><Icon size={18} /></span>
      <b>{title(workflow)}</b>
      <small>{guide?.tagline() || t(String(workflow.description || ''))}</small>
      {guide && <ul className="onboarding-workflow-points">
        {guide.points().map((point) => <li key={point}>{point}</li>)}
      </ul>}
    </button>;
  })}</div>;
}

// Context step: session-lifecycle toggles (auto-compact / auto-clear) — the
// onboarding face of Settings → Context. Memory has one master in General.
function ContextStep({ autoClearOn, compactAuto, pending, run, onAutoClear, onCompact }: {
  autoClearOn: boolean;
  compactAuto: boolean;
  pending: string;
  run: RunCapability;
  onAutoClear(next: boolean): void;
  onCompact(next: boolean): void;
}) {
  const lifecycle = [
    { key: 'compact', label: t('Auto-compact'), hint: t('Compact automatically as the context reaches its limit'),
      value: compactAuto, apply: onCompact,
      save: (next: boolean) => run('setCompactionSettings', [{ auto: next }], 'onboarding-autocompact') },
    { key: 'clear', label: t('Auto-clear'), hint: t('Clear idle sessions after the provider default window'),
      value: autoClearOn, apply: onAutoClear,
      save: (next: boolean) => run('setAutoClear', [{ enabled: next }], 'onboarding-autoclear') },
  ];
  return <div className="onboarding-star-card onboarding-connect-card onboarding-context-card">
    <div>
      <span className="onboarding-connect-title">{t('Session lifecycle')}</span>
      <p>{t('Choose how Mixdog manages long-running and idle sessions.')}</p>
    </div>
    {/* Lifecycle toggles live inside the card: a separate section overflowed
        the fixed-height dialog into a scrollbar (user: 스크롤 안 나오게). */}
    <div className="onboarding-context-rows">
      {lifecycle.map((row) => <div className="onboarding-context-row" key={row.key}>
        <div><b>{row.label}</b><small>{row.hint}</small></div>
        <div className="onboarding-provider-toggle" role="group" aria-label={row.label}>
          {([[true, t('On')], [false, t('Off')]] as const).map(([value, name]) => <button key={name} type="button"
            className={row.value === value ? 'active' : ''} disabled={Boolean(pending)}
            onClick={() => {
              if (row.value === value) return;
              void row.save(value).then((result) => { if (result !== undefined) row.apply(value); });
            }}>{name}</button>)}
        </div>
      </div>)}
    </div>
  </div>;
}

function ChannelsStep({ setup, pending, run, onReload }: {
  setup: RecordValue;
  pending: string;
  run: RunCapability;
  onReload(): void;
}) {
  const channel = record(setup.channel);
  const activeProvider = String(setup.provider || 'discord');
  const discordReady = record(setup.discord).authenticated === true;
  const telegramReady = record(setup.telegram).authenticated === true;
  // Connected tokens hide their input (an empty password box reads broken);
  // Replace reopens the field.
  const [editingToken, setEditingToken] = useState<Record<string, boolean>>({});
  const providers = [
    { id: 'discord' as const, name: 'Discord', save: 'saveDiscordToken' as const,
      status: record(setup.discord), tokenPlaceholder: t('Discord bot token'),
      targetLabel: t('Main channel'), targetHint: t('Where Mixdog posts and listens'),
      targetPlaceholder: t('Discord channel ID'),
      targetValue: String(channel.discordChannelId || '') },
    { id: 'telegram' as const, name: 'Telegram', save: 'saveTelegramToken' as const,
      status: record(setup.telegram), tokenPlaceholder: t('Telegram bot token'),
      targetLabel: t('Main chat'), targetHint: t('Where Mixdog posts and listens'),
      targetPlaceholder: t('Telegram chat ID'),
      targetValue: String(channel.telegramChatId || '') },
  ];
  return <>
    {(discordReady || telegramReady) && <div className="onboarding-model-section">
      <h3>{t('Active channel')}</h3>
      <div className="onboarding-provider-list">
        <div className="onboarding-provider-row onboarding-provider-row--plain">
          <div><b>{t('Use for messaging')}</b><small>{t('Mixdog talks through this provider')}</small></div>
          <div className="onboarding-provider-toggle" role="group" aria-label={t('Active channel provider')}>
            {([['discord', 'Discord', discordReady], ['telegram', 'Telegram', telegramReady]] as const)
              .map(([id, name, ready]) => <button key={id} type="button"
                className={activeProvider === id ? 'active' : ''}
                disabled={Boolean(pending) || !ready}
                onClick={() => {
                  if (activeProvider === id) return;
                  void run('setChannelProvider', [id], 'onboarding-provider')
                    .then((result) => { if (result !== undefined) onReload(); });
                }}>{name}</button>)}
          </div>
        </div>
      </div>
    </div>}
    {providers.map((provider) => <div className="onboarding-model-section" key={provider.id}>
      <h3>{provider.name}</h3>
      <div className="onboarding-provider-list">
        <form onSubmit={(event) => {
          event.preventDefault();
          const form = event.currentTarget;
          const secret = new FormData(form).get('secret');
          void run(provider.save, [secret], `onboarding-${provider.id}-token`).then((result) => {
            if (result !== undefined) {
              form.reset();
              setEditingToken((state) => ({ ...state, [provider.id]: false }));
              onReload();
            }
          });
        }}>
          <div><b>{t('Bot token')}</b>
            <small>{provider.status.authenticated
              ? t('Connected')
              : t(String(provider.status.detail || provider.status.status || 'Create a bot and paste its token'))}</small></div>
          {provider.status.authenticated && !editingToken[provider.id]
            ? <>
              <input className="masked" value="••••••••••••••••" readOnly disabled
                aria-label={t('{{name}} bot token (saved)', { name: provider.name })} />
              <button type="button" className="ghost" disabled={Boolean(pending)}
                onClick={() => setEditingToken((state) => ({ ...state, [provider.id]: true }))}>{t('Replace')}</button>
            </>
            : <>
              <input name="secret" type="password" autoComplete="off" placeholder={provider.tokenPlaceholder} required />
              <button disabled={Boolean(pending)}>{provider.status.authenticated ? t('Save') : t('Connect')}</button>
              {provider.status.authenticated && <button type="button" className="ghost" disabled={Boolean(pending)}
                onClick={() => setEditingToken((state) => ({ ...state, [provider.id]: false }))}>{t('Cancel')}</button>}
            </>}
        </form>
        <form onSubmit={(event) => {
          event.preventDefault();
          const channelId = new FormData(event.currentTarget).get('channelId');
          void run('setChannel', [{ provider: provider.id, channelId }], `onboarding-${provider.id}-target`)
            .then((result) => { if (result !== undefined) onReload(); });
        }}>
          <div><b>{provider.targetLabel}</b><small>{provider.targetHint}</small></div>
          <input name="channelId" defaultValue={provider.targetValue}
            placeholder={provider.targetPlaceholder} required />
          <button disabled={Boolean(pending)}>{t('Save')}</button>
        </form>
      </div>
    </div>)}
    <p className="onboarding-note">{t('The channel worker and advanced options live in Settings → Channels.')}</p>
  </>;
}

const PAIR_RETRY_MS = 2_000;

function PairStep({ api }: { api: DesktopApi }) {
  const supported = typeof api.getRemoteAccessInfo === 'function';
  const [info, setInfo] = useState<DesktopRemoteAccessInfo | null | undefined>(
    () => getCachedConnectionInfo(api));
  const ready = connectionInfoReady(info);
  useEffect(() => {
    if (!supported || ready) return undefined;
    let live = true;
    let timer = 0;
    const attempt = () => {
      void preloadConnectionInfo(api).then((value) => {
        if (!live) return;
        setInfo(value);
        if (connectionInfoReady(value)) return;
        timer = window.setTimeout(attempt, PAIR_RETRY_MS);
      });
    };
    attempt();
    return () => { live = false; window.clearTimeout(timer); };
  }, [api, ready, supported]);
  if (!supported) {
    return <p className="onboarding-note">{t('Phone pairing lives in the desktop app under Settings → Connection.')}</p>;
  }
  if (!ready) {
    return <div className="onboarding-pair"><div className="settings-connection-grid">
      <figure className="settings-connection-card settings-connection-card--loading"
        aria-label={t('Preparing pairing code')} aria-busy="true">
        <div className="settings-connection-qr-placeholder" aria-hidden="true" />
        <figcaption><b>{t('Preparing pairing code…')}</b><small>{t('Starting the secure relay')}</small></figcaption>
      </figure>
    </div></div>;
  }
  return <div className="onboarding-pair">
    <div className="settings-connection-grid">
      <figure className="settings-connection-card">
        <div aria-hidden="true" dangerouslySetInnerHTML={{ __html: info?.relayBrowserQrSvg || '' }} />
        <figcaption><b>{t('Open the web app')}</b><small>{t('Works on iPhone and Android — nothing to install')}</small></figcaption>
      </figure>
    </div>
    <p className="onboarding-note">{t('You can pair more devices later in Settings → Connection.')}</p>
  </div>;
}
