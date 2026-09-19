import { Blocks, ChevronRight, Plug, Sparkles } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { t } from '../i18n';
import { CapabilityIcon } from '../CapabilityIcon';
import { skillDisplayDescription } from '../skill-presentation';
import { showDesktopToast } from '../notifications';
import { record } from '../record-utils';
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
          autoFocus
          disabled={busy}
        />
      </ExtensionField>
    </ExtensionDetailDialog>
  );
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
          <Sparkles size={17} aria-hidden="true" />
          <span>
            <b>{t('Skill')}</b>
            <small>{t('Instructions that define how this skill works.')}</small>
          </span>
          <ChevronRight size={16} aria-hidden="true" />
        </button>
        <button type="button" data-extension-create-kind="mcp" onClick={() => onSelect('mcp')}>
          <Plug size={17} aria-hidden="true" />
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
  return (
    <Group title="MCP">
      {createOpen && (
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
        <ListEmpty text={sectionLoaded(data, 'mcp') ? 'No MCP servers configured.' : 'Loading MCP servers…'} />
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
            busy={busy}
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
              title: 'Remove MCP server?',
              description: t('{{name}} will be removed from Mixdog.', { name: openName }),
              confirmLabel: 'Remove',
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
  const disabled = new Set(
    (Array.isArray(record(data.disabledSkills).disabled)
      ? (record(data.disabledSkills).disabled as unknown[])
      : []
    ).map(String)
  );
  const busy = Boolean(pending);
  const [detail, setDetail] = useState<{ name: string; content: string | null } | null>(null);
  const setEnabled = (name: string, enabled: boolean) => {
    const next = new Set(disabled);
    if (enabled) next.delete(name);
    else next.add(name);
    void run('setDisabledSkills', [[...next]]);
  };
  const toggle = (name: string) => setEnabled(name, disabled.has(name));
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
    showDesktopToast(`Saved "${String(payload.name || '')}".`, 'success');
  };
  return (
    <Group title="Skills">
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
        <ListEmpty text={sectionLoaded(data, 'skills') ? 'No skills found.' : 'Loading skills…'} />
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

function PluginsPanel({ api, data, pending, run, confirm, createOpen, closeCreate }: PanelContext) {
  const { openSkillTools, skillToolsDialog } = useSkillToolLinks({ data, pending, run });
  const status = record(data.plugins);
  const plugins = rows(status, 'plugins');
  const busy = Boolean(pending);
  const [openId, setOpenId] = useState('');
  const open = openId ? plugins.find((plugin) => String(plugin.id || plugin.name) === openId) : undefined;
  const disabledSkills = new Set(
    (Array.isArray(record(data.disabledSkills).disabled)
      ? (record(data.disabledSkills).disabled as unknown[])
      : []
    ).map(String)
  );
  const ownedSkillRows = (id: string) =>
    rows(record(data.skills), 'skills').filter(
      (skill) => record(skill.owner).kind === 'plugin' && String(record(skill.owner).id || '') === id
    );
  const ownedMcpServers = (plugin: RecordValue) => {
    const base = String(plugin.mcpServerName || '');
    if (!base) return [];
    return rows(record(data.mcp), 'servers').filter(
      (server) => String(server.name) === base || String(server.name).startsWith(`${base}--`)
    );
  };
  return (
    <Group title="Plugins">
      {skillToolsDialog}
      {createOpen && (
        <PluginInstallDialog
          busy={busy}
          onClose={() => closeCreate?.()}
          onSubmit={(source) => void run('addPlugin', [source])}
        />
      )}
      {plugins.length === 0 && (
        <ListEmpty text={sectionLoaded(data, 'plugins') ? 'No plugins installed.' : 'Loading plugins…'} />
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
      {open &&
        (() => {
          const id = String(open.id || open.name);
          const skills = ownedSkillRows(id);
          const servers = ownedMcpServers(open);
          const contents = skills.length + servers.length;
          // Footer keeps the plugin's real actions only — Remove (parked left),
          // Update, and Reconfigure MCP when the plugin ships one. The Copy
          // buttons are gone: the root path and MCP name sit in Info as
          // selectable text (user: 불필요한 표면 정리).
          return (
            <ExtensionDetailDialog
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
                        title: 'Remove plugin?',
                        description: t('{{name}} will be removed from Mixdog.', { name: label(open) }),
                        confirmLabel: 'Remove',
                        danger: true,
                        onConfirm: () => {
                          setOpenId('');
                          void run('removePlugin', [open]);
                        },
                      })
                    }
                  >
                    {t('Remove')}
                  </button>
                  {Boolean(open.mcpScript && open.mcpEnabled) && (
                    <button type="button" disabled={busy} onClick={() => void run('enablePluginMcp', [open])}>
                      {t('Reconfigure MCP')}
                    </button>
                  )}
                  <button type="button" disabled={busy} onClick={() => void run('updatePlugin', [open])}>
                    {open.sourceType === 'local' ? t('Update metadata') : t('Update plugin')}
                  </button>
                  <button type="button" className="secondary" onClick={() => setOpenId('')}>
                    {t('Close')}
                  </button>
                </>
              }
              onClose={() => setOpenId('')}
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
                          icon={<CapabilityIcon name={name} size={15} />}
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
                                onChange={(next) => {
                                  const nextSet = new Set(disabledSkills);
                                  if (next) nextSet.delete(name);
                                  else nextSet.add(name);
                                  void run('setDisabledSkills', [[...nextSet]]);
                                }}
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
                          icon={<Plug size={15} aria-hidden="true" />}
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
                      icon={<Plug size={15} aria-hidden="true" />}
                      title={String(open.mcpServerName || t('MCP server'))}
                      description={t('This plugin ships an MCP server. Enable MCP to connect it.')}
                      tone="muted"
                      control={
                        <ExtensionAction disabled={busy} onClick={() => void run('enablePluginMcp', [open])}>
                          {t('Enable MCP')}
                        </ExtensionAction>
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
        })()}
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
