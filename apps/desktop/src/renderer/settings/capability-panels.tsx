import {
  Blocks,
  Check,
  ChevronRight,
  Plug,
  Sparkles,
  X,
} from 'lucide-react';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

import type {
  DesktopApi,
} from '../../shared/contract';
import {
  t,
} from '../i18n';
import { useMobileBack } from '../mobile-back';
import { showDesktopToast } from '../notifications';
import { providerDisplayName } from '../provider-display';
import { acquireTitleBarDim } from '../titlebar-dim';
import { record } from '../record-utils';
import { AboutPanel } from './about-panel';
import { BuiltInFeaturesPanel } from './built-in-features-panel';
import { ConnectionPanel } from './connection-panel';
import { GeneralPanel } from './general-panel';
import { GitPanel } from './git-panel';

import { ActionButton, AutoSaveRow, CompactSwitch, Group, ListEmpty, ResourceRow, ToggleRow } from "./capability-controls";
import {
  currentProjectPath,
  ExtensionDetailDialog,
  ExtensionFacts,
  ExtensionHero,
  ExtensionItemRow,
  ExtensionRow,
  ExtensionScopeField,
  ExtensionSection,
  extensionScopeBadge,
  scopeOf,
} from './extension-detail';
import { durationTextInput, formatDuration, label, rows, sectionError, sectionLoaded, type CapabilityCategory, type PanelContext, type RecordValue } from "./capability-data";
import { ProvidersPanel } from './provider-panel';

export { OAuthControl } from './provider-panel';

export function CategoryPanel({ category, context }: {
  category: CapabilityCategory;
  context: PanelContext;
}) {
  if (category === 'builtins') return <BuiltInFeaturesPanel {...context} />;
  if (category === 'output-style') return <OutputStylePanel {...context} />;
  if (category === 'providers') return <ProvidersPanel {...context} />;
  if (category === 'git') return <GitPanel />;
  if (category === 'mcp') return <McpPanel {...context} />;
  if (category === 'plugins') return <PluginExtensionsPanel {...context} />;
  if (category === 'skills') return <SkillExtensionsPanel {...context} />;
  if (category === 'context') return <ContextPanel {...context} />;
  if (category === 'system') return <SystemPanel {...context} />;
  if (category === 'shortcuts') return <ShortcutsPanel />;
  if (category === 'connection') return <ConnectionPanel api={context.api} />;
  if (category === 'about') return <AboutPanel />;
  return <GeneralPanel {...context} />;
}

// Keybind reference (read-only). Bindings live in App.tsx's
// global keydown handler and the composer key map; keep this list in sync.
const SHORTCUT_GROUPS: ReadonlyArray<readonly [string, ReadonlyArray<readonly [string, string]>]> = [
  ['Project', [
    ['Ctrl+N', 'New task'],
    ['Ctrl+P', 'Quick Open'],
    ['Ctrl+Shift+P', 'Command Palette'],
    ['Ctrl+W', 'Close tab'],
    ['Ctrl+Tab / Ctrl+Shift+Tab', 'Next / previous tab'],
    ['Ctrl+← / →', 'Switch tab / pane'],
    ['Ctrl+↑ / ↓', 'Focus pane above / below'],
    ['Ctrl+B', 'Toggle left side bar'],
    ['Ctrl+Alt+B', 'Toggle right utility panel'],
    ['Ctrl+` / Ctrl+T', 'Toggle terminal panel'],
    ['Ctrl+,', 'Open settings'],
    ['Esc', 'Close menus and popovers'],
  ]],
  ['Editor', [
    ['F2', 'Rename symbol'],
    ['Ctrl+.', 'Quick Fix'],
    ['Shift+Alt+F', 'Format document'],
    ['F12 / Shift+F12', 'Go to definition / references'],
  ]],
  ['Composer', [
    ['Enter', 'Send message'],
    ['Shift+Enter / Ctrl+Enter', 'Insert new line'],
    ['Ctrl+J', 'Insert new line'],
    ['Ctrl+U', 'Delete to line start'],
    ['↑ / ↓', 'Prompt history (empty draft)'],
    ['/', 'Command palette'],
    ['@', 'File and context mentions'],
  ]],
  ['Conversation', [
    ['PageUp / PageDown', 'Scroll conversation'],
    ['Home / End', 'First / latest message'],
  ]],
];

