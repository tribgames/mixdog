import { Blocks, ChevronRight, Plug, Sparkles } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { t } from '../i18n';
import { CapabilityIcon } from '../CapabilityIcon';
import { skillDisplayDescription } from '../skill-presentation';
import { showDesktopToast } from '../notifications';
import { record } from '../record-utils';
import { useRemoteHostOpenAccess } from '../remote-host-access';
import { SidebarLoadingDialog } from '../sidebar-dialog';
import { BuiltInFeaturesPanel } from './built-in-features-panel';
import { PluginInfo } from './plugin-info';
import { SkillEditorDialog, useSkillToolLinks } from './skill-editor';
import { CompactSwitch, Group, ListEmpty } from './capability-controls';
import { label, rows, sectionLoaded, type PanelContext, type RecordValue } from './capability-data';
import {
  currentProjectPath,
  ExtensionAction,
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
import { McpEditorDialog, mcpRowDescription, mcpStatus } from './mcp-editor-dialog';
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

type SkillExtensionCreateKind = 'skill' | 'mcp';

function SkillExtensionCreateDialog({
  onClose,
  onSelect,
}: {
  onClose(): void;
  onSelect(kind: SkillExtensionCreateKind): void;
}) {
  return (
    <ExtensionDetailDialog
      width="compact"
      className="extensions-create-dialog"
      titleId="extensions-create-dialog-title"
      title={t('Add skill or MCP')}
      onClose={onClose}
    >
      <div className="extensions-create-options">
        <button type="button" data-extension-create-kind="skill" onClick={() => onSelect('skill')}>
          <Sparkles size={18} aria-hidden="true" />
          <span>
            <b>{t('Skill')}</b>
            <small>{t('Instructions that define how this skill works.')}</small>
          </span>
          <ChevronRight size={16} aria-hidden="true" />
        </button>
        <button type="button" data-extension-create-kind="mcp" onClick={() => onSelect('mcp')}>
          <Plug size={18} aria-hidden="true" />
          <span>
            <b>{t('MCP')}</b>
            <small>{t('How Mixdog connects to this MCP server.')}</small>
          </span>
          <ChevronRight size={16} aria-hidden="true" />
        </button>
      </div>
    </ExtensionDetailDialog>
  );
}

export function McpPanel({ api, data, pending, run, confirm, createOpen, closeCreate }: PanelContext) {
  const status = record(data.mcp);
  const servers = rows(status, 'servers').filter((server) => server.source !== 'plugin');
  const busy = Boolean(pending);
  const [editor, setEditor] = useState<{ name: string; server: RecordValue | null } | null>(null);
  const openName = editor?.name || '';
  const openServer = editor?.server || null;
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
          onClose={() => closeCreate?.()}
          onSave={(payload) => {
            closeCreate?.();
            void run('saveMcpServer', [payload]);
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
          />
        );
      })}
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
          server={openServer}
          busy={busy}
          onClose={closeEditor}
          scopeField={
            <ExtensionScopeField
              api={api}
              run={run}
              kind="mcp"
              name={openName}
              {...scopeOf(servers.find((server) => String(server.name) === openName) || openServer)}
              currentPath={currentProjectPath(data)}
              busy={busy}
            />
          }
          onSave={(payload) => {
            closeEditor();
            void run('saveMcpServer', [payload]);
          }}
          onToggle={() => {
            const enabled = openServer.enabled !== false;
            void run('setMcpServerEnabled', [openName, !enabled]);
          }}
          onRemove={() =>
            confirm({
              title: t('Remove MCP server?'),
              description: t('{{name}} will be removed from Mixdog.', { name: openName }),
              confirmLabel: t('Remove'),
              danger: true,
              onConfirm: () => {
                const name = openName;
                closeEditor();
                void run('removeMcpServer', [name]);
              },
            })
          }
        />
      )}
    </Group>
  );
}

function SkillsPanel({ api, data, pending, run, createOpen, closeCreate }: PanelContext) {
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
    void run<RecordValue>('skillContent', [name], `skill-content-${name}`, false).then((value) => {
      setDetail((current) => {
        if (current?.name !== name) return current;
        return value === undefined ? null : { name, content: String(record(value).content || '') };
      });
    });
  };
  const save = async (payload: RecordValue) => {
    const capability = detail ? 'saveSkill' : 'addSkill';
    const value = await run<RecordValue>(capability, [payload]);
    if (value === undefined) return;
    setDetail(null);
    closeCreate?.();
    showDesktopToast(t('Saved "{{name}}".', { name: String(payload.name || '') }), 'success');
  };
  return (
    <Group title={t('Skills')}>
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
      {skills.length === 0 && (
        <ListEmpty text={sectionLoaded(data, 'skills') ? t('No skills found.') : t('Loading skills…')} />
      )}
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
          />
        );
      })}
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

function pluginSkillRows(data: PanelContext['data'], pluginId: string): RecordValue[] {
  return rows(record(data.skills), 'skills').filter(
    (skill) => record(skill.owner).kind === 'plugin' && String(record(skill.owner).id || '') === pluginId
  );
}

function pluginMcpServers(data: PanelContext['data'], plugin: RecordValue): RecordValue[] {
  const base = String(plugin.mcpServerName || '');
  if (!base) return [];
  return rows(record(data.mcp), 'servers').filter(
    (server) => String(server.name) === base || String(server.name).startsWith(`${base}--`)
  );
}

