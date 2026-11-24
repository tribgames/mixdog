import { Blocks, ChevronDown, ChevronRight, Plug, Plus } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { t } from '../i18n';
import { CapabilityIcon } from '../CapabilityIcon';
import { skillDisplayDescription } from '../skill-presentation';
import { showDesktopToast } from '../notifications';
import { record } from '../record-utils';
import { useRemoteHostOpenAccess } from '../remote-host-access';
import { contextMenuRowProps, ScmContextMenu, type ScmContextMenuState } from '../ScmContextMenu';
import { toggleHeading } from '../session-sidebar-sections';
import { SidebarLoadingDialog } from '../sidebar-dialog';
import {
  isOpen,
  readOpenMap,
  SKILL_CATEGORY_OPEN_KEY,
  toggleOpen,
  writeOpenMap,
  type OpenMap,
} from '../sidebar-open-state';
import { SidebarResourceTitle, type SidebarResourceTag } from '../sidebar-resource-row';
import {
  isBuiltinSource,
  isSharedSkill,
  OWN_SKILLS,
  pluginIdOf,
  sharedSkillNames,
  skillCategories,
  skillSourceRows,
  type SkillSourceRow,
} from './skill-sources';
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
import { McpEditorDialog, mcpRowDescription, mcpStatus, probeMcpAuth, withLiveMcpStatus } from './mcp-editor-dialog';
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

const REMOVAL_IN_FLIGHT = Symbol('mcp-removal-in-flight');

function useRemovalTombstones(snapshot: unknown) {
  const [removed, setRemoved] = useState<ReadonlyMap<string, unknown>>(() => new Map());
  const latest = useRef<unknown>(snapshot);
  const markRemoving = (name: string) => setRemoved((current) => new Map(current).set(name, REMOVAL_IN_FLIGHT));
  const forgetRemoved = (name: string) =>
    setRemoved((current) => {
      if (!current.has(name)) return current;
      const next = new Map(current);
      next.delete(name);
      return next;
    });
  const settleRemoved = (name: string) =>
    setRemoved((current) =>
      current.get(name) === REMOVAL_IN_FLIGHT ? new Map(current).set(name, latest.current) : current
    );
  useEffect(() => {
    latest.current = snapshot;
    setRemoved((current) => {
      const next = new Map([...current].filter(([, seen]) => seen === REMOVAL_IN_FLIGHT || seen === snapshot));
      return next.size === current.size ? current : next;
    });
  }, [snapshot]);
  return { removed, markRemoving, forgetRemoved, settleRemoved };
}

