import { Blocks, Plug } from 'lucide-react';
import { useEffect, useState } from 'react';
import {
  type ConnectorCatalogEntry,
  GMAIL_APP_PASSWORD,
} from '../../shared/core-src/runtime/shared/connector-catalog.mjs';
import {
  announceConnectorsChanged,
  connectCatalogConnector,
  gmailAppPasswordErrorText,
  invoke as invokeCapability,
  readMcpServers,
  startConnectorLogin,
} from '../connector-connect';
import { ConnectorIcon } from '../connector-icon';
import { type ConnectorSourceKind, detectConnectorSource, uniqueServerName } from '../connectors-model';
import { errorMessage } from '../editor-pane-session-errors';
import { applyGoogleOwnKey, parseGoogleClientJson, revertGoogleOwnKey } from '../google-own-key';
import { ErrorNotice } from '../ErrorNotice';
import { t } from '../i18n';
import { showDesktopToast } from '../notifications';
import { record } from '../record-utils';
import {
  ExtensionAction,
  ExtensionDetailDialog,
  ExtensionField,
  ExtensionItemList,
  ExtensionItemRow,
  ExtensionNote,
  ExtensionSection,
} from './extension-detail';
import { mcpErrorSummary, mcpRowDescription, mcpStatus } from './mcp-editor-dialog';
import { PluginInfo } from './plugin-info';
import { label, text, type PanelContext, type RecordValue as Row } from './capability-data';
import { mcpReason } from './connector-rows';
import { openExternalUrl } from './desktop-bridge';

/** "내 Google 키 사용": the user's own Google OAuth client; with it Google
 *  Calendar and Drive appear in the list. The downloaded client_secret_*.json
 *  is picked or pasted. */
export function GoogleOwnKeyDialog({
  active,
  newAccountOf,
  onClose,
}: {
  active: boolean;
  /** Also adds one more account of this connector on the key, then signs it in. */
  newAccountOf: ConnectorCatalogEntry | null;
  onClose(): void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [pasted, setPasted] = useState('');
  const finish = (work: () => Promise<void>, done: string) => {
    setBusy(true);
    setError('');
    work()
      .then(() => {
        announceConnectorsChanged();
        showDesktopToast(done, 'success');
        onClose();
      })
      .catch((reason) => setError(t(errorMessage(reason))))
      .finally(() => setBusy(false));
  };
  const apply = (source: string) =>
    finish(async () => {
      const added = await applyGoogleOwnKey(invokeCapability, parseGoogleClientJson(source), newAccountOf?.id);
      // The new account's server runs on the key now: its sign-in may start.
      if (added && newAccountOf) {
        connectCatalogConnector(newAccountOf, '', null, { server: added }).catch((reason) =>
          showDesktopToast(errorMessage(reason), 'error')
        );
      }
    }, t('Your Google key is in use.'));
  return (
    <ExtensionDetailDialog
      width="compact"
      className="connectors-key-dialog"
      titleId="connectors-google-key-title"
      title={t('Use my Google key')}
      onClose={onClose}
      onSubmit={(event) => {
        event.preventDefault();
        if (pasted.trim()) apply(pasted);
      }}
      footer={
        <>
          {error && <ErrorNotice error={error} />}
          {active && (
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() => finish(() => revertGoogleOwnKey(invokeCapability), t('Back to the Mixdog key.'))}
            >
              {t('Switch back to the Mixdog key')}
            </button>
          )}
          <button type="button" className="secondary" disabled={busy} onClick={onClose}>
            {t('Cancel')}
          </button>
          <button type="submit" disabled={busy || !pasted.trim()}>
            {t('Apply')}
          </button>
        </>
      }
    >
      <ol className="connectors-can-do">
        <li>{t('Create a Google Cloud project and enable the Calendar and Drive APIs.')}</li>
        <li>
          {t('Create an OAuth client of type "Desktop app".')}{' '}
          <button
            type="button"
            className="connectors-link"
            onClick={() => openExternalUrl('https://console.cloud.google.com/apis/credentials')}
          >
            {t('Open Credentials')} ↗
          </button>
        </li>
        <li>
          {t('Add yourself as a test user.')}{' '}
          <button
            type="button"
            className="connectors-link"
            onClick={() => openExternalUrl('https://console.cloud.google.com/auth/audience')}
          >
            {t('Open Audience')} ↗
          </button>
        </li>
        <li>
          {t(
            "Optional: to avoid signing in again every week, press 'Publish app' on the Audience page. It is only for you, so no review is needed; at sign-in, press Advanced → Continue on the 'unverified app' screen."
          )}{' '}
          <button
            type="button"
            className="connectors-link"
            onClick={() => openExternalUrl('https://console.cloud.google.com/auth/audience')}
          >
            {t('Open Audience')} ↗
          </button>
        </li>
        <li>{t('Pick the downloaded client_secret_*.json file.')}</li>
      </ol>
      <ExtensionField label={t('Client file')}>
        <input
          type="file"
          accept=".json,application/json"
          disabled={busy}
          onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            event.currentTarget.value = '';
            if (file) void file.text().then(apply, (reason) => setError(errorMessage(reason)));
          }}
        />
      </ExtensionField>
      <ExtensionField label={t('Or paste the JSON')}>
        <textarea
          rows={3}
          value={pasted}
          onChange={(event) => setPasted(event.currentTarget.value)}
          autoComplete="off"
          spellCheck={false}
          disabled={busy}
        />
      </ExtensionField>
    </ExtensionDetailDialog>
  );
}

