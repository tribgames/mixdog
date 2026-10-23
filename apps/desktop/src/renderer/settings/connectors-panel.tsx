// Extensions → 커넥터 (design/mockups/connectors): the catalog ("커넥터",
// alphabetical, one-click 연결) and "커스텀 커넥터" (raw MCP servers, plugins
// that bring MCP as expandable packages, and "커스텀 커넥터 추가"). Rows read
// the host's MCP and plugin status as they are; nothing is renamed or merged.
import { Blocks, ChevronDown, ChevronRight, Plug, Plus } from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import {
  type ConnectorCatalogEntry,
  connectorMultiAccount,
  GMAIL_APP_PASSWORD,
} from '../../../../../src/runtime/shared/connector-catalog.mjs';
import {
  announceConnectorsChanged,
  appPasswordAccount,
  cancelConnectorLogin,
  CONNECTORS_CHANGED_EVENT,
  connectCatalogConnector,
  disconnectConnector,
  finishConnectorLogin,
  gmailAppPasswordErrorText,
  invoke as invokeCapability,
  readMcpServers,
  reenableConnector,
  retireConnectorLogin,
  startConnectorLogin,
  useConnectorLogin,
} from '../connector-connect';
import { RowOverflowMenu } from '../RowOverflowMenu';
import { ConnectorIcon } from '../connector-icon';
import { ConnectorLoginDialogs } from '../connector-login-dialogs';
import { connectorCanDo } from '../connectors-copy';
import {
  type ConnectorRowStatus,
  type ConnectorRowView,
  type ConnectorSourceKind,
  connectorIdentity,
  connectorRowView,
  detectConnectorSource,
  groupConnectors,
  uniqueServerName,
} from '../connectors-model';
import { errorMessage } from '../editor-pane-session-errors';
import { applyGoogleOwnKey, parseGoogleClientJson, revertGoogleOwnKey, usesGoogleOwnKey } from '../google-own-key';
import { ErrorNotice } from '../ErrorNotice';
import { ConnectorStep } from '../connector-step';
import { t } from '../i18n';
import { showDesktopToast } from '../notifications';
import { record } from '../record-utils';
import { useRemoteHostOpenAccess } from '../remote-host-access';
import { SidebarLoadingDialog } from '../sidebar-dialog';
import { SidebarResourceTitle, type SidebarResourceTag } from '../sidebar-resource-row';
import { Group, ListEmpty } from './capability-controls';
import { label, rows, sectionLoaded, type PanelContext, type RecordValue } from './capability-data';
import {
  ExtensionAction,
  ExtensionDetailDialog,
  ExtensionField,
  ExtensionItemList,
  ExtensionItemRow,
  ExtensionNote,
  ExtensionSection,
} from './extension-detail';
import {
  McpEditorDialog,
  mcpErrorSummary,
  mcpRowDescription,
  mcpStatus,
} from './mcp-editor-dialog';
import { PluginInfo } from './plugin-info';
import { capabilityBlockedRemotely, manageOnHostNote } from './remote-capability-guard';

type Row = RecordValue;

const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '');

/** One list row: the open button (icon, title, tag, optional line) and,
 *  beside it, the row's one action (연결 / 취소). */
function ConnectorRow({
  id,
  icon,
  title,
  tag,
  line,
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
  line?: ReactNode;
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
        onClick={onOpen}
      >
        <span className="extensions-row-icon sidebar-resource-icon" aria-hidden="true">
          {icon}
        </span>
        <span className="schedules-row-copy utilities-row-copy">
          <SidebarResourceTitle label={title} />
          {/* One status line: the badge first, then the text. */}
          {tag?.label || line ? (
            <small title={typeof line === 'string' ? [tag?.label, line].filter(Boolean).join(' · ') : undefined}>
              {tag?.label ? (
                <span className="sidebar-resource-tag" data-tone={tag.tone || 'muted'}>
                  {tag.label}
                </span>
              ) : null}
              {line ? <span className="connectors-row-line">{line}</span> : null}
            </small>
          ) : null}
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

function retryOf(view: ConnectorRowView, actions: RowActions, switchAccount: (() => void) | null) {
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
        line: <ConnectorStep view={view} connector={connector} compact />,
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
        // A short chip; the line says what happened and why.
        tag: { label: t('Failed'), tone: 'danger' as const },
        // A sign-in Google granted without the access: the row's instruction
        // is the short form, shown whole; the full sentence is its tooltip.
        line:
          view.reason === 'scopeNotGranted' ? (
            <span className="connectors-row-scope" title={view.error}>
              {t('More access needed')}
            </span>
          ) : (
            [t("Couldn't connect"), view.error].filter(Boolean).join(' · ')
          ),
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
        tag: serverTag(server),
        line: server ? mcpReason(server) : '',
        action: button(t('Connect'), actions.connect),
      };
  }
}

function CatalogRow({
  entry,
  server,
  locked,
  onConnect,
  onOpen,
}: {
  entry: ConnectorCatalogEntry;
  server: Row | null;
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
      action={state.action}
      status={state.view.status}
      justConnected={state.view.justConnected}
      // Not connected yet: the row itself connects (sign-in, app password or key
      // dialog) instead of opening a detail first.
      onOpen={state.view.status === 'idle' || state.view.status === 'needs-connect' ? onConnect : onOpen}
    />
  );
}

/** Why a configured server is not working, for the row's second line. */
function mcpReason(server: Row): string {
  if (server.enabled === false) {
    return server.disabledReason === 'plugin disabled' ? t('The plugin is turned off.') : '';
  }
  return server.error ? mcpErrorSummary(server.error) : '';
}

/** A configured server's own actions: 다시 켜기 (switched off by the user, not
 *  by its plugin), 다시 인증 (a stored sign-in that expired or was revoked)
 *  and 연결 (an OAuth server never signed in). */