function ShortcutsPanel() {
  return <>
    {SHORTCUT_GROUPS.map(([title, rows]) => <Group key={title} title={title}>
      <div className="settings-shortcut-list">
        {rows.map(([keys, label]) => <div className="settings-shortcut-row" key={keys}>
          <span>{t(label)}</span>
          <kbd>{keys}</kbd>
        </div>)}
      </div>
    </Group>)}
  </>;
}

function ChoicePanel({ title, values, active, pending, emptyText, onChoose }: {
  title: string; values: RecordValue[]; active: string; pending: string; emptyText?: string; onChoose(id: string): void;
}) {
  return <Group title={title}>{values.length ? values.map((entry) => {
    const id = String(entry.id);
    return <ResourceRow key={id} title={label(entry)} description={String(entry.description || entry.source || '')}
      selected={id === active || entry.active === true}
      actions={id !== active && !entry.active && <ActionButton disabled={Boolean(pending)} onClick={() => onChoose(id)}>Choose</ActionButton>} />;
  }) : <ListEmpty text={emptyText || `No ${title.toLowerCase()} available.`} />}</Group>;
}

function OutputStylePanel({ data, pending, run }: PanelContext) {
  const output = record(data.outputStyles);
  const failure = sectionError(data, 'outputStyles');
  return <ChoicePanel title="" values={rows(output, 'styles')}
    active={String(record(output.current).id || output.configured || 'default')} pending={pending}
    emptyText={sectionLoaded(data, 'outputStyles')
      ? 'No output styles available.'
      : (failure ? `Output styles unavailable: ${failure}` : 'Loading output styles…')}
    onChoose={(id) => void run('setOutputStyle', [id])} />;
}

function UpdatePanel({
  data,
  pending,
  run,
  updaterState,
  checkDesktopUpdate,
  installDesktopUpdate,
}: PanelContext) {
  const update = record(data.update);
  const version = 'version' in updaterState
    ? updaterState.version
    : String(update.latestVersion || '');
  const busy = Boolean(pending)
    || updaterState.status === 'checking'
    || updaterState.status === 'downloading'
    || updaterState.status === 'installing';
  const installLabel = updaterState.status === 'ready'
    ? t('Update to v{{version}}', { version: updaterState.version })
    : updaterState.status === 'installing'
      ? t('Installing v{{version}}…', { version: updaterState.version })
      : updaterState.status === 'downloading'
        ? t('Downloading v{{version}}…', { version: updaterState.version })
        : updaterState.status === 'checking'
          ? 'Checking for update…'
          : updaterState.status === 'up-to-date'
            ? 'Up to date'
            : updaterState.status === 'error'
              ? 'Update unavailable'
              : 'Check for update';
  return <Group title="Update">
    <ResourceRow title="Current version" description="Installed Mixdog Desktop version."
      meta={String(update.currentVersion || t('unknown'))} />
    <ResourceRow title="Latest version" meta={version || t('unknown')}
      actions={<ActionButton disabled={busy} onClick={() => void checkDesktopUpdate()}>Check now</ActionButton>} />
    <ToggleRow title="Auto-update" checked={update.autoUpdate === true}
      disabled={busy} onChange={(enabled) => void run('setAutoUpdate', [enabled])} />
    <ResourceRow title="Install update" actions={<ActionButton
      disabled={busy || updaterState.status !== 'ready'}
      onClick={() => void installDesktopUpdate()}>{installLabel}</ActionButton>} />
  </Group>;
}

/** Every extension list row is one drill-in action. Enabled state stays
 *  visible as metadata; its switch lives in the detail surface. */
