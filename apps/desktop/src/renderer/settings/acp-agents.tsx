import { Plus, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { type AcpAgentGroup, type AcpAgentStatus, acpAgentGroups, acpAgentsOf } from '../acp-agent-status';
import { ErrorNotice } from '../ErrorNotice';
import { t } from '../i18n';
import { ProviderIcon } from '../provider-display';
import { type ProviderAccountPool, type ProviderAccountSource, ProviderAccountsList } from '../ProviderAccountsList';
import { record } from '../record-utils';
import { isRemoteHostRenderer } from '../remote-ui-projection';
import { useSection } from '../section-store';
import {
  getUsageDashboardSnapshot,
  refreshUsageDashboard,
  refreshUsageDashboardAfterAuth,
} from '../usage-dashboard-store';
import { SlotProgress } from './built-in-install-progress';
import { ActionButton, ListEmpty } from './capability-controls';
import { invalidateCapabilitySettings, type PanelContext, type RecordValue } from './capability-data';
import { openExternalUrl } from './desktop-bridge';
import { ExtensionAction, ExtensionItemRow, ExtensionNote, type ExtensionItemTone } from './extension-detail';
import { OAuthLoginDialog, pasteErrorText, useOAuthLoginFlow } from './oauth-login-flow';

/** A check, install or update the core is running for the agent. */
const running = (agent: AcpAgentStatus) =>
  agent.state === 'checking' || agent.state === 'installing' || agent.state === 'updating';

const reason = (error: unknown): string =>
  String((error as Error)?.message || error || '') || t('Something went wrong');

/** The agent's state in words: the status pill, its tone and what to do about it. A value the core left out
 *  leaves its sentence, never a blank in one. */
export function acpAgentWords(agent: AcpAgentStatus): { status: string; tone: ExtensionItemTone; description: string } {
  const values = { name: agent.label, command: agent.command, version: agent.version, minimum: agent.minimumVersion };
  switch (agent.state) {
    case 'ready':
      return {
        status: t('Ready'),
        tone: 'ok',
        description: agent.version ? t('Version {{version}}', values) : t('Version not reported'),
      };
    case 'installing':
      return {
        status: t('Installing…'),
        tone: 'muted',
        description: t('Downloading and installing {{name}}.', values),
      };
    case 'updating':
      return {
        status: t('Updating…'),
        tone: 'muted',
        description: t('Updating {{name}} to the newest version.', values),
      };
    case 'notInstalled': {
      let description = t('{{name}} was not found. Install it, then check again.', values);
      if (agent.canInstall) description = t('{{name}} is not installed.', values);
      else if (agent.command)
        description = t('The {{command}} command was not found. Install {{name}}, then check again.', values);
      return { status: t('Not found'), tone: 'warn', description };
    }
    case 'versionUnknown': {
      let description = t('{{name}} did not report its version. Update it, then check again.', values);
      if (agent.canInstall) description = t('{{name}} did not report its version.', values);
      else if (agent.command)
        description = t('{{command}} did not report its version. Update {{name}}, then check again.', values);
      return { status: t('Version unknown'), tone: 'warn', description };
    }
    case 'versionTooOld': {
      let description = agent.version
        ? t('{{name}} {{version}} is too old.', values)
        : t('A newer version of {{name}} is needed.', values);
      if (agent.minimumVersion) {
        description = agent.version
          ? t('{{name}} {{version}} is installed; {{minimum}} or later is needed.', values)
          : t('An older version of {{name}} is installed; {{minimum}} or later is needed.', values);
      }
      return { status: t('Update needed'), tone: 'warn', description };
    }
    case 'signedOut': {
      let description = t('Sign in to {{name}} in a terminal, then check again.', values);
      if (agent.canSignIn) description = t('Sign in to use {{name}} here.', values);
      else if (agent.command) description = t('Run {{command}} in a terminal to sign in, then check again.', values);
      return { status: t('Signed out'), tone: 'warn', description };
    }
    case 'unsupported':
      return {
        status: t('Not supported'),
        tone: 'muted',
        description: t('{{name}} does not run on this computer.', values),
      };
    case 'failed':
      return {
        status: t('Failed'),
        tone: 'danger',
        description: agent.message || t('{{name}} did not start.', values),
      };
    case 'checking':
      return {
        status: t('Checking…'),
        tone: 'muted',
        description: agent.command ? t('Looking for {{command}}…', values) : t('Looking for {{name}}…', values),
      };
    case 'off':
      return {
        status: t('Not checked'),
        tone: 'muted',
        description: t('Not checked yet. Check again to look for it.'),
      };
    default:
      return {
        status: t('Not understood'),
        tone: 'warn',
        description: agent.reportedState
          ? t('This version of Mixdog does not understand the state "{{state}}". Check again, or update Mixdog.', {
              state: agent.reportedState,
            })
          : t('No state was reported for {{name}}. Check again, or update Mixdog.', values),
      };
  }
}

/** The install or update that failed last, said beside the state it left. */
function faultLine(agent: AcpAgentStatus): string {
  if (!agent.lastError) return '';
  const message = { message: agent.lastError.message || t('No reason was given.') };
  return agent.lastError.action === 'install'
    ? t('Install failed: {{message}}', message)
    : t('Update failed: {{message}}', message);
}

/** What each Antigravity preset's sign-in is for, as its step of the agent's one sign-in. */
const SIGN_IN_STEP_TITLES: Readonly<Record<string, () => string>> = {
  'acp-antigravity': () => t('Google sign-in for Gemini models'),
  'acp-antigravity-cli': () => t('Google sign-in for Claude models'),
};

function signInStepTitle(member: AcpAgentStatus): string {
  return SIGN_IN_STEP_TITLES[member.provider]?.() ?? t('Sign in to {{name}}', { name: member.label });
}

/** The one account an agent is signed in with, as a provider's roster: its usage is the usage dashboard's entry of
 *  whichever of its presets reports one, and a refresh reads them again. The agent names no account and keeps no
 *  other, so nothing else of the roster changes. */
function agentAccountSource(providers: readonly string[], plan: string): ProviderAccountSource {
  const [provider] = providers;
  const read = async (): Promise<ProviderAccountPool> => {
    const { dashboard, refreshedAt } = getUsageDashboardSnapshot();
    // Every row, not `usageRows`: the agent's own reading also when a provider's row lists it (`sameQuotaAs`).
    const rows = record(dashboard).rows;
    const row = (Array.isArray(rows) ? rows.map(record) : []).find((entry) => providers.includes(String(entry.id)));
    const windows = (Array.isArray(row?.windows) ? row.windows.map(record) : []).map((window) => ({
      label: String(window.label || ''),
      usedPct: typeof window.usedPct === 'number' ? window.usedPct : null,
      resetAt: typeof window.resetAt === 'number' ? window.resetAt : null,
    }));
    const checkedAt = typeof row?.updatedAt === 'number' ? row.updatedAt : undefined;
    return {
      accounts: [
        {
          id: `${provider}:default`,
          // The agent tells the account's plan and no name: the plan stands where a provider's row says who it is.
          label: plan || t('Account 1'),
          authenticated: true,
          reauthRequired: false,
          // Once the dashboard has answered, an agent it shows no windows for has no reading (the core withdrew it
          // on a sign-out or another sign-in); before that, the last one stays painted.
          usage: windows.length || refreshedAt > 0 ? { windows, checkedAt } : null,
        },
      ],
      selectedId: `${provider}:default`,
      auto: false,
      policy: 'manual',
    };
  };
  return {
    read,
    update: async (change) => {
      if (change.refreshUsage === true) {
        await refreshUsageDashboard(window.mixdogDesktop, { force: true, providers: [...providers] });
      }
      return read();
    },
  };
}

function AcpAgentRow({
  group,
  busy,
  installRequested,
  onInstall,
  signInAfterInstall,
  onSignInAfterInstall,
  onSigningIn,
  run,
  confirm,
}: {
  group: AcpAgentGroup;
  busy: boolean;
  /** The app's install request is still open. */
  installRequested: boolean;
  onInstall(): void;
  /** An install just ended well: the sign-in it leaves to do opens by itself. */
  signInAfterInstall: boolean;
  /** Told once the row has acted on `signInAfterInstall`. */
  onSignInAfterInstall(): void;
  /** Told when the agent's sign-in starts or stops waiting. */
  onSigningIn(id: string, pending: boolean): void;
  run: PanelContext['run'];
  confirm: PanelContext['confirm'];
}) {
  const { agent, members } = group;
  // The one sign-in's steps (the members it walks, in the core's order) and the step under way.
  const [steps, setSteps] = useState<AcpAgentStatus[]>([]);
  const [step, setStep] = useState(0);
  // Counts sign-ins, so a step's flow the core starts after its sign-in was closed is cancelled rather than shown.
  const walk = useRef(0);
  const login = useOAuthLoginFlow({
    run,
    keyId: `acp-${agent.id}`,
    cancelCapability: 'cancelOAuthProviderLogin',
    statusCapability: 'getOAuthProviderLoginStatus',
    statusError: t('Sign-in status could not be checked.'),
    // The core opens no browser for this sign-in: this window opens its page below.
    remote: false,
    // Back closes the whole sign-in, between two steps too.
    dialog: { open: steps.length > 0, close: closeSignIn },
    // A finished sign-in has the core look at the agent again; the row follows its report, and the account's usage
    // is read again without holding the dialog for it.
    refresh: async () => {
      void refreshUsageDashboardAfterAuth(
        window.mixdogDesktop,
        members.map((member) => member.provider)
      );
      return undefined;
    },
    // A completed step hands over to the next in the same dialog; the last one closes it, the row then showing the
    // signed-in account.
    onDone: () => {
      const next = step + 1;
      if (next >= steps.length) {
        closeSignIn();
        return;
      }
      setStep(next);
      begin(steps[next], walk.current);
    },
  });
  function begin(member: AcpAgentStatus, sign: number) {
    void login.start(async () => {
      const started = await run<RecordValue>(
        'beginOAuthProviderLogin',
        [member.provider],
        `acp-sign-in-${member.id}`,
        false,
        false,
        'throw'
      );
      if (walk.current === sign) return started;
      const startedId = String(record(started).flowId || '');
      if (startedId) void run('cancelOAuthProviderLogin', [startedId], `oauth-cancel-acp-${agent.id}`, false);
      return null;
    });
  }
  const { flow } = login;
  const flowId = String(flow?.flowId || '');
  const flowState = String(flow?.state || '');
  const page = String(flow?.url || flow?.manualUrl || '');
  const opened = useRef('');
  const current = steps[step];
  // A core that opens the browser itself does so on its own machine: a window on another one still opens the page.
  const opensItself = current?.loginOpensBrowser === true && !isRemoteHostRenderer();
  useEffect(() => {
    if (opensItself || !flowId || flowState !== 'pending' || !page || opened.current === flowId) return;
    opened.current = flowId;
    openExternalUrl(page);
  }, [opensItself, flowId, flowState, page]);
  // Between two steps no flow is open yet: the dialog waits on the next one.
  let dialogFlow = flow;
  if (!dialogFlow && steps.length) dialogFlow = { state: login.error ? 'failed' : 'pending' };
  const signingIn = Boolean(current) && String(dialogFlow?.state || '') === 'pending';
  useEffect(() => {
    onSigningIn(agent.id, signingIn);
    return () => onSigningIn(agent.id, false);
  }, [agent.id, signingIn, onSigningIn]);
  const words = signingIn
    ? { status: t('Signing in…'), tone: 'muted' as const, description: t('Finish signing in in your browser.') }
    : acpAgentWords(agent);
  const fault = faultLine(agent);
  const name = { name: agent.label };
  const blocked = busy || installRequested || running(agent);
  // One Sign in walks each member that is signed out as a step of one dialog, in the core's order (the official
  // server's browser consent, then the CLI's login); signed in, it signs each in again with another account.
  const signIn = () => {
    const walked = members.filter((member) => member.canSignIn && member.state === agent.state);
    if (!walked.length) return;
    walk.current += 1;
    setSteps(walked);
    setStep(0);
    begin(walked[0], walk.current);
  };
  // Closed or cancelled, the sign-in ends at its step: the steps already completed stay signed in.
  function closeSignIn() {
    walk.current += 1;
    setSteps([]);
    setStep(0);
    login.close();
  }
  // Right after an install, a sign-in it leaves to do opens by itself; any other state it ends in only ends the wait.
  // biome-ignore lint/correctness/useExhaustiveDependencies: it acts when the install's end meets the state the core settles on.
  useEffect(() => {
    if (!signInAfterInstall || running(agent)) return;
    onSignInAfterInstall();
    if (agent.state === 'signedOut' && agent.canSignIn) signIn();
  }, [signInAfterInstall, agent.state, agent.canSignIn]);
  const providers = members.map((member) => member.provider).join(' ');
  const accounts = useMemo(() => agentAccountSource(providers.split(' '), agent.plan), [providers, agent.plan]);
  const signOuts = members.filter((member) => member.canSignOut);
  // Only a CLI that shares its sign-in with its own command outside Mixdog signs that command out too.
  const external = signOuts.find((member) => member.sharesExternalSignIn);
  const disconnect = () =>
    confirm({
      title: t('Disconnect account?'),
      description: external
        ? t(
            'Every {{name}} session running in Mixdog ends now. The {{command}} command outside Mixdog uses the same sign-in, so it is signed out too.',
            { ...name, command: external.command }
          )
        : t('Every {{name}} session running in Mixdog ends now.', name),
      confirmLabel: t('Disconnect'),
      danger: true,
      // Each member signs itself out; the row follows the state the core then reports.
      onConfirm: async () => {
        for (const member of signOuts) {
          await run('forgetProviderAuth', [member.provider], `acp-sign-out-${member.id}`);
        }
      },
    });
  // Only the official server (Gemini) has a platform it does not run on; the CLI's models stay.
  const geminiUnavailable = agent.state !== 'unsupported' && members.some((member) => member.state === 'unsupported');
  let control = null;
  if (agent.state === 'installing' || agent.state === 'updating') {
    control = (
      <SlotProgress
        percent={null}
        label={agent.state === 'installing' ? t('Installing {{name}}…', name) : t('Updating {{name}}…', name)}
      />
    );
  } else if (signingIn) {
    control = null;
  } else if (agent.canInstall && agent.state === 'notInstalled') {
    control = (
      <ExtensionAction disabled={blocked} ariaLabel={t('Install {{name}}', name)} onClick={onInstall}>
        {agent.lastError?.action === 'install' ? t('Retry') : t('Install')}
      </ExtensionAction>
    );
  } else if (agent.canInstall && (agent.state === 'versionTooOld' || agent.state === 'versionUnknown')) {
    control = (
      <ExtensionAction disabled={blocked} ariaLabel={t('Update {{name}}', name)} onClick={onInstall}>
        {agent.lastError?.action === 'update' ? t('Retry') : t('Update')}
      </ExtensionAction>
    );
  } else if (agent.canSignIn && agent.state === 'signedOut') {
    control = (
      <ExtensionAction disabled={blocked} ariaLabel={t('Connect {{name}}', name)} onClick={signIn}>
        {t('Connect')}
      </ExtensionAction>
    );
  }
  // A signed-in agent is the provider account card, with the one account its CLI holds.
  const card = agent.state === 'ready';
  return (
    <>
      {card ? (
        <div data-acp-agent={agent.id} data-acp-state={signingIn ? 'signingIn' : agent.state}>
          <ProviderAccountsList
            provider={agent.provider}
            title={agent.label}
            source={accounts}
            renderActions={() =>
              agent.canSignOut && (
                <ActionButton danger disabled={blocked || signingIn} onClick={disconnect}>
                  {t('Disconnect')}
                </ActionButton>
              )
            }
            headerAction={
              agent.canSignIn && (
                <button
                  type="button"
                  className="provider-account-add-button"
                  disabled={blocked || signingIn}
                  // The agent keeps one account: its own sign-in, run again, puts another in this one's place.
                  aria-label={t('Sign in with another account')}
                  title={t('Sign in with another account. It replaces this one: {{name}} keeps one account.', name)}
                  onClick={signIn}
                >
                  <Plus size={16} aria-hidden="true" />
                </button>
              )
            }
          />
          <ErrorNotice errors={[fault]} />
        </div>
      ) : (
        <ExtensionItemRow
          icon={<ProviderIcon provider={agent.provider} width={16} height={16} />}
          title={agent.label}
          status={words.status}
          tone={words.tone}
          description={words.description}
          fault={fault}
          dataAttributes={{ 'data-acp-agent': agent.id, 'data-acp-state': signingIn ? 'signingIn' : agent.state }}
          control={control}
        />
      )}
      {geminiUnavailable && <ExtensionNote>{t('Gemini is not available on this computer.')}</ExtensionNote>}
      {dialogFlow && (
        <OAuthLoginDialog
          portal
          id={`acp-${agent.id}`}
          closeLabel={t('Close sign-in')}
          flow={dialogFlow}
          error={login.error}
          step={
            current && {
              title: signInStepTitle(current),
              // A single sign-in is no numbered step.
              position:
                steps.length > 1 ? t('Step {{step}} of {{count}}', { step: step + 1, count: steps.length }) : undefined,
            }
          }
          paste={
            flow?.manualCodeSupported === true
              ? {
                  title: t('Code from the sign-in page'),
                  placeholder: t('Paste the code'),
                  ariaLabel: t('Code from the sign-in page'),
                  error: login.pasteError,
                  onSubmit: (code, form) => {
                    form.reset();
                    login.setPasteError('');
                    void run<RecordValue>(
                      'completeOAuthProviderLogin',
                      [flowId, code],
                      `acp-sign-in-code-${agent.id}`,
                      false,
                      false,
                      'throw'
                    )
                      .then((next) => {
                        if (next) login.mergeFlow(record(next));
                      })
                      .catch((reason) => {
                        if (form.isConnected) login.setPasteError(pasteErrorText(reason));
                      });
                  },
                }
              : undefined
          }
          disabled={false}
          onClose={closeSignIn}
        />
      )}
    </>
  );
}

/** Antigravity ACP among the providers: each agent the core reports, its presets as one, with its state, its install,
 *  update and sign-in, and a way to look again. */
export function AcpProviders({
  api,
  data,
  pending,
  run,
  confirm,
}: Pick<PanelContext, 'api' | 'data' | 'pending' | 'run' | 'confirm'>) {
  // The live value over the settings read, as every reader of `toolModules` takes it.
  const live = useSection<RecordValue>('toolModules');
  const value = { ...record(data.toolModules), ...record(live) }.acpAgents;
  const enabled = record(value).enabled === true;
  const busy = Boolean(pending);
  // The install or update: the core fetches every agent's programs and answers at the end, its progress showing as
  // each agent's state. It is sent outside the panel's queued commands, so switching Antigravity ACP off (which ends
  // the install) is not held behind it.
  const [install, setInstall] = useState({ running: false, error: '' });
  // An install that ended well hands the row the sign-in it leaves to do.
  const [signInNext, setSignInNext] = useState(false);
  const on = useRef(false);
  on.current = enabled;
  // A failure belongs to the agents it was about: switching them off ends them, and the failure with them.
  useEffect(() => {
    if (enabled) return;
    setInstall((current) => (current.error ? { ...current, error: '' } : current));
    setSignInNext(false);
  }, [enabled]);
  const onInstall = () => {
    if (install.running || !api.invokeCapability) return;
    setInstall({ running: true, error: '' });
    void Promise.resolve(
      api.invokeCapability<RecordValue>({ capability: 'installBuiltinFeature', args: ['acpAgents'] })
    ).then(
      () => {
        invalidateCapabilitySettings(api, 'installBuiltinFeature');
        setInstall({ running: false, error: '' });
        setSignInNext(on.current);
      },
      // An install ended by switching Antigravity ACP off is no failure to report.
      (error: unknown) => setInstall({ running: false, error: on.current ? reason(error) : '' })
    );
  };
  // Asking for the agents while they are on has the core look at every agent's programs again.
  const onCheckAgain = () => void run('setBuiltinToolEnabled', ['acpAgents', true], 'acp-check-again');
  const groups = acpAgentGroups(value);
  const checking = acpAgentsOf(value).some(running);
  // The core's answer to a failed install is the failure an agent's row already says.
  const said = groups.some(({ agent }) => agent.lastError);
  // A look again would bring a CLI up to date under its own running sign-in.
  const [signingIn, setSigningIn] = useState<ReadonlySet<string>>(() => new Set());
  const noteSignIn = useCallback(
    (id: string, pending: boolean) =>
      setSigningIn((current) => {
        if (current.has(id) === pending) return current;
        const next = new Set(current);
        if (pending) next.add(id);
        else next.delete(id);
        return next;
      }),
    []
  );
  if (!enabled) return null;
  return (
    <section className="settings-group settings-provider-cards" data-acp-agents="true">
      <header>
        <div className="settings-group-head">
          <h3>{t('Antigravity ACP')}</h3>
          <ExtensionAction
            ariaLabel={t('Check again')}
            tooltip={t('Check again')}
            disabled={busy || install.running || checking || signingIn.size > 0}
            onClick={onCheckAgain}
          >
            <RefreshCw size={14} aria-hidden="true" />
          </ExtensionAction>
        </div>
      </header>
      {groups.length ? (
        groups.map((group) => (
          <div className="settings-group-body" key={group.agent.id}>
            <AcpAgentRow
              group={group}
              busy={busy}
              installRequested={install.running}
              onInstall={onInstall}
              signInAfterInstall={signInNext}
              onSignInAfterInstall={() => setSignInNext(false)}
              onSigningIn={noteSignIn}
              run={run}
              confirm={confirm}
            />
          </div>
        ))
      ) : (
        <div className="settings-group-body">
          <ListEmpty text={t('No agents were reported. Check again, or update Mixdog if none appear.')} />
        </div>
      )}
      <ErrorNotice errors={[said ? '' : install.error]} />
    </section>
  );
}
