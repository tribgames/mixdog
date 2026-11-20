import { ChevronDown, ChevronRight, Plug } from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import type { ConnectorCatalogEntry } from '../../shared/core-src/runtime/shared/connector-catalog.mjs';
import {
  cancelConnectorLogin,
  finishConnectorLogin,
  reenableConnector,
  retireConnectorLogin,
  startConnectorLogin,
  useConnectorLogin,
} from '../connector-connect';
import { ConnectorIcon } from '../connector-icon';
import {
  type ConnectorRowStatus,
  type ConnectorRowView,
  connectorIdentity,
  connectorRowView,
} from '../connectors-model';
import { ConnectorStep } from '../connector-step';
import { t } from '../i18n';
import { record } from '../record-utils';
import { SidebarResourceTitle, type SidebarResourceTag } from '../sidebar-resource-row';
import { ExtensionAction } from './extension-detail';
import { mcpErrorSummary, mcpStatus } from './mcp-editor-dialog';
import type { RecordValue as Row } from './capability-data';

/** One single-line list row: the open button (icon, title, then the tag or the
 *  live sign-in step right after the name) and, beside it, the row's one action
 *  (연결 / 취소). The status detail (`line`) is not printed: the narrow rail has
 *  no room for it, so it is the tag's tooltip (the row's, without a tag). */
export function ConnectorRow({
  id,
  icon,
  title,
  tag,
  line,
  step,
  action,
  expanded,
  nested = false,
  status,
  justConnected = false,
  onOpen,
}: {
  id: string;
  icon: ReactNode;
  title: string;
  tag?: SidebarResourceTag | null;
  line?: string;
  step?: ReactNode;
  action?: ReactNode;
  /** A package row: the chevron shows its open state. */
  expanded?: boolean;
  nested?: boolean;
  status?: ConnectorRowStatus;
  justConnected?: boolean;
  onOpen(): void;
}) {
  const Chevron = expanded ? ChevronDown : ChevronRight;
  return (
    <div
      className="connectors-row"
      data-connector-row={id}
      data-nested={nested ? 'true' : undefined}
      data-row-status={status}
      data-just-connected={justConnected ? 'true' : undefined}
    >
      <button
        type="button"
        className="schedules-row utilities-row extensions-row extensions-row-open"
        aria-label={title}
        aria-expanded={expanded}
        title={!tag?.label && line ? line : undefined}
        onClick={onOpen}
      >
        <span className="extensions-row-icon sidebar-resource-icon" aria-hidden="true">
          {icon}
        </span>
        <span className="schedules-row-copy utilities-row-copy">
          <SidebarResourceTitle label={title} tag={tag?.label ? { ...tag, title: line || undefined } : null}>
            {step}
          </SidebarResourceTitle>
        </span>
        {!action && <Chevron className="utilities-row-chevron" size={16} aria-hidden="true" />}
      </button>
      {action ? <span className="connectors-row-action">{action}</span> : null}
    </div>
  );
}

/** The list tag of a configured server (연결됨, 로그인 필요, 실패, 비활성화). */
function serverTag(server: Row | null): SidebarResourceTag | null {
  if (!server) return null;
  const status = mcpStatus(server);
  return { label: status.label, tone: status.tone };
}

const HIGHLIGHT_MS = 2_500;

/** The row's brief "just connected" mark: it starts with the confirmation and
 *  outlives the session that triggered it. */
function useJustConnected(justConnected: boolean): boolean {
  const [on, setOn] = useState(false);
  const timer = useRef(0);
  useEffect(() => {
    if (!justConnected) return;
    setOn(true);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setOn(false), HIGHLIGHT_MS);
  }, [justConnected]);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return on;
}

/** What a server row's actions do: 연결, 다시 인증, 다시 켜기, and the retry
 *  of a failed attempt in its own mode. Null where the row has none. */
interface RowActions {
  connect: (() => void) | null;
  reauth: (() => void) | null;
  reenable: (() => void) | null;
}

export function retryOf(view: ConnectorRowView, actions: RowActions, switchAccount: (() => void) | null) {
  if (view.mode === 'reenable') return actions.reenable;
  if (view.mode === 'reauth') return actions.reauth ?? actions.connect;
  if (view.mode === 'switch') return switchAccount;
  return actions.connect;
}

/**
 * A row's one state (connectorRowView) as its tag, live line and action:
 * pending → spinner + step and 취소 only; connected → 연결됨 (+ account) and
 * 관리; failed → "연결하지 못했습니다 · <reason>" and 다시 시도; turned off →
 * 다시 켜기; expired → 다시 인증; otherwise 연결.
 */
