import { Plus, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { type AcpAgentStatus, acpAgentsOf } from '../acp-agent-status';
import { CapabilityIcon } from '../CapabilityIcon';
import { ErrorNotice } from '../ErrorNotice';
import { t } from '../i18n';
import { type ProviderAccountPool, type ProviderAccountSource, ProviderAccountsList } from '../ProviderAccountsList';
import { record } from '../record-utils';
import {
  getUsageDashboardSnapshot,
  refreshUsageDashboard,
  refreshUsageDashboardAfterAuth,
} from '../usage-dashboard-store';
import { SlotProgress } from './built-in-install-progress';
import { ActionButton } from './capability-controls';
import type { PanelContext, RecordValue } from './capability-data';
import { openExternalUrl } from './desktop-bridge';
import {
  ExtensionAction,
  ExtensionItemList,
  ExtensionItemRow,
  ExtensionNote,
  ExtensionSection,
  type ExtensionItemTone,
} from './extension-detail';
import { OAuthLoginDialog, pasteErrorText, useOAuthLoginFlow } from './oauth-login-flow';

/** A check, install or update the core is running for the agent. */
const running = (agent: AcpAgentStatus) =>
  agent.state === 'checking' || agent.state === 'installing' || agent.state === 'updating';

/** Turned on, and no agent can run a session or is still being looked at. */
export function acpAgentsBlocking(value: unknown): boolean {
  return (
    record(value).enabled === true && acpAgentsOf(value).every((agent) => agent.state !== 'ready' && !running(agent))
  );
}

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
        // A CLI that never answers keeps the check running: turning the feature off is what stops it.
        description: `${agent.command ? t('Looking for {{command}}…', values) : t('Looking for {{name}}…', values)} ${t('To stop, turn Antigravity ACP off.')}`,
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

/** The one account an agent's CLI is signed in with, as a provider's roster: its usage is the usage dashboard's
 *  entry of the agent, and a refresh reads that entry again. The CLI names no account and keeps no other, so
 *  nothing else of the roster changes. */
function agentAccountSource(provider: string, plan: string): ProviderAccountSource {
  const read = async (): Promise<ProviderAccountPool> => {
    const { dashboard, refreshedAt } = getUsageDashboardSnapshot();
    // Every row, not `usageRows`: the agent's own reading also when a provider's row lists it (`sameQuotaAs`).
    const rows = record(dashboard).rows;
    const row = (Array.isArray(rows) ? rows.map(record) : []).find((entry) => entry.id === provider);
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
        await refreshUsageDashboard(window.mixdogDesktop, { force: true, providers: [provider] });
      }
      return read();
    },
  };
}

