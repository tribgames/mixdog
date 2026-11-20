// Extensions → 커넥터 (design/mockups/connectors): the catalog ("커넥터",
// alphabetical, one-click 연결) and "커스텀 커넥터" (raw MCP servers, plugins
// that bring MCP as expandable packages, and "커스텀 커넥터 추가"). Rows read
// the host's MCP and plugin status as they are; nothing is renamed or merged.
import { Blocks, ChevronDown, ChevronRight, Plus } from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import type { ConnectorCatalogEntry } from '../../shared/core-src/runtime/shared/connector-catalog.mjs';
import { subscribeSetupChanges } from '../setup-change-refresh';
import {
  announceConnectorsChanged,
  appPasswordAccount,
  CONNECTORS_CHANGED_EVENT,
  connectCatalogConnector,
  needsOwnGoogleClient,
  ownGoogleClientNote,
  disconnectConnector,
  invoke as invokeCapability,
  startConnectorLogin,
} from '../connector-connect';
import { ConnectorLoginDialogs } from '../connector-login-dialogs';
import { connectorAccountOwners, connectorAccountRows, groupConnectors, serverNameOf } from '../connectors-model';
import { errorMessage } from '../editor-pane-session-errors';
import { usesGoogleOwnKey } from '../google-own-key';
import { t } from '../i18n';
import { showDesktopToast } from '../notifications';
import { record } from '../record-utils';
import { useRemoteHostOpenAccess } from '../remote-host-access';
import { SidebarLoadingDialog } from '../sidebar-dialog';
import { Group, ListEmpty } from './capability-controls';
import { label, rows, sectionLoaded, type PanelContext } from './capability-data';
import { ExtensionAction } from './extension-detail';
import { McpEditorDialog, probeMcpAuth, withLiveMcpStatus } from './mcp-editor-dialog';
import { capabilityBlockedRemotely, manageOnHostNote } from './remote-capability-guard';
import type { RecordValue as Row } from './capability-data';
import { ConnectorRow, CatalogRow, CustomServerRow, serverActions } from './connector-rows';
import { ConnectorDetail } from './connector-detail';
import {
  ConnectorKeySheet,
  ConnectorPluginDialog,
  CustomConnectorDialog,
  GmailAppPasswordDialog,
  GoogleOwnKeyDialog,
  PluginRemovalDialog,
} from './connector-dialogs';

type DetailTarget = { kind: 'catalog'; id: string } | { kind: 'server'; name: string } | { kind: 'plugin'; id: string };

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
  // Server and account names share one space (an account's name addresses it).
  const takenNames = connectorAccountRows(servers).map((server) => String(server.name));
  const [detail, setDetail] = useState<DetailTarget | null>(null);
  const [keyEntry, setKeyEntry] = useState<{ entry: ConnectorCatalogEntry; add: boolean } | null>(null);
  // "내 Google 키 사용": `null` closed, else whether a Google server already runs on the user's key.
  const [googleKey, setGoogleKey] = useState<boolean | null>(null);
  // The connector whose extra account the open key dialog also adds, if any.
  const [googleKeyAccountOf, setGoogleKeyAccountOf] = useState<ConnectorCatalogEntry | null>(null);
  const openGoogleKey = (newAccountOf: ConnectorCatalogEntry | null = null) => {
    setGoogleKeyAccountOf(newAccountOf);
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
    // A bot switching accounts moves `inUse` on the host; the open detail
    // dialog reads the same list, so it follows the setup-change broadcast too.
    const unsubscribe = subscribeSetupChanges(refresh);
    return () => {
      window.removeEventListener(CONNECTORS_CHANGED_EVENT, refresh);
      unsubscribe();
    };
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
  // A build without the built-in Google client never starts that sign-in.
  // Only the host's affirmative `googleClient` offers it; a host that doesn't say is unknown.
  const googleClient = record(data.mcp).googleClient !== false;
  const mcpLoaded = sectionLoaded(data, 'mcp');
  const ownClientNeeded = (entry: ConnectorCatalogEntry, server: Row | null) =>
    mcpLoaded && needsOwnGoogleClient(entry, server, googleClient);
  // `newAccountOf`: the key dialog also adds one more account of that connector.
  const askOwnClient = (newAccountOf: ConnectorCatalogEntry | null = null) => {
    showDesktopToast(ownGoogleClientNote(), 'info');
    openGoogleKey(newAccountOf);
  };
  const addAccount = (entry: ConnectorCatalogEntry) => {
    if (connectLocked) return lockedToast();
    // An API-key or connection-string account is entered in the same dialog as the first.
    if (entry.backend.kind === 'apiKey') {
      setDetail(null);
      return setKeyEntry({ entry, add: true });
    }
    // A new account has no client of its own yet.
    if (ownClientNeeded(entry, null)) return askOwnClient(entry);
    connectCatalogConnector(entry, '', null, { add: true }).catch((reason) =>
      showDesktopToast(errorMessage(reason), 'error')
    );
  };
  const connectCatalog = (entry: ConnectorCatalogEntry, server: Row | null = null) => {
    if (connectLocked) return lockedToast();
    if (entry.backend.kind === 'apiKey') return setKeyEntry({ entry, add: false });
    // Gmail is app-password only: an app-password server is reconnected, else a new account is added.
    if (entry.id === 'gmail') return openAppPassword(entry, appPasswordAccount(server) ? server : null);
    if (ownClientNeeded(entry, server)) return askOwnClient();
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
          // An account row edits the server holding the accounts.
          onAdvanced={row.server ? () => openEditor(serverNameOf(row.server)) : null}
          onRemovePlugin={null}
          accounts={row.servers}
          onAddAccount={row.entry.id !== 'gmail' ? () => addAccount(row.entry) : null}
          onDisconnectAccount={(account) => disconnect(account, true, row.entry.name)}
          onAppPassword={row.entry.id === 'gmail' ? (account) => openAppPassword(row.entry, account) : null}
          ownClientNote={
            row.entry.id !== 'gmail' && ownClientNeeded(row.entry, row.server) ? ownGoogleClientNote() : ''
          }
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
  const loaded = mcpLoaded;

  return (
    <>
      <Group title={t('Connectors')}>
        {groups.catalog.map(({ entry, server, servers: accounts }) => (
          <CatalogRow
            key={entry.id}
            entry={entry}
            server={server}
            hasAccounts={accounts.length > 0}
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
      {keyEntry && <ConnectorKeySheet entry={keyEntry.entry} add={keyEntry.add} onClose={() => setKeyEntry(null)} />}
      {appPassword && (
        <GmailAppPasswordDialog
          entry={appPassword.entry}
          account={appPassword.account}
          target={appPassword.target}
          onClose={() => setAppPassword(null)}
        />
      )}
      {googleKey !== null && (
        <GoogleOwnKeyDialog active={googleKey} newAccountOf={googleKeyAccountOf} onClose={() => setGoogleKey(null)} />
      )}
      {(createOpen || addOpen) && !connectLocked && (
        <CustomConnectorDialog
          taken={takenNames}
          run={run}
          onGoogleKey={() => openGoogleKey()}
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
          takenNames={takenNames}
          accountOwners={connectorAccountOwners(servers)}
          onClose={() => setEditor(null)}
          onConnect={(name) => void startConnectorLogin(name, name)}
          onProbe={(config) => probeMcpAuth(run, config)}
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
          server={withLiveMcpStatus(editorServer, editorRow ?? undefined)}
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
              description: t('{{name}} will be removed.', { name: editorName }),
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
