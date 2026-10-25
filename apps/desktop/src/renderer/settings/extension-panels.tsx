import { Blocks, Plug } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { t } from '../i18n';
import { CapabilityIcon } from '../CapabilityIcon';
import { skillDisplayDescription } from '../skill-presentation';
import { showDesktopToast } from '../notifications';
import { record } from '../record-utils';
import { useRemoteHostOpenAccess } from '../remote-host-access';
import { ScmContextMenu, type ScmContextMenuState } from '../ScmContextMenu';
import { SidebarLoadingDialog } from '../sidebar-dialog';
import { BuiltInFeaturesPanel } from './built-in-features-panel';
import { PluginInfo } from './plugin-info';
import { SkillEditorDialog } from './skill-editor';
import { CompactSwitch, Group, ListEmpty } from './capability-controls';
import { label, rows, sectionLoaded, type PanelContext, type RecordValue } from './capability-data';
import { connectorAccountOwners, isConnectorPlugin } from '../connectors-model';
import {
  currentProjectPath,
  ExtensionDetailDialog,
  ExtensionField,
  ExtensionItemList,
  ExtensionItemRow,
  ExtensionNote,
  ExtensionRow,
  ExtensionScopeField,
  ExtensionSection,
  scopeOf,
} from './extension-detail';
import { errorMessage } from '../editor-pane-session-errors';
import { McpEditorDialog, mcpRowDescription, mcpStatus } from './mcp-editor-dialog';
import { useMcpOAuthLogin } from './mcp-oauth-login';
import { capabilityBlockedRemotely, manageOnHostNote } from './remote-capability-guard';

function PluginInstallDialog({
  busy,
  onClose,
  onSubmit,
}: {
  busy: boolean;
  onClose(): void;
  onSubmit(source: string): void;
}) {
  return (
    <ExtensionDetailDialog
      width="compact"
      className="extensions-plugin-dialog"
      titleId="extensions-plugin-dialog-title"
      icon={<Blocks size={16} aria-hidden="true" />}
      title={t('Install plugin')}
      onClose={onClose}
      onSubmit={(event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        const source = String(new FormData(event.currentTarget).get('source') || '').trim();
        if (!source) return;
        onSubmit(source);
        onClose();
      }}
      footer={
        <>
          <button type="button" className="secondary" disabled={busy} onClick={onClose}>
            {t('Cancel')}
          </button>
          <button type="submit" disabled={busy}>
            {t('Install')}
          </button>
        </>
      }
    >
      <ExtensionField label={t('Source')}>
        <input
          name="source"
          placeholder="https://github.com/org/plugin or C:\path"
          required
          // biome-ignore lint/a11y/noAutofocus: the dialog's only field takes focus on open.
          autoFocus
          disabled={busy}
        />
      </ExtensionField>
    </ExtensionDetailDialog>
  );
}

function disabledSkillNames(data: PanelContext['data']): Set<string> {
  const disabled = record(data.disabledSkills).disabled;
  return new Set((Array.isArray(disabled) ? disabled : []).map(String));
}

function saveSkillEnabled(run: PanelContext['run'], disabled: ReadonlySet<string>, name: string, enabled: boolean) {
  const next = new Set(disabled);
  if (enabled) next.delete(name);
  else next.add(name);
  void run('setDisabledSkills', [[...next]]);
}

const REMOVAL_IN_FLIGHT = Symbol('mcp-removal-in-flight');

