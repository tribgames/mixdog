import {
  Blocks,
  Check,
  ChevronRight,
  Plug,
  Sparkles,
  X,
} from 'lucide-react';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';

import { t } from '../i18n';
import { ErrorNotice, errorSummary } from '../ErrorNotice';
import { showDesktopToast } from '../notifications';
import { record } from '../record-utils';
import { SidebarLoadingDialog } from '../sidebar-dialog';
import { BuiltInFeaturesPanel } from './built-in-features-panel';
import {
  CompactSwitch,
  Group,
  ListEmpty,
} from './capability-controls';
import {
  label,
  rows,
  sectionLoaded,
  type PanelContext,
  type RecordValue,
} from './capability-data';
import {
  currentProjectPath,
  ExtensionAction,
  ExtensionDetailDialog,
  ExtensionFacts,
  ExtensionField,
  ExtensionItemList,
  ExtensionItemRow,
  ExtensionNote,
  ExtensionRow,
  ExtensionScopeField,
  ExtensionSection,
  scopeOf,
  type ExtensionItemTone,
} from './extension-detail';

function SkillEditorDialog({
  skill,
  instructions,
  disabled,
  busy,
  readOnly = false,
  scopeField,
  onClose,
  onSave,
  onToggle,
}: {
  skill: RecordValue | null;
  instructions: string;
  disabled: boolean;
  busy: boolean;
  readOnly?: boolean;
  scopeField?: ReactNode;
  onClose(): void;
  onSave(payload: RecordValue): void;
  onToggle?(): void;
}) {
  const editing = Boolean(skill);
  const name = String(skill?.name || '');
  const [formError, setFormError] = useState('');
  return <ExtensionDetailDialog width="editor" className="extensions-skill-dialog"
    titleId="extensions-skill-dialog-title"
    icon={<Sparkles size={16} aria-hidden="true" />}
    title={editing ? name : t('Add skill')} onClose={onClose}
    headerControl={editing && onToggle
      ? <CompactSwitch label={`${name} · ${t('Enabled')}`} checked={!disabled}
          disabled={busy} onChange={() => onToggle()} />
      : null}
    onSubmit={(event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (readOnly) return;
      const data = new FormData(event.currentTarget);
      const nextName = String(data.get('skill-name') || '').trim();
      const description = String(data.get('skill-description') || '').trim();
      const whenToUse = String(data.get('skill-trigger') || '').trim();
      const body = String(data.get('skill-instructions') || '').trim();
      if (!body) {
        setFormError('SKILL.md instructions must not be empty.');
        return;
      }
      setFormError('');
      onSave({
        ...(editing ? { originalName: name } : {}),
        name: nextName,
        description,
        whenToUse,
        instructions: body,
      });
    }}
    footer={<>
      {formError && <ErrorNotice error={formError} />}
      <button type="button" className="secondary" disabled={busy} onClick={onClose}>
        {t(readOnly ? 'Close' : 'Cancel')}
      </button>
      {!readOnly && <button type="submit" disabled={busy}>{t('Save')}</button>}
    </>}>
    {editing ? scopeField : null}
    <ExtensionField label={t('Name')} note={t('Shown in skill lists and menus.')}>
      <input name="skill-name" defaultValue={name}
        required autoFocus={!editing} disabled={busy || readOnly} maxLength={64}
        pattern="[a-z0-9]+(?:-[a-z0-9]+)*" />
    </ExtensionField>
    {/* Description and trigger are the two halves of the model's skill
        listing (`description — when_to_use`), cut at 250 characters. The
        description names the capability; the trigger carries the phrases
        and boundary that route the skill. */}
    <ExtensionField label={t('Description')}
      note={t('One sentence on what this skill does. Shown in the skill list.')}>
      <input name="skill-description" defaultValue={String(skill?.description || '')}
        required disabled={busy || readOnly} maxLength={1024} />
    </ExtensionField>
    <ExtensionField className="workflows-md-field extensions-trigger-field" label={t('Trigger')}
      note={t('Phrases and situations that should call this skill, and what it should leave to others.')}>
      <textarea name="skill-trigger" defaultValue={String(skill?.whenToUse || '')}
        disabled={busy || readOnly} maxLength={1024} />
    </ExtensionField>
    <ExtensionField className="workflows-md-field extensions-instructions-field" label={t('Instructions')}
      note={t('Instructions that define how this skill works.')}>
      <textarea name="skill-instructions"
        defaultValue={instructions || (editing ? '' : '# Instructions\n\nDescribe how to use this skill.')}
        required spellCheck={false} disabled={busy || readOnly} />
    </ExtensionField>
  </ExtensionDetailDialog>;
}