function useRowState({
  server,
  serverName,
  connector = '',
  actions,
  locked,
  onOpen,
}: {
  server: Row | null;
  serverName: string;
  connector?: string;
  actions: RowActions;
  locked: boolean;
  onOpen(): void;
}) {
  const login = useConnectorLogin(serverName, connector);
  const state = connectorRowView(server, login);
  const highlight = useJustConnected(state.justConnected);
  const view = { ...state, justConnected: highlight && state.status === 'connected' };
  const listConnected = server?.connected === true;
  useEffect(() => {
    if (state.finished) finishConnectorLogin(serverName);
    else if (state.justConnected && listConnected) retireConnectorLogin(serverName);
  }, [state.finished, state.justConnected, listConnected, serverName]);
  const button = (label: string, onClick: (() => void) | null) =>
    onClick ? (
      <ExtensionAction disabled={locked} onClick={onClick}>
        {label}
      </ExtensionAction>
    ) : null;
  const identity = connectorIdentity(server);
  switch (view.status) {
    case 'pending':
      return {
        view,
        tag: null,
        line: '',
        step: <ConnectorStep view={view} connector={connector} compact />,
        action: (
          <ExtensionAction onClick={() => cancelConnectorLogin(serverName, connector)}>{t('Cancel')}</ExtensionAction>
        ),
      };
    case 'connected':
      return {
        view,
        tag: { label: t('Connected'), tone: 'ok' as const },
        line: identity,
        action: <ExtensionAction onClick={onOpen}>{t('Manage')}</ExtensionAction>,
      };
    case 'failed':
      return {
        view,
        tag: {
          label: view.reason === 'scopeNotGranted' ? t('More access needed') : t('Failed'),
          tone: 'danger' as const,
        },
        line:
          view.reason === 'scopeNotGranted'
            ? view.error
            : [t("Couldn't connect"), view.error].filter(Boolean).join(' · '),
        action: button(t('Try again'), retryOf(view, actions, null)),
      };
    case 'disabled':
      return {
        view,
        tag: serverTag(server),
        line: server ? mcpReason(server) : '',
        action: button(t('Turn back on'), actions.reenable),
      };
    case 'needs-reauth':
      return {
        view,
        tag: serverTag(server),
        line: t('The sign-in expired or was revoked.'),
        action: button(t('Re-authenticate'), actions.reauth),
      };
    default:
      return {
        view,
        // Never signed in (a sign-in that was started and not finished included): the row reads as any other
        // unconnected one, with 연결 alone.
        tag: view.status === 'needs-connect' ? null : serverTag(server),
        line: server ? mcpReason(server) : '',
        action: button(t('Connect'), actions.connect),
      };
  }
}

export function CatalogRow({
  entry,
  server,
  hasAccounts,
  locked,
  onConnect,
  onOpen,
}: {
  entry: ConnectorCatalogEntry;
  server: Row | null;
  /** The connector has accounts: its detail lists them, each with its own state and connect action. */
  hasAccounts: boolean;
  locked: boolean;
  onConnect(): void;
  onOpen(): void;
}) {
  const name = server ? String(server.name) : '';
  const state = useRowState({
    server,
    serverName: name,
    connector: entry.id,
    // A catalog 연결 always runs the catalog flow (it also makes the server).
    actions: { ...serverActions(server, entry.name, entry.id), connect: onConnect },
    locked,
    onOpen,
  });
  return (
    <ConnectorRow
      id={entry.id}
      icon={<ConnectorIcon id={entry.id} name={entry.name} />}
      title={entry.name}
      tag={state.tag}
      line={state.line}
      step={state.step}
      action={state.action}
      status={state.view.status}
      justConnected={state.view.justConnected}
      // Not connected yet and no account to show: the row itself connects (sign-in,
      // app password or key dialog) instead of opening a detail first. With accounts
      // the detail opens whatever the first one needs, so the others stay reachable.
      onOpen={
        !hasAccounts && (state.view.status === 'idle' || state.view.status === 'needs-connect') ? onConnect : onOpen
      }
    />
  );
}

/** Why a configured server is not working, for the row's tag tooltip. */
export function mcpReason(server: Row): string {
  if (server.enabled === false) {
    return server.disabledReason === 'plugin disabled' ? t('The plugin is turned off.') : '';
  }
  return server.error ? mcpErrorSummary(server.error) : '';
}

/** A configured server's own actions: 다시 켜기 (switched off by the user, not
 *  by its plugin), 다시 인증 (a stored sign-in that expired or was revoked)
 *  and 연결 (an OAuth server never signed in). */
export function serverActions(server: Row | null, label: string, connector = ''): RowActions {
  if (!server) return { connect: null, reauth: null, reenable: null };
  const name = String(server.name);
  const oauth = server.oauth && typeof server.oauth === 'object' ? record(server.oauth) : null;
  return {
    reenable:
      server.enabled === false && server.disabledReason !== 'plugin disabled'
        ? () => void reenableConnector(name, label, connector)
        : null,
    reauth: oauth ? () => void startConnectorLogin(name, label, { mode: 'reauth', connector }) : null,
    connect: oauth && server.connected !== true ? () => void startConnectorLogin(name, label, { connector }) : null,
  };
}

export function CustomServerRow({
  server,
  locked,
  nested,
  onOpen,
}: {
  server: Row;
  locked: boolean;
  nested?: boolean;
  onOpen(): void;
}) {
  const name = String(server.name);
  const state = useRowState({ server, serverName: name, actions: serverActions(server, name), locked, onOpen });
  return (
    <ConnectorRow
      id={name}
      nested={nested}
      icon={<Plug size={16} aria-hidden="true" />}
      title={name}
      tag={state.tag}
      line={state.line}
      step={state.step}
      action={state.action}
      status={state.view.status}
      justConnected={state.view.justConnected}
      onOpen={onOpen}
    />
  );
}