function SkillEditorDialog({ skill, instructions, disabled, busy, readOnly = false, scopeField, onClose, onSave, onToggle }: {
  skill: RecordValue | null;
  instructions: string;
  disabled: boolean;
  busy: boolean;
  readOnly?: boolean;
  /** Project-scope control; rendered above the fields while editing. */
  scopeField?: ReactNode;
  onClose(): void;
  onSave(payload: RecordValue): void;
  onToggle?(): void;
}) {
  const editing = Boolean(skill);
  const [formError, setFormError] = useState('');
  useMobileBack(true, onClose);
  useEffect(() => acquireTitleBarDim(), []);
  return createPortal(<div className="schedules-dialog-layer"
    onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}
    onKeyDown={(event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }
    }}>
    <section className="schedules-dialog workflows-dialog extensions-skill-dialog"
      role="dialog" aria-modal="true" aria-labelledby="extensions-skill-dialog-title">
      <header>
        <h2 id="extensions-skill-dialog-title">
          {editing ? String(skill?.name || '') : t('Add skill')}
        </h2>
        <div className="schedules-dialog-header-actions">
          {editing && onToggle && <CompactSwitch
            label={`${String(skill?.name || '')} · ${t('Enabled')}`} checked={!disabled}
            disabled={busy} onChange={() => onToggle()} />}
          <button type="button" aria-label={t('Close')} onClick={onClose}>
            <X size={16} aria-hidden="true" />
          </button>
        </div>
      </header>
      <form onSubmit={(event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        if (readOnly) return;
        const data = new FormData(event.currentTarget);
        const name = String(data.get('skill-name') || '').trim();
        const description = String(data.get('skill-trigger') || '').trim();
        const body = String(data.get('skill-instructions') || '').trim();
        if (!body) {
          setFormError('SKILL.md instructions must not be empty.');
          return;
        }
        setFormError('');
        onSave({
          ...(editing ? { originalName: String(skill?.name || '') } : {}),
          name,
          description,
          instructions: body,
        });
      }}>
        {editing ? scopeField : null}
        <label className="schedules-field"><span>{t('Name')}</span>
          <small>{t('Shown in skill lists and menus.')}</small>
          <input name="skill-name" defaultValue={String(skill?.name || '')}
            required autoFocus={!editing} disabled={busy || readOnly} maxLength={64}
            pattern="[a-z0-9]+(?:-[a-z0-9]+)*" />
        </label>
        <label className="schedules-field workflows-md-field extensions-trigger-field">
          <span>{t('Trigger')}</span>
          <small>{t('When should this skill be used?')}</small>
          <textarea name="skill-trigger" defaultValue={String(skill?.description || '')}
            required disabled={busy || readOnly} maxLength={1024} />
        </label>
        <label className="schedules-field workflows-md-field extensions-instructions-field">
          <span>{t('Instructions')}</span>
          <small>{t('Instructions that define how this skill works.')}</small>
          <textarea name="skill-instructions"
            defaultValue={instructions || (editing ? '' : '# Instructions\n\nDescribe how to use this skill.')}
            required spellCheck={false} disabled={busy || readOnly} />
        </label>
        <footer>
          {formError && <p className="schedules-form-error" role="alert">{formError}</p>}
          <button type="button" disabled={busy} onClick={onClose}>{t('Cancel')}</button>
          {!readOnly && <button type="submit" disabled={busy}>{t('Save')}</button>}
        </footer>
      </form>
    </section>
  </div>, document.body);
}

/** Create form for the rail: the panel header's + action opens it above the
 *  list and submitting closes it, so the list is never permanently pushed down
 *  by a form (the settings dialog's multi-column FormRow does not fit 260px). */
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