export function McpPanel({ data, pending, run, confirm, refreshExtensions, createOpen, closeCreate }: PanelContext) {
  const status = record(data.mcp);
  const oauthLogin = useMcpOAuthLogin({ run, refreshExtensions });
  // Probing is a read: no busy state, no list refresh, and a failure comes back
  // as the result instead of a toast.
  const probeAuth = async (config: RecordValue) => {
    try {
      return await run<RecordValue>('probeMcpServerAuth', [config], 'probeMcpServerAuth', false, true, 'throw');
    } catch (reason) {
      return { auth: 'unreachable', error: errorMessage(reason) };
    }
  };
  // A confirmed removal hides its row while the call is in flight. Once it
  // resolves, the first MCP snapshot that arrives after that point is
  // authoritative and drops the tombstone; a failed removal drops it at once.
  // Each entry holds REMOVAL_IN_FLIGHT or the snapshot current at resolve.
  const [removed, setRemoved] = useState<ReadonlyMap<string, unknown>>(() => new Map());
  const latestMcp = useRef<unknown>(data.mcp);
  const listed = rows(status, 'servers').filter((server) => server.source !== 'plugin');
  const servers = listed.filter((server) => !removed.has(String(server.name)));
  const busy = Boolean(pending);
  const forgetRemoved = (name: string) =>
    setRemoved((current) => {
      if (!current.has(name)) return current;
      const next = new Map(current);
      next.delete(name);
      return next;
    });
  const settleRemoved = (name: string) =>
    setRemoved((current) =>
      current.get(name) === REMOVAL_IN_FLIGHT ? new Map(current).set(name, latestMcp.current) : current
    );
  useEffect(() => {
    latestMcp.current = data.mcp;
    setRemoved((current) => {
      const next = new Map([...current].filter(([, seen]) => seen === REMOVAL_IN_FLIGHT || seen === data.mcp));
      return next.size === current.size ? current : next;
    });
  }, [data.mcp]);
  const [editor, setEditor] = useState<{ name: string; server: RecordValue | null } | null>(null);
  const openName = editor?.name || '';
  const openServer = editor?.server || null;
  const openRow = servers.find((server) => String(server.name) === openName);
  const liveOpenServer =
    openServer && openRow
      ? {
          ...openServer,
          status: openRow.status,
          error: openRow.error,
          connected: openRow.connected,
          authRequired: openRow.authRequired,
          oauth: openRow.oauth,
        }
      : openServer;
  const openEditor = (name: string) => {
    closeCreate?.();
    setEditor({ name, server: null });
    void run<RecordValue>('getMcpServerConfig', [name], `mcp-config-${name}`, false).then((detail) =>
      setEditor((current) => {
        if (current?.name !== name) return current;
        if (!detail) return null;
        const row = servers.find((server) => String(server.name) === name);
        return { name, server: { ...(row || {}), ...detail } };
      })
    );
  };
  const closeEditor = () => setEditor(null);
  const confirmRemove = (name: string) =>
    confirm({
      title: t('Remove MCP server?'),
      description: t('{{name}} will be removed from Mixdog.', { name }),
      confirmLabel: t('Remove'),
      danger: true,
      onConfirm: async () => {
        setEditor((current) => (current?.name === name ? null : current));
        setRemoved((current) => new Map(current).set(name, REMOVAL_IN_FLIGHT));
        const result = await run('removeMcpServer', [name]);
        if (result === undefined) forgetRemoved(name);
        else settleRemoved(name);
      },
    });
  const [menu, setMenu] = useState<ScmContextMenuState | null>(null);
  // Items run after the menu closes and returns focus to the row.
  const openMenu = (name: string, enabled: boolean, point: { x: number; y: number }) =>
    setMenu({
      label: name,
      ...point,
      items: [
        { id: 'edit', label: t('Edit'), onSelect: () => window.setTimeout(() => openEditor(name), 0) },
        {
          id: 'toggle',
          label: enabled ? t('Disable') : t('Enable'),
          onSelect: () => void run('setMcpServerEnabled', [name, !enabled]),
        },
        {
          id: 'remove',
          label: t('Remove'),
          danger: true,
          separatorBefore: true,
          onSelect: () => window.setTimeout(() => confirmRemove(name), 0),
        },
      ],
    });
  // Secrets in MCP configs never travel over remote access: the editor cannot
  // open or save there, so the add flow and rows are replaced by a note.
  // A host with open access gets the editor; the subscription re-renders it
  // when the host's level is learned.
  useRemoteHostOpenAccess();
  const mcpLocked = capabilityBlockedRemotely('getMcpServerConfig') || capabilityBlockedRemotely('saveMcpServer');
  useEffect(() => {
    if (!createOpen || !mcpLocked) return;
    closeCreate?.();
    showDesktopToast(manageOnHostNote(), 'info');
  }, [createOpen, mcpLocked, closeCreate]);
  return (
    <Group title={t('MCP')}>
      {mcpLocked && <ListEmpty text={manageOnHostNote()} />}
      {createOpen && !mcpLocked && (
        <McpEditorDialog
          key="new-mcp"
          server={null}
          busy={busy}
          takenNames={servers.map((server) => String(server.name))}
          accountOwners={connectorAccountOwners(servers)}
          onClose={() => closeCreate?.()}
          onConnect={(serverName) => void oauthLogin.connect(serverName)}
          onProbe={probeAuth}
          // Creation must never overwrite: the host rejects a name that exists
          // by now (the dialog's takenNames can be stale) and the dialog shows it.
          onSave={async (payload) => {
            const added = await run('addMcpServer', [payload], 'addMcpServer', true, false, 'throw');
            if (added === undefined) return;
            forgetRemoved(String(payload.name || ''));
            closeCreate?.();
          }}
        />
      )}
      {servers.length === 0 && (
        <ListEmpty text={sectionLoaded(data, 'mcp') ? t('No MCP servers configured.') : t('Loading MCP servers…')} />
      )}
      {servers.map((server) => {
        const name = String(server.name);
        const enabled = server.enabled !== false;
        const status = mcpStatus(server);
        return (
          <ExtensionRow
            key={name}
            icon={<Plug size={16} aria-hidden="true" />}
            title={name}
            description={mcpRowDescription(server)}
            status={status.connected ? null : { label: status.label, tone: status.tone }}
            enabled={enabled}
            busy={busy || mcpLocked}
            onOpen={() => openEditor(name)}
            onMenu={(point) => openMenu(name, enabled, point)}
          />
        );
      })}
      <ScmContextMenu state={menu} onClose={() => setMenu(null)} />
      {oauthLogin.dialog}
      {editor && !openServer && (
        <SidebarLoadingDialog
          title={openName}
          onClose={closeEditor}
          dataAttributes={{ 'data-extension-loading': 'mcp' }}
        />
      )}
      {openName && openServer && (
        <McpEditorDialog
          key={openName}
          // The card follows the live list row: a finished sign-in or sign-out
          // changes its status while the editor stays open.
          server={liveOpenServer}
          busy={busy}
          onClose={closeEditor}
          onConnect={(serverName) => void oauthLogin.connect(serverName)}
          onDisconnect={(serverName) => void oauthLogin.disconnect(serverName)}
          // No "Applies to" here: a connector is on in every project unless
          // Project settings switches it off (사용할 커넥터).
          onSave={(payload) => {
            closeEditor();
            void run('saveMcpServer', [payload]);
          }}
          onToggle={() => {
            const enabled = openServer.enabled !== false;
            void run('setMcpServerEnabled', [openName, !enabled]);
          }}
          onRemove={() => confirmRemove(openName)}
        />
      )}
    </Group>
  );
}