export function McpPanel({ data, pending, run, confirm, refreshExtensions, createOpen, closeCreate }: PanelContext) {
  const status = record(data.mcp);
  const oauthLogin = useMcpOAuthLogin({ run, refreshExtensions });
  const { removed, markRemoving, forgetRemoved, settleRemoved } = useRemovalTombstones(data.mcp);
  const listed = rows(status, 'servers').filter((server) => server.source !== 'plugin');
  const servers = listed.filter((server) => !removed.has(String(server.name)));
  const busy = Boolean(pending);
  const [editor, setEditor] = useState<{ name: string; server: RecordValue | null } | null>(null);
  const openName = editor?.name || '';
  const openServer = editor?.server || null;
  const openRow = servers.find((server) => String(server.name) === openName);
  const liveOpenServer = openServer && withLiveMcpStatus(openServer, openRow);
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
      description: t('{{name}} will be removed.', { name }),
      confirmLabel: t('Remove'),
      danger: true,
      onConfirm: async () => {
        setEditor((current) => (current?.name === name ? null : current));
        markRemoving(name);
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
          onProbe={(config) => probeMcpAuth(run, config)}
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
          onSave={async (payload) => {
            const saved = await run('saveMcpServer', [payload], 'saveMcpServer', true, false, 'throw');
            if (saved === undefined) return;
            closeEditor();
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

function useSkillCategoryOpen(): [(sourceKey: string) => boolean, (sourceKey: string) => void] {
  const [map, setMap] = useState<OpenMap>(() => readOpenMap(window.localStorage, SKILL_CATEGORY_OPEN_KEY));
  const toggle = (sourceKey: string) =>
    setMap((current) => {
      const next = toggleOpen(current, sourceKey);
      writeOpenMap(window.localStorage, SKILL_CATEGORY_OPEN_KEY, next);
      return next;
    });
  return [(sourceKey) => isOpen(map, sourceKey), toggle];
}

function skillRowStatus(
  row: SkillSourceRow,
  shared: ReadonlySet<string>,
  sourceLabel: (sourceKey: string) => string
): { tag: SidebarResourceTag | null; note: string } {
  if (row.state === 'off') return { tag: { label: t('Disabled'), tone: 'muted' }, note: '' };
  if (row.state === 'hidden') {
    return {
      tag: { label: t('Overridden'), tone: 'muted' },
      note: t('In use: {{source}}', { source: sourceLabel(row.hiddenBy) }),
    };
  }
  return {
    tag: isSharedSkill(shared, row) ? { label: t('In use'), tone: 'ok' } : null,
    note: row.replacesBuiltin ? t('Replaces the built-in skill') : '',
  };
}

/** One source's skill: the row opens its card, the switch turns that source's
 *  skill on or off. The status line names what is in use instead. */
function SkillSourceRowView({
  row,
  sourceLabel,
  status,
  on,
  busy,
  onOpen,
  onMenu,
  onToggle,
}: {
  row: SkillSourceRow;
  sourceLabel: string;
  status: { tag: SidebarResourceTag | null; note: string };
  on: boolean;
  busy: boolean;
  onOpen(): void;
  onMenu(point: { x: number; y: number }): void;
  onToggle(on: boolean): void;
}) {
  const off = row.state === 'off';
  const description = skillDisplayDescription(row.record).trim() || t('Skill instructions');
  return (
    <div
      className="schedules-row utilities-row skills-row"
      data-extension-row={row.name}
      data-skill-key={row.key}
      data-skill-state={row.state}
      data-enabled={off ? 'false' : 'true'}
      {...contextMenuRowProps(onMenu)}
    >
      <button
        type="button"
        className="skills-row-open"
        aria-label={row.name}
        data-tooltip={description}
        disabled={busy}
        onClick={onOpen}
      >
        <span className="extensions-row-icon sidebar-resource-icon" aria-hidden="true">
          <CapabilityIcon name={row.name} />
        </span>
        <span className="schedules-row-copy utilities-row-copy">
          <SidebarResourceTitle label={row.name} tag={status.tag} />
          {status.note ? <small className="skills-row-note">{status.note}</small> : null}
        </span>
      </button>
      <CompactSwitch
        label={`${row.name} · ${sourceLabel} · ${t('Enabled')}`}
        checked={on}
        optimistic={false}
        disabled={busy || !row.switchable}
        onChange={onToggle}
      />
    </div>
  );
}

/** The user's own skills, then each plugin's, one category per source. A
 *  skill another source's skill of the same name hides is listed too; built-in
 *  skills are listed only while the disabled list turns them off. */
export function SkillsPanel({
  api,
  data,
  pending,
  run,
  confirm,
  refreshExtensions,
  createOpen,
  closeCreate,
  openCreate,
}: PanelContext) {
  const status = record(data.skills);
  const all = skillSourceRows(status);
  const shared = sharedSkillNames(all);
  const busy = Boolean(pending);
  const [sameNamesOnly, setSameNamesOnly] = useState(false);
  const filtering = sameNamesOnly && shared.size > 0;
  const [categoryOpen, toggleCategory] = useSkillCategoryOpen();
  const pluginLabels = new Map(
    rows(record(data.plugins), 'plugins').map((plugin) => [String(plugin.id || plugin.name || ''), label(plugin)])
  );
  const sourceLabel = (sourceKey: string) => {
    if (sourceKey === OWN_SKILLS) return t('My skills');
    if (isBuiltinSource(sourceKey)) return t('Built-in');
    const id = pluginIdOf(sourceKey);
    return pluginLabels.get(id) || id;
  };
  const categories = skillCategories(all)
    .map((category) => ({
      ...category,
      rows: filtering ? category.rows.filter((row) => isSharedSkill(shared, row)) : category.rows,
    }))
    .filter((category) => category.rows.length > 0 || (!filtering && category.sourceKey === OWN_SKILLS));
  const [detail, setDetail] = useState<{ key: string; name: string; content: string | null } | null>(null);
  // A switched row shows the asked value only until the core replies; then it
  // shows the refreshed row, which may still be off for another reason.
  const [switching, setSwitching] = useState<Readonly<Record<string, boolean>>>({});
  const toggle = (row: SkillSourceRow, on: boolean) => {
    setSwitching((current) => ({ ...current, [row.key]: on }));
    void run('setSkillEnabled', [row.key, on]).finally(() => setSwitching(({ [row.key]: _done, ...rest }) => rest));
  };
  const shownOn = (row: SkillSourceRow) => switching[row.key] ?? row.state !== 'off';
  const open = detail ? all.find((row) => row.key === detail.key) : undefined;
  const openDetail = (row: SkillSourceRow) => {
    const { key, name } = row;
    closeCreate?.();
    setDetail({ key, name, content: null });
    void refreshExtensions();
    void run<RecordValue>('skillContent', [key], `skill-content-${key}`, false).then((value) => {
      setDetail((current) => {
        if (current?.key !== key) return current;
        return value === undefined ? null : { key, name, content: String(record(value).content || '') };
      });
    });
  };
  const [menu, setMenu] = useState<ScmContextMenuState | null>(null);
  const openMenu = (row: SkillSourceRow, point: { x: number; y: number }) => {
    const off = !shownOn(row);
    const toggleLabel = off ? t('Enable') : t('Disable');
    setMenu({
      label: row.name,
      ...point,
      items: [
        { id: 'open', label: t('Open'), onSelect: () => window.setTimeout(() => openDetail(row), 0) },
        ...(row.switchable ? [{ id: 'toggle', label: toggleLabel, onSelect: () => toggle(row, off) }] : []),
        ...(row.editable
          ? [
              {
                id: 'remove',
                label: t('Delete'),
                danger: true,
                separatorBefore: true,
                onSelect: () => window.setTimeout(() => confirmRemove(row), 0),
              },
            ]
          : []),
      ],
    });
  };
  const confirmRemove = ({ key, name }: SkillSourceRow) =>
    confirm({
      title: t('Delete skill?'),
      description: t('{{name}} will be deleted from your skills.', { name }),
      confirmLabel: t('Delete'),
      danger: true,
      onConfirm: () => {
        setDetail((current) => (current?.key === key ? null : current));
        void run('removeSkill', [{ name }]);
      },
    });
  const save = async (payload: RecordValue) => {
    const capability = detail ? 'saveSkill' : 'addSkill';
    const value = await run<RecordValue>(capability, [payload]);
    if (value === undefined) return;
    setDetail(null);
    closeCreate?.();
    // A required-tools save of a read-only skill sends no name: the open row has it.
    const name = String(payload.name || detail?.name || '');
    showDesktopToast(t('Saved "{{name}}".', { name }), 'success');
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
      {!sectionLoaded(data, 'skills') && all.length === 0 ? (
        <ListEmpty text={t('Loading skills…')} />
      ) : (
        <>
          {shared.size > 0 && (
            // biome-ignore lint/a11y/useSemanticElements: a fieldset's default border and padding would change the segmented control; only the group role is wanted
            <div className="skills-filter" role="group" aria-label={t('Skill filter')}>
              <button type="button" aria-pressed={!filtering} onClick={() => setSameNamesOnly(false)}>
                {t('All')}
              </button>
              <button type="button" aria-pressed={filtering} onClick={() => setSameNamesOnly(true)}>
                {t('Same names only')}
              </button>
            </div>
          )}
          {categories.map((category) => {
            const name = sourceLabel(category.sourceKey);
            const expanded = categoryOpen(category.sourceKey);
            return (
              <section
                key={category.sourceKey}
                className="skills-category"
                data-skill-source={category.sourceKey}
                aria-label={name}
              >
                <div className="sidebar-category-header">
                  <button
                    type="button"
                    className="sidebar-recent-heading sidebar-heading-toggle"
                    aria-expanded={expanded}
                    onClick={toggleHeading(() => toggleCategory(category.sourceKey))}
                  >
                    <span>{name}</span>
                    <small>{category.rows.length}</small>
                    {expanded ? (
                      <ChevronDown size={12} aria-hidden="true" />
                    ) : (
                      <ChevronRight size={12} aria-hidden="true" />
                    )}
                  </button>
                </div>
                {expanded && (
                  <div className="skills-category-list">
                    {category.rows.length === 0 && (
                      <button
                        type="button"
                        className="schedules-row utilities-row skills-row skills-invite"
                        disabled={busy}
                        onClick={() => openCreate?.()}
                      >
                        <span className="extensions-row-icon sidebar-resource-icon" aria-hidden="true">
                          <Plus size={16} />
                        </span>
                        <span className="schedules-row-copy utilities-row-copy">
                          <SidebarResourceTitle label={t('Add skill')} />
                          <small className="skills-row-note">{t('Skills you create appear here.')}</small>
                        </span>
                      </button>
                    )}
                    {category.rows.map((row) => (
                      <SkillSourceRowView
                        key={row.key}
                        row={row}
                        sourceLabel={name}
                        status={skillRowStatus(row, shared, sourceLabel)}
                        on={shownOn(row)}
                        busy={busy}
                        onOpen={() => openDetail(row)}
                        onMenu={(point) => openMenu(row, point)}
                        onToggle={(on) => toggle(row, on)}
                      />
                    ))}
                  </div>
                )}
              </section>
            );
          })}
        </>
      )}
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
          key={detail.key}
          skill={open.record}
          tools={rows(status, 'tools')}
          instructions={detail.content}
          disabled={!shownOn(open)}
          busy={busy}
          readOnly={!open.editable}
          scopeField={
            open.sourceKey === OWN_SKILLS ? (
              <ExtensionScopeField
                api={api}
                run={run}
                kind="skills"
                name={detail.name}
                {...scopeOf(open.record)}
                currentPath={currentProjectPath(data)}
                busy={busy}
              />
            ) : undefined
          }
          onClose={() => setDetail(null)}
          onSave={(payload) => void save(payload)}
          onToggle={open.switchable ? () => toggle(open, !shownOn(open)) : undefined}
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
    description: t('{{name}} will be removed.', { name: label(plugin) }),
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
