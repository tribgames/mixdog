// MCP server editor: transport/row helpers, the string and pair list editors
// and the create/edit dialog.
import { Check, Plug, X } from 'lucide-react';
import { useState, type FormEvent, type ReactNode } from 'react';
import { t } from '../i18n';
import { ErrorNotice, errorSummary } from '../ErrorNotice';
import { record } from '../record-utils';
import type { SidebarResourceTagTone } from '../sidebar-resource-row';
import { CompactSwitch } from './capability-controls';
import type { RecordValue } from './capability-data';
import {
  ExtensionDetailDialog,
  ExtensionField,
  ExtensionItemList,
  ExtensionItemRow,
  ExtensionNote,
} from './extension-detail';

function mcpTransport(config: RecordValue): string {
  const explicit = String(config.type || config.transport || '').toLowerCase();
  if (config.autoDetect) return 'autoDetect';
  if (explicit === 'streamable-http' || explicit === 'streamablehttp') return 'http';
  if (explicit === 'stdio') return 'stdio';
  if (['http', 'sse', 'ws'].includes(explicit)) return 'http';
  return config.url ? 'http' : 'stdio';
}

export function mcpRowDescription(server: RecordValue): string {
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
    if (Object.hasOwn(result, key)) {
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
  return (
    <fieldset className="extensions-mcp-list">
      <legend>{t(label)}</legend>
      <small>{t(description)}</small>
      <div className="extensions-mcp-list-rows">
        {visible.map((value, index) => (
          <div className="extensions-mcp-list-row" key={`${label}-${index}`}>
            <input
              value={value}
              placeholder={placeholder}
              disabled={busy}
              spellCheck={false}
              onChange={(event) => {
                const next = [...visible];
                next[index] = event.currentTarget.value;
                onChange(next);
              }}
            />
            <button
              type="button"
              aria-label={t('Remove')}
              disabled={busy || (!value && values.length === 0)}
              onClick={() => onChange(visible.filter((_, rowIndex) => rowIndex !== index))}
            >
              <X size={14} aria-hidden="true" />
            </button>
          </div>
        ))}
      </div>
      <button
        type="button"
        className="extensions-mcp-list-add"
        disabled={busy}
        onClick={() => onChange([...visible.filter((value, index) => value || index < values.length), ''])}
      >
        + {t('Add')}
      </button>
    </fieldset>
  );
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
  return (
    <fieldset className="extensions-mcp-list">
      <legend>{t(label)}</legend>
      <small>{t(description)}</small>
      <div className="extensions-mcp-list-rows">
        {visible.map((row, index) => (
          <div className="extensions-mcp-list-row extensions-mcp-pair-row" key={`${label}-${index}`}>
            <input
              value={row.key}
              placeholder={keyPlaceholder}
              disabled={busy}
              spellCheck={false}
              onChange={(event) => {
                const next = visible.map((entry) => ({ ...entry }));
                next[index].key = event.currentTarget.value;
                onChange(next);
              }}
            />
            <input
              value={row.value}
              placeholder={valuePlaceholder}
              disabled={busy}
              spellCheck={false}
              onChange={(event) => {
                const next = visible.map((entry) => ({ ...entry }));
                next[index].value = event.currentTarget.value;
                onChange(next);
              }}
            />
            <button
              type="button"
              aria-label={t('Remove')}
              disabled={busy || (!row.key && !row.value && values.length === 0)}
              onClick={() => onChange(visible.filter((_, rowIndex) => rowIndex !== index))}
            >
              <X size={14} aria-hidden="true" />
            </button>
          </div>
        ))}
      </div>
      <button
        type="button"
        className="extensions-mcp-list-add"
        disabled={busy}
        onClick={() =>
          onChange([
            ...visible.filter((row, index) => row.key || row.value || index < values.length),
            { key: '', value: '' },
          ])
        }
      >
        + {t('Add')}
      </button>
    </fieldset>
  );
}

export function McpEditorDialog({
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
  const connection = server ? mcpStatus(server) : null;
  return (
    <ExtensionDetailDialog
      width="editor"
      className="extensions-mcp-dialog"
      titleId="extensions-mcp-dialog-title"
      icon={<Plug size={16} aria-hidden="true" />}
      title={editing ? name : t('Add MCP server')}
      onClose={onClose}
      titleStatus={connection ? { label: connection.label, tone: connection.tone } : undefined}
      headerControl={
        editing && onToggle ? (
          <CompactSwitch
            label={`${name} · ${t('Enabled')}`}
            checked={server?.enabled !== false}
            disabled={busy}
            onChange={() => onToggle()}
          />
        ) : null
      }
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
      footer={
        <>
          {formError && <ErrorNotice error={formError} />}
          {editing && onRemove && (
            <button type="button" className="danger" disabled={busy} onClick={onRemove}>
              {t('Remove')}
            </button>
          )}
          <button type="button" className="secondary" disabled={busy} onClick={onClose}>
            {t(autoDetect ? 'Close' : 'Cancel')}
          </button>
          {!autoDetect && (
            <button type="submit" disabled={busy}>
              {t('Save')}
            </button>
          )}
        </>
      }
    >
      {connection && server && (
        <ExtensionItemList>
          <ExtensionItemRow
            icon={<Plug size={15} aria-hidden="true" />}
            title={t('Connection')}
            description={server.error ? errorSummary(server.error) : mcpRowDescription(server)}
            tone={connection.tone}
          />
        </ExtensionItemList>
      )}
      {editing ? scopeField : null}
      <ExtensionField label={t('Name')} note={t('Shown in the MCP server list.')}>
        <input
          name="mcp-name"
          defaultValue={name}
          required
          autoFocus={!editing}
          disabled={busy || autoDetect}
          maxLength={80}
          pattern="[a-z0-9_.-]+"
        />
      </ExtensionField>
      <ExtensionField
        as="div"
        className="extensions-mcp-transport-field"
        label={t('Transport')}
        note={t('How Mixdog connects to this MCP server.')}
      >
        {autoDetect && <ExtensionNote>{t('Auto-detect')}</ExtensionNote>}
        {!autoDetect && (
          <div className="extensions-mcp-transport" role="group" aria-label={t('Transport')}>
            <button
              type="button"
              className={transport === 'stdio' ? 'active' : ''}
              aria-pressed={transport === 'stdio'}
              disabled={busy}
              onClick={() => setTransport('stdio')}
            >
              <Check size={12} aria-hidden="true" />
              <span>{t('stdio')}</span>
            </button>
            <button
              type="button"
              className={transport === 'http' ? 'active' : ''}
              aria-pressed={transport === 'http'}
              disabled={busy}
              onClick={() => setTransport('http')}
            >
              <Check size={12} aria-hidden="true" />
              <span>{t('Streamable HTTP')}</span>
            </button>
          </div>
        )}
      </ExtensionField>
      {transport === 'stdio' ? (
        <>
          <ExtensionField label={t('Command')} note={t('Executable used to start the stdio server.')}>
            <input
              name="mcp-command"
              defaultValue={String(config.command || '')}
              required
              disabled={busy}
              spellCheck={false}
            />
          </ExtensionField>
          <McpStringListEditor
            label="Arguments"
            description="One command argument per row."
            values={args}
            placeholder="--argument"
            busy={busy}
            onChange={setArgs}
          />
          <McpPairListEditor
            label="Environment"
            description="Environment variables passed to the server."
            values={env}
            keyPlaceholder={t('Key')}
            valuePlaceholder={t('Value')}
            busy={busy}
            onChange={setEnv}
          />
          <McpStringListEditor
            label="Environment passthrough"
            description="Environment variable names inherited by the server."
            values={envVars}
            placeholder="VARIABLE_NAME"
            busy={busy}
            onChange={setEnvVars}
          />
          <ExtensionField label={t('Working directory')} note={t('Optional directory used when starting the server.')}>
            <input
              name="mcp-cwd"
              defaultValue={String(config.cwd || '')}
              placeholder="~/code"
              disabled={busy}
              spellCheck={false}
            />
          </ExtensionField>
        </>
      ) : (
        !autoDetect && (
          <>
            <ExtensionField label={t('URL')} note={t('Streamable HTTP server endpoint.')}>
              <input
                name="mcp-url"
                type="url"
                defaultValue={String(config.url || '')}
                required
                disabled={busy}
                spellCheck={false}
              />
            </ExtensionField>
            <ExtensionField
              label={t('Bearer token environment variable')}
              note={t('Environment variable containing the bearer token. The token is not stored.')}
            >
              <input
                name="mcp-bearer-token-env"
                defaultValue={String(config.bearer_token_env_var || '')}
                placeholder="MCP_BEARER_TOKEN"
                disabled={busy}
                spellCheck={false}
              />
            </ExtensionField>
            <McpPairListEditor
              label="Headers"
              description="HTTP request headers."
              values={headers}
              keyPlaceholder={t('Key')}
              valuePlaceholder={t('Value')}
              busy={busy}
              onChange={setHeaders}
            />
            <McpPairListEditor
              label="Environment-backed headers"
              description="Map each HTTP header to an environment variable name."
              values={envHeaders}
              keyPlaceholder="Header"
              valuePlaceholder="VARIABLE_NAME"
              busy={busy}
              onChange={setEnvHeaders}
            />
          </>
        )
      )}
      {autoDetect && (
        <ExtensionNote>{t('Built-in auto-detect servers keep their managed connection settings.')}</ExtensionNote>
      )}
    </ExtensionDetailDialog>
  );
}

/** THE connection state for one MCP server: the list row's tag, the editor's
 *  title badge, and a plugin card's bundled-server row all read it, so the same
 *  server can never show two different labels or tones (user: 실패태그 바깥쪽
 *  이랑 팝업안쪽이랑 다르네 — a failure was `danger` in the list and `warn` in
 *  the editor). `connected` lets the list drop the tag on the normal case while
 *  the editor still states it. Transport/endpoint or failure details stay in
 *  the editor body. */
export function mcpStatus(server: RecordValue): { label: string; tone: SidebarResourceTagTone; connected: boolean } {
  const raw = String(server.status || '').trim();
  const connected = server.connected === true || raw.toLowerCase() === 'connected';
  if (server.enabled === false) return { label: t('Disabled'), tone: 'muted', connected: false };
  if (connected) return { label: t('Connected'), tone: 'ok', connected: true };
  if (server.error) return { label: t('Failed'), tone: 'danger', connected: false };
  if (raw) return { label: `${raw.charAt(0).toUpperCase()}${raw.slice(1)}`, tone: 'muted', connected: false };
  return { label: t('Not connected'), tone: 'warn', connected: false };
}