/** The user's own skills only: built-in and plugin skills stay out of the UI. */
export function SkillsPanel({
  api,
  data,
  pending,
  run,
  confirm,
  refreshExtensions,
  createOpen,
  closeCreate,
}: PanelContext) {
  const status = record(data.skills);
  const skills = rows(status, 'skills').filter(
    (skill) => record(skill.owner).kind !== 'builtin' && record(skill.owner).kind !== 'plugin'
  );
  const disabled = disabledSkillNames(data);
  const busy = Boolean(pending);
  const [detail, setDetail] = useState<{ name: string; content: string | null } | null>(null);
  const toggle = (name: string) => saveSkillEnabled(run, disabled, name, disabled.has(name));
  const open = detail ? skills.find((skill) => String(skill.name) === detail.name) : undefined;
  const openOff = detail ? disabled.has(detail.name) : false;
  const openDetail = (name: string) => {
    closeCreate?.();
    setDetail({ name, content: null });
    void refreshExtensions();
    void run<RecordValue>('skillContent', [name], `skill-content-${name}`, false).then((value) => {
      setDetail((current) => {
        if (current?.name !== name) return current;
        return value === undefined ? null : { name, content: String(record(value).content || '') };
      });
    });
  };
  const [menu, setMenu] = useState<ScmContextMenuState | null>(null);
  const openMenu = (name: string, off: boolean, point: { x: number; y: number }) =>
    setMenu({
      label: name,
      ...point,
      items: [
        { id: 'open', label: t('Open'), onSelect: () => window.setTimeout(() => openDetail(name), 0) },
        { id: 'toggle', label: off ? t('Enable') : t('Disable'), onSelect: () => toggle(name) },
        {
          id: 'remove',
          label: t('Delete'),
          danger: true,
          separatorBefore: true,
          onSelect: () => window.setTimeout(() => confirmRemove(name), 0),
        },
      ],
    });
  const confirmRemove = (name: string) =>
    confirm({
      title: t('Delete skill?'),
      description: t('{{name}} will be deleted from your skills.', { name }),
      confirmLabel: t('Delete'),
      danger: true,
      onConfirm: () => {
        setDetail((current) => (current?.name === name ? null : current));
        void run('removeSkill', [{ name }]);
      },
    });
  const save = async (payload: RecordValue) => {
    const capability = detail ? 'saveSkill' : 'addSkill';
    const value = await run<RecordValue>(capability, [payload]);
    if (value === undefined) return;
    setDetail(null);
    closeCreate?.();
    showDesktopToast(t('Saved "{{name}}".', { name: String(payload.name || '') }), 'success');
  };
  return (
    <Group>
      {createOpen && (
        <SkillEditorDialog
          skill={null}
          instructions=""
          disabled={false}
          busy={busy}
          tools={rows(status, 'tools')}
          onClose={() => closeCreate?.()}
          onSave={(payload) => void save(payload)}
        />
      )}
      {skills.length === 0 &&
        (sectionLoaded(data, 'skills') ? (
          <div className="utility-dock-empty">
            <p>{t('No skills.')}</p>
          </div>
        ) : (
          <ListEmpty text={t('Loading skills…')} />
        ))}
      {skills.map((skill) => {
        const name = String(skill.name);
        const off = disabled.has(name);
        const description = skillDisplayDescription(skill).trim() || t('Skill instructions');
        return (
          <ExtensionRow
            key={name}
            icon={<CapabilityIcon name={name} />}
            title={name}
            description={description}
            enabled={!off}
            status={off ? { label: t('Disabled'), tone: 'muted' } : null}
            busy={busy}
            onOpen={() => openDetail(name)}
            onMenu={(point) => openMenu(name, off, point)}
          />
        );
      })}
      <ScmContextMenu state={menu} onClose={() => setMenu(null)} />
      {detail && open && detail.content === null && (
        <SidebarLoadingDialog
          title={detail.name}
          onClose={() => setDetail(null)}
          dataAttributes={{ 'data-extension-loading': 'skill' }}
        />
      )}
      {detail && open && detail.content !== null && (
        <SkillEditorDialog
          key={detail.name}
          skill={open}
          tools={rows(status, 'tools')}
          instructions={detail.content}
          disabled={openOff}
          busy={busy}
          readOnly={open.editable === false}
          scopeField={
            <ExtensionScopeField
              api={api}
              run={run}
              kind="skills"
              name={detail.name}
              {...scopeOf(open)}
              currentPath={currentProjectPath(data)}
              busy={busy}
            />
          }
          onClose={() => setDetail(null)}
          onSave={(payload) => void save(payload)}
          onToggle={() => toggle(detail.name)}
        />
      )}
    </Group>
  );
}