function mcpTransport(config: RecordValue): string {
  const explicit = String(config.type || config.transport || '').toLowerCase();
  if (config.autoDetect) return 'autoDetect';
  if (explicit === 'streamable-http' || explicit === 'streamablehttp') return 'http';
  if (explicit === 'stdio') return 'stdio';
  if (['http', 'sse', 'ws'].includes(explicit)) return 'http';
  return config.url ? 'http' : 'stdio';
}

function mcpRowDescription(server: RecordValue): string {
  const nested = record(server.config);
  const config = Object.keys(nested).length ? nested : server;
  const transport = mcpTransport(config);
  if (transport === 'autoDetect') return t('Auto-detect');
  if (transport === 'http') {
    return [t('Streamable HTTP'), String(config.url || '').trim()].filter(Boolean).join(' · ');
  }
  return ['STDIO', String(config.command || '').trim()].filter(Boolean).join(' · ');
}

type McpPair = { key: string; value: string };

function mcpStringValues(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

function mcpPairValues(value: unknown): McpPair[] {
  return Object.entries(record(value)).map(([key, entry]) => ({ key, value: String(entry ?? '') }));
}

function mcpPairRecord(values: McpPair[], field: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const row of values) {
    const key = row.key.trim();
    const value = row.value;
    if (!key && !value.trim()) continue;
    if (!key) throw new Error(`${field} contains a value without a key.`);
    if (Object.prototype.hasOwnProperty.call(result, key)) {
      throw new Error(`${field} contains duplicate key "${key}".`);
    }
    result[key] = value;
  }
  return result;
}

function McpStringListEditor({
  label,
  description,
  values,
  placeholder,
  busy,
  onChange,
}: {
  label: string;
  description: string;
  values: string[];
  placeholder: string;
  busy: boolean;
  onChange(values: string[]): void;
}) {
  const visible = values.length ? values : [''];
  return <fieldset className="extensions-mcp-list">
    <legend>{t(label)}</legend>
    <small>{t(description)}</small>
    <div className="extensions-mcp-list-rows">
      {visible.map((value, index) => <div className="extensions-mcp-list-row" key={`${label}-${index}`}>
        <input value={value} placeholder={placeholder} disabled={busy} spellCheck={false}
          onChange={(event) => {
            const next = [...visible];
            next[index] = event.currentTarget.value;
            onChange(next);
          }} />
        <button type="button" aria-label={t('Remove')} disabled={busy || (!value && values.length === 0)}
          onClick={() => onChange(visible.filter((_, rowIndex) => rowIndex !== index))}>
          <X size={14} aria-hidden="true" />
        </button>
      </div>)}
    </div>
    <button type="button" className="extensions-mcp-list-add" disabled={busy}
      onClick={() => onChange([...visible.filter((value, index) => value || index < values.length), ''])}>
      + {t('Add')}
    </button>
  </fieldset>;
}