function McpStringListEditor({ label, description, values, placeholder, busy, onChange }: {
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

function McpPairListEditor({ label, description, values, keyPlaceholder, valuePlaceholder, busy, onChange }: {
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

function McpEditorDialog({ server, busy, scopeField, onClose, onSave, onToggle, onRemove }: {
  server: RecordValue | null;
  busy: boolean;
  /** Project-scope control; rendered under the status line while editing. */
  scopeField?: ReactNode;
  onClose(): void;
  onSave(payload: RecordValue): void;
  onToggle?(): void;
  onRemove?(): void;
}) {
  const editing = Boolean(server);
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
  useMobileBack(true, onClose);
  useEffect(() => acquireTitleBarDim(), []);
  return createPortal(<div className="schedules-dialog-layer"
    onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}
    onKeyDown={(event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }
    }}>
    <section className="schedules-dialog extensions-skill-dialog extensions-mcp-dialog"
      role="dialog" aria-modal="true" aria-labelledby="extensions-mcp-dialog-title">
      <header>
        <h2 id="extensions-mcp-dialog-title">
          {editing ? String(server?.name || '') : t('Add MCP server')}
        </h2>
        <div className="schedules-dialog-header-actions">
          {editing && onToggle && <CompactSwitch
            label={`${String(server?.name || '')} · ${t('Enabled')}`}
            checked={server?.enabled !== false} disabled={busy}
            onChange={() => onToggle()} />}
          <button type="button" aria-label={t('Close')} onClick={onClose}>
            <X size={16} aria-hidden="true" />
          </button>
        </div>
      </header>
      <form onSubmit={(event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        if (autoDetect) return;
        const data = new FormData(event.currentTarget);
        try {
          const name = String(data.get('mcp-name') || '').trim();
          const payload: RecordValue = {
            ...(editing ? { originalName: String(server?.name || '') } : {}),
            name,
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
      }}>
        {editing && <p className="extensions-mcp-summary">
          {String(server?.status || 'unknown')}{server?.error ? ` · ${String(server.error)}` : ''}
        </p>}
        {editing ? scopeField : null}
        <section className="extensions-mcp-card extensions-mcp-identity-card">
          <label className="schedules-field"><span>{t('Name')}</span>
            <small>{t('Shown in the MCP server list.')}</small>
            <input name="mcp-name" defaultValue={String(server?.name || '')}
              required autoFocus={!editing} disabled={busy || autoDetect} maxLength={80}
              pattern="[a-z0-9_.-]+" />
          </label>
          <div className="schedules-field extensions-mcp-transport-field">
            <span>{t('Transport')}</span>
            <small>{t('How Mixdog connects to this MCP server.')}</small>
            {autoDetect ? <p className="extensions-mcp-note">{t('Auto-detect')}</p>
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
          </div>
        </section>
        {transport === 'stdio' ? <section className="extensions-mcp-card extensions-mcp-config-card">
          <label className="schedules-field"><span>{t('Command')}</span>
            <small>{t('Executable used to start the stdio server.')}</small>
            <input name="mcp-command" defaultValue={String(config.command || '')}
              required disabled={busy} spellCheck={false} />
          </label>
          <McpStringListEditor label="Arguments" description="One command argument per row."
            values={args} placeholder="--argument" busy={busy} onChange={setArgs} />
          <McpPairListEditor label="Environment" description="Environment variables passed to the server."
            values={env} keyPlaceholder={t('Key')} valuePlaceholder={t('Value')}
            busy={busy} onChange={setEnv} />
          <McpStringListEditor label="Environment passthrough"
            description="Environment variable names inherited by the server."
            values={envVars} placeholder="VARIABLE_NAME" busy={busy} onChange={setEnvVars} />
          <label className="schedules-field"><span>{t('Working directory')}</span>
            <small>{t('Optional directory used when starting the server.')}</small>
            <input name="mcp-cwd" defaultValue={String(config.cwd || '')}
              placeholder="~/code" disabled={busy} spellCheck={false} />
          </label>
        </section> : !autoDetect && <section className="extensions-mcp-card extensions-mcp-config-card">
          <label className="schedules-field"><span>{t('URL')}</span>
            <small>{t('Streamable HTTP server endpoint.')}</small>
            <input name="mcp-url" type="url" defaultValue={String(config.url || '')}
              required disabled={busy} spellCheck={false} />
          </label>
          <label className="schedules-field"><span>{t('Bearer token environment variable')}</span>
            <small>{t('Environment variable containing the bearer token. The token is not stored.')}</small>
            <input name="mcp-bearer-token-env"
              defaultValue={String(config.bearer_token_env_var || '')}
              placeholder="MCP_BEARER_TOKEN"
              disabled={busy} spellCheck={false} />
          </label>
          <McpPairListEditor label="Headers" description="HTTP request headers."
            values={headers} keyPlaceholder={t('Key')} valuePlaceholder={t('Value')}
            busy={busy} onChange={setHeaders} />
          <McpPairListEditor label="Environment-backed headers"
            description="Map each HTTP header to an environment variable name."
            values={envHeaders} keyPlaceholder="Header" valuePlaceholder="VARIABLE_NAME"
            busy={busy} onChange={setEnvHeaders} />
        </section>}
        {autoDetect && <p className="extensions-mcp-note">
          {t('Built-in auto-detect servers keep their managed connection settings.')}
        </p>}
        <footer>
          {formError && <p className="schedules-form-error" role="alert">{formError}</p>}
          {editing && onRemove && <button type="button" className="danger"
            disabled={busy} onClick={onRemove}>{t('Remove')}</button>}
          <button type="button" disabled={busy} onClick={onClose}>{t('Cancel')}</button>
          {!autoDetect && <button type="submit" disabled={busy}>{t('Save')}</button>}
        </footer>
      </form>
    </section>
  </div>, document.body);
}

function PluginInstallDialog({ busy, onClose, onSubmit }: {
  busy: boolean;
  onClose(): void;
  onSubmit(source: string): void;
}) {
  useMobileBack(true, onClose);
  useEffect(() => acquireTitleBarDim(), []);
  return createPortal(<div className="schedules-dialog-layer"
    onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}
    onKeyDown={(event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }
    }}>
    <section className="schedules-dialog workflows-dialog extensions-plugin-dialog"
      role="dialog" aria-modal="true" aria-labelledby="extensions-plugin-dialog-title">
      <header>
        <h2 id="extensions-plugin-dialog-title">{t('Install plugin')}</h2>
        <div className="schedules-dialog-header-actions">
          <button type="button" aria-label={t('Close')} onClick={onClose}>
            <X size={16} aria-hidden="true" />
          </button>
        </div>
      </header>
      <form onSubmit={(event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        const source = String(new FormData(event.currentTarget).get('source') || '').trim();
        if (!source) return;
        onSubmit(source);
        onClose();
      }}>
        <label className="schedules-field">
          <span>{t('Source')}</span>
          <input name="source" placeholder="https://github.com/org/plugin or C:\path"
            required autoFocus disabled={busy} />
        </label>
        <footer>
          <button type="button" disabled={busy} onClick={onClose}>{t('Cancel')}</button>
          <button type="submit" disabled={busy}>{t('Install')}</button>
        </footer>
      </form>
    </section>
  </div>, document.body);
}

type SkillExtensionCreateKind = 'skill' | 'mcp';

function SkillExtensionCreateDialog({ onClose, onSelect }: {
  onClose(): void;
  onSelect(kind: SkillExtensionCreateKind): void;
}) {
  useMobileBack(true, onClose);
  useEffect(() => acquireTitleBarDim(), []);
  return createPortal(<div className="schedules-dialog-layer"
    onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}
    onKeyDown={(event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }
    }}>
    <section className="schedules-dialog extensions-create-dialog" role="dialog" aria-modal="true"
      aria-labelledby="extensions-create-dialog-title">
      <header>
        <h2 id="extensions-create-dialog-title">{t('Add skill or MCP')}</h2>
        <div className="schedules-dialog-header-actions">
          <button type="button" aria-label={t('Close')} onClick={onClose}>
            <X size={16} aria-hidden="true" />
          </button>
        </div>
      </header>
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
    </section>
  </div>, document.body);
}

function McpPanel({ api, data, pending, run, confirm, createOpen, closeCreate }: PanelContext) {
  const status = record(data.mcp);
  // Plugin-owned servers are installed, shown, and toggled with their plugin
  // (Extensions → Plugins); only standalone user servers are listed here.
  const servers = rows(status, 'servers').filter((server) => server.source !== 'plugin');
  const busy = Boolean(pending);
  const [openName, setOpenName] = useState('');
  const [openServer, setOpenServer] = useState<RecordValue | null>(null);
  const openEditor = async (name: string) => {
    closeCreate?.();
    setOpenName(name);
    setOpenServer(null);
    const detail = await run<RecordValue>('getMcpServerConfig', [name], `mcp-config-${name}`, false);
    if (detail) {
      const row = servers.find((server) => String(server.name) === name);
      setOpenServer({ ...(row || {}), ...detail });
    }
  };
  const closeEditor = () => {
    setOpenName('');
    setOpenServer(null);
  };
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
        description={mcpRowDescription(server)} badge={extensionScopeBadge(server)}
        enabled={enabled} busy={busy}
        onOpen={() => void openEditor(name)} />;
    }) : <ListEmpty text={sectionLoaded(data, 'mcp')
      ? 'No MCP servers configured.' : 'Loading MCP servers…'} />}
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
  // Built-in and plugin skills belong to their feature or plugin: they install,
  // show, and toggle with it under Extensions, so only user skills appear here.
  const skills = rows(status, 'skills').filter((skill) => record(skill.owner).kind !== 'builtin'
    && record(skill.owner).kind !== 'plugin');
  const disabled = new Set((Array.isArray(record(data.disabledSkills).disabled) ? record(data.disabledSkills).disabled as unknown[] : []).map(String));
  const busy = Boolean(pending);
  // User-global skills are editable. Plugin-provided skills use the same detail
  // surface but remain read-only because their installation owns the files.
  const [detail, setDetail] = useState<{ name: string; content: string } | null>(null);
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
    void run<RecordValue>('skillContent', [name], `skill-content-${name}`, false)
      .then((value) => {
        if (value !== undefined) {
          setDetail({ name, content: String(record(value).content || '') });
        }
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
        badge={extensionScopeBadge(skill)}
        busy={busy} onOpen={() => openDetail(name)} />;
    }) : <ListEmpty text={sectionLoaded(data, 'skills')
      ? 'No skills found.' : 'Loading skills…'} />}
    {detail && open && <SkillEditorDialog key={detail.name} skill={open}
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
  // A plugin's skills ride its toggle; they are listed here, not under Skills.
  const ownedSkillRows = (id: string) => rows(record(data.skills), 'skills')
    .filter((skill) => record(skill.owner).kind === 'plugin' && String(record(skill.owner).id || '') === id);
  // The MCP server(s) a plugin installed carry its `plugin-<name>` prefix.
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
        description={description} badge={extensionScopeBadge(plugin)}
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
      return <ExtensionDetailDialog title={label(open)}
        enabled={open.enabled !== false} busy={busy}
        onToggle={(next) => void run('setPluginEnabled', [open, next])}
        actions={<>
        <button type="button" disabled={busy} onClick={() => void run('updatePlugin', [open])}>
          {open.sourceType === 'local' ? t('Update metadata') : t('Update plugin')}
        </button>
        {Boolean(open.mcpScript && open.mcpEnabled) && <button type="button" disabled={busy}
          onClick={() => void run('enablePluginMcp', [open])}>
          {t('Reconfigure MCP')}
        </button>}
        {Boolean(open.root) && <button type="button"
          onClick={() => void navigator.clipboard?.writeText(String(open.root))}>
          {t('Copy root')}
        </button>}
        {Boolean(open.mcpServerName) && <button type="button"
          onClick={() => void navigator.clipboard?.writeText(String(open.mcpServerName))}>
          {t('Copy MCP name')}
        </button>}
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
      </>}
      onClose={() => setOpenId('')}>
        <ExtensionHero icon={<Blocks size={22} aria-hidden="true" />} title={label(open)}
          tagline={String(open.description || '').trim()
            || [String(open.version || '').trim(), String(open.sourceType || '').trim()].filter(Boolean).join(' · ')} />
        <ExtensionScopeField api={api} run={run} kind="plugins" name={id}
          {...scopeOf(open)} currentPath={currentProjectPath(data)} busy={busy} />
        {/* Each bundled skill / MCP server switches on its own here (user:
            플러그인 안에서 연동 필요한 게 있거나 스킬 보고 싶으면 안에서 온오프
            토글 따로), and a shipped-but-unconnected MCP server shows its
            Enable action in the same row instead of the footer. */}
        <ExtensionSection title={t('Contents')} count={contents}>
          {contents ? <div className="extensions-item-list">
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
          </div> : null}
          {Boolean(open.mcpScript && !open.mcpEnabled) && <div className="extensions-item-list">
            <ExtensionItemRow icon={<Plug size={15} aria-hidden="true" />}
              title={String(open.mcpServerName || t('MCP server'))}
              description={t('This plugin ships an MCP server. Enable MCP to connect it.')}
              tone="muted"
              control={<button type="button" className="extensions-item-action" disabled={busy}
                onClick={() => void run('enablePluginMcp', [open])}>{t('Enable MCP')}</button>} />
          </div>}
          {!contents && !(open.mcpScript && !open.mcpEnabled) && <p className="extensions-mcp-note">
            {t('Nothing installed by this plugin yet.')}
          </p>}
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

function PluginExtensionsPanel(context: PanelContext) {
  return <>
    <BuiltInFeaturesPanel {...context} />
    <PluginsPanel {...context} />
  </>;
}

function SkillExtensionsPanel(context: PanelContext) {
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

// Context management (user decision): ONE page owns how a session's context
// evolves — auto-compact, idle auto-clear, and the memory that carries over.
function ContextPanel({ data, pending, run }: PanelContext) {
  const autoClear = record(data.autoClear);
  const compaction = record(data.compaction);
  const providerDefaults = rows(autoClear.providerDefaults);
  const busy = Boolean(pending);
  return <>
    <Group title="Session lifecycle">
      <ToggleRow title="Auto-compact" description="Compact automatically as the active context reaches its limit."
        checked={compaction.auto !== false} disabled={busy} onChange={(enabled) => void run('setCompactionSettings', [{ auto: enabled }])} />
      <ToggleRow title="Auto-clear" description={`Clear idle sessions after ${formatDuration(autoClear.idleMs) || 'the provider default'}.`}
        checked={autoClear.enabled !== false} disabled={busy} onChange={(enabled) => void run('setAutoClear', [{ enabled }])} />
      {providerDefaults.map((entry) => <AutoSaveRow key={String(entry.provider)}
        title={`${providerDisplayName(String(entry.provider || 'default'))} idle window`}
        name="duration" value={durationTextInput(entry.idleMs)} placeholder={durationTextInput(entry.builtInMs)}
        required disabled={busy}
        onSave={(duration) => void run('setAutoClear', [{ provider: entry.provider, duration }], `autoclear-${entry.provider}`)}
        actions={Boolean(entry.custom) && <ActionButton disabled={busy} onClick={() => void run('setAutoClear', [
          { provider: entry.provider, resetProvider: true },
        ], `autoclear-reset-${entry.provider}`)}>Reset</ActionButton>} />)}
    </Group>
  </>;
}

function SystemPanel(context: PanelContext) {
  return SystemPanelBody(context);
}

// Desktop-local power setting (main-process powerSaveBlocker): rides the
// readSettings/updateSetting lane, not an engine capability, so it loads its
// own state. Hidden when the hosting shell exposes no settings surface.
function DesktopPowerGroup() {
  const api = (window as unknown as { mixdogDesktop?: Partial<DesktopApi> }).mixdogDesktop;
  const [keepAwake, setKeepAwake] = useState<boolean | null>(null);
  useEffect(() => {
    let live = true;
    void api?.readSettings?.().then((settings) => {
      if (live) setKeepAwake(settings.keepAwake !== false);
    }).catch(() => {});
    return () => { live = false; };
  }, [api]);
  if (keepAwake === null || !api?.updateSetting) return null;
  return <Group title="Power"
    description="Keep the computer awake while agents are working, so long runs never stall mid-turn.">
    <ToggleRow title="Keep system awake while working" checked={keepAwake}
      onChange={(enabled) => {
        setKeepAwake(enabled);
        void api.updateSetting?.('keepAwake', enabled).catch(() => {});
      }} />
  </Group>;
}

function SystemPanelBody(context: PanelContext) {
  const { pending, run } = context;
  const busy = Boolean(pending);
  return <>
    {/* The remote runtime toggle moved to the session header (user decision):
        a persistent on/off button next to the context indicator. */}
    <UpdatePanel {...context} />
    <DesktopPowerGroup />
    <Group title="Doctor">
      <ResourceRow title="Diagnostics" description="Check the runtime, providers, integrations, and local installation."
        actions={<ActionButton disabled={busy} onClick={() => void run('runDoctor')}>Run doctor</ActionButton>} />
    </Group>
  </>;
}

// Schedules and webhook endpoints both moved to dedicated main-pane pages
// (sidebar → Schedules / Webhooks); the Channels settings page is retired.
