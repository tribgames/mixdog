// The chat side of connectors: the connect card a `setup connect_connector`
// call leaves in the conversation ("Slack 연결 · 연결"), running the same
// one-click flow as Extensions → 커넥터, and the Agents pane's "커넥터" pill
// with the marks of the connected services.
import { Link } from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import { connectorAppPasswordOnly, connectorById } from '../../../../src/runtime/shared/connector-catalog.mjs';
import {
  appPasswordAccount,
  cancelConnectorLogin,
  CONNECTORS_CHANGED_EVENT,
  connectCatalogConnector,
  finishConnectorLogin,
  needsOwnGoogleClient,
  openConnectorsTab,
  ownGoogleClientNote,
  readMcpStatus,
  retireConnectorLogin,
  useConnectorLogin,
} from './connector-connect';
import { ConnectorIcon } from './connector-icon';
import { ConnectorLoginDialogs } from './connector-login-dialogs';
import { connectorIdentity, connectorRowView } from './connectors-model';
import { ConnectorStep } from './connector-step';
import { flattenedToolActivityItems } from './transcript-tool-core';
import type { TranscriptItem } from './desktop-types';
import { errorMessage } from './editor-pane-session-errors';
import { t } from './i18n';
import { showDesktopToast } from './notifications';
import { subscribeSetupChanges } from './setup-change-refresh';
import { capabilityBlockedRemotely, manageOnHostNote } from './settings/remote-capability-guard';
import './starter-guide.css';
import './desktop/extension-dialog.css';

type Row = Record<string, unknown>;

/** The catalog ids a tool round asks to connect (setup connect_connector). */
export function connectorCardIds(items: readonly TranscriptItem[]): string[] {
  const ids: string[] = [];
  for (const item of flattenedToolActivityItems(items)) {
    if (item.name !== 'setup') continue;
    const args = (item.args && typeof item.args === 'object' ? item.args : {}) as Row;
    const id = typeof args.connector === 'string' ? args.connector : '';
    if (args.action === 'connect_connector' && connectorById(id) && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

/** The host's MCP rows, re-read whenever a connector or setup change lands. */
function useMcpServers(): Row[] | null {
  return useMcpStatus().servers;
}

/** The host's MCP rows plus whether this build has the built-in Google client. */
function useMcpStatus(): { servers: Row[] | null; googleClient: boolean } {
  const [servers, setServers] = useState<Row[] | null>(null);
  const [googleClient, setGoogleClient] = useState(true);
  useEffect(() => {
    let live = true;
    const read = () =>
      void readMcpStatus()
        .then((next) => {
          if (!live) return;
          setServers(next.servers);
          setGoogleClient(next.googleClient);
        })
        .catch(() => undefined);
    read();
    window.addEventListener(CONNECTORS_CHANGED_EVENT, read);
    const unsubscribe = subscribeSetupChanges(read);
    return () => {
      live = false;
      window.removeEventListener(CONNECTORS_CHANGED_EVENT, read);
      unsubscribe();
    };
  }, []);
  return { servers, googleClient };
}

export function ConnectorChatCard({ id }: { id: string }) {
  const entry = connectorById(id);
  const { servers, googleClient } = useMcpStatus();
  const server = servers?.find((row) => row.connector === id && row.source !== 'plugin') ?? null;
  const name = server ? String(server.name) : '';
  const login = useConnectorLogin(name, id);
  // The same one state as the 커넥터 row.
  const view = connectorRowView(server, login);
  const listConnected = server?.connected === true;
  useEffect(() => {
    if (view.finished && name) finishConnectorLogin(name);
    else if (view.justConnected && listConnected) retireConnectorLogin(name);
  }, [view.finished, view.justConnected, listConnected, name]);
  if (!entry) return null;
  const connected = view.status === 'connected';
  const waiting = view.status === 'pending';
  const appPasswordOnly = connectorAppPasswordOnly(entry) && (!server || Boolean(appPasswordAccount(server)));
  // Judged on the selected server (the one Connect would use), once the host has answered.
  const ownClient = !appPasswordOnly && servers !== null && needsOwnGoogleClient(entry, server, googleClient);
  const connect = () => {
    if (capabilityBlockedRemotely('beginMcpOAuthLogin')) {
      showDesktopToast(manageOnHostNote(), 'info');
      return;
    }
    // A key, an app password or the user's own Google client happens on the 커넥터 tab.
    if (entry.backend.kind !== 'oauth' || appPasswordOnly || ownClient) {
      openConnectorsTab();
      return;
    }
    connectCatalogConnector(entry).catch((reason) => showDesktopToast(errorMessage(reason), 'error'));
  };
  let line: ReactNode = appPasswordOnly
    ? t('Connect with an app password on the Connectors tab')
    : ownClient
      ? ownGoogleClientNote()
      : entry.backend.kind === 'oauth'
        ? t('Sign in in the browser')
        : t('Finish on the Connectors tab');
  if (waiting) line = <ConnectorStep view={view} connector={entry.id} />;
  else if (connected) line = connectorIdentity(server) || name;
  else if (view.status === 'failed') line = view.error;
  else if (server?.authRequired === true && !ownClient) line = t('Sign-in required');
  return (
    // biome-ignore lint/a11y/useSemanticElements: a <div> card; role="group" names it.
    <div
      className="connector-chat-card"
      role="group"
      aria-label={t('Connect {{name}}', { name: entry.name })}
      data-connector-card={id}
    >
      <ConnectorIcon id={entry.id} name={entry.name} className="connector-tile-card" />
      <span className="connector-chat-copy">
        <b>{t('Connect {{name}}', { name: entry.name })}</b>
        <small>{line}</small>
      </span>
      {connected ? (
        <span className="sidebar-resource-tag" data-tone="ok">
          {t('Connected')}
        </span>
      ) : waiting ? (
        <button type="button" className="extensions-action" onClick={() => cancelConnectorLogin(name, id)}>
          {t('Cancel')}
        </button>
      ) : (
        <button type="button" className="extensions-action" onClick={connect}>
          {view.status === 'failed' ? t('Try again') : t('Connect')}
        </button>
      )}
      <ConnectorLoginDialogs />
    </div>
  );
}

/** Agents pane foot, above 시작 가이드: "커넥터" with the connected services'
 *  marks overlapped; opens the 커넥터 tab. */
export function ConnectorsPill() {
  const servers = useMcpServers();
  const connected = (servers ?? [])
    .map((row) => (row.connected === true && row.source !== 'plugin' ? connectorById(row.connector) : null))
    .filter((entry, index, all): entry is NonNullable<typeof entry> => Boolean(entry) && all.indexOf(entry) === index)
    .sort((a, b) => a.name.localeCompare(b.name));
  const shown = connected.slice(0, 4);
  return (
    <section className="starter-guide connectors-pill" aria-label={t('Connectors')}>
      <div className="starter-guide-pill">
        <button type="button" className="starter-guide-toggle" onClick={openConnectorsTab}>
          <Link size={14} aria-hidden="true" />
          <span className="starter-guide-title">{t('Connectors')}</span>
          <span className="connectors-pill-state">
            {shown.length > 0 && (
              <span className="connectors-pill-logos" aria-hidden="true">
                {shown.map((entry) => (
                  <ConnectorIcon key={entry.id} id={entry.id} name={entry.name} className="connector-tile-pill" />
                ))}
              </span>
            )}
            <span className="connectors-pill-status" data-connected={connected.length > 0 ? 'true' : 'false'}>
              {connected.length > 0 ? t('{{count}} connected', { count: connected.length }) : t('Connect now')}
            </span>
          </span>
        </button>
      </div>
    </section>
  );
}