function McpPairListEditor({
  label,
  description,
  values,
  keyPlaceholder,
  valuePlaceholder,
  busy,
  onChange,
}: {
  label: string;
  description: string;
  values: McpPair[];
  keyPlaceholder: string;
  valuePlaceholder: string;
  busy: boolean;
  onChange(values: McpPair[]): void;
}) {
  const visible = values.length ? values : [{ key: '', value: '' }];
  return <fieldset className="extensions-mcp-list">
    <legend>{t(label)}</legend>
    <small>{t(description)}</small>
    <div className="extensions-mcp-list-rows">
      {visible.map((row, index) => <div className="extensions-mcp-list-row extensions-mcp-pair-row"
        key={`${label}-${index}`}>
        <input value={row.key} placeholder={keyPlaceholder} disabled={busy} spellCheck={false}
          onChange={(event) => {
            const next = visible.map((entry) => ({ ...entry }));
            next[index].key = event.currentTarget.value;
            onChange(next);
          }} />
        <input value={row.value} placeholder={valuePlaceholder} disabled={busy} spellCheck={false}
          onChange={(event) => {
            const next = visible.map((entry) => ({ ...entry }));
            next[index].value = event.currentTarget.value;
            onChange(next);
          }} />
        <button type="button" aria-label={t('Remove')} disabled={busy || (!row.key && !row.value && values.length === 0)}
          onClick={() => onChange(visible.filter((_, rowIndex) => rowIndex !== index))}>
          <X size={14} aria-hidden="true" />
        </button>
      </div>)}
    </div>
    <button type="button" className="extensions-mcp-list-add" disabled={busy}
      onClick={() => onChange([
        ...visible.filter((row, index) => row.key || row.value || index < values.length),
        { key: '', value: '' },
      ])}>
      + {t('Add')}
    </button>
  </fieldset>;
}

