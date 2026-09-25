// Guided first-run setup: a full-window hero card
// with clickable progress bars, per-step hero titles, and Ctrl+Enter to
// advance. The capability wiring (completeOnboarding / skipOnboarding and the
// provider/model reads) is shared with Settings and stays authoritative.
import { ArrowLeft, ArrowRight, Check, ExternalLink, Github, Star, UserRound, X } from 'lucide-react';
import { type FormEvent, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import type {
  DesktopApi,
  DesktopCapability,
  DesktopCapabilityReadRequest,
  DesktopCapabilityReadResult,
  DesktopGithubCliAccount,
  DesktopGithubCliLoginFlow,
  DesktopGithubCliStatus,
} from '../../shared/contract';
import { t } from '../i18n';
import { ErrorNotice } from '../ErrorNotice';
import { OpenSelect } from '../OpenSelect';
import { PaneSurfaceGate } from '../PaneSurfaceGate';
import { providerDisplayName } from '../provider-display';
import { record } from '../record-utils';
import { invalidateSidebarReferenceForMutation } from '../sidebar-reference-cache';
import { acquireTitleBarDim } from '../titlebar-dim';
import { OAuthControl } from './CapabilitySettings';
import { getCachedGitPanelInfo, patchCachedGitPanelInfo, preloadGitPanelInfo } from './git-panel-info';
import '../desktop/21-onboarding.css';

type RecordValue = Record<string, unknown>;
type RunCapability = <T = unknown>(
  capability: DesktopCapability,
  args?: unknown[],
  key?: string,
  refresh?: boolean,
  silent?: boolean
) => Promise<T | undefined>;
const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

const MIXDOG_REPO_URL = 'https://github.com/tribgames/mixdog';
const CLI_DOWNLOAD_URL = 'https://cli.github.com';
// Resume marker: reopening the wizard continues from the last step reached.
const ONBOARDING_STEP_KEY = 'mixdog.onboarding.step';

const STEPS = [
  {
    id: 'profile',
    label: () => t('Profile'),
    title: () => t('Make it yours'),
    subtitle: () => t('Tell Mixdog what to call you, your development experience, and which language to answer in.'),
  },
  {
    id: 'providers',
    label: () => t('Providers'),
    title: () => t('Connect your providers'),
    subtitle: () => t('Sign in with API keys or OAuth. Local models are set up through chat.'),
  },
  {
    id: 'git',
    label: () => t('Git'),
    title: () => t('Set up Git & GitHub'),
    subtitle: () => t('Connect the GitHub CLI and you are set — commits and pull requests just work.'),
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
  requests: DesktopCapabilityReadRequest[]
): Promise<DesktopCapabilityReadResult[]> {
  if (typeof api.readCapabilities === 'function') return api.readCapabilities(requests);
  return Promise.all(
    requests.map(async (request) => {
      try {
        const result = await api.invokeCapability({ capability: request.capability, args: request.args });
        return { ok: true as const, value: result.value };
      } catch (reason) {
        return { ok: false as const, error: reason instanceof Error ? reason.message : String(reason) };
      }
    })
  );
}

export function OnboardingWizard({ api, onDone }: { api: DesktopApi; onDone(): void }) {
  const [step, setStep] = useState(savedStep);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState('');
  const [error, setError] = useState('');
  const [providerSetup, setProviderSetup] = useState<RecordValue>({});
  const [profile, setProfile] = useState<RecordValue>({});
  const [confirmSkip, setConfirmSkip] = useState(false);
  const layerRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const skipTriggerRef = useRef<HTMLButtonElement | null>(null);
  const priorFocus = useRef<HTMLElement | null>(null);
  const capabilityPendingRef = useRef(false);
  const mutationChain = useRef<Promise<unknown>>(Promise.resolve());
  const mutationCount = useRef(0);
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
    } catch {
      /* resume is a convenience only */
    }
  }, [step]);
  const clearResume = () => {
    try {
      window.localStorage.removeItem(ONBOARDING_STEP_KEY);
    } catch {
      /* resume is a convenience only */
    }
  };

  const run = useCallback(
    async <T,>(
      capability: DesktopCapability,
      args: unknown[] = [],
      key: string = capability,
      _refresh = false,
      silent = false
    ): Promise<T | undefined> => {
      if (!silent) {
        mutationCount.current += 1;
        capabilityPendingRef.current = true;
        setPending(key);
        setError('');
      }
      const execute = async (): Promise<T | undefined> => {
        try {
          const result = (await api.invokeCapability<T>({ capability, args })).value;
          // Invalidate only after the authoritative mutation has resolved.
          invalidateSidebarReferenceForMutation(capability);
          return result;
        } catch (reason) {
          if (!silent) setError(reason instanceof Error ? reason.message : String(reason));
          return undefined;
        } finally {
          if (!silent && --mutationCount.current === 0) {
            capabilityPendingRef.current = false;
            setPending('');
          }
        }
      };
      // OAuth status reads must not wait behind an interactive login mutation.
      if (silent) return execute();
      const task = mutationChain.current.then(execute);
      mutationChain.current = task;
      return task;
    },
    [api]
  );

  const load = useCallback(
    async (force = false) => {
      if (!loadedRef.current) setLoading(true);
      setError('');
      try {
        const readResults = await readCapabilityBatch(api, [
          { capability: 'getProviderSetup', args: [{ force }] },
          { capability: 'getProfile' },
        ]);
        const values = readResults.map((result) => (result.ok ? result.value : null));
        const readErrors = readResults.flatMap((result) => (result.ok ? [] : [result.error]));
        if (readErrors.length) setError(readErrors.join(' · '));
        setProviderSetup(record(values[0]));
        setProfile(record(values[1]));
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : String(reason));
      } finally {
        loadedRef.current = true;
        setLoading(false);
      }
    },
    [api]
  );

  useEffect(() => {
    if (!loadedRef.current) void load();
  }, [load]);

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

  // Every step saves as it changes (models stay untouched: the first turn picks
  // a connected provider's model), so Finish and Skip both only mark it done.
  const finish = async () => {
    const result = await run('skipOnboarding', [], 'finish-onboarding');
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
    void finish();
  };

  advanceRef.current = () => {
    // Commit the title before a keyboard shortcut unmounts its input.
    if (document.activeElement instanceof HTMLInputElement) document.activeElement.blur();
    if (loading || capabilityPendingRef.current) return;
    if (step < STEPS.length - 1) setStep(step + 1);
    else void finish();
  };

  useLayoutEffect(() => {
    priorFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const layer = layerRef.current;
    const background = Array.from(document.body.children)
      .filter(
        (element): element is HTMLElement =>
          element instanceof HTMLElement && !element.matches('.mx-toast-region') && element !== layer
      )
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
        // Screen-local submit: never advance underneath a
        // nested dialog (OAuth login, skip confirmation).
        if (nested) return;
        event.preventDefault();
        event.stopPropagation();
        advanceRef.current();
        return;
      }
      if (event.key === 'Escape') {
        const openPortaledMenu = Array.from(
          dialog.querySelectorAll<HTMLElement>('[role="combobox"][aria-expanded="true"][aria-controls]')
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
  }, [finish]);

  const meta = STEPS[step];

  return createPortal(
    <div
      ref={layerRef}
      className="onboarding-layer"
      onMouseDown={(event) => {
        // Click-off dismissal stays available on every step:
        // only a press on the scrim itself asks for skip confirmation.
        if (event.target !== event.currentTarget || pending || confirmSkip) return;
        requestSkip(closeRef.current);
      }}
    >
      <section
        ref={dialogRef}
        className="onboarding-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="onboarding-title"
        tabIndex={-1}
      >
        <header>
          <div className="onboarding-hero">
            <h1 id="onboarding-title">{meta.title()}</h1>
            <p>{meta.subtitle()}</p>
          </div>
          <div className="onboarding-top-actions">
            <nav aria-label={t('Setup progress')}>
              {STEPS.map((entry, index) => (
                <button
                  key={entry.id}
                  type="button"
                  title={entry.label()}
                  className={`onboarding-progress-bar${progressBarState(index, step)}`}
                  aria-label={t('Go to step {{step}}: {{label}}', { step: index + 1, label: entry.label() })}
                  aria-current={index === step ? 'step' : undefined}
                  disabled={Boolean(pending)}
                  onClick={() => setStep(index)}
                />
              ))}
              <span className="onboarding-progress-count">
                {t('{{current}} of {{total}}', {
                  current: step + 1,
                  total: STEPS.length,
                })}
              </span>
            </nav>
            <button
              ref={closeRef}
              type="button"
              aria-label={t('Skip setup')}
              disabled={Boolean(pending)}
              onClick={(event) => requestSkip(event.currentTarget)}
            >
              <X size={16} />
            </button>
          </div>
        </header>
        <div className="onboarding-body">
          <PaneSurfaceGate ready={!loading} label={t('Loading your Mixdog configuration…')}>
            <div className="onboarding-ready-content">
              <div className="onboarding-step-view" key={meta.id}>
                {meta.id === 'profile' && (
                  <ProfileStep
                    profile={profile}
                    pending={pending}
                    run={run}
                    onProfile={(patch) => setProfile((current) => ({ ...current, ...patch }))}
                  />
                )}
                {meta.id === 'providers' && (
                  <ProviderStep
                    api={api}
                    setup={providerSetup}
                    pending={pending}
                    run={run}
                    onSaveApiKey={(event, provider) => void saveApiKey(event, provider)}
                    onReload={() => void load(true)}
                  />
                )}
                {meta.id === 'git' && <GitStep api={api} />}
                {meta.id === 'star' && <StarStep api={api} />}
              </div>
              {error && <ErrorNotice error={error} />}
            </div>
          </PaneSurfaceGate>
        </div>
        <footer>
          {/* On the last step Finish does exactly what Skip does: one exit only. */}
          {step < STEPS.length - 1 && (
            <button
              type="button"
              className="secondary"
              disabled={Boolean(pending)}
              onClick={(event) => requestSkip(event.currentTarget)}
            >
              {t('Skip setup')}
            </button>
          )}
          <div>
            {step > 0 && (
              <button type="button" disabled={Boolean(pending)} onClick={() => setStep((value) => value - 1)}>
                <ArrowLeft size={14} /> {t('Back')}
              </button>
            )}
            {step < STEPS.length - 1 ? (
              <button
                type="button"
                className="primary"
                disabled={loading || Boolean(pending)}
                onClick={() => advanceRef.current()}
              >
                {t('Next')} <ArrowRight size={14} />
              </button>
            ) : (
              <button
                type="button"
                className="primary"
                disabled={loading || Boolean(pending)}
                onClick={() => void finish()}
              >
                <Check size={14} /> {t('Finish')}
              </button>
            )}
          </div>
        </footer>
        {confirmSkip && (
          <OnboardingSkipConfirmation onCancel={closeSkipConfirmation} onConfirm={confirmSkipOnboarding} />
        )}
      </section>
    </div>,
    document.body
  );
}