function PluginDetailDialog({
  plugin: open,
  api,
  data,
  busy,
  run,
  confirm,
  openSkillTools,
  onClose,
}: Pick<PanelContext, 'api' | 'data' | 'run' | 'confirm'> & {
  plugin: RecordValue;
  busy: boolean;
  openSkillTools(name: string): void;
  onClose(): void;
}) {
  const id = String(open.id || open.name);
  const skills = pluginSkillRows(data, id);
  const servers = pluginMcpServers(data, open);
  const disabledSkills = disabledSkillNames(data);
  const contents = skills.length + servers.length;
  // Adding or reconfiguring an MCP server writes its config, which is host-only
  // on an older host.
  useRemoteHostOpenAccess();
  const remote = capabilityBlockedRemotely('saveMcpServer');
  // Footer keeps the plugin's real actions only — Remove (parked left),
  // Update, and Reconfigure MCP when the plugin ships one. The root path and
  // MCP name sit in Info as selectable text.
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
            onClick={() =>
              confirm({
                title: t('Remove plugin?'),
                description: t('{{name}} will be removed from Mixdog.', { name: label(open) }),
                confirmLabel: t('Remove'),
                danger: true,
                onConfirm: () => {
                  onClose();
                  void run('removePlugin', [open]);
                },
              })
            }
          >
            {t('Remove')}
          </button>
          {remote && Boolean(open.mcpScript) && <small className="extensions-note">{manageOnHostNote()}</small>}
          {Boolean(open.mcpScript && open.mcpEnabled) && (
            <button type="button" disabled={busy || remote} onClick={() => void run('enablePluginMcp', [open])}>
              {t('Reconfigure MCP')}
            </button>
          )}
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
      <ExtensionSection title={t('Contents')} count={contents}>
        {contents > 0 && (
          <ExtensionItemList>
            {skills.map((skill) => {
              const name = String(skill.name);
              const off = disabledSkills.has(name);
              return (
                <ExtensionItemRow
                  key={`skill:${name}`}
                  icon={<CapabilityIcon name={name} size={16} />}
                  title={name}
                  description={skillDisplayDescription(skill).trim()}
                  tone={off ? 'off' : 'ok'}
                  control={
                    <>
                      <ExtensionAction disabled={busy} onClick={() => openSkillTools(name)}>
                        {t('Required tools')}
                      </ExtensionAction>
                      <CompactSwitch
                        label={`${name} · ${t('Enabled')}`}
                        checked={!off}
                        disabled={busy}
                        onChange={(next) => saveSkillEnabled(run, disabledSkills, name, next)}
                      />
                    </>
                  }
                />
              );
            })}
            {servers.map((server) => {
              const name = String(server.name);
              const enabled = server.enabled !== false;
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
                      checked={enabled}
                      disabled={busy}
                      onChange={(next) => void run('setMcpServerEnabled', [name, next])}
                    />
                  }
                />
              );
            })}
          </ExtensionItemList>
        )}
        {Boolean(open.mcpScript && !open.mcpEnabled) && (
          <ExtensionItemList>
            <ExtensionItemRow
              icon={<Plug size={16} aria-hidden="true" />}
              title={String(open.mcpServerName || t('MCP server'))}
              description={t('This plugin ships an MCP server. Enable MCP to connect it.')}
              tone="muted"
              control={
                remote ? (
                  <ExtensionNote>{manageOnHostNote()}</ExtensionNote>
                ) : (
                  <ExtensionAction disabled={busy} onClick={() => void run('enablePluginMcp', [open])}>
                    {t('Enable MCP')}
                  </ExtensionAction>
                )
              }
            />
          </ExtensionItemList>
        )}
        {!contents && !(open.mcpScript && !open.mcpEnabled) && (
          <ExtensionNote>{t('Nothing installed by this plugin yet.')}</ExtensionNote>
        )}
      </ExtensionSection>
      <PluginInfo plugin={open} />
    </ExtensionDetailDialog>
  );
}

function PluginsPanel({ api, data, pending, run, confirm, createOpen, closeCreate }: PanelContext) {
  const { openSkillTools, skillToolsDialog } = useSkillToolLinks({ data, pending, run });
  const status = record(data.plugins);
  const plugins = rows(status, 'plugins');
  const busy = Boolean(pending);
  const [openId, setOpenId] = useState('');
  const open = openId ? plugins.find((plugin) => String(plugin.id || plugin.name) === openId) : undefined;
  return (
    <Group title={t('Plugins')}>
      {skillToolsDialog}
      {createOpen && (
        <PluginInstallDialog
          busy={busy}
          onClose={() => closeCreate?.()}
          onSubmit={(source) => void run('addPlugin', [source])}
        />
      )}
      {plugins.length === 0 && (
        <ListEmpty text={sectionLoaded(data, 'plugins') ? t('No plugins installed.') : t('Loading plugins…')} />
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
            status={!enabled ? { label: t('Disabled'), tone: 'muted' } : null}
            enabled={enabled}
            busy={busy}
            onOpen={() => setOpenId(id)}
          />
        );
      })}
      {open && (
        <PluginDetailDialog
          plugin={open}
          api={api}
          data={data}
          busy={busy}
          run={run}
          confirm={confirm}
          openSkillTools={openSkillTools}
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
  const { createOpen, closeCreate } = context;
  const [createKind, setCreateKind] = useState<SkillExtensionCreateKind | null>(null);
  useEffect(() => {
    if (!createOpen) setCreateKind(null);
  }, [createOpen]);
  const closeCreateFlow = () => {
    setCreateKind(null);
    closeCreate?.();
  };
  return (
    <>
      {createOpen && !createKind && <SkillExtensionCreateDialog onClose={closeCreateFlow} onSelect={setCreateKind} />}
      <SkillsPanel {...context} createOpen={createKind === 'skill'} closeCreate={closeCreateFlow} />
      <McpPanel {...context} createOpen={createKind === 'mcp'} closeCreate={closeCreateFlow} />
    </>
  );
}