function McpEditorDialog({
  server,
  busy,
  scopeField,
  onClose,
  onSave,
  onToggle,
  onRemove,
}: {
  server: RecordValue | null;
  busy: boolean;
  scopeField?: ReactNode;
  onClose(): void;
  onSave(payload: RecordValue): void;
  onToggle?(): void;
  onRemove?(): void;
}) {
  const editing = Boolean(server);
  const name = String(server?.name || '');
  const config = record(server?.config);
  const initialTransport = mcpTransport(config);
  const [transport, setTransport] = useState(initialTransport);
  const [args, setArgs] = useState(() => mcpStringValues(config.args));
  const [env, setEnv] = useState(() => mcpPairValues(config.env));
  const [envVars, setEnvVars] = useState(() => mcpStringValues(config.env_vars));
  const [headers, setHeaders] = useState(() => mcpPairValues(config.headers));
  const [envHeaders, setEnvHeaders] = useState(() => mcpPairValues(config.env_http_headers));
  const [formError, setFormError] = useState('');
  const autoDetect = initialTransport === 'autoDetect';
  const connection = editing && server ? mcpConnection(server) : null;
  return <ExtensionDetailDialog width="editor" className="extensions-mcp-dialog"
    titleId="extensions-mcp-dialog-title"
    icon={<Plug size={16} aria-hidden="true" />}
    title={editing ? name : t('Add MCP server')} onClose={onClose}
    headerControl={editing && onToggle
      ? <CompactSwitch label={`${name} · ${t('Enabled')}`}
          checked={server?.enabled !== false} disabled={busy}
          onChange={() => onToggle()} />
      : null}
    onSubmit={(event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (autoDetect) return;
      const data = new FormData(event.currentTarget);
      try {
        const payload: RecordValue = {
          ...(editing ? { originalName: name } : {}),
          name: String(data.get('mcp-name') || '').trim(),
          type: transport,
        };
        if (transport === 'stdio') {
          payload.command = String(data.get('mcp-command') || '').trim();
          payload.args = args.map((value) => value.trim()).filter(Boolean);
          payload.env = mcpPairRecord(env, 'Environment');
          payload.env_vars = envVars.map((value) => value.trim()).filter(Boolean);
          payload.cwd = String(data.get('mcp-cwd') || '').trim();
        } else {
          payload.url = String(data.get('mcp-url') || '').trim();
          payload.headers = mcpPairRecord(headers, 'Headers');
          payload.bearer_token_env_var = String(data.get('mcp-bearer-token-env') || '').trim();
          payload.env_http_headers = mcpPairRecord(envHeaders, 'Environment-backed headers');
        }
        setFormError('');
        onSave(payload);
      } catch (error) {
        setFormError(error instanceof Error ? error.message : String(error));
      }
    }}
    footer={<>
      {formError && <ErrorNotice error={formError} />}
      {editing && onRemove && <button type="button" className="danger"
        disabled={busy} onClick={onRemove}>{t('Remove')}</button>}
      <button type="button" className="secondary" disabled={busy} onClick={onClose}>
        {t(autoDetect ? 'Close' : 'Cancel')}
      </button>
      {!autoDetect && <button type="submit" disabled={busy}>{t('Save')}</button>}
    </>}>
    {connection && <ExtensionItemList>
      <ExtensionItemRow icon={<Plug size={15} aria-hidden="true" />} title={t('Connection')}
        description={connection.description} status={connection.status} tone={connection.tone} />
    </ExtensionItemList>}
    {editing ? scopeField : null}
    <ExtensionField label={t('Name')} note={t('Shown in the MCP server list.')}>
      <input name="mcp-name" defaultValue={name}
        required autoFocus={!editing} disabled={busy || autoDetect} maxLength={80}
        pattern="[a-z0-9_.-]+" />
    </ExtensionField>
    <ExtensionField as="div" className="extensions-mcp-transport-field" label={t('Transport')}
      note={t('How Mixdog connects to this MCP server.')}>
      {autoDetect ? <ExtensionNote>{t('Auto-detect')}</ExtensionNote>
        : <div className="extensions-mcp-transport" role="group" aria-label={t('Transport')}>
          <button type="button" className={transport === 'stdio' ? 'active' : ''}
            aria-pressed={transport === 'stdio'} disabled={busy}
            onClick={() => setTransport('stdio')}>
            <Check size={12} aria-hidden="true" />
            <span>{t('stdio')}</span>
          </button>
          <button type="button" className={transport === 'http' ? 'active' : ''}
            aria-pressed={transport === 'http'} disabled={busy}
            onClick={() => setTransport('http')}>
            <Check size={12} aria-hidden="true" />
            <span>{t('Streamable HTTP')}</span>
          </button>
        </div>}
    </ExtensionField>
    {transport === 'stdio' ? <>
      <ExtensionField label={t('Command')} note={t('Executable used to start the stdio server.')}>
        <input name="mcp-command" defaultValue={String(config.command || '')}
          required disabled={busy} spellCheck={false} />
      </ExtensionField>
      <McpStringListEditor label="Arguments" description="One command argument per row."
        values={args} placeholder="--argument" busy={busy} onChange={setArgs} />
      <McpPairListEditor label="Environment" description="Environment variables passed to the server."
        values={env} keyPlaceholder={t('Key')} valuePlaceholder={t('Value')}
        busy={busy} onChange={setEnv} />
      <McpStringListEditor label="Environment passthrough"
        description="Environment variable names inherited by the server."
        values={envVars} placeholder="VARIABLE_NAME" busy={busy} onChange={setEnvVars} />
      <ExtensionField label={t('Working directory')} note={t('Optional directory used when starting the server.')}>
        <input name="mcp-cwd" defaultValue={String(config.cwd || '')}
          placeholder="~/code" disabled={busy} spellCheck={false} />
      </ExtensionField>
    </> : !autoDetect && <>
      <ExtensionField label={t('URL')} note={t('Streamable HTTP server endpoint.')}>
        <input name="mcp-url" type="url" defaultValue={String(config.url || '')}
          required disabled={busy} spellCheck={false} />
      </ExtensionField>
      <ExtensionField label={t('Bearer token environment variable')}
        note={t('Environment variable containing the bearer token. The token is not stored.')}>
        <input name="mcp-bearer-token-env"
          defaultValue={String(config.bearer_token_env_var || '')}
          placeholder="MCP_BEARER_TOKEN"
          disabled={busy} spellCheck={false} />
      </ExtensionField>
      <McpPairListEditor label="Headers" description="HTTP request headers."
        values={headers} keyPlaceholder={t('Key')} valuePlaceholder={t('Value')}
        busy={busy} onChange={setHeaders} />
      <McpPairListEditor label="Environment-backed headers"
        description="Map each HTTP header to an environment variable name."
        values={envHeaders} keyPlaceholder="Header" valuePlaceholder="VARIABLE_NAME"
        busy={busy} onChange={setEnvHeaders} />
    </>}
    {autoDetect && <ExtensionNote>
      {t('Built-in auto-detect servers keep their managed connection settings.')}
    </ExtensionNote>}
  </ExtensionDetailDialog>;
}