function pluginRowStatus(enabled: boolean, warning: boolean) {
  if (!enabled) return { label: t('Disabled'), tone: 'muted' as const };
  if (warning) return { label: t('No skills found.'), tone: 'warn' as const };
  return null;
}

// A plugin's MCP servers are the status rows whose owner metadata names it.
function pluginMcpServers(data: PanelContext['data'], plugin: RecordValue): RecordValue[] {
  const id = String(plugin.id || plugin.name || '');
  if (!id) return [];
  return rows(record(data.mcp), 'servers').filter((server) => {
    const owner = record(server.owner);
    return owner.kind === 'plugin' && String(owner.id || '') === id;
  });
}

function pluginMcpProblems(plugin: RecordValue, servers: RecordValue[]): string[] {
  const declared = (Array.isArray(plugin.mcpErrors) ? plugin.mcpErrors : []).map((error) => {
    const row = record(error);
    const key = String(row.key || '');
    return key ? `${key}: ${String(row.message || '')}` : String(row.message || '');
  });
  const warned = servers.flatMap((server) =>
    [...(Array.isArray(server.warnings) ? server.warnings : []), ...(server.error ? [server.error] : [])].map(
      (warning) => `${String(server.name)}: ${String(warning)}`
    )
  );
  return [...declared, ...warned].filter(Boolean);
}