function OnboardingSkipConfirmation({ onCancel, onConfirm }: { onCancel(): void; onConfirm(): void }) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    cancelRef.current?.focus();
  }, []);
  // This scrim stacks on the wizard's: the native caption band has to darken
  // by the same amount the DOM does.
  useEffect(() => acquireTitleBarDim(), []);
  return (
    <div className="settings-confirm-layer">
      <section
        className="settings-confirm-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="onboarding-skip-title"
        aria-describedby="onboarding-skip-description"
        data-settings-nested-dialog
      >
        <header>
          <h3 id="onboarding-skip-title">{t('Skip Mixdog setup?')}</h3>
          <button type="button" aria-label={t('Close skip confirmation')} onClick={onCancel}>
            <X aria-hidden="true" size={16} />
          </button>
        </header>
        <p id="onboarding-skip-description">
          {t('You can configure providers, models, Git, themes, and output style later in Settings.')}
        </p>
        <footer>
          <button ref={cancelRef} type="button" onClick={onCancel}>
            {t('Cancel')}
          </button>
          <button type="button" className="danger" onClick={onConfirm}>
            {t('Skip setup')}
          </button>
        </footer>
      </section>
    </div>
  );
}

function ProviderStep({
  api,
  setup,
  pending,
  run,
  onSaveApiKey,
  onReload,
}: {
  api: DesktopApi;
  setup: RecordValue;
  pending: string;
  run: RunCapability;
  onSaveApiKey(event: FormEvent<HTMLFormElement>, provider: string): void;
  onReload(): void;
}) {
  // OpenCode Go leads the API list (user decision).
  const apiProviders = [...rows(setup.api)].sort(
    (left, right) => Number(String(right.id) === 'opencode-go') - Number(String(left.id) === 'opencode-go')
  );
  const oauthProviders = rows(setup.oauth);
  return (
    <>
      {oauthProviders.length > 0 && (
        <div className="onboarding-model-section">
          <h3>{t('OAuth')}</h3>
          <div className="onboarding-provider-list">
            {/* One status slot for every provider kind: the state reads under the
          name, never above the row's actions (user: 커넥티드 위치가 제각각).
          The token file/store location is plumbing, not setup guidance. */}
            {oauthProviders.map((provider) => {
              const connected =
                provider.usable === true ||
                (provider.usable == null && Boolean(provider.authenticated) && !provider.reauthRequired);
              return (
              <div className="onboarding-provider-row" key={String(provider.id)}>
                <div>
                  <b>{providerTitle(provider)}</b>
                  <small className={`onboarding-provider-state${connected ? ' connected' : ''}`}>
                    {t(providerStatusText(provider))}
                  </small>
                </div>
                {/* A working login needs no Connect; Forget stays for switching. */}
                {!connected && (
                  <span className="onboarding-provider-action">
                    <OAuthControl
                      api={api}
                      provider={{ ...provider, label: providerTitle(provider) }}
                      disabled={Boolean(pending)}
                      run={run}
                      onComplete={onReload}
                    />
                  </span>
                )}
                {Boolean(provider.authenticated || provider.reauthRequired) && (
                  <button
                    type="button"
                    className="ghost"
                    disabled={Boolean(pending)}
                    onClick={() => {
                      void run('forgetProviderAuth', [provider.id], `forget-${provider.id}`).then((result) => {
                        if (result !== undefined) onReload();
                      });
                    }}
                  >
                    {t('Forget')}
                  </button>
                )}
              </div>
              );
            })}
          </div>
        </div>
      )}
      {apiProviders.length > 0 && (
        <div className="onboarding-model-section">
          <h3>{t('API keys')}</h3>
          <div className="onboarding-provider-list">
            {apiProviders.map((provider) => (
              <form key={String(provider.id)} onSubmit={(event) => onSaveApiKey(event, String(provider.id))}>
                <div>
                  <b>{providerTitle(provider)}</b>
                  <small className={`onboarding-provider-state${provider.authenticated ? ' connected' : ''}`}>
                    {provider.authenticated
                      ? t('Connected')
                      : t(String(provider.detail || provider.status || 'API key required'))}
                  </small>
                </div>
                {!provider.authenticated && typeof provider.url === 'string' && /^https:\/\//.test(provider.url) && (
                  <button
                    type="button"
                    className="ghost"
                    disabled={Boolean(pending)}
                    onClick={() =>
                      void (window as unknown as { mixdogDesktop?: DesktopApi }).mixdogDesktop
                        ?.openExternal?.(String(provider.url))
                        .catch(() => undefined)
                    }
                  >
                    {t('Get API key ↗')}
                  </button>
                )}
                <input
                  name="secret"
                  type="password"
                  autoComplete="off"
                  aria-label={`${providerTitle(provider)} API key`}
                  disabled={Boolean(pending)}
                  placeholder={provider.authenticated ? t('Replace API key') : t('API key')}
                  required
                />
                <button disabled={Boolean(pending)}>{provider.authenticated ? t('Replace') : t('Connect')}</button>
                {Boolean(provider.stored || (!provider.env && provider.authenticated)) && (
                  <button
                    type="button"
                    className="ghost"
                    disabled={Boolean(pending)}
                    onClick={() => {
                      void run('forgetProviderAuth', [provider.id], `forget-${provider.id}`).then((result) => {
                        if (result !== undefined) onReload();
                      });
                    }}
                  >
                    {t('Forget')}
                  </button>
                )}
              </form>
            ))}
          </div>
        </div>
      )}
      <div className="onboarding-model-section">
        <h3>{t('Local models')}</h3>
        <p className="onboarding-note">
          {t('To add a model, ask in chat. The local-provider skill checks your PC and guides installation.')}
        </p>
      </div>
    </>
  );
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
  const [identityReady, setIdentityReady] = useState(false);
  const [identityBusy, setIdentityBusy] = useState(false);
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
    return () => {
      live = false;
    };
  }, [api, supported]);

  const flowId = flow?.flowId || '';
  const flowState = flow?.state || '';
  useEffect(() => {
    if (!flowId || (flowState !== 'pending' && flowState !== 'code')) return undefined;
    let cancelled = false;
    const timer = window.setInterval(() => {
      void api
        .githubCliLoginStatus?.(flowId)
        .then((next) => {
          if (cancelled || !next) return;
          setFlow(next);
          if (next.state === 'success') {
            // Main reports success only after `gh auth status` confirmed the
            // account: adopt it now. Waiting for the refresh probe flashed the
            // Sign-in button back for ~1s, and a click there started a second
            // device flow (a new 8-character code).
            setStatus((current) => ({
              installed: true,
              ...current,
              authenticated: true,
              ...(next.login ? { login: next.login } : {}),
            }));
            void refresh();
          }
        })
        .catch(() => {
          /* transient; the next tick retries */
        });
    }, 1_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [api, flowId, flowState, refresh]);

  const authenticated = status?.authenticated === true;
  useEffect(() => {
    if (!supported || !authenticated) return undefined;
    let live = true;
    void api
      .githubCliAccount?.()
      .then((next) => {
        if (!live) return;
        setAccount(next || null);
        patchCachedGitPanelInfo(api, { account: next || null });
      })
      .catch(() => {
        /* the status row still shows the login */
      });
    return () => {
      live = false;
    };
  }, [api, authenticated, supported]);

  useEffect(() => {
    if (!authenticated) {
      setIdentityReady(false);
      return;
    }
    if (flowId) return;
    let live = true;
    void api
      .gitGlobalConfig?.()
      .then((config) => {
        if (live) setIdentityReady(Boolean(config.name && config.email));
      })
      .catch((reason) => {
        if (live) setGitError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => {
      live = false;
    };
  }, [api, authenticated, flowId]);

  const syncIdentity = useCallback(async () => {
    setIdentityBusy(true);
    setIdentityReady(false);
    setGitError('');
    try {
      if (!api.githubCliAccount || !api.setGitGlobalConfig) {
        throw new Error(t('Git identity setup is unavailable.'));
      }
      // Never adopt a cached account from before this login.
      const next = await api.githubCliAccount();
      if (!next?.name || !next.email) throw new Error(t('GitHub account name or email is unavailable.'));
      setAccount(next);
      patchCachedGitPanelInfo(api, { account: next });
      await api.setGitGlobalConfig('user.name', next.name);
      const config = await api.setGitGlobalConfig('user.email', next.email);
      if (config.name !== next.name || config.email !== next.email) {
        throw new Error(t('The setting could not be saved.'));
      }
      setIdentityReady(true);
    } catch (reason) {
      setGitError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setIdentityBusy(false);
    }
  }, [api]);

  useEffect(() => {
    if (flowState !== 'success' || !flowId) return;
    if (identityFlow.current === flowId) return;
    identityFlow.current = flowId;
    void syncIdentity();
  }, [flowId, flowState, syncIdentity]);

  if (!supported) {
    return (
      <p className="onboarding-note">
        {t('Git and GitHub connect from the desktop app. You can set this up any time in Settings → Git.')}
      </p>
    );
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
  const busyAny = Boolean(busy) || identityBusy;
  const flowLive = flowState === 'pending' || flowState === 'code';

  const pill = githubPill(loading, Boolean(status?.installed), authenticated);
  const login = String(status?.login || account?.name || '');
  const showAvatar = authenticated && Boolean(login) && !avatarFailed;
  let connectedNote = t('GitHub is connected. Set up your commit identity to finish Git setup.');
  if (identityBusy) connectedNote = t('Saving…');
  else if (identityReady) connectedNote = t('Commits and pull requests are ready to go.');
  const connectHint =
    !status?.installed && !loading
      ? t('Mixdog installs the GitHub CLI and signs you in — one click, no terminal needed.')
      : t('Sign in opens github.com with a one-time code — Mixdog links your commits automatically.');
  // In-card actions stay plated, not primary: the footer's Next is the one
  // primary action on every step.
  return (
    <div className="onboarding-card">
      <div className="onboarding-card-head">
        <span className={`onboarding-card-icon${showAvatar ? ' avatar' : ''}`} aria-hidden="true">
          {showAvatar ? (
            <img src={`https://github.com/${login}.png?size=128`} alt="" onError={() => setAvatarFailed(true)} />
          ) : (
            <Github size={20} />
          )}
        </span>
        <div className="onboarding-card-heading">
          <b className="onboarding-card-title">{authenticated && login ? login : t('Connect GitHub')}</b>
          <span className={`onboarding-pill ${pill[0]}`}>{pill[1]}</span>
          {Boolean(status?.version) && <span className="onboarding-pill neutral">gh {status?.version}</span>}
          {authenticated && Boolean(account?.email) && <span className="onboarding-card-meta">{account?.email}</span>}
        </div>
      </div>
      <p className="onboarding-card-text">{authenticated ? connectedNote : connectHint}</p>
      {authenticated && (
        <div className="onboarding-card-actions">
          <small>{t('Manage in Settings → Git.')}</small>
          {!identityReady && (
            <button type="button" disabled={busyAny} onClick={() => void syncIdentity()}>
              {t('Set up commit identity')}
            </button>
          )}
        </div>
      )}
      {!authenticated && (
        <div className="onboarding-card-actions">
          {!loading && !status?.installed && (
            <>
              <button type="button" className="ghost" disabled={busyAny} onClick={() => open(CLI_DOWNLOAD_URL)}>
                <ExternalLink size={14} /> {t('Manual download')}
              </button>
              <button
                type="button"
                disabled={busyAny}
                onClick={() =>
                  act('install', () =>
                    api.installGithubCli?.().then((next) => {
                      if (!next) return;
                      setStatus(next);
                      patchCachedGitPanelInfo(api, { status: next });
                    })
                  )
                }
              >
                {busy === 'install' ? t('Installing…') : t('Install GitHub CLI')}
              </button>
            </>
          )}
          {status?.installed && !status.authenticated && !flowLive && (
            <button
              type="button"
              disabled={busyAny}
              onClick={() =>
                act('connect', () =>
                  api.githubCliLoginStart?.().then((started) => {
                    if (started) setFlow(started);
                  })
                )
              }
            >
              <Github size={14} /> {t('Sign in with GitHub')}
            </button>
          )}
          {flowLive && (
            <button
              type="button"
              className="ghost"
              disabled={busyAny}
              onClick={() => {
                const id = flowId;
                setFlow(null);
                act('cancel', () => api.githubCliLoginCancel?.(id));
              }}
            >
              {t('Cancel')}
            </button>
          )}
        </div>
      )}
      {flowLive && (
        <p className="onboarding-note" role="status">
          {flow?.code ? (
            <>
              {t('Enter code')} <code className="onboarding-code">{flow.code}</code>{' '}
              {t('at github.com/login/device — the browser should open by itself.')}{' '}
              <button
                type="button"
                className="onboarding-link"
                onClick={() => open(flow.url || 'https://github.com/login/device')}
              >
                {t('Open github.com ↗')}
              </button>
            </>
          ) : (
            t('Starting GitHub sign-in…')
          )}
        </p>
      )}
      <ErrorNotice errors={[flowState === 'error' ? flow?.message || t('unknown error') : '', gitError]} />
    </div>
  );
}

function progressBarState(index: number, step: number): string {
  if (index === step) return ' active';
  return index < step ? ' complete' : '';
}

// The runtime's raw status words (Set / Not Set / Signed In / Reauth Required
// …) have no catalog entries; onboarding shows the three translated states.
function providerStatusText(provider: { reauthRequired?: unknown; authenticated?: unknown }): string {
  if (provider.reauthRequired) return 'Reauth required';
  return provider.authenticated ? 'Connected' : 'Not connected';
}

function githubPill(loading: boolean, installed: boolean, authenticated: boolean): [string, string] {
  if (loading) return ['neutral', t('Checking…')];
  if (!installed) return ['warn', t('CLI not installed')];
  return authenticated ? ['ok', t('Connected')] : ['warn', t('Not connected')];
}

function starLabel(starred: boolean, busy: boolean): string {
  if (starred) return t('Starred');
  return busy ? t('Starring…') : t('Star');
}

// Final step: the About panel's star action (gh CLI when signed in, repo page
// otherwise) framed as the closing ask before Finish.
function StarStep({ api }: { api: DesktopApi }) {
  const [ghReady, setGhReady] = useState(false);
  const [starred, setStarred] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    void api
      .githubStarStatus?.()
      ?.then((status) => {
        if (!live || !status) return;
        setGhReady(status.available === true);
        setStarred(status.starred === true);
      })
      .catch(() => {
        /* the button stays a plain repo link */
      });
    return () => {
      live = false;
    };
  }, [api]);
  const open = (url: string) => void api.openExternal?.(url).catch(() => undefined);
  const star = () => {
    if (starred || !ghReady || !api.starGithub) {
      open(MIXDOG_REPO_URL);
      return;
    }
    setBusy(true);
    void api
      .starGithub()
      .then((result) => setStarred(result?.starred === true))
      .catch(() => open(MIXDOG_REPO_URL))
      .finally(() => setBusy(false));
  };
  // A GitHub-repo-card composition (familiar, concrete) instead of a glowing
  // poster tile (user: AI slop 같다).
  return (
    <div className="onboarding-card">
      <div className="onboarding-card-head">
        <span className="onboarding-card-icon" aria-hidden="true">
          <Github size={20} />
        </span>
        <div className="onboarding-card-heading">
          <b className="onboarding-card-title">mixdog</b>
          <span className="onboarding-pill neutral">{t('Public')}</span>
        </div>
      </div>
      <p className="onboarding-card-text">
        {t('Standalone coding agent — multi-provider agent workflows across CLI, desktop, and phone.')}{' '}
        {starred
          ? t('Thank you for the star — it genuinely helps mixdog grow!')
          : t('Built in the open; a star helps other developers find it.')}
      </p>
      <div className="onboarding-repo-meta">
        <span>
          <i aria-hidden="true" /> {t('Free & open source')}
        </span>
        <span>{t('Runs on your machine')}</span>
        <span>{t('No sign-up')}</span>
      </div>
      <div className="onboarding-card-actions">
        <button type="button" className="ghost" disabled={busy} onClick={() => open(MIXDOG_REPO_URL)}>
          <ExternalLink size={14} /> {t('Open on GitHub')}
        </button>
        {/* Star sits at the card's bottom-right — the easiest spot to hit. */}
        <button
          type="button"
          className={starred ? 'starred' : undefined}
          disabled={busy || starred}
          onClick={star}
        >
          <Star size={14} fill={starred ? 'currentColor' : 'none'} />
          {starLabel(starred, busy)}
        </button>
      </div>
    </div>
  );
}

function ProfileStep({
  profile,
  pending,
  run,
  onProfile,
}: {
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
  const experienceLevels = rows(profile.experienceLevels).map((entry) => ({
    value: String(entry.id || entry.value || ''),
    label: title(entry),
  }));
  const commitTitle = () => {
    if (trimmed === String(profile.title || '')) return;
    void run('setProfile', [{ title: trimmed }], 'onboarding-profile-title').then((result) => {
      if (result !== undefined) onProfile({ title: trimmed });
    });
  };
  // Settings-row layout (label + hint left, control right) keeps the whole
  // first step on screen without scrolling at the default window size.
  return (
    <div className="onboarding-card onboarding-profile-card">
      <div className="onboarding-card-head">
        <span
          className={`onboarding-card-icon round onboarding-profile-avatar${initial ? ' has-initial' : ''}`}
          aria-hidden="true"
        >
          {initial ? <b>{initial}</b> : <UserRound size={20} />}
        </span>
        <p className="onboarding-card-title" aria-live="polite">
          {trimmed ? t('Hello, {{name}} 👋', { name: trimmed }) : t('Hello there 👋')}
        </p>
      </div>
      <div className="onboarding-profile-fields">
        <label>
          <span>
            <b>{t('Title')}</b>
            <small>{t('How Mixdog addresses you.')}</small>
          </span>
          <input
            name="title"
            value={draft}
            placeholder={t('Your name or role')}
            aria-label={t('Profile title')}
            disabled={Boolean(pending)}
            onChange={(event) => {
              setTouched(true);
              setDraft(event.currentTarget.value);
            }}
            onBlur={commitTitle}
            onKeyDown={(event) => {
              if (event.key === 'Enter') event.currentTarget.blur();
            }}
          />
        </label>
        <label>
          <span>
            <b>{t('Experience level')}</b>
            <small>
              {t(
                'How much development experience do you have? This only adjusts terminology and assumed background, not response length.'
              )}
            </small>
          </span>
          <OpenSelect
            ariaLabel={t('Experience level')}
            value={String(profile.experienceLevel || '')}
            disabled={Boolean(pending)}
            options={[
              { value: '', label: t('Select…'), disabled: true },
              ...(experienceLevels.length
                ? experienceLevels
                : [
                    { value: 'beginner', label: t('Beginner') },
                    { value: 'vibe-coder', label: t('Vibe coder') },
                    { value: 'junior', label: t('Junior') },
                    { value: 'expert', label: t('Expert') },
                  ]),
            ]}
            onChange={(experienceLevel) => {
              void run('setProfile', [{ experienceLevel }], 'onboarding-profile-experience').then((result) => {
                if (result !== undefined) onProfile({ experienceLevel });
              });
            }}
          />
        </label>
        <label>
          <span>
            <b>{t('Language')}</b>
            <small>{t('Every reply follows this language.')}</small>
          </span>
          <OpenSelect
            ariaLabel={t('Response language')}
            value={String(profile.language || 'system')}
            disabled={Boolean(pending)}
            options={languages.length ? languages : [{ value: 'system', label: t('System') }]}
            onChange={(language) => {
              void run('setProfile', [{ language }], 'onboarding-profile-language').then((result) => {
                if (result !== undefined) onProfile({ language });
              });
            }}
          />
        </label>
      </div>
    </div>
  );
}