/** Connection row at the top of an MCP editor: the transport/endpoint line,
 *  or the failure summary, under one status dot — replacing the bare
 *  "unknown · error" text the editor used to open with. */
function mcpConnection(server: RecordValue): { description: string; status: string; tone: ExtensionItemTone } {
  const enabled = server.enabled !== false;
  const raw = String(server.status || '').trim();
  const connected = server.connected === true || raw.toLowerCase() === 'connected';
  const failed = Boolean(server.error);
  return {
    description: server.error ? errorSummary(server.error) : mcpRowDescription(server),
    status: !enabled ? t('Off')
      : connected ? t('Connected')
      : failed ? t('Failed')
      : raw ? `${raw.charAt(0).toUpperCase()}${raw.slice(1)}` : t('Not connected'),
    tone: !enabled ? 'off' : connected ? 'ok' : failed ? 'warn' : 'muted',
  };
}

function PluginInstallDialog({ busy, onClose, onSubmit }: {
  busy: boolean;
  onClose(): void;
  onSubmit(source: string): void;
}) {
  return <ExtensionDetailDialog width="compact" className="extensions-plugin-dialog"
    titleId="extensions-plugin-dialog-title"
    icon={<Blocks size={16} aria-hidden="true" />}
    title={t('Install plugin')} onClose={onClose}
    onSubmit={(event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const source = String(new FormData(event.currentTarget).get('source') || '').trim();
      if (!source) return;
      onSubmit(source);
      onClose();
    }}
    footer={<>
      <button type="button" className="secondary" disabled={busy} onClick={onClose}>{t('Cancel')}</button>
      <button type="submit" disabled={busy}>{t('Install')}</button>
    </>}>
    <ExtensionField label={t('Source')}>
      <input name="source" placeholder="https://github.com/org/plugin or C:\path"
        required autoFocus disabled={busy} />
    </ExtensionField>
  </ExtensionDetailDialog>;
}

type SkillExtensionCreateKind = 'skill' | 'mcp';