function confirmPluginRemoval(
  { confirm, run }: Pick<PanelContext, 'confirm' | 'run'>,
  plugin: RecordValue,
  onRemoved: () => void
) {
  confirm({
    title: t('Remove plugin?'),
    description: t('{{name}} will be removed from Mixdog.', { name: label(plugin) }),
    confirmLabel: t('Remove'),
    danger: true,
    onConfirm: () => {
      onRemoved();
      void run('removePlugin', [plugin]);
    },
  });
}

function PluginDetailDialog({
  plugin: open,
  api,
  data,
  busy,
  run,
  confirm,
  refreshExtensions,
  onClose,
}: Pick<PanelContext, 'api' | 'data' | 'run' | 'confirm' | 'refreshExtensions'> & {
  plugin: RecordValue;
  busy: boolean;
  onClose(): void;
}) {
  const id = String(open.id || open.name);
  // Opening the dialog shows what is on disk now, not the last sweep.
  // biome-ignore lint/correctness/useExhaustiveDependencies: once per opened plugin.
  useEffect(() => {
    void refreshExtensions();
  }, [id]);
  const servers = pluginMcpServers(data, open);
  const mcpProblems = pluginMcpProblems(open, servers);
  const pluginOn = open.enabled !== false;
  const contents = servers.length;
  // Footer keeps the plugin's real actions only — Remove (parked left) and
  // Update. Its MCP servers appear on their own from its declarations; the
  // root path and MCP names sit in Info as selectable text.
  return (
    <ExtensionDetailDialog
      className="extensions-plugin-detail-dialog"
      title={label(open)}
      icon={<Blocks size={16} aria-hidden="true" />}
      tagline={
        String(open.description || '').trim() ||
        [String(open.version || '').trim(), String(open.sourceType || '').trim()].filter(Boolean).join(' · ')
      }
      enabled={open.enabled !== false}
      busy={busy}
      onToggle={(next) => void run('setPluginEnabled', [open, next])}
      footer={
        <>
          <button
            type="button"
            className="danger"
            disabled={busy}
            onClick={() => confirmPluginRemoval({ confirm, run }, open, onClose)}
          >
            {t('Remove')}
          </button>
          <button type="button" disabled={busy} onClick={() => void run('updatePlugin', [open])}>
            {open.sourceType === 'local' ? t('Update metadata') : t('Update plugin')}
          </button>
          <button type="button" className="secondary" onClick={onClose}>
            {t('Close')}
          </button>
        </>
      }
      onClose={onClose}
    >
      <ExtensionScopeField
        api={api}
        run={run}
        kind="plugins"
        name={id}
        {...scopeOf(open)}
        currentPath={currentProjectPath(data)}
        busy={busy}
      />
      {Boolean(open.warning) && (
        <ExtensionNote tone="danger">
          {t('No skills or MCP server found. Searched: {{paths}}', {
            paths: (Array.isArray(open.searchedSkillRoots) ? open.searchedSkillRoots : []).map(String).join(', '),
          })}
        </ExtensionNote>
      )}
      {mcpProblems.map((problem) => (
        <ExtensionNote key={problem} tone="danger">
          {t('MCP problem: {{message}}', { message: problem })}
        </ExtensionNote>
      ))}
      <ExtensionSection title={t('Contents')} count={contents}>
        {!pluginOn && servers.length > 0 && (
          <ExtensionNote>{t('Turn the plugin on to connect its MCP servers.')}</ExtensionNote>
        )}
        {contents > 0 && (
          <ExtensionItemList>
            {servers.map((server) => {
              const name = String(server.name);
              // The switch is the server's own intent; the plugin toggle above
              // still gates whether it runs.
              const serverOn = server.serverEnabled !== false;
              const status = mcpStatus(server);
              return (
                <ExtensionItemRow
                  key={`mcp:${name}`}
                  icon={<Plug size={16} aria-hidden="true" />}
                  title={name}
                  description={mcpRowDescription(server)}
                  status={status.label}
                  tone={status.tone}
                  control={
                    <CompactSwitch
                      label={`${name} · ${t('Enabled')}`}
                      checked={serverOn}
                      disabled={busy}
                      onChange={(next) => void run('setMcpServerEnabled', [name, next])}
                    />
                  }
                />
              );
            })}
          </ExtensionItemList>
        )}
        {!contents && <ExtensionNote>{t('Nothing installed by this plugin yet.')}</ExtensionNote>}
      </ExtensionSection>
      <PluginInfo plugin={open} />
    </ExtensionDetailDialog>
  );
}