function AcpAgentRow({
  agent,
  busy,
  installRequested,
  onInstall,
  onSigningIn,
  run,
  confirm,
}: {
  agent: AcpAgentStatus;
  busy: boolean;
  /** The app's install request is still open. */
  installRequested: boolean;
  onInstall(): void;
  /** Told when the agent's sign-in starts or stops waiting. */
  onSigningIn(id: string, pending: boolean): void;
  run: PanelContext['run'];
  confirm: PanelContext['confirm'];
}) {
  const login = useOAuthLoginFlow({
    run,
    keyId: `acp-${agent.id}`,
    cancelCapability: 'cancelOAuthProviderLogin',
    statusCapability: 'getOAuthProviderLoginStatus',
    statusError: t('Sign-in status could not be checked.'),
    // The core opens no browser for this sign-in: this window opens its page below.
    remote: false,
    // A finished sign-in has the core look at the CLI again; the row follows its report, and the account's usage is
    // read again without holding the dialog for it.
    refresh: async () => {
      void refreshUsageDashboardAfterAuth(window.mixdogDesktop, [agent.provider]);
      return undefined;
    },
  });
  const { flow } = login;
  const flowId = String(flow?.flowId || '');
  const flowState = String(flow?.state || '');
  const page = String(flow?.url || flow?.manualUrl || '');
  const opened = useRef('');
  useEffect(() => {
    if (!flowId || flowState !== 'pending' || !page || opened.current === flowId) return;
    opened.current = flowId;
    openExternalUrl(page);
  }, [flowId, flowState, page]);
  const signingIn = flowState === 'pending';
  useEffect(() => {
    onSigningIn(agent.id, signingIn);
    return () => onSigningIn(agent.id, false);
  }, [agent.id, signingIn, onSigningIn]);
  const words = signingIn
    ? { status: t('Signing in…'), tone: 'muted' as const, description: t('Finish signing in in your browser.') }
    : acpAgentWords(agent);
  const fault =
    faultLine(agent) || (!flow && login.error ? t('Sign-in failed: {{message}}', { message: login.error }) : '');
  const name = { name: agent.label };
  const blocked = busy || installRequested || running(agent);
  const signIn = () =>
    void login.start(() =>
      run<RecordValue>('beginOAuthProviderLogin', [agent.provider], `acp-sign-in-${agent.id}`, false, false, 'throw')
    );
  const accounts = useMemo(() => agentAccountSource(agent.provider, agent.plan), [agent.provider, agent.plan]);
  const disconnect = () =>
    confirm({
      title: t('Disconnect account?'),
      description: t(
        'Every {{name}} session running in Mixdog ends now. The {{command}} command outside Mixdog uses the same sign-in, so it is signed out too.',
        { ...name, command: agent.command }
      ),
      confirmLabel: t('Disconnect'),
      danger: true,
      // The agent signs itself out; its row follows the state the core then reports.
      onConfirm: async () => {
        await run('forgetProviderAuth', [agent.provider], `acp-sign-out-${agent.id}`);
      },
    });
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
      <ExtensionAction disabled={blocked} ariaLabel={t('Sign in to {{name}}', name)} onClick={signIn}>
        {t('Sign in')}
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
                  // The CLI keeps one account: its own sign-in, run again, puts another in this one's place.
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
          icon={<CapabilityIcon kind="builtin" name="acpAgents" size={16} />}
          title={agent.label}
          status={words.status}
          tone={words.tone}
          description={words.description}
          fault={fault}
          dataAttributes={{ 'data-acp-agent': agent.id, 'data-acp-state': signingIn ? 'signingIn' : agent.state }}
          control={control}
        />
      )}
      {flow && (
        <OAuthLoginDialog
          portal
          id={`acp-${agent.id}`}
          closeLabel={t('Close sign-in')}
          flow={flow}
          error={login.error}
          paste={
            flow.manualCodeSupported === true
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
                      [flow.flowId, code],
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
          onClose={login.close}
        />
      )}
    </>
  );
}

/** Each agent the core reports with the state of its CLI, its install, update and sign-in, and a way to look
 *  again. */
export function AcpAgentsSection({
  value,
  busy,
  installRequested,
  error,
  onCheckAgain,
  onInstall,
  run,
  confirm,
}: {
  confirm: PanelContext['confirm'];
  /** The settings value's `acpAgents`. */
  value: unknown;
  busy: boolean;
  installRequested: boolean;
  /** The install request's own failure, shown when no agent's `lastError` already says it. */
  error: string;
  onCheckAgain(): void;
  onInstall(): void;
  run: PanelContext['run'];
}) {
  const agents = acpAgentsOf(value);
  const checking = agents.some(running);
  // The core's answer to a failed install is the failure an agent's row already says.
  const said = agents.some((agent) => agent.lastError);
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
  return (
    <ExtensionSection
      title={t('Agents')}
      dataAttributes={{ 'data-acp-agents': 'true' }}
      action={
        <ExtensionAction
          ariaLabel={t('Check again')}
          tooltip={t('Check again')}
          disabled={busy || installRequested || checking || signingIn.size > 0}
          onClick={onCheckAgain}
        >
          <RefreshCw size={14} aria-hidden="true" />
        </ExtensionAction>
      }
    >
      {agents.length ? (
        <ExtensionItemList>
          {agents.map((agent) => (
            <AcpAgentRow
              key={agent.id}
              agent={agent}
              busy={busy}
              installRequested={installRequested}
              onInstall={onInstall}
              onSigningIn={noteSignIn}
              run={run}
              confirm={confirm}
            />
          ))}
        </ExtensionItemList>
      ) : (
        <ExtensionNote>{t('No agents were reported. Check again, or update Mixdog if none appear.')}</ExtensionNote>
      )}
      <ErrorNotice errors={[said ? '' : error]} />
    </ExtensionSection>
  );
}