function SkillExtensionCreateDialog({ onClose, onSelect }: {
  onClose(): void;
  onSelect(kind: SkillExtensionCreateKind): void;
}) {
  return <ExtensionDetailDialog width="compact" className="extensions-create-dialog"
    titleId="extensions-create-dialog-title" title={t('Add skill or MCP')} onClose={onClose}>
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
  </ExtensionDetailDialog>;
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
    void run<RecordValue>('getMcpServerConfig', [name], `mcp-config-${name}`, false)
      .then((detail) => setEditor((current) => {
        if (current?.name !== name) return current;
        if (!detail) return null;
        const row = servers.find((server) => String(server.name) === name);
        return { name, server: { ...(row || {}), ...detail } };
      }));
  };
  const closeEditor = () => setEditor(null);
  return <Group title="MCP">
    {createOpen && <McpEditorDialog key="new-mcp" server={null} busy={busy}
      onClose={() => closeCreate?.()}
      onSave={(payload) => {
        closeCreate?.();
        void run('saveMcpServer', [payload]);
      }} />}
    {servers.length ? servers.map((server) => {
      const name = String(server.name);
      const enabled = server.enabled !== false;
      return <ExtensionRow key={name} icon={<Plug size={16} aria-hidden="true" />} title={name}
        description={mcpRowDescription(server)}
        enabled={enabled} busy={busy}
        onOpen={() => openEditor(name)} />;
    }) : <ListEmpty text={sectionLoaded(data, 'mcp')
      ? 'No MCP servers configured.' : 'Loading MCP servers…'} />}
    {editor && !openServer && <SidebarLoadingDialog title={openName} onClose={closeEditor}
      dataAttributes={{ 'data-extension-loading': 'mcp' }} />}
    {openName && openServer && <McpEditorDialog key={openName}
      server={openServer} busy={busy} onClose={closeEditor}
      scopeField={<ExtensionScopeField api={api} run={run} kind="mcp" name={openName}
        {...scopeOf(servers.find((server) => String(server.name) === openName) || openServer)}
        currentPath={currentProjectPath(data)} busy={busy} />}
      onSave={(payload) => {
        closeEditor();
        void run('saveMcpServer', [payload]);
      }}
      onToggle={() => {
        const enabled = openServer.enabled !== false;
        void run('setMcpServerEnabled', [openName, !enabled]);
      }}
      onRemove={() => confirm({
        title: 'Remove MCP server?',
        description: t('{{name}} will be removed from Mixdog.', { name: openName }),
        confirmLabel: 'Remove',
        danger: true,
        onConfirm: () => {
          const name = openName;
          closeEditor();
          void run('removeMcpServer', [name]);
        },
      })} />}
  </Group>;
}