function PluginsPanel({ api, data, pending, run, confirm, refreshExtensions, createOpen, closeCreate }: PanelContext) {
  const status = record(data.plugins);
  // Plugins that bring MCP servers are connectors (Connectors → 커스텀 커넥터).
  const plugins = rows(status, 'plugins').filter((plugin) => !isConnectorPlugin(plugin));
  const busy = Boolean(pending);
  const [openId, setOpenId] = useState('');
  const open = openId ? plugins.find((plugin) => String(plugin.id || plugin.name) === openId) : undefined;
  const [menu, setMenu] = useState<ScmContextMenuState | null>(null);
  const openMenu = (plugin: RecordValue, point: { x: number; y: number }) => {
    const id = String(plugin.id || plugin.name);
    const enabled = plugin.enabled !== false;
    setMenu({
      label: label(plugin),
      ...point,
      items: [
        { id: 'details', label: t('Details'), onSelect: () => window.setTimeout(() => setOpenId(id), 0) },
        {
          id: 'toggle',
          label: enabled ? t('Disable') : t('Enable'),
          onSelect: () => void run('setPluginEnabled', [plugin, !enabled]),
        },
        { id: 'update', label: t('Update'), onSelect: () => void run('updatePlugin', [plugin]) },
        {
          id: 'remove',
          label: t('Remove'),
          danger: true,
          separatorBefore: true,
          onSelect: () =>
            window.setTimeout(
              () =>
                confirmPluginRemoval({ confirm, run }, plugin, () =>
                  setOpenId((current) => (current === id ? '' : current))
                ),
              0
            ),
        },
      ],
    });
  };
  return (
    <Group title={t('Plugins')}>
      {createOpen && (
        <PluginInstallDialog
          busy={busy}
          onClose={() => closeCreate?.()}
          onSubmit={(source) => void run('addPlugin', [source])}
        />
      )}
      {plugins.length === 0 && (
        <ListEmpty text={sectionLoaded(data, 'plugins') ? t('No plugins.') : t('Loading plugins…')} />
      )}
      {plugins.map((plugin) => {
        const id = String(plugin.id || plugin.name);
        const enabled = plugin.enabled !== false;
        const description =
          String(plugin.description || '').trim() ||
          [String(plugin.version || '').trim(), String(plugin.sourceType || plugin.source || '').trim()]
            .filter(Boolean)
            .join(' · ') ||
          t('Installed plugin');
        return (
          <ExtensionRow
            key={id}
            icon={<Blocks size={16} aria-hidden="true" />}
            title={label(plugin)}
            description={description}
            status={pluginRowStatus(enabled, Boolean(plugin.warning))}
            enabled={enabled}
            busy={busy}
            onOpen={() => setOpenId(id)}
            onMenu={(point) => openMenu(plugin, point)}
          />
        );
      })}
      <ScmContextMenu state={menu} onClose={() => setMenu(null)} />
      {open && (
        <PluginDetailDialog
          plugin={open}
          api={api}
          data={data}
          busy={busy}
          run={run}
          confirm={confirm}
          refreshExtensions={refreshExtensions}
          onClose={() => setOpenId('')}
        />
      )}
    </Group>
  );
}

export function PluginExtensionsPanel(context: PanelContext) {
  return (
    <>
      <BuiltInFeaturesPanel {...context} />
      <PluginsPanel {...context} />
    </>
  );
}

export function SkillExtensionsPanel(context: PanelContext) {
  return <McpPanel {...context} />;
}
