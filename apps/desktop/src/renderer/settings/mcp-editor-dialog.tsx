// MCP server editor: transport/row helpers, the string and pair list editors
// and the create/edit dialog.
import { Check, Plug, X } from 'lucide-react';
import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react';
import { t } from '../i18n';
import { describeError, ErrorNotice, errorSummary } from '../ErrorNotice';
import { errorMessage } from '../editor-pane-session-errors';
import { record } from '../record-utils';
import type { SidebarResourceTagTone } from '../sidebar-resource-row';
import { CompactSwitch } from './capability-controls';
import type { RecordValue } from './capability-data';
import {
  ExtensionAction,
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

/** True when the config already carries its own credentials (a bearer
 *  variable or headers), so explicit OAuth sign-in does not apply. */
function mcpHasConfiguredAuth(config: RecordValue): boolean {
  return Boolean(
    String(config.bearer_token_env_var || '').trim() ||
      Object.keys(record(config.headers)).length ||
      Object.keys(record(config.env_http_headers)).length
  );
}

function validHttpUrl(value: string): boolean {
  try {
    const protocol = new URL(value).protocol;
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

/** Wait after the last keystroke before the add dialog asks the server how it
 *  authenticates. */
const PROBE_TYPING_DELAY_MS = 500;

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
    if (!key) throw new Error(t('{{field}} contains a value without a key.', { field }));
    if (Object.hasOwn(result, key)) {
      throw new Error(t('{{field}} contains duplicate key "{{key}}".', { field, key }));
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
      <legend>{label}</legend>
      <small>{description}</small>
      <div className="extensions-mcp-list-rows">
        {visible.map((value, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: rows are plain strings edited by position and never reorder.
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
      <legend>{label}</legend>
      <small>{description}</small>
      <div className="extensions-mcp-list-rows">
        {visible.map((row, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: rows are key/value pairs edited by position and never reorder.
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
  busy: busyProp,
  readOnly = false,
  scopeField,
  takenNames = [],
  accountOwners = {},
  onClose,
  onSave,
  onToggle,
  onRemove,
  onConnect,
  onDisconnect,
  onProbe,
}: {
  server: RecordValue | null;
  busy: boolean;
  /** A plugin-owned server: its config is shown, never edited here. */
  readOnly?: boolean;
  scopeField?: ReactNode;
  takenNames?: string[];
  /** Connector account name → connector name: the user knows these as accounts, not servers. */
  accountOwners?: Record<string, string>;
  onClose(): void;
  /** A returned promise keeps the dialog open: its rejection shows in the form. */
  onSave(payload: RecordValue): unknown;
  onToggle?(): void;
  onRemove?(): void;
  /** Starts the explicit OAuth login of a saved server. */
  onConnect?(name: string): void;
  /** Deletes the saved OAuth sign-in of a server. */
  onDisconnect?(name: string): void;
  /** Asks a not yet saved HTTP server how it authenticates. */
  onProbe?(config: RecordValue): Promise<RecordValue | undefined>;
}) {
  const editing = Boolean(server);
  // Every field locks with a read-only config; Close stays usable.
  const busy = busyProp || readOnly;
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
  const [url, setUrl] = useState(String(config.url || ''));
  const [bearer, setBearer] = useState(String(config.bearer_token_env_var || ''));
  const autoDetect = initialTransport === 'autoDetect';
  const connection = server ? mcpStatus(server) : null;
  const oauth = record(server?.oauth);
  const signedIn = oauth.signedIn === true;
  // An enabled HTTP server that carries no credentials of its own signs in
  // with explicit OAuth. Anything not connected can retry with Connect, so a
  // failed first login never leaves the server without a way back in.
  const oauthEligible =
    editing &&
    initialTransport === 'http' &&
    server?.enabled !== false &&
    !mcpHasConfiguredAuth(config) &&
    (signedIn || !connection?.connected);
  const oauthActions = oauthEligible;

  // Add dialog: once the URL settles, ask the server how it authenticates.
  const authFilled =
    bearer.trim() !== '' || [...headers, ...envHeaders].some((row) => row.key.trim() !== '' || row.value.trim() !== '');
  const probeUrl =
    !editing && onProbe && transport === 'http' && !authFilled && validHttpUrl(url.trim()) ? url.trim() : '';
  const [probe, setProbe] = useState<{ url: string; auth: string; error: string } | null>(null);
  const [probing, setProbing] = useState(false);
  const [blurTick, setBlurTick] = useState(0);
  const flushProbeRef = useRef(false);
  const probedUrlRef = useRef('');
  const onProbeRef = useRef(onProbe);
  onProbeRef.current = onProbe;
  // biome-ignore lint/correctness/useExhaustiveDependencies: blurTick re-runs the check immediately when the URL field loses focus.
  useEffect(() => {
    const flush = flushProbeRef.current;
    flushProbeRef.current = false;
    setProbing(false);
    if (!probeUrl) {
      probedUrlRef.current = '';
      setProbe(null);
      return undefined;
    }
    if (probedUrlRef.current === probeUrl) return undefined;
    let cancelled = false;
    const timer = window.setTimeout(
      async () => {
        setProbing(true);
        let result: RecordValue | undefined;
        try {
          result = await onProbeRef.current?.({ type: 'http', url: probeUrl });
        } catch (reason) {
          result = { auth: 'unreachable', error: errorMessage(reason) };
        }
        if (cancelled) return;
        setProbing(false);
        if (!result) return;
        probedUrlRef.current = probeUrl;
        setProbe({ url: probeUrl, auth: String(result.auth || ''), error: String(result.error || '') });
      },
      flush ? 0 : PROBE_TYPING_DELAY_MS
    );
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [probeUrl, blurTick]);
  const probeResult = probeUrl && probe?.url === probeUrl ? probe : null;
  const save = (form: HTMLFormElement, connectAfter: boolean) => {
    if (autoDetect) return;
    const data = new FormData(form);
    const fail = (error: unknown) => setFormError(error instanceof Error ? error.message : String(error));
    try {
      const payload: RecordValue = {
        ...(editing ? { originalName: name } : {}),
        name: String(data.get('mcp-name') || '').trim(),
        type: transport,
      };
      if (!editing && Object.hasOwn(accountOwners, String(payload.name))) {
        throw new Error(
          t('The name "{{name}}" is used by a {{connector}} account. Choose another name.', {
            name: String(payload.name),
            connector: accountOwners[String(payload.name)],
          })
        );
      }
      if (!editing && takenNames.includes(String(payload.name))) {
        throw new Error(t('MCP server "{{name}}" already exists.', { name: String(payload.name) }));
      }
      if (transport === 'stdio') {
        payload.command = String(data.get('mcp-command') || '').trim();
        payload.args = args.map((value) => value.trim()).filter(Boolean);
        payload.env = mcpPairRecord(env, t('Environment'));
        payload.env_vars = envVars.map((value) => value.trim()).filter(Boolean);
        payload.cwd = String(data.get('mcp-cwd') || '').trim();
      } else {
        payload.url = String(data.get('mcp-url') || '').trim();
        payload.headers = mcpPairRecord(headers, t('Headers'));
        payload.bearer_token_env_var = String(data.get('mcp-bearer-token-env') || '').trim();
        payload.env_http_headers = mcpPairRecord(envHeaders, t('Environment-backed headers'));
        payload.oauthClientId = String(data.get('mcp-oauth-client-id') || '').trim();
        // Sent only when typed: the host keeps it in the keychain, never here.
        const secret = String(data.get('mcp-oauth-client-secret') || '').trim();
        if (secret) payload.oauthClientSecret = secret;
      }
      setFormError('');
      void Promise.resolve(onSave(payload))
        .then(() => {
          if (connectAfter) onConnect?.(String(payload.name));
        })
        .catch(fail);
    } catch (error) {
      fail(error);
    }
  };
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
      onSubmit={(event) => {
        event.preventDefault();
        save(event.currentTarget, false);
      }}
      footer={
        <>
          {formError && <ErrorNotice error={formError} />}
          {editing && onRemove && !readOnly && (
            <button type="button" className="danger" disabled={busy} onClick={onRemove}>
              {t('Remove')}
            </button>
          )}
          <button type="button" className="secondary" disabled={busyProp} onClick={onClose}>
            {t(autoDetect || readOnly ? 'Close' : 'Cancel')}
          </button>
          {!autoDetect && !readOnly && (
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
            icon={<Plug size={16} aria-hidden="true" />}
            title={t('Connection')}
            description={server.error ? mcpErrorSummary(server.error) : mcpRowDescription(server)}
            tone={connection.tone}
            control={
              oauthActions &&
              (!signedIn ? (
                <ExtensionAction disabled={busy} onClick={() => onConnect?.(name)}>
                  {t('Connect')}
                </ExtensionAction>
              ) : (
                <>
                  <ExtensionAction disabled={busy} onClick={() => onConnect?.(name)}>
                    {t('Reconnect')}
                  </ExtensionAction>
                  <ExtensionAction danger disabled={busy} onClick={() => onDisconnect?.(name)}>
                    {t('Disconnect')}
                  </ExtensionAction>
                </>
              ))
            }
          />
        </ExtensionItemList>
      )}
      {editing ? scopeField : null}
      <ExtensionField
        label={t('Name')}
        note={
          editing
            ? t('The server id stays fixed: agent and project switches refer to it.')
            : t('Shown in the MCP server list.')
        }
      >
        <input
          name="mcp-name"
          defaultValue={name}
          // The id never changes once saved: a rename would orphan the
          // per-agent and per-project connector switches keyed by it.
          readOnly={editing}
          required
          // biome-ignore lint/a11y/noAutofocus: the dialog's first field takes focus when creating.
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
          // biome-ignore lint/a11y/useSemanticElements: a div button group; <fieldset> would change the element tag.
          <div className="mx-segmented extensions-mcp-transport" role="group" aria-label={t('Transport')}>
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
        // Keyed so a transport switch remounts the fields: the stdio and HTTP inputs sit at the same positions.
        <Fragment key="stdio">
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
            label={t('Arguments')}
            description={t('One command argument per row.')}
            values={args}
            placeholder="--argument"
            busy={busy}
            onChange={setArgs}
          />
          <McpPairListEditor
            label={t('Environment')}
            description={t('Environment variables passed to the server.')}
            values={env}
            keyPlaceholder={t('Key')}
            valuePlaceholder={t('Value')}
            busy={busy}
            onChange={setEnv}
          />
          <McpStringListEditor
            label={t('Environment passthrough')}
            description={t('Environment variable names inherited by the server.')}
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
        </Fragment>
      ) : (
        !autoDetect && (
          <Fragment key="http">
            <ExtensionField label={t('URL')} note={t('Streamable HTTP server endpoint.')}>
              <input
                name="mcp-url"
                type="url"
                value={url}
                required
                disabled={busy}
                spellCheck={false}
                onChange={(event) => setUrl(event.currentTarget.value)}
                onBlur={() => {
                  flushProbeRef.current = true;
                  setBlurTick((tick) => tick + 1);
                }}
              />
            </ExtensionField>
            {probeUrl && probing && <ExtensionNote role="status">{t('Checking…')}</ExtensionNote>}
            {probeResult?.auth === 'unreachable' && (
              <ExtensionNote tone="danger" role="status">
                {probeResult.error
                  ? mcpErrorSummary(probeResult.error)
                  : t('Could not verify the connection. Try again.')}
              </ExtensionNote>
            )}
            {probeResult?.auth === 'oauth' && (
              <ExtensionItemList>
                <ExtensionItemRow
                  icon={<Plug size={16} aria-hidden="true" />}
                  title={t('Connection')}
                  description={mcpRowDescription({ type: 'http', url: probeResult.url })}
                  status={t('Sign-in required')}
                  tone="warn"
                  dataAttributes={{ 'data-mcp-oauth-probe': 'oauth' }}
                  control={
                    <ExtensionAction
                      disabled={busy}
                      onClick={(event) => {
                        const form = event.currentTarget.form;
                        if (form?.reportValidity()) save(form, true);
                      }}
                    >
                      {t('Connect')}
                    </ExtensionAction>
                  }
                />
              </ExtensionItemList>
            )}
            <ExtensionField
              label={t('Bearer token environment variable')}
              note={t('Environment variable containing the bearer token. The token is not stored.')}
            >
              <input
                name="mcp-bearer-token-env"
                value={bearer}
                placeholder="MCP_BEARER_TOKEN"
                disabled={busy}
                spellCheck={false}
                onChange={(event) => setBearer(event.currentTarget.value)}
              />
            </ExtensionField>
            <McpPairListEditor
              label={t('Headers')}
              description={t('HTTP request headers.')}
              values={headers}
              keyPlaceholder={t('Key')}
              valuePlaceholder={t('Value')}
              busy={busy}
              onChange={setHeaders}
            />
            <McpPairListEditor
              label={t('Environment-backed headers')}
              description={t('Map each HTTP header to an environment variable name.')}
              values={envHeaders}
              keyPlaceholder={t('Header')}
              valuePlaceholder="VARIABLE_NAME"
              busy={busy}
              onChange={setEnvHeaders}
            />
            <ExtensionField
              label={t('OAuth client ID')}
              note={t('Your own app registered with the service. Empty: Mixdog’s, or one registered automatically.')}
            >
              <input
                name="mcp-oauth-client-id"
                defaultValue={String(config.oauthClientId || '')}
                autoComplete="off"
                disabled={busy}
                spellCheck={false}
              />
            </ExtensionField>
            <ExtensionField
              label={t('OAuth client secret')}
              note={t('Kept in the system keychain. Leave empty to keep the saved one.')}
            >
              <input
                name="mcp-oauth-client-secret"
                type="password"
                autoComplete="off"
                disabled={busy}
                spellCheck={false}
              />
            </ExtensionField>
          </Fragment>
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
  // A server waiting for explicit OAuth sign-in is not a failure.
  if (server.authRequired === true) return { label: t('Sign-in required'), tone: 'warn', connected: false };
  if (server.error) return { label: t('Failed'), tone: 'danger', connected: false };
  // Runtime statuses are English identifiers: only known ones are shown, translated.
  if (raw.toLowerCase() === 'pending') return { label: t('Pending'), tone: 'muted', connected: false };
  return { label: t('Not connected'), tone: 'warn', connected: false };
}

/** The host's error for a sign-in the provider granted without a requested access. */
export function isScopeNotGrantedError(error: unknown): boolean {
  return /MCP OAuth scopeNotGranted/.test(error instanceof Error ? error.message : String(error ?? ''));
}

/** A failure on an MCP row. The shared transport wording names "the provider",
 *  which is wrong for an MCP server, so a connection failure gets a neutral line. */
export function mcpErrorSummary(error: unknown): string {
  // The sign-in succeeded but the provider left a requested access out (an
  // unchecked box on Google's consent screen): oauth-shared.mjs scopeNotGranted.
  if (isScopeNotGrantedError(error)) {
    return t(
      "Google didn't grant the access Mixdog needs. Connect again and check the access box on the Google screen before Continue."
    );
  }
  return describeError(error).kind === 'connection' ? t('Connection failed') : errorSummary(error);
}