function SkillsPanel({ api, data, pending, run, createOpen, closeCreate }: PanelContext) {
  const status = record(data.skills);
  const skills = rows(status, 'skills').filter((skill) => record(skill.owner).kind !== 'builtin'
    && record(skill.owner).kind !== 'plugin');
  const disabled = new Set((Array.isArray(record(data.disabledSkills).disabled)
    ? record(data.disabledSkills).disabled as unknown[]
    : []).map(String));
  const busy = Boolean(pending);
  const [detail, setDetail] = useState<{ name: string; content: string | null } | null>(null);
  const setEnabled = (name: string, enabled: boolean) => {
    const next = new Set(disabled);
    if (enabled) next.delete(name); else next.add(name);
    void run('setDisabledSkills', [[...next]]);
  };
  const toggle = (name: string) => setEnabled(name, disabled.has(name));
  const open = detail ? skills.find((skill) => String(skill.name) === detail.name) : undefined;
  const openOff = detail ? disabled.has(detail.name) : false;
  const openDetail = (name: string) => {
    closeCreate?.();
    setDetail({ name, content: null });
    void run<RecordValue>('skillContent', [name], `skill-content-${name}`, false)
      .then((value) => {
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
  return <Group title="Skills">
    {createOpen && <SkillEditorDialog skill={null} instructions="" disabled={false} busy={busy}
      onClose={() => closeCreate?.()} onSave={(payload) => void save(payload)} />}
    {skills.length ? skills.map((skill) => {
      const name = String(skill.name);
      const off = disabled.has(name);
      const description = String(skill.description || '').trim() || t('Skill instructions');
      return <ExtensionRow key={name} icon={<Sparkles size={16} aria-hidden="true" />}
        title={name} description={description} enabled={!off}
        busy={busy} onOpen={() => openDetail(name)} />;
    }) : <ListEmpty text={sectionLoaded(data, 'skills')
      ? 'No skills found.' : 'Loading skills…'} />}
    {detail && open && detail.content === null && <SidebarLoadingDialog title={detail.name}
      onClose={() => setDetail(null)} dataAttributes={{ 'data-extension-loading': 'skill' }} />}
    {detail && open && detail.content !== null && <SkillEditorDialog key={detail.name} skill={open}
      instructions={detail.content} disabled={openOff} busy={busy}
      readOnly={open.editable === false}
      scopeField={<ExtensionScopeField api={api} run={run} kind="skills" name={detail.name}
        {...scopeOf(open)} currentPath={currentProjectPath(data)} busy={busy} />}
      onClose={() => setDetail(null)} onSave={(payload) => void save(payload)}
      onToggle={() => toggle(detail.name)} />}
  </Group>;
}

function PluginsPanel({ api, data, pending, run, confirm, createOpen, closeCreate }: PanelContext) {
  const status = record(data.plugins);
  const plugins = rows(status, 'plugins');
  const busy = Boolean(pending);
  const [openId, setOpenId] = useState('');
  const open = openId ? plugins.find((plugin) => String(plugin.id || plugin.name) === openId) : undefined;
  const disabledSkills = new Set((Array.isArray(record(data.disabledSkills).disabled)
    ? record(data.disabledSkills).disabled as unknown[] : []).map(String));
  const ownedSkillRows = (id: string) => rows(record(data.skills), 'skills')
    .filter((skill) => record(skill.owner).kind === 'plugin' && String(record(skill.owner).id || '') === id);
  const ownedMcpServers = (plugin: RecordValue) => {
    const base = String(plugin.mcpServerName || '');
    if (!base) return [];
    return rows(record(data.mcp), 'servers')
      .filter((server) => String(server.name) === base || String(server.name).startsWith(`${base}--`));
  };
  return <Group title="Plugins">
    {createOpen && <PluginInstallDialog busy={busy}
      onClose={() => closeCreate?.()}
      onSubmit={(source) => void run('addPlugin', [source])} />}
    {plugins.length ? plugins.map((plugin) => {
      const id = String(plugin.id || plugin.name);
      const enabled = plugin.enabled !== false;
      const description = String(plugin.description || '').trim()
        || [String(plugin.version || '').trim(), String(plugin.sourceType || plugin.source || '').trim()]
          .filter(Boolean).join(' · ')
        || t('Installed plugin');
      return <ExtensionRow key={id} icon={<Blocks size={16} aria-hidden="true" />} title={label(plugin)}
        description={description}
        enabled={enabled} busy={busy}
        onOpen={() => setOpenId(id)} />;
    }) : <ListEmpty text={sectionLoaded(data, 'plugins')
      ? 'No plugins installed.' : 'Loading plugins…'} />}
    {open && (() => {
      const id = String(open.id || open.name);
      const skills = ownedSkillRows(id);
      const servers = ownedMcpServers(open);
      const contents = skills.length + servers.length;
      const installedAt = formatInstallDate(open.installedAt);
      const updatedAt = formatInstallDate(open.updatedAt);
      // Footer keeps the plugin's real actions only — Remove (parked left),
      // Update, and Reconfigure MCP when the plugin ships one. The Copy
      // buttons are gone: the root path and MCP name sit in Info as
      // selectable text (user: 불필요한 표면 정리).
      return <ExtensionDetailDialog title={label(open)}
        icon={<Blocks size={16} aria-hidden="true" />}
        tagline={String(open.description || '').trim()
          || [String(open.version || '').trim(), String(open.sourceType || '').trim()].filter(Boolean).join(' · ')}
        enabled={open.enabled !== false} busy={busy}
        onToggle={(next) => void run('setPluginEnabled', [open, next])}
        footer={<>
          <button type="button" className="danger" disabled={busy}
            onClick={() => confirm({
              title: 'Remove plugin?',
              description: t('{{name}} will be removed from Mixdog.', { name: label(open) }),
              confirmLabel: 'Remove',
              danger: true,
              onConfirm: () => {
                setOpenId('');
                void run('removePlugin', [open]);
              },
            })}>{t('Remove')}</button>
          {Boolean(open.mcpScript && open.mcpEnabled) && <button type="button" disabled={busy}
            onClick={() => void run('enablePluginMcp', [open])}>
            {t('Reconfigure MCP')}
          </button>}
          <button type="button" disabled={busy} onClick={() => void run('updatePlugin', [open])}>
            {open.sourceType === 'local' ? t('Update metadata') : t('Update plugin')}
          </button>
          <button type="button" className="secondary" onClick={() => setOpenId('')}>{t('Close')}</button>
        </>}
        onClose={() => setOpenId('')}>
        <ExtensionScopeField api={api} run={run} kind="plugins" name={id}
          {...scopeOf(open)} currentPath={currentProjectPath(data)} busy={busy} />
        <ExtensionSection title={t('Contents')} count={contents}>
          {contents ? <ExtensionItemList>
            {skills.map((skill) => {
              const name = String(skill.name);
              const off = disabledSkills.has(name);
              return <ExtensionItemRow key={`skill:${name}`}
                icon={<Sparkles size={15} aria-hidden="true" />}
                title={name} description={String(skill.description || '').trim()}
                tone={off ? 'off' : 'ok'}
                control={<CompactSwitch label={`${name} · ${t('Enabled')}`} checked={!off}
                  disabled={busy} onChange={(next) => {
                    const nextSet = new Set(disabledSkills);
                    if (next) nextSet.delete(name); else nextSet.add(name);
                    void run('setDisabledSkills', [[...nextSet]]);
                  }} />} />;
            })}
            {servers.map((server) => {
              const name = String(server.name);
              const enabled = server.enabled !== false;
              const connected = server.connected === true;
              return <ExtensionItemRow key={`mcp:${name}`}
                icon={<Plug size={15} aria-hidden="true" />}
                title={name} description={mcpRowDescription(server)}
                status={!enabled ? '' : connected ? t('Connected') : String(server.error ? t('Failed') : t('Not connected'))}
                tone={!enabled ? 'off' : connected ? 'ok' : 'warn'}
                control={<CompactSwitch label={`${name} · ${t('Enabled')}`} checked={enabled}
                  disabled={busy} onChange={(next) => void run('setMcpServerEnabled', [name, next])} />} />;
            })}
          </ExtensionItemList> : null}
          {Boolean(open.mcpScript && !open.mcpEnabled) && <ExtensionItemList>
            <ExtensionItemRow icon={<Plug size={15} aria-hidden="true" />}
              title={String(open.mcpServerName || t('MCP server'))}
              description={t('This plugin ships an MCP server. Enable MCP to connect it.')}
              tone="muted"
              control={<ExtensionAction disabled={busy}
                onClick={() => void run('enablePluginMcp', [open])}>{t('Enable MCP')}</ExtensionAction>} />
          </ExtensionItemList>}
          {!contents && !(open.mcpScript && !open.mcpEnabled) && <ExtensionNote>
            {t('Nothing installed by this plugin yet.')}
          </ExtensionNote>}
        </ExtensionSection>
        <ExtensionSection title={t('Info')}>
          <ExtensionFacts facts={[
            ['Version', String(open.version || 'unversioned')],
            ['Source', [String(open.sourceType || ''), String(open.sourceUrl || '')].filter(Boolean).join(' · ')],
            ['Root', String(open.root || '')],
            ['MCP server', String(open.mcpServerName || '')],
            ['Installed', installedAt],
            ['Updated', updatedAt],
          ]} />
        </ExtensionSection>
      </ExtensionDetailDialog>;
    })()}
  </Group>;
}

function formatInstallDate(value: unknown): string {
  const stamp = typeof value === 'number' ? value : Date.parse(String(value || ''));
  if (!Number.isFinite(stamp) || stamp <= 0) return '';
  try {
    return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(stamp));
  } catch {
    return '';
  }
}

export function PluginExtensionsPanel(context: PanelContext) {
  return <>
    <BuiltInFeaturesPanel {...context} />
    <PluginsPanel {...context} />
  </>;
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
  return <>
    {createOpen && !createKind && <SkillExtensionCreateDialog
      onClose={closeCreateFlow} onSelect={setCreateKind} />}
    <SkillsPanel {...context} createOpen={createKind === 'skill'} closeCreate={closeCreateFlow} />
    <McpPanel {...context} createOpen={createKind === 'mcp'} closeCreate={closeCreateFlow} />
  </>;
}