function serverActions(server: Row | null, label: string, connector = ''): RowActions {
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

function CustomServerRow({
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
      action={state.action}
      status={state.view.status}
      justConnected={state.view.justConnected}
      onOpen={onOpen}
    />
  );
}

function toolRows(server: Row | null): Row[] {
  // Live tool names carry the `mcp__<server>__` routing prefix.
  const prefix = `mcp__${String(server?.name || '')}__`;
  return (Array.isArray(server?.tools) ? server.tools : []).map((tool) => {
    const row = typeof tool === 'string' ? { name: tool } : record(tool);
    const name = String(row.name || '');
    return { ...row, name: name.startsWith(prefix) ? name.slice(prefix.length) : name };
  });
}

/** "읽기 N개 · 쓰기 M개" from the tools' read-only hints. */
function toolSummary(tools: Row[]): string | undefined {
  // Only servers whose live tools keep their hints can be split honestly.
  if (!tools.some((tool) => tool.annotations && typeof tool.annotations === 'object')) return undefined;
  const reads = tools.filter((tool) => record(tool.annotations).readOnlyHint === true).length;
  return t('{{reads}} read · {{writes}} write', { reads, writes: tools.length - reads });
}

function accountLine(entry: ConnectorCatalogEntry | null, server: Row): string {
  if (appPasswordAccount(server)) return t('Connected with an app password');
  if (entry?.backend.kind === 'oauth') {
    let host = entry.backend.url;
    try {
      host = new URL(entry.backend.url).host;
    } catch {
      /* the url as written */
    }
    return t('Signed in at {{host}}', { host });
  }
  if (entry?.backend.kind === 'apiKey') return t('Connected with your key');
  if (record(server.oauth).signedIn === true) return t('Signed in with OAuth');
  return mcpRowDescription(server);
}

type DetailTarget = { kind: 'catalog'; id: string } | { kind: 'server'; name: string } | { kind: 'plugin'; id: string };

/** One account of a catalog connector: its address (or server name), its own
 *  state, and one ⋯ menu with its 앱 비밀번호 바꾸기 / 계정 전환 / 로그아웃 /
 *  연결 해제 (and 다시 인증 beside it when the account needs it). */
function AccountRow({
  entry,
  server,
  busy,
  locked,
  onDisconnect,
  onChangePassword,
  onSwitch,
  onSignOut,
}: {
  entry: ConnectorCatalogEntry;
  server: Row;
  busy: boolean;
  locked: boolean;
  onDisconnect(): void;
  onChangePassword: (() => void) | null;
  onSwitch: (() => void) | null;
  onSignOut: (() => void) | null;
}) {
  const name = String(server.name);
  const title = entry?.name ?? name;
  const login = useConnectorLogin(name);
  const view = connectorRowView(server, login);
  const actions = serverActions(server, title, entry?.id ?? '');
  const status = mcpStatus(server);
  const retry = view.status === 'failed' ? retryOf(view, actions, null) : null;
  const fix = view.status === 'needs-reauth' ? actions.reauth : view.status === 'disabled' ? actions.reenable : retry;
  const signedIn = record(server.oauth).signedIn === true;
  const identity = connectorIdentity(server) || (signedIn ? t("Account information isn't available") : name);
  const description =
    view.status === 'pending'
      ? t('Connecting…')
      : view.status === 'failed'
        ? view.error
        : view.status === 'connected'
          ? accountLine(entry, server)
          : status.label;
  const items = [
    ...(onChangePassword
      ? [{ id: 'change-password', label: t('Change app password'), onSelect: onChangePassword }]
      : []),
    ...(onSwitch ? [{ id: 'switch', label: t('Switch account'), onSelect: onSwitch }] : []),
    ...(onSignOut ? [{ id: 'sign-out', label: t('Sign out'), onSelect: onSignOut }] : []),
    { id: 'disconnect', label: t('Disconnect'), danger: true, onSelect: onDisconnect },
  ].map((item) => ({ ...item, disabled: busy || locked }));
  return (
    <ExtensionItemRow
      icon={<ConnectorIcon id={entry.id} name={entry.name} />}
      title={identity}
      description={description}
      tone={view.status === 'connected' ? 'ok' : undefined}
      control={
        <>
          {fix && (
            <ExtensionAction disabled={busy || locked} onClick={fix}>
              {view.status === 'needs-reauth'
                ? t('Re-authenticate')
                : view.status === 'disabled'
                  ? t('Turn back on')
                  : t('Try again')}
            </ExtensionAction>
          )}
          <RowOverflowMenu label={identity} items={items} />
        </>
      }
    />
  );
}

/** One connector's card. Before connecting: what it can do and 연결. After:
 *  the account, what it can do, 더 보기 (tools) and 연결 해제. A plugin's
 *  connection also offers 플러그인 삭제… (its own impact dialog). */
function ConnectorDetail({
  entry,
  server,
  busy,
  locked,
  run,
  onConnect,
  onDisconnect,
  onAdvanced,
  onRemovePlugin,
  onAppPassword = null,
  accounts = [],
  onAddAccount = null,
  onDisconnectAccount = null,
  onClose,
}: {
  entry: ConnectorCatalogEntry | null;
  server: Row | null;
  /** Every connected account of a multi-account connector (first = `server`). */
  accounts?: Row[];
  /** 다른 계정 추가 (Gmail, Calendar, Drive). */
  onAddAccount?: (() => void) | null;
  onDisconnectAccount?: ((server: Row) => void) | null;
  busy: boolean;
  locked: boolean;
  run: PanelContext['run'];
  onConnect: (() => void) | null;
  onDisconnect(): void;
  onAdvanced: (() => void) | null;
  onRemovePlugin: (() => void) | null;
  /** Gmail: 앱 비밀번호로 연결 beside the Google sign-in. */
  onAppPassword?: ((server: Row | null) => void) | null;
  onClose(): void;
}) {
  const [more, setMore] = useState(false);
  // Every catalog connector shares one frame: its accounts list as rows with a ⋯ menu.
  const gmail = entry?.id === 'gmail';
  const framed = Boolean(entry);
  const framedAccounts = accounts.length ? accounts : server ? [server] : [];
  const several = accounts.length > 1;
  const name = server ? String(server.name) : '';
  const title = entry?.name ?? name;
  const login = useConnectorLogin(name, entry?.id ?? '');
  // The same one state as the row: never 연결됨 beside a pending step.
  const view = connectorRowView(server, login);
  const connected = view.status === 'connected';
  const pending = view.status === 'pending';
  // A configured, switched-on server can be disconnected even while it fails.
  const disconnectable = Boolean(server) && server?.enabled !== false && !several && !framed;
  // "+ 계정 추가": Gmail adds by app password, Calendar and Drive by sign-in.
  const addAccount = gmail ? (onAppPassword ? () => onAppPassword(null) : null) : onAddAccount;
  const status = server ? mcpStatus(server) : null;
  const canDo = entry ? connectorCanDo(entry.id) : [];
  const tools = toolRows(server);
  const oauth = record(server?.oauth);
  const signedIn = oauth.signedIn === true;
  const actions = serverActions(server, title, entry?.id ?? '');
  const switchAccount = signedIn
    ? () => void startConnectorLogin(name, title, { mode: 'switch', connector: entry?.id ?? '' })
    : null;
  const reason = view.status === 'failed' ? view.error : server && !connected && !pending ? mcpReason(server) : '';
  const headerAction = pending ? (
    <ExtensionAction onClick={() => cancelConnectorLogin(name, entry?.id ?? '')}>{t('Cancel')}</ExtensionAction>
  ) : view.status === 'failed' ? (
    retryOf(view, { ...actions, connect: onConnect ?? actions.connect }, switchAccount) && (
      <ExtensionAction
        disabled={busy || locked}
        onClick={retryOf(view, { ...actions, connect: onConnect ?? actions.connect }, switchAccount) ?? undefined}
      >
        {t('Try again')}
      </ExtensionAction>
    )
  ) : view.status === 'disabled' && actions.reenable ? (
    <ExtensionAction disabled={busy || locked} onClick={actions.reenable}>
      {t('Turn back on')}
    </ExtensionAction>
  ) : view.status === 'needs-reauth' && actions.reauth ? (
    <ExtensionAction disabled={busy || locked} onClick={actions.reauth}>
      {t('Re-authenticate')}
    </ExtensionAction>
  ) : !connected && onConnect ? (
    <ExtensionAction disabled={busy || locked} onClick={onConnect}>
      {t('Connect')}
    </ExtensionAction>
  ) : null;
  const foldTools =
    connected && tools.length > 0 ? (
      <button
        type="button"
        className={framed ? 'connectors-fold' : 'connectors-link'}
        aria-expanded={more}
        onClick={() => setMore(!more)}
      >
        {framed ? t('{{count}} tools', { count: tools.length }) : t('Show more')}
        {more ? <ChevronDown size={12} aria-hidden="true" /> : <ChevronRight size={12} aria-hidden="true" />}
      </button>
    ) : null;
  return (
    <ExtensionDetailDialog
      width={connected ? 'detail' : 'compact'}
      className="connectors-detail-dialog"
      titleId="connectors-detail-title"
      icon={
        entry ? (
          <ConnectorIcon id={entry.id} name={entry.name} className="connector-tile-dialog" />
        ) : (
          <Plug size={16} aria-hidden="true" />
        )
      }
      title={title}
      titleStatus={
        connected
          ? { label: t('Connected'), tone: 'ok' }
          : pending
            ? undefined
            : view.status === 'failed'
              ? { label: t("Couldn't connect"), tone: 'danger' }
              : status && server?.enabled !== false
                ? { label: status.label, tone: status.tone }
                : { label: t('Not connected yet'), tone: 'muted' }
      }
      headerControl={headerAction || null}
      footer={
        disconnectable || onRemovePlugin || onAdvanced ? (
          <>
            {onAdvanced && (
              <button type="button" className="connectors-footer-advanced" onClick={onAdvanced}>
                {t('Advanced settings')}
              </button>
            )}
            {disconnectable && (
              <button type="button" className="danger" disabled={busy || locked} onClick={onDisconnect}>
                {t('Disconnect')}
              </button>
            )}
            {onRemovePlugin && (
              <button type="button" className="secondary" disabled={busy || locked} onClick={onRemovePlugin}>
                {t('Remove plugin…')}
              </button>
            )}
            <button type="button" className="secondary" onClick={onClose}>
              {t('Close')}
            </button>
          </>
        ) : undefined
      }
      onClose={onClose}
    >
      {pending && (
        <ExtensionNote>
          <ConnectorStep view={view} connector={entry?.id ?? ''} />
        </ExtensionNote>
      )}
      {reason && <ExtensionNote tone="danger">{reason}</ExtensionNote>}
      {framed && entry && framedAccounts.length > 0 && (
        <ExtensionSection
          title={t('Account')}
          action={
            addAccount ? (
              <ExtensionAction disabled={busy || locked || pending} onClick={addAccount}>
                + {t('Add account')}
              </ExtensionAction>
            ) : undefined
          }
        >
          <ExtensionItemList>
            {framedAccounts.map((account) => {
              const accountName = String(account.name);
              const accountSignedIn = record(account.oauth).signedIn === true;
              return (
                <AccountRow
                  key={accountName}
                  entry={entry}
                  server={account}
                  busy={busy}
                  locked={locked}
                  onDisconnect={() => onDisconnectAccount?.(account)}
                  onChangePassword={onAppPassword && appPasswordAccount(account) ? () => onAppPassword(account) : null}
                  onSwitch={
                    accountSignedIn
                      ? () => void startConnectorLogin(accountName, title, { mode: 'switch', connector: entry.id })
                      : null
                  }
                  onSignOut={
                    // Signing out forgets the sign-in; it never switches the server off.
                    accountSignedIn
                      ? () =>
                          void run('signOutMcpServer', [accountName], `mcp-oauth-signout-${accountName}`).then(
                            announceConnectorsChanged
                          )
                      : null
                  }
                />
              );
            })}
          </ExtensionItemList>
          {signedIn && !several && oauth.forcedAccountChoice !== true && (
            <p className="connectors-hint">
              {t(
                '{{name}} has no documented way to ask for another account. To switch, sign out or change accounts on the {{name}} website first, then use Switch account.',
                { name: title }
              )}
            </p>
          )}
        </ExtensionSection>
      )}
      {canDo.length > 0 && (
        <ExtensionSection title={t('What it can do')}>
          <ul className="connectors-can-do">
            {canDo.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          {framed && foldTools}
        </ExtensionSection>
      )}
      {!(framed && canDo.length > 0) && foldTools}
      {more && connected && (
        <ExtensionSection title={t('Tools')} count={tools.length} description={toolSummary(tools)}>
          <ExtensionItemList>
            {tools.map((tool) => (
              <ExtensionItemRow
                key={String(tool.name)}
                title={String(tool.name)}
                description={text(tool.description).split('\n')[0]}
              />
            ))}
          </ExtensionItemList>
        </ExtensionSection>
      )}
    </ExtensionDetailDialog>
  );
}

const openLink = (url: string) => void window.mixdogDesktop?.openExternal?.(url).catch(() => undefined);

/** "내 Google 키 사용": the user's own Google OAuth client; with it Google
 *  Calendar and Drive appear in the list. The downloaded client_secret_*.json
 *  is picked or pasted. */
function GoogleOwnKeyDialog({ active, onClose }: { active: boolean; onClose(): void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [pasted, setPasted] = useState('');
  const finish = (work: () => Promise<void>, done: string) => {
    setBusy(true);
    setError('');
    work()
      .then(() => {
        announceConnectorsChanged();
        showDesktopToast(done, 'success');
        onClose();
      })
      .catch((reason) => setError(t(errorMessage(reason))))
      .finally(() => setBusy(false));
  };
  const apply = (source: string) =>
    finish(
      async () => applyGoogleOwnKey(invokeCapability, parseGoogleClientJson(source)),
      t('Your Google key is in use.')
    );
  return (
    <ExtensionDetailDialog
      width="compact"
      className="connectors-key-dialog"
      titleId="connectors-google-key-title"
      title={t('Use my Google key')}
      onClose={onClose}
      onSubmit={(event) => {
        event.preventDefault();
        if (pasted.trim()) apply(pasted);
      }}
      footer={
        <>
          {error && <ErrorNotice error={error} />}
          {active && (
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() => finish(() => revertGoogleOwnKey(invokeCapability), t('Back to the Mixdog key.'))}
            >
              {t('Switch back to the Mixdog key')}
            </button>
          )}
          <button type="button" className="secondary" disabled={busy} onClick={onClose}>
            {t('Cancel')}
          </button>
          <button type="submit" disabled={busy || !pasted.trim()}>
            {t('Apply')}
          </button>
        </>
      }
    >
      <ol className="connectors-can-do">
        <li>{t('Create a Google Cloud project and enable the Calendar and Drive APIs.')}</li>
        <li>
          {t('Create an OAuth client of type "Desktop app".')}{' '}
          <button
            type="button"
            className="connectors-link"
            onClick={() => openLink('https://console.cloud.google.com/apis/credentials')}
          >
            {t('Open Credentials')} ↗
          </button>
        </li>
        <li>
          {t('Add yourself as a test user.')}{' '}
          <button
            type="button"
            className="connectors-link"
            onClick={() => openLink('https://console.cloud.google.com/auth/audience')}
          >
            {t('Open Audience')} ↗
          </button>
        </li>
        <li>
          {t(
            "Optional: to avoid signing in again every week, press 'Publish app' on the Audience page. It is only for you, so no review is needed; at sign-in, press Advanced → Continue on the 'unverified app' screen."
          )}{' '}
          <button
            type="button"
            className="connectors-link"
            onClick={() => openLink('https://console.cloud.google.com/auth/audience')}
          >
            {t('Open Audience')} ↗
          </button>
        </li>
        <li>{t('Pick the downloaded client_secret_*.json file.')}</li>
      </ol>
      <ExtensionField label={t('Client file')}>
        <input
          type="file"
          accept=".json,application/json"
          disabled={busy}
          onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            event.currentTarget.value = '';
            if (file) void file.text().then(apply, (reason) => setError(errorMessage(reason)));
          }}
        />
      </ExtensionField>
      <ExtensionField label={t('Or paste the JSON')}>
        <textarea
          rows={3}
          value={pasted}
          onChange={(event) => setPasted(event.currentTarget.value)}
          autoComplete="off"
          spellCheck={false}
          disabled={busy}
        />
      </ExtensionField>
    </ExtensionDetailDialog>
  );
}

