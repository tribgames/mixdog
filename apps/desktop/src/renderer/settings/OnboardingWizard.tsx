// Guided first-run setup: a full-window hero card
// with clickable progress bars, per-step hero titles, and Ctrl+Enter to
// advance. The capability wiring (completeOnboarding / skipOnboarding and the
// provider/model reads) is shared with Settings and stays authoritative.
import { ExternalLink, Github, Star, UserRound, X } from 'lucide-react';
import { type FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import type {
  DesktopApi,
  DesktopCapability,
  DesktopGithubCliAccount,
  DesktopGithubCliLoginFlow,
  DesktopGithubCliStatus,
} from '../../shared/contract';
import { t } from '../i18n';
import { scrimDismiss } from '../scrim-dismiss';
import { useMobileBack } from '../mobile-back';
import { useRemoteHostOpenAccess } from '../remote-host-access';
import { capabilityBlockedRemotely, manageOnHostNote } from './remote-capability-guard';
import { ErrorNotice } from '../ErrorNotice';
import { OpenSelect } from '../OpenSelect';
import { PaneSurfaceGate } from '../PaneSurfaceGate';
import { providerDisplayName } from '../provider-display';
import { rows } from '../record-utils';
import { acquireTitleBarDim } from '../titlebar-dim';
import { AppearanceChoice } from './appearance-choice';
import { ClientManagedProviders } from './client-managed-providers';
import { OAuthControl } from './CapabilitySettings';
import { OnboardingFooter, OnboardingProgress } from './onboarding-wizard-chrome';
import { useOnboardingModality, useOnboardingRun, useOnboardingSetup } from './onboarding-wizard-state';
import { getCachedGitPanelInfo, patchCachedGitPanelInfo, preloadGitPanelInfo } from './git-panel-info';
import { GithubDeviceCodeText, useGithubDeviceCode } from './github-device-code';
import { useGithubLoginPolling } from './github-login-polling';
import { probeGithubStarred, readGithubStarred, rememberGithubStarred } from './github-star-storage';
import '../desktop/21-onboarding.css';
import { errorMessage } from '../editor-pane-session-errors';

type RecordValue = Record<string, unknown>;
type RunCapability = <T = unknown>(
  capability: DesktopCapability,
  args?: unknown[],
  key?: string,
  refresh?: boolean,
  silent?: boolean
) => Promise<T | undefined>;
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
    id: 'appearance',
    label: () => t('Theme'),
    title: () => t('Pick how Mixdog looks'),
    subtitle: () =>
      t('Follow your system, choose dark or light, or pick a picture skin. You can change it later in Settings.'),
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

function title(value: RecordValue): string {
  return t(String(value.label || value.name || value.display || value.id || 'Unknown'));
}

function providerTitle(value: RecordValue): string {
  if (value.name || value.label) return String(value.name || value.label);
  const id = String(value.id || value.provider || value.name || '');
  return providerDisplayName(id);
}

export function OnboardingWizard({ api, onDone }: { api: DesktopApi; onDone(): void }) {
  // Provider setup works remotely on a current host; only an older host still
  // refuses it, and re-renders this wizard when its level is learned.
  useRemoteHostOpenAccess();
  const [step, setStep] = useState(savedStep);
  const [confirmSkip, setConfirmSkip] = useState(false);
  const layerRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const skipTriggerRef = useRef<HTMLButtonElement | null>(null);
  const advanceRef = useRef<() => void>(() => {});
  // The wizard's fullscreen scrim cannot cover the NATIVE caption controls —
  // hold the titlebar dim claim while the wizard is mounted.
  useEffect(() => acquireTitleBarDim(), []);
  // Warm the Git and Star steps while the first steps are on screen, so
  // entering them paints the finished card instead of popping in.
  useEffect(() => {
    void preloadGitPanelInfo(api);
    if (!readGithubStarred()) void probeGithubStarred(api).catch(() => undefined);
  }, [api]);

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

  const { run, pending, error, setError, capabilityPendingRef } = useOnboardingRun(api);
  const { loading, load, providerSetup, profile, setProfile } = useOnboardingSetup(api, setError);

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

  useMobileBack(confirmSkip, closeSkipConfirmation);

  const confirmSkipOnboarding = () => {
    setConfirmSkip(false);
    void finish();
  };

  // Moving on past the Git step with GitHub connected installs the Git
  // built-in — the same activation as its Extensions card — so the git and
  // github tools work from the first task. Skipping, no system Git, or a
  // failed write leaves the card to install from; it never blocks setup.
  const activateGit = async () => {
    const github = await api.githubCliStatus?.();
    if (github?.authenticated !== true) return;
    const git = await api.gitCliStatus?.();
    if (git?.installed !== true) return;
    await run('setBuiltinToolEnabled', ['git', true], 'git-builtin', false, true);
  };
  const goToStep = (next: number) => {
    if (STEPS[step].id === 'git' && next > step) void activateGit().catch(() => undefined);
    setStep(next);
  };

  advanceRef.current = () => {
    // Commit the title before a keyboard shortcut unmounts its input.
    if (document.activeElement instanceof HTMLInputElement) document.activeElement.blur();
    if (loading || capabilityPendingRef.current) return;
    if (step < STEPS.length - 1) goToStep(step + 1);
    else void finish();
  };

  useOnboardingModality({ layerRef, dialogRef, closeRef, advanceRef, requestSkip });

  const meta = STEPS[step];

  return createPortal(
    // Scrim click-to-dismiss asks for skip confirmation; keyboard dismissal is the document Escape handler.
    <div
      ref={layerRef}
      className="onboarding-layer"
      {...scrimDismiss(() => {
        // Click-off dismissal stays available on every step:
        // only a tap on the scrim itself asks for skip confirmation.
        if (pending || confirmSkip) return;
        requestSkip(closeRef.current);
      })}
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
            <OnboardingProgress steps={STEPS} step={step} busy={Boolean(pending)} onGo={goToStep} />
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
                {meta.id === 'appearance' && <AppearanceChoice />}
                {meta.id === 'providers' && capabilityBlockedRemotely('saveProviderApiKey') && (
                  <div className="onboarding-model-section">
                    <h3>{t('Providers')}</h3>
                    <p>{t('Finish provider setup on the desktop.')}</p>
                    <small>{manageOnHostNote()}</small>
                  </div>
                )}
                {meta.id === 'providers' && !capabilityBlockedRemotely('saveProviderApiKey') && (
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
        <OnboardingFooter
          step={step}
          stepCount={STEPS.length}
          busy={Boolean(pending)}
          loading={loading}
          onSkip={requestSkip}
          onBack={() => setStep((value) => value - 1)}
          onNext={() => advanceRef.current()}
          onFinish={() => void finish()}
        />
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
    // Scrim click-to-dismiss; keyboard dismissal is the dialog's cancel button and Escape.
    <div className="settings-confirm-layer" {...scrimDismiss(onCancel)}>
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
  if (setup.managedByClient === true) return <ClientManagedProviders setup={setup} />;
  const apiProviders = rows(setup.api).filter((provider) => provider.id !== 'vertex-ai');
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
                      : String(provider.detail || provider.status || '') || t('API key required')}
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
                  aria-label={t('{{value0}} API key', { value0: providerTitle(provider) })}
                  disabled={Boolean(pending)}
                  placeholder={provider.authenticated ? t('Replace API key') : t('API key')}
                  required
                />
                <button type="submit" disabled={Boolean(pending)}>
                  {provider.authenticated ? t('Replace') : t('Connect')}
                </button>
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
  const [identityBusy, setIdentityBusy] = useState(false);
  const [avatarFailed, setAvatarFailed] = useState(false);
  const identityFlow = useRef('');
  const identityAdopted = useRef(false);

  const refresh = useCallback(async () => {
    if (!api.githubCliStatus) return;
    try {
      const next = await api.githubCliStatus();
      setStatus(next);
      patchCachedGitPanelInfo(api, { status: next });
    } catch (reason) {
      setGitError(errorMessage(reason));
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
  useGithubLoginPolling({ host: api, flowId, flowState, setFlow, setStatus, refreshStatus: refresh });
  const deviceCode = useGithubDeviceCode(api, flow, (url) => void api.openExternal?.(url).catch(() => undefined));

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

  // No identity UI (same rule as Settings → Git, user decision: 연동하면
  // 자동으로): the commit identity follows the connected account — on a
  // machine with no identity yet, and after every sign-in completed here.
  const syncIdentity = useCallback(async () => {
    setIdentityBusy(true);
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
    } catch (reason) {
      setGitError(errorMessage(reason));
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

  useEffect(() => {
    if (!authenticated || flowId || identityAdopted.current) return undefined;
    let live = true;
    void api
      .gitGlobalConfig?.()
      .then((config) => {
        if (!live || identityAdopted.current || config.name || config.email) return;
        identityAdopted.current = true;
        void syncIdentity();
      })
      .catch((reason) => {
        if (live) setGitError(errorMessage(reason));
      });
    return () => {
      live = false;
    };
  }, [api, authenticated, flowId, syncIdentity]);

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
      .catch((reason) => setGitError(errorMessage(reason)))
      .finally(() => setBusy(''));
  };
  const open = (url: string) => void api.openExternal?.(url).catch(() => undefined);
  const loading = status === null;
  const busyAny = Boolean(busy) || identityBusy;
  const flowLive = flowState === 'pending' || flowState === 'code';

  const pill = githubPill(loading, Boolean(status?.installed), authenticated);
  const login = String(status?.login || account?.name || '');
  const showAvatar = authenticated && Boolean(login) && !avatarFailed;
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
      {/* A failed automatic identity shows its error instead of "ready". */}
      {flowLive && deviceCode.active ? (
        <GithubDeviceCodeText state={deviceCode} />
      ) : (
        !(authenticated && gitError) && (
          <p className="onboarding-card-text">
            {authenticated ? t('Commits and pull requests are ready to go.') : connectHint}
          </p>
        )
      )}
      {authenticated && (
        <div className="onboarding-card-actions">
          <small>{t('Manage in Settings → Git.')}</small>
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
          {flowLive && deviceCode.active && (
            <button
              type="button"
              disabled={busyAny}
              onClick={deviceCode.opened ? deviceCode.reopen : deviceCode.openGithub}
            >
              {deviceCode.opened ? t('Open GitHub again ↗') : t('Copy & open GitHub ↗')}
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
      {flowLive && !deviceCode.active && (
        <p className="onboarding-note" role="status">
          {t('Starting GitHub sign-in…')}
        </p>
      )}
      <ErrorNotice errors={[flowState === 'error' ? flow?.message || t('unknown error') : '', gitError]} />
    </div>
  );
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
  // A remembered star paints at once (the About panel's rule) and skips the
  // probe; otherwise the probe fills in gh availability.
  const [starred, setStarred] = useState(readGithubStarred);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (readGithubStarred()) return undefined;
    let live = true;
    void probeGithubStarred(api)
      .then((status) => {
        if (!live || !status) return;
        setGhReady(status.available);
        setStarred(status.starred);
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
      .then((result) => setStarred(rememberGithubStarred(result?.starred === true)))
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
        <button type="button" className={starred ? 'starred' : undefined} disabled={busy || starred} onClick={star}>
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
              if (event.key === 'Enter' && !event.nativeEvent.isComposing) event.currentTarget.blur();
            }}
          />
        </label>
        {/* biome-ignore lint/a11y/noLabelWithoutControl: wraps the custom OpenSelect, which carries its own aria-label. */}
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
        {/* biome-ignore lint/a11y/noLabelWithoutControl: wraps the custom OpenSelect, which carries its own aria-label. */}
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
