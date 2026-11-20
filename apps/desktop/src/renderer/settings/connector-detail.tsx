import { ChevronDown, ChevronRight, Plug } from 'lucide-react';
import { useState } from 'react';
import type { ConnectorCatalogEntry } from '../../shared/core-src/runtime/shared/connector-catalog.mjs';
import {
  announceConnectorsChanged,
  appPasswordAccount,
  cancelConnectorLogin,
  startConnectorLogin,
  useConnectorLogin,
} from '../connector-connect';
import { RowOverflowMenu } from '../RowOverflowMenu';
import { ConnectorIcon } from '../connector-icon';
import { connectorCanDo } from '../connectors-copy';
import { connectorIdentity, connectorRowView, serverNameOf } from '../connectors-model';
import { ConnectorStep } from '../connector-step';
import { t } from '../i18n';
import { record } from '../record-utils';
import {
  ExtensionAction,
  ExtensionDetailDialog,
  ExtensionItemList,
  ExtensionItemRow,
  ExtensionNote,
  ExtensionSection,
} from './extension-detail';
import { mcpRowDescription, mcpStatus } from './mcp-editor-dialog';
import { text, type PanelContext, type RecordValue as Row } from './capability-data';
import { retryOf, mcpReason, serverActions } from './connector-rows';

function toolRows(server: Row | null): Row[] {
  // Live tool names carry the `mcp__<server>__` routing prefix.
  const prefix = `mcp__${serverNameOf(server)}__`;
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

/** One account of a catalog connector: its address (or server name), its own
 *  state, and one ⋯ menu with its 앱 비밀번호 바꾸기 / 계정 전환 / 로그아웃 /
 *  연결 해제 (and 다시 인증 beside it when the account needs it). */
function AccountRow({
  entry,
  server,
  busy,
  locked,
  onConnect,
  onDisconnect,
  onChangePassword,
  onSwitch,
  onSignOut,
}: {
  entry: ConnectorCatalogEntry;
  server: Row;
  busy: boolean;
  locked: boolean;
  /** This account's own 연결 (sign-in or app password), where it has one. */
  onConnect: (() => void) | null;
  onDisconnect(): void;
  onChangePassword: (() => void) | null;
  onSwitch: (() => void) | null;
  onSignOut: (() => void) | null;
}) {
  const name = String(server.name);
  const title = entry.name;
  const login = useConnectorLogin(name);
  const view = connectorRowView(server, login);
  const actions = serverActions(server, title, entry.id);
  const status = mcpStatus(server);
  const retry = view.status === 'failed' ? (retryOf(view, actions, null) ?? onConnect) : null;
  const fixes: Partial<Record<typeof view.status, { run: (() => void) | null; label: string }>> = {
    'needs-reauth': { run: actions.reauth, label: t('Re-authenticate') },
    disabled: { run: actions.reenable, label: t('Turn back on') },
    'needs-connect': { run: onConnect, label: t('Connect') },
  };
  const { run: fix, label: fixLabel } = fixes[view.status] ?? { run: retry, label: t('Try again') };
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
              {fixLabel}
            </ExtensionAction>
          )}
          {server.inUse === true && <span className="connectors-in-use">{t('In use')}</span>}
          <RowOverflowMenu label={identity} items={items} />
        </>
      }
    />
  );
}

/** One connector's card. Before connecting: what it can do and 연결. After:
 *  the account, what it can do, 더 보기 (tools) and 연결 해제. A plugin's
 *  connection also offers 플러그인 삭제… (its own impact dialog). */
export function ConnectorDetail({
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
  ownClientNote = '',
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
  /** This build has no built-in Google client and none is configured. */
  ownClientNote?: string;
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
  const retry = retryOf(view, { ...actions, connect: onConnect ?? actions.connect }, switchAccount);
  const headerAction = pending ? (
    <ExtensionAction onClick={() => cancelConnectorLogin(name, entry?.id ?? '')}>{t('Cancel')}</ExtensionAction>
  ) : view.status === 'failed' ? (
    retry && (
      <ExtensionAction disabled={busy || locked} onClick={retry}>
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
  ) : !connected && onConnect && !(framed && framedAccounts.length > 0) ? (
    // A connector with accounts connects each from its own row below.
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
              : status && server?.enabled !== false && view.status !== 'needs-connect'
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
      {ownClientNote && !connected && !pending && <ExtensionNote>{ownClientNote}</ExtensionNote>}
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
                  // Gmail connects an account by its app password, the others by sign-in.
                  onConnect={
                    gmail
                      ? onAppPassword
                        ? () => onAppPassword(account)
                        : null
                      : serverActions(account, title, entry.id).connect
                  }
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