/** API-key services: one field and where to get the key. */
export function ConnectorKeySheet({
  entry,
  add = false,
  onClose,
}: {
  entry: ConnectorCatalogEntry;
  /** One more account of the connector, not a reconnect of its first. */
  add?: boolean;
  onClose(): void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const backend = entry.backend.kind === 'apiKey' ? entry.backend : null;
  const connectionString = Boolean(backend?.env?.includes('CONNECTION_STRING'));
  return (
    <ExtensionDetailDialog
      width="compact"
      className="connectors-key-dialog"
      titleId="connectors-key-title"
      icon={<ConnectorIcon id={entry.id} name={entry.name} className="connector-tile-dialog" />}
      title={t('Connect {{name}}', { name: entry.name })}
      onClose={onClose}
      onSubmit={(event) => {
        event.preventDefault();
        const key = String(new FormData(event.currentTarget).get('connector-key') || '').trim();
        if (!key) return;
        setBusy(true);
        setError('');
        connectCatalogConnector(entry, key, null, add ? { add: true } : {})
          .then(onClose)
          .catch((reason) => setError(errorMessage(reason)))
          .finally(() => setBusy(false));
      }}
      footer={
        <>
          {error && <ErrorNotice error={error} />}
          <button type="button" className="secondary" disabled={busy} onClick={onClose}>
            {t('Cancel')}
          </button>
          <button type="submit" disabled={busy}>
            {t('Connect')}
          </button>
        </>
      }
    >
      <ExtensionField label={connectionString ? t('Connection string') : t('API key')}>
        <input
          name="connector-key"
          type={connectionString ? 'text' : 'password'}
          placeholder={backend?.placeholder}
          autoComplete="off"
          spellCheck={false}
          required
          // biome-ignore lint/a11y/noAutofocus: the sheet's only field takes focus on open.
          autoFocus
          disabled={busy}
        />
      </ExtensionField>
      <p className="connectors-hint">
        {t('This service needs a key instead of a sign-in.')}{' '}
        {backend?.keyUrl && (
          <button type="button" className="connectors-link" onClick={() => openExternalUrl(backend.keyUrl)}>
            {t('Where to get a key')} ↗
          </button>
        )}
      </p>
    </ExtensionDetailDialog>
  );
}

export function GmailAppPasswordDialog({
  entry,
  account,
  target,
  onClose,
}: {
  entry: ConnectorCatalogEntry;
  account: string;
  /** The server to reconnect; `{ add: true }` makes one more account. */
  target: { server?: string; add?: boolean };
  onClose(): void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // Opening the dialog opens Google's app-password page in the default browser.
  useEffect(() => {
    openExternalUrl(GMAIL_APP_PASSWORD.helpUrl);
  }, []);
  return (
    <ExtensionDetailDialog
      width="compact"
      className="connectors-key-dialog"
      titleId="connectors-gmail-app-password-title"
      icon={<ConnectorIcon id={entry.id} name={entry.name} className="connector-tile-dialog" />}
      title={t('Connect Gmail with an app password')}
      onClose={onClose}
      onSubmit={(event) => {
        event.preventDefault();
        const form = event.currentTarget;
        const field = form.elements.namedItem('gmail-app-password') as HTMLInputElement | null;
        const email = (form.elements.namedItem('gmail-address') as HTMLInputElement | null)?.value ?? '';
        const password = field?.value ?? '';
        setBusy(true);
        setError('');
        connectCatalogConnector(entry, '', { email, password }, target)
          .then(onClose)
          .catch((reason) => {
            if (field) field.value = '';
            setError(gmailAppPasswordErrorText(reason));
          })
          .finally(() => setBusy(false));
      }}
      footer={
        <>
          {error && <ErrorNotice error={error} />}
          <button type="button" className="secondary" disabled={busy} onClick={onClose}>
            {t('Cancel')}
          </button>
          <button type="submit" disabled={busy}>
            {t('Connect')}
          </button>
        </>
      }
    >
      <ExtensionNote>{t('The Google app password page was opened in your browser.')}</ExtensionNote>
      <ol className="connectors-steps">
        <li>
          <div className="connectors-step-body">
            <b>{t('Create an app password at Google')}</b>
            <p className="connectors-hint">
              {t('Enter "Mixdog" as the app name and press Create. 2-Step Verification must be on.')}
            </p>
            <ExtensionAction onClick={() => openExternalUrl(GMAIL_APP_PASSWORD.helpUrl)}>
              {t('Open the app password page')} ↗
            </ExtensionAction>
          </div>
        </li>
        <li>
          <div className="connectors-step-body">
            <b>{t('Paste the address and the 16 characters')}</b>
            <ExtensionField label={t('Gmail address')}>
              <input
                name="gmail-address"
                type="email"
                defaultValue={account}
                placeholder="name@gmail.com"
                autoComplete="username"
                spellCheck={false}
                required
                // biome-ignore lint/a11y/noAutofocus: the dialog's first field takes focus on open.
                autoFocus
                disabled={busy}
              />
            </ExtensionField>
            <ExtensionField label={t('App password')}>
              <input
                name="gmail-app-password"
                type="password"
                placeholder="xxxx xxxx xxxx xxxx"
                autoComplete="off"
                spellCheck={false}
                required
                disabled={busy}
              />
            </ExtensionField>
          </div>
        </li>
      </ol>
    </ExtensionDetailDialog>
  );
}

const KIND_LABEL: Record<ConnectorSourceKind, () => string> = {
  'mcp-url': () => t('Remote MCP server'),
  'mcp-command': () => t('Program on this computer'),
  plugin: () => t('Plugin'),
};

/** "커스텀 커넥터 추가": one field. The paste is detected (never run), a light
 *  choice settles an ambiguous one, and 고급 opens the structured editor. */
export function CustomConnectorDialog({
  taken,
  run,
  onAdvanced,
  onGoogleKey,
  onClose,
}: {
  taken: string[];
  run: PanelContext['run'];
  onAdvanced(): void;
  onGoogleKey(): void;
  onClose(): void;
}) {
  const [value, setValue] = useState('');
  const [choice, setChoice] = useState<ConnectorSourceKind | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const detected = detectConnectorSource(value);
  const options = detected ? [detected.kind, ...detected.alternatives] : [];
  const kind = detected ? (choice && options.includes(choice) ? choice : detected.kind) : null;
  const note =
    kind === 'mcp-url'
      ? t('A remote MCP server. If it needs a sign-in, you are guided right after.')
      : kind === 'mcp-command'
        ? t('An MCP server that runs on this computer.')
        : kind === 'plugin'
          ? t('A plugin. The app installs it and lists its connections.')
          : '';
  const submit = async () => {
    if (!detected || !kind) return;
    setBusy(true);
    setError('');
    try {
      if (kind === 'plugin') {
        await run('addPlugin', [detected.source ?? value.trim()], 'addPlugin', true, false, 'throw');
        onClose();
        return;
      }
      const name = uniqueServerName(detected.name, taken);
      const input =
        kind === 'mcp-url'
          ? { name, type: 'http', url: detected.url }
          : { name, type: 'stdio', command: detected.command, args: detected.args ?? [] };
      await run('addMcpServer', [input], 'addMcpServer', true, false, 'throw');
      onClose();
      const row = (await readMcpServers()).find((server) => server.name === name);
      announceConnectorsChanged();
      if (row?.authRequired === true) await startConnectorLogin(name, name);
      else if (row?.connected === true) showDesktopToast(t('Connected to {{name}}', { name }), 'success');
      else if (row?.error) showDesktopToast(mcpErrorSummary(row.error), 'error');
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  };
  return (
    <ExtensionDetailDialog
      width="compact"
      className="connectors-add-dialog"
      titleId="connectors-add-title"
      icon={<Blocks size={16} aria-hidden="true" />}
      title={t('Add custom connector')}
      onClose={onClose}
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
      footer={
        <>
          {error && <ErrorNotice error={error} />}
          <span className="connectors-footer-spacer">
            <button type="button" className="connectors-link" disabled={busy} onClick={onAdvanced}>
              {t('Advanced')}
            </button>
            <button type="button" className="connectors-link" disabled={busy} onClick={onGoogleKey}>
              {t('Use my Google key')}
            </button>
          </span>
          <button type="button" className="secondary" disabled={busy} onClick={onClose}>
            {t('Cancel')}
          </button>
          <button type="submit" disabled={busy || !kind}>
            {t('Connect')}
          </button>
        </>
      }
    >
      <ExtensionField label={t('Address or command')}>
        <input
          name="connector-source"
          value={value}
          placeholder={t('Paste an address or a command')}
          spellCheck={false}
          autoComplete="off"
          // biome-ignore lint/a11y/noAutofocus: the dialog's only field takes focus on open.
          autoFocus
          disabled={busy}
          onChange={(event) => {
            setValue(event.currentTarget.value);
            setChoice(null);
          }}
        />
      </ExtensionField>
      {options.length > 1 && (
        <div className="connectors-kind-choice" data-connector-choice="">
          <span>{t('What is this?')}</span>
          {/* biome-ignore lint/a11y/useSemanticElements: a div button group; <fieldset> would change the element tag. */}
          <div className="mx-segmented" role="group" aria-label={t('What is this?')}>
            {options.map((option) => (
              <button
                key={option}
                type="button"
                className={kind === option ? 'active' : ''}
                aria-pressed={kind === option}
                disabled={busy}
                onClick={() => setChoice(option)}
              >
                {KIND_LABEL[option]()}
              </button>
            ))}
          </div>
        </div>
      )}
      <p className="connectors-hint" data-connector-detected={kind ?? ''} role="status">
        {note || t('MCP addresses, npx … commands and plugin links all work.')}
      </p>
    </ExtensionDetailDialog>
  );
}

/** "플러그인 삭제…": what goes with the plugin before anything is removed. */
export function PluginRemovalDialog({
  plugin,
  servers,
  busy,
  onConfirm,
  onClose,
}: {
  plugin: Row;
  servers: Row[];
  busy: boolean;
  onConfirm(): void;
  onClose(): void;
}) {
  const managed = plugin.managed !== false;
  const root = text(plugin.root);
  return (
    <ExtensionDetailDialog
      width="compact"
      className="connectors-plugin-removal"
      titleId="connectors-plugin-removal-title"
      icon={<Blocks size={16} aria-hidden="true" />}
      title={t('Remove {{name}}?', { name: label(plugin) })}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="secondary" disabled={busy} onClick={onClose}>
            {t('Cancel')}
          </button>
          <button type="button" className="danger" disabled={busy} onClick={onConfirm}>
            {t('Remove plugin')}
          </button>
        </>
      }
    >
      <ExtensionSection title={t('What is removed')}>
        <ExtensionItemList>
          <ExtensionItemRow
            icon={<Plug size={16} aria-hidden="true" />}
            title={t('Connections')}
            description={servers.length ? servers.map((server) => String(server.name)).join(', ') : t('None')}
          />
          <ExtensionItemRow
            title={t('Hooks')}
            description={plugin.hooks === true ? t('Its hooks stop running.') : t('None')}
          />
          <ExtensionItemRow
            title={t('Files')}
            description={
              managed
                ? t('The folder the app installed is deleted: {{path}}', { path: root })
                : t('Your local folder stays as it is: {{path}}', { path: root })
            }
            tone={managed ? 'warn' : 'muted'}
          />
        </ExtensionItemList>
      </ExtensionSection>
    </ExtensionDetailDialog>
  );
}

/** A plugin that brings MCP: package management (on/off, update, remove with
 *  its impact) and its connections. */
export function ConnectorPluginDialog({
  plugin,
  servers,
  busy,
  locked,
  run,
  onOpenServer,
  onRemove,
  onClose,
}: {
  plugin: Row;
  servers: Row[];
  busy: boolean;
  locked: boolean;
  run: PanelContext['run'];
  onOpenServer(name: string): void;
  onRemove(): void;
  onClose(): void;
}) {
  const problems = (Array.isArray(plugin.mcpErrors) ? plugin.mcpErrors : []).map((error) => {
    const row = record(error);
    return [text(row.key), text(row.message)].filter(Boolean).join(': ');
  });
  return (
    <ExtensionDetailDialog
      className="extensions-plugin-detail-dialog"
      title={label(plugin)}
      icon={<Blocks size={16} aria-hidden="true" />}
      tagline={text(plugin.description) || [text(plugin.version), text(plugin.sourceType)].filter(Boolean).join(' · ')}
      enabled={plugin.enabled !== false}
      busy={busy || locked}
      onToggle={(next) => void run('setPluginEnabled', [plugin, next])}
      footer={
        <>
          <button type="button" className="danger" disabled={busy || locked} onClick={onRemove}>
            {t('Remove plugin…')}
          </button>
          <button type="button" disabled={busy || locked} onClick={() => void run('updatePlugin', [plugin])}>
            {plugin.sourceType === 'local' ? t('Update metadata') : t('Update plugin')}
          </button>
          <button type="button" className="secondary" onClick={onClose}>
            {t('Close')}
          </button>
        </>
      }
      onClose={onClose}
    >
      {problems.map((problem) => (
        <ExtensionNote key={problem} tone="danger">
          {t('MCP problem: {{message}}', { message: problem })}
        </ExtensionNote>
      ))}
      <ExtensionSection title={t('Connections')} count={servers.length}>
        {plugin.enabled === false && servers.length > 0 && (
          <ExtensionNote>{t('Turn the plugin on to connect its MCP servers.')}</ExtensionNote>
        )}
        <ExtensionItemList>
          {servers.map((server) => {
            const status = mcpStatus(server);
            return (
              <ExtensionItemRow
                key={String(server.name)}
                icon={<Plug size={16} aria-hidden="true" />}
                title={String(server.name)}
                description={mcpReason(server) || mcpRowDescription(server)}
                status={status.label}
                tone={status.tone}
                control={
                  <ExtensionAction onClick={() => onOpenServer(String(server.name))}>{t('Details')}</ExtensionAction>
                }
              />
            );
          })}
        </ExtensionItemList>
      </ExtensionSection>
      <PluginInfo plugin={plugin} />
    </ExtensionDetailDialog>
  );
}