/** API-key services: one field and where to get the key. */
function ConnectorKeySheet({ entry, onClose }: { entry: ConnectorCatalogEntry; onClose(): void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const backend = entry.backend.kind === 'apiKey' ? entry.backend : null;
  const connectionString = Boolean(backend?.env?.includes('CONNECTION_STRING'));
  return (
    <ExtensionDetailDialog
      width="compact"
      className="connectors-key-dialog"
      titleId="connectors-key-title"
      icon={<ConnectorIcon id={entry.id} name={entry.name} className="connector-tile-dialog" />}
      title={t('Connect {{name}}', { name: entry.name })}
      onClose={onClose}
      onSubmit={(event) => {
        event.preventDefault();
        const key = String(new FormData(event.currentTarget).get('connector-key') || '').trim();
        if (!key) return;
        setBusy(true);
        setError('');
        connectCatalogConnector(entry, key)
          .then(onClose)
          .catch((reason) => setError(errorMessage(reason)))
          .finally(() => setBusy(false));
      }}
      footer={
        <>
          {error && <ErrorNotice error={error} />}
          <button type="button" className="secondary" disabled={busy} onClick={onClose}>
            {t('Cancel')}
          </button>
          <button type="submit" disabled={busy}>
            {t('Connect')}
          </button>
        </>
      }
    >
      <ExtensionField label={connectionString ? t('Connection string') : t('API key')}>
        <input
          name="connector-key"
          type={connectionString ? 'text' : 'password'}
          placeholder={backend?.placeholder}
          autoComplete="off"
          spellCheck={false}
          required
          // biome-ignore lint/a11y/noAutofocus: the sheet's only field takes focus on open.
          autoFocus
          disabled={busy}
        />
      </ExtensionField>
      <p className="connectors-hint">
        {t('This service needs a key instead of a sign-in.')}{' '}
        {backend?.keyUrl && (
          <button
            type="button"
            className="connectors-link"
            onClick={() => void window.mixdogDesktop?.openExternal?.(backend.keyUrl).catch(() => undefined)}
          >
            {t('Where to get a key')} ↗
          </button>
        )}
      </p>
    </ExtensionDetailDialog>
  );
}

/** Gmail with a Google app password (IMAP/SMTP) instead of the Google
 *  sign-in. The host checks the password with Gmail before anything is saved
 *  and keeps it in the keychain; the field is read once on submit and
 *  emptied after a failure, never held in React state. */
function GmailAppPasswordDialog({
  entry,
  account,
  target,
  onClose,
}: {
  entry: ConnectorCatalogEntry;
  account: string;
  /** The server to reconnect; `{ add: true }` makes one more account. */
  target: { server?: string; add?: boolean };
  onClose(): void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // Opening the dialog opens Google's app-password page in the default browser.
  useEffect(() => {
    openLink(GMAIL_APP_PASSWORD.helpUrl);
  }, []);
  return (
    <ExtensionDetailDialog
      width="compact"
      className="connectors-key-dialog"
      titleId="connectors-gmail-app-password-title"
      icon={<ConnectorIcon id={entry.id} name={entry.name} className="connector-tile-dialog" />}
      title={t('Connect Gmail with an app password')}
      onClose={onClose}
      onSubmit={(event) => {
        event.preventDefault();
        const form = event.currentTarget;
        const field = form.elements.namedItem('gmail-app-password') as HTMLInputElement | null;
        const email = (form.elements.namedItem('gmail-address') as HTMLInputElement | null)?.value ?? '';
        const password = field?.value ?? '';
        setBusy(true);
        setError('');
        connectCatalogConnector(entry, '', { email, password }, target)
          .then(onClose)
          .catch((reason) => {
            if (field) field.value = '';
            setError(gmailAppPasswordErrorText(reason));
          })
          .finally(() => setBusy(false));
      }}
      footer={
        <>
          {error && <ErrorNotice error={error} />}
          <button type="button" className="secondary" disabled={busy} onClick={onClose}>
            {t('Cancel')}
          </button>
          <button type="submit" disabled={busy}>
            {t('Connect')}
          </button>
        </>
      }
    >
      <ExtensionNote>{t('The Google app password page was opened in your browser.')}</ExtensionNote>
      <ol className="connectors-steps">
        <li>
          <div className="connectors-step-body">
            <b>{t('Create an app password at Google')}</b>
            <p className="connectors-hint">
              {t('Enter "Mixdog" as the app name and press Create. 2-Step Verification must be on.')}
            </p>
            <ExtensionAction onClick={() => openLink(GMAIL_APP_PASSWORD.helpUrl)}>
              {t('Open the app password page')} ↗
            </ExtensionAction>
          </div>
        </li>
        <li>
          <div className="connectors-step-body">
            <b>{t('Paste the address and the 16 characters')}</b>
            <ExtensionField label={t('Gmail address')}>
              <input
                name="gmail-address"
                type="email"
                defaultValue={account}
                placeholder="name@gmail.com"
                autoComplete="username"
                spellCheck={false}
                required
                // biome-ignore lint/a11y/noAutofocus: the dialog's first field takes focus on open.
                autoFocus
                disabled={busy}
              />
            </ExtensionField>
            <ExtensionField label={t('App password')}>
              <input
                name="gmail-app-password"
                type="password"
                placeholder="xxxx xxxx xxxx xxxx"
                autoComplete="off"
                spellCheck={false}
                required
                disabled={busy}
              />
            </ExtensionField>
          </div>
        </li>
      </ol>
    </ExtensionDetailDialog>
  );
}

const KIND_LABEL: Record<ConnectorSourceKind, () => string> = {
  'mcp-url': () => t('Remote MCP server'),
  'mcp-command': () => t('Program on this computer'),
  plugin: () => t('Plugin'),
};

/** "커스텀 커넥터 추가": one field. The paste is detected (never run), a light
 *  choice settles an ambiguous one, and 고급 opens the structured editor. */
function CustomConnectorDialog({
  taken,
  run,
  onAdvanced,
  onGoogleKey,
  onClose,
}: {
  taken: string[];
  run: PanelContext['run'];
  onAdvanced(): void;
  onGoogleKey(): void;
  onClose(): void;
}) {
  const [value, setValue] = useState('');
  const [choice, setChoice] = useState<ConnectorSourceKind | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const detected = detectConnectorSource(value);
  const options = detected ? [detected.kind, ...detected.alternatives] : [];
  const kind = detected ? (choice && options.includes(choice) ? choice : detected.kind) : null;
  const note =
    kind === 'mcp-url'
      ? t('A remote MCP server. If it needs a sign-in, you are guided right after.')
      : kind === 'mcp-command'
        ? t('An MCP server that runs on this computer.')
        : kind === 'plugin'
          ? t('A plugin. Mixdog installs it and lists its connections.')
          : '';
  const submit = async () => {
    if (!detected || !kind) return;
    setBusy(true);
    setError('');
    try {
      if (kind === 'plugin') {
        await run('addPlugin', [detected.source ?? value.trim()], 'addPlugin', true, false, 'throw');
        onClose();
        return;
      }
      const name = uniqueServerName(detected.name, taken);
      const input =
        kind === 'mcp-url'
          ? { name, type: 'http', url: detected.url }
          : { name, type: 'stdio', command: detected.command, args: detected.args ?? [] };
      await run('addMcpServer', [input], 'addMcpServer', true, false, 'throw');
      onClose();
      const row = (await readMcpServers()).find((server) => server.name === name);
      announceConnectorsChanged();
      if (row?.authRequired === true) await startConnectorLogin(name, name);
      else if (row?.connected === true) showDesktopToast(t('Connected to {{name}}', { name }), 'success');
      else if (row?.error) showDesktopToast(mcpErrorSummary(row.error), 'error');
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  };
  return (
    <ExtensionDetailDialog
      width="compact"
      className="connectors-add-dialog"
      titleId="connectors-add-title"
      icon={<Blocks size={16} aria-hidden="true" />}
      title={t('Add custom connector')}
      onClose={onClose}
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
      footer={
        <>
          {error && <ErrorNotice error={error} />}
          <span className="connectors-footer-spacer">
            <button type="button" className="connectors-link" disabled={busy} onClick={onAdvanced}>
              {t('Advanced')}
            </button>
            <button type="button" className="connectors-link" disabled={busy} onClick={onGoogleKey}>
              {t('Use my Google key')}
            </button>
          </span>
          <button type="button" className="secondary" disabled={busy} onClick={onClose}>
            {t('Cancel')}
          </button>
          <button type="submit" disabled={busy || !kind}>
            {t('Connect')}
          </button>
        </>
      }
    >
      <ExtensionField label={t('Address or command')}>
        <input
          name="connector-source"
          value={value}
          placeholder={t('Paste an address or a command')}
          spellCheck={false}
          autoComplete="off"
          // biome-ignore lint/a11y/noAutofocus: the dialog's only field takes focus on open.
          autoFocus
          disabled={busy}
          onChange={(event) => {
            setValue(event.currentTarget.value);
            setChoice(null);
          }}
        />
      </ExtensionField>
      {options.length > 1 && (
        <div className="connectors-kind-choice" data-connector-choice="">
          <span>{t('What is this?')}</span>
          {/* biome-ignore lint/a11y/useSemanticElements: a div button group; <fieldset> would change the element tag. */}
          <div className="mx-segmented" role="group" aria-label={t('What is this?')}>
            {options.map((option) => (
              <button
                key={option}
                type="button"
                className={kind === option ? 'active' : ''}
                aria-pressed={kind === option}
                disabled={busy}
                onClick={() => setChoice(option)}
              >
                {KIND_LABEL[option]()}
              </button>
            ))}
          </div>
        </div>
      )}
      <p className="connectors-hint" data-connector-detected={kind ?? ''} role="status">
        {note || t('MCP addresses, npx … commands and plugin links all work.')}
      </p>
    </ExtensionDetailDialog>
  );
}

/** "플러그인 삭제…": what goes with the plugin before anything is removed. */
function PluginRemovalDialog({
  plugin,
  servers,
  busy,
  onConfirm,
  onClose,
}: {
  plugin: Row;
  servers: Row[];
  busy: boolean;
  onConfirm(): void;
  onClose(): void;
}) {
  const managed = plugin.managed !== false;
  const root = text(plugin.root);
  return (
    <ExtensionDetailDialog
      width="compact"
      className="connectors-plugin-removal"
      titleId="connectors-plugin-removal-title"
      icon={<Blocks size={16} aria-hidden="true" />}
      title={t('Remove {{name}}?', { name: label(plugin) })}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="secondary" disabled={busy} onClick={onClose}>
            {t('Cancel')}
          </button>
          <button type="button" className="danger" disabled={busy} onClick={onConfirm}>
            {t('Remove plugin')}
          </button>
        </>
      }
    >
      <ExtensionSection title={t('What is removed')}>
        <ExtensionItemList>
          <ExtensionItemRow
            icon={<Plug size={16} aria-hidden="true" />}
            title={t('Connections')}
            description={servers.length ? servers.map((server) => String(server.name)).join(', ') : t('None')}
          />
          <ExtensionItemRow
            title={t('Hooks')}
            description={plugin.hooks === true ? t('Its hooks stop running.') : t('None')}
          />
          <ExtensionItemRow
            title={t('Files')}
            description={
              managed
                ? t('The folder Mixdog installed is deleted: {{path}}', { path: root })
                : t('Your local folder stays as it is: {{path}}', { path: root })
            }
            tone={managed ? 'warn' : 'muted'}
          />
        </ExtensionItemList>
      </ExtensionSection>
    </ExtensionDetailDialog>
  );
}

/** A plugin that brings MCP: package management (on/off, update, remove with
 *  its impact) and its connections. */
function ConnectorPluginDialog({
  plugin,
  servers,
  busy,
  locked,
  run,
  onOpenServer,
  onRemove,
  onClose,
}: {
  plugin: Row;
  servers: Row[];
  busy: boolean;
  locked: boolean;
  run: PanelContext['run'];
  onOpenServer(name: string): void;
  onRemove(): void;
  onClose(): void;
}) {
  const problems = (Array.isArray(plugin.mcpErrors) ? plugin.mcpErrors : []).map((error) => {
    const row = record(error);
    return [text(row.key), text(row.message)].filter(Boolean).join(': ');
  });
  return (
    <ExtensionDetailDialog
      className="extensions-plugin-detail-dialog"
      title={label(plugin)}
      icon={<Blocks size={16} aria-hidden="true" />}
      tagline={text(plugin.description) || [text(plugin.version), text(plugin.sourceType)].filter(Boolean).join(' · ')}
      enabled={plugin.enabled !== false}
      busy={busy || locked}
      onToggle={(next) => void run('setPluginEnabled', [plugin, next])}
      footer={
        <>
          <button type="button" className="danger" disabled={busy || locked} onClick={onRemove}>
            {t('Remove plugin…')}
          </button>
          <button type="button" disabled={busy || locked} onClick={() => void run('updatePlugin', [plugin])}>
            {plugin.sourceType === 'local' ? t('Update metadata') : t('Update plugin')}
          </button>
          <button type="button" className="secondary" onClick={onClose}>
            {t('Close')}
          </button>
        </>
      }
      onClose={onClose}
    >
      {problems.map((problem) => (
        <ExtensionNote key={problem} tone="danger">
          {t('MCP problem: {{message}}', { message: problem })}
        </ExtensionNote>
      ))}
      <ExtensionSection title={t('Connections')} count={servers.length}>
        {plugin.enabled === false && servers.length > 0 && (
          <ExtensionNote>{t('Turn the plugin on to connect its MCP servers.')}</ExtensionNote>
        )}
        <ExtensionItemList>
          {servers.map((server) => {
            const status = mcpStatus(server);
            return (
              <ExtensionItemRow
                key={String(server.name)}
                icon={<Plug size={16} aria-hidden="true" />}
                title={String(server.name)}
                description={mcpReason(server) || mcpRowDescription(server)}
                status={status.label}
                tone={status.tone}
                control={
                  <ExtensionAction onClick={() => onOpenServer(String(server.name))}>{t('Details')}</ExtensionAction>
                }
              />
            );
          })}
        </ExtensionItemList>
      </ExtensionSection>
      <PluginInfo plugin={plugin} />
    </ExtensionDetailDialog>
  );
}

export function ConnectorsPanel(context: PanelContext) {
  const { data, pending, run, confirm, refreshExtensions, createOpen, closeCreate } = context;
  const busy = Boolean(pending);
  useRemoteHostOpenAccess();
  // The host refuses these lanes to an older paired client: manage there.
  const connectLocked = capabilityBlockedRemotely('beginMcpOAuthLogin');
  const editLocked = capabilityBlockedRemotely('getMcpServerConfig') || capabilityBlockedRemotely('saveMcpServer');
  const servers = rows(record(data.mcp), 'servers');
  const plugins = rows(record(data.plugins), 'plugins');
  const groups = groupConnectors(servers, plugins);
  const [detail, setDetail] = useState<DetailTarget | null>(null);
  const [keyEntry, setKeyEntry] = useState<ConnectorCatalogEntry | null>(null);
  // "내 Google 키 사용": `null` closed, else whether a Google server already runs on the user's key.
  const [googleKey, setGoogleKey] = useState<boolean | null>(null);
  const openGoogleKey = () => {
    closeAdd();
    const names = servers
      .filter((server) => server.connector === 'google-calendar' || server.connector === 'google-drive')
      .map((server) => String(server.name));
    void Promise.all(names.map((name) => usesGoogleOwnKey(invokeCapability, name).catch(() => false))).then((list) =>
      setGoogleKey(list.some(Boolean))
    );
  };
  const [appPassword, setAppPassword] = useState<{
    entry: ConnectorCatalogEntry;
    account: string;
    target: { server?: string; add?: boolean };
  } | null>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [removing, setRemoving] = useState<Row | null>(null);
  // The 커스텀 커넥터 추가 row opens the same dialog as the header's +.
  const [addOpen, setAddOpen] = useState(false);
  const closeAdd = () => {
    setAddOpen(false);
    closeCreate?.();
  };
  const [editor, setEditor] = useState<{ name: string; server: Row | null } | 'new' | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshExtensions is stable per panel; a connect elsewhere (chat card) re-reads the lists.
  useEffect(() => {
    const refresh = () => void refreshExtensions();
    window.addEventListener(CONNECTORS_CHANGED_EVENT, refresh);
    return () => window.removeEventListener(CONNECTORS_CHANGED_EVENT, refresh);
  }, []);
  const lockedToast = () => showDesktopToast(manageOnHostNote(), 'info');
  const openAppPassword = (entry: ConnectorCatalogEntry, server: Row | null) => {
    if (connectLocked) return lockedToast();
    setDetail(null);
    // No server: one more account; else that server is reconnected.
    setAppPassword({
      entry,
      account: appPasswordAccount(server),
      target: server ? { server: String(server.name) } : { add: true },
    });
  };
  const addAccount = (entry: ConnectorCatalogEntry) => {
    if (connectLocked) return lockedToast();
    connectCatalogConnector(entry, '', null, { add: true }).catch((reason) =>
      showDesktopToast(errorMessage(reason), 'error')
    );
  };
  const connectCatalog = (entry: ConnectorCatalogEntry, server: Row | null = null) => {
    if (connectLocked) return lockedToast();
    if (entry.backend.kind === 'apiKey') return setKeyEntry(entry);
    // Gmail is app-password only: an app-password server is reconnected, else a new account is added.
    if (entry.id === 'gmail') return openAppPassword(entry, appPasswordAccount(server) ? server : null);
    connectCatalogConnector(entry).catch((reason) => showDesktopToast(errorMessage(reason), 'error'));
  };
  const openEditor = (name: string) => {
    if (editLocked) return lockedToast();
    setDetail(null);
    setEditor({ name, server: null });
    void run<Row>('getMcpServerConfig', [name], `mcp-config-${name}`, false).then((config) => {
      const row = servers.find((server) => String(server.name) === name);
      setEditor((current) =>
        current !== 'new' && current?.name === name
          ? config
            ? { name, server: { ...row, ...config } }
            : null
          : current
      );
    });
  };
  // 연결 해제: a catalog connection is removed (its sign-in with it); a custom
  // or plugin connection is switched off, keeping its config and the plugin.
  const disconnect = (server: Row, catalog: boolean, title: string) => {
    setDetail(null);
    disconnectConnector(String(server.name), title, catalog, (capability, args) =>
      run(capability, args, capability, true, false, 'throw')
    ).catch((reason) => showDesktopToast(errorMessage(reason), 'error'));
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: the header's + opens the add dialog; nothing else does.
  useEffect(() => {
    if (createOpen && connectLocked) {
      closeCreate?.();
      lockedToast();
    }
  }, [createOpen, connectLocked]);

  const serverByName = (name: string) => servers.find((server) => String(server.name) === name) ?? null;
  const pluginOf = (server: Row | null) => {
    const owner = record(server?.owner);
    return owner.kind === 'plugin' ? (plugins.find((plugin) => String(plugin.id) === String(owner.id)) ?? null) : null;
  };
  const packageOf = (id: string) =>
    groups.packages.find((entry) => String(entry.plugin.id || entry.plugin.name) === id);

  let dialog: ReactNode = null;
  if (detail?.kind === 'catalog') {
    const row = groups.catalog.find((entry) => entry.entry.id === detail.id);
    if (row) {
      dialog = (
        <ConnectorDetail
          entry={row.entry}
          server={row.server}
          busy={busy}
          locked={connectLocked}
          run={run}
          onConnect={() => connectCatalog(row.entry, row.server)}
          onDisconnect={() => row.server && disconnect(row.server, true, row.entry.name)}
          onAdvanced={row.server ? () => openEditor(String(row.server?.name)) : null}
          onRemovePlugin={null}
          accounts={row.servers}
          onAddAccount={
            connectorMultiAccount(row.entry) && row.entry.id !== 'gmail' ? () => addAccount(row.entry) : null
          }
          onDisconnectAccount={(account) => disconnect(account, true, row.entry.name)}
          onAppPassword={row.entry.id === 'gmail' ? (account) => openAppPassword(row.entry, account) : null}
          onClose={() => setDetail(null)}
        />
      );
    }
  } else if (detail?.kind === 'server') {
    const server = serverByName(detail.name);
    const plugin = pluginOf(server);
    if (server) {
      dialog = (
        <ConnectorDetail
          entry={null}
          server={server}
          busy={busy}
          locked={connectLocked}
          run={run}
          onConnect={serverActions(server, detail.name).connect}
          onDisconnect={() => disconnect(server, false, detail.name)}
          onAdvanced={() => openEditor(detail.name)}
          onRemovePlugin={plugin ? () => setRemoving(plugin) : null}
          onClose={() => setDetail(null)}
        />
      );
    }
  } else if (detail?.kind === 'plugin') {
    const entry = packageOf(detail.id);
    if (entry) {
      dialog = (
        <ConnectorPluginDialog
          plugin={entry.plugin}
          servers={entry.servers}
          busy={busy}
          locked={connectLocked}
          run={run}
          onOpenServer={(name) => setDetail({ kind: 'server', name })}
          onRemove={() => setRemoving(entry.plugin)}
          onClose={() => setDetail(null)}
        />
      );
    }
  }
  const editorServer = editor && editor !== 'new' ? editor.server : null;
  const editorName = editor && editor !== 'new' ? editor.name : '';
  const editorRow = editorName ? serverByName(editorName) : null;
  const removingId = removing ? String(removing.id || removing.name) : '';
  const loaded = sectionLoaded(data, 'mcp');

  return (
    <>
      <Group title={t('Connectors')}>
        {groups.catalog.map(({ entry, server }) => (
          <CatalogRow
            key={entry.id}
            entry={entry}
            server={server}
            locked={connectLocked}
            onConnect={() => connectCatalog(entry, server)}
            onOpen={() => setDetail({ kind: 'catalog', id: entry.id })}
          />
        ))}
      </Group>
      <Group title={t('Custom connectors')}>
        {!loaded && <ListEmpty text={t('Loading MCP servers…')} />}
        {groups.custom.map((server) => (
          <CustomServerRow
            key={String(server.name)}
            server={server}
            locked={connectLocked}
            onOpen={() => setDetail({ kind: 'server', name: String(server.name) })}
          />
        ))}
        {groups.packages.map(({ plugin, servers: owned }) => {
          const id = String(plugin.id || plugin.name);
          const open = expanded.has(id);
          return (
            <div key={id} className="connectors-package" data-connector-package={id}>
              <ConnectorRow
                id={id}
                icon={<Blocks size={16} aria-hidden="true" />}
                title={label(plugin)}
                tag={plugin.enabled === false ? { label: t('Disabled'), tone: 'muted' } : null}
                line={owned.length ? t('Connections: {{count}}', { count: owned.length }) : t('No MCP servers yet')}
                action={
                  <ExtensionAction
                    ariaLabel={open ? t('Collapse') : t('Expand')}
                    onClick={() =>
                      setExpanded((current) => {
                        const next = new Set(current);
                        if (open) next.delete(id);
                        else next.add(id);
                        return next;
                      })
                    }
                  >
                    {open ? (
                      <ChevronDown size={14} aria-hidden="true" />
                    ) : (
                      <ChevronRight size={14} aria-hidden="true" />
                    )}
                  </ExtensionAction>
                }
                onOpen={() => setDetail({ kind: 'plugin', id })}
              />
              {open &&
                owned.map((server) => (
                  <CustomServerRow
                    key={String(server.name)}
                    nested
                    server={server}
                    locked={connectLocked}
                    onOpen={() => setDetail({ kind: 'server', name: String(server.name) })}
                  />
                ))}
            </div>
          );
        })}
        <ConnectorRow
          id="add-custom-connector"
          icon={<Plus size={16} aria-hidden="true" />}
          title={t('Add custom connector')}
          onOpen={() => (connectLocked ? lockedToast() : setAddOpen(true))}
        />
      </Group>
      {dialog}
      {keyEntry && <ConnectorKeySheet entry={keyEntry} onClose={() => setKeyEntry(null)} />}
      {appPassword && (
        <GmailAppPasswordDialog
          entry={appPassword.entry}
          account={appPassword.account}
          target={appPassword.target}
          onClose={() => setAppPassword(null)}
        />
      )}
      {googleKey !== null && <GoogleOwnKeyDialog active={googleKey} onClose={() => setGoogleKey(null)} />}
      {(createOpen || addOpen) && !connectLocked && (
        <CustomConnectorDialog
          taken={servers.map((server) => String(server.name))}
          run={run}
          onGoogleKey={openGoogleKey}
          onAdvanced={() => {
            closeAdd();
            if (editLocked) lockedToast();
            else setEditor('new');
          }}
          onClose={closeAdd}
        />
      )}
      {editor === 'new' && (
        <McpEditorDialog
          key="new-mcp"
          server={null}
          busy={busy}
          takenNames={servers.map((server) => String(server.name))}
          onClose={() => setEditor(null)}
          onConnect={(name) => void startConnectorLogin(name, name)}
          onProbe={async (config) => {
            try {
              return await run<Row>('probeMcpServerAuth', [config], 'probeMcpServerAuth', false, true, 'throw');
            } catch (reason) {
              return { auth: 'unreachable', error: errorMessage(reason) };
            }
          }}
          onSave={async (payload) => {
            await run('addMcpServer', [payload], 'addMcpServer', true, false, 'throw');
            setEditor(null);
            announceConnectorsChanged();
          }}
        />
      )}
      {editor && editor !== 'new' && !editorServer && (
        <SidebarLoadingDialog
          title={editorName}
          onClose={() => setEditor(null)}
          dataAttributes={{ 'data-extension-loading': 'mcp' }}
        />
      )}
      {editorServer && (
        <McpEditorDialog
          key={editorName}
          server={
            editorRow
              ? {
                  ...editorServer,
                  status: editorRow.status,
                  error: editorRow.error,
                  connected: editorRow.connected,
                  authRequired: editorRow.authRequired,
                  oauth: editorRow.oauth,
                }
              : editorServer
          }
          busy={busy}
          // A plugin's server config belongs to the plugin.
          readOnly={editorServer.readOnly === true}
          onClose={() => setEditor(null)}
          onConnect={(name) => void startConnectorLogin(name, name)}
          onDisconnect={(name) => void run('signOutMcpServer', [name], `mcp-oauth-signout-${name}`)}
          onSave={(payload) => {
            setEditor(null);
            void run('saveMcpServer', [payload]).then(announceConnectorsChanged);
          }}
          onToggle={() => void run('setMcpServerEnabled', [editorName, editorServer.enabled === false])}
          onRemove={() =>
            confirm({
              title: t('Remove MCP server?'),
              description: t('{{name}} will be removed from Mixdog.', { name: editorName }),
              confirmLabel: t('Remove'),
              danger: true,
              onConfirm: async () => {
                setEditor(null);
                await run('removeMcpServer', [editorName]);
                announceConnectorsChanged();
              },
            })
          }
        />
      )}
      {removing && (
        <PluginRemovalDialog
          plugin={removing}
          servers={packageOf(removingId)?.servers ?? []}
          busy={busy}
          onClose={() => setRemoving(null)}
          onConfirm={() => {
            setRemoving(null);
            setDetail(null);
            void run('removePlugin', [removing]).then(announceConnectorsChanged);
          }}
        />
      )}
      <ConnectorLoginDialogs />
    </>
  );
}
