// The Ports panel of a server window: what listens on the server, the ports
// forwarded to this PC (127.0.0.1 only), and new ports offered for forwarding.
// The list is scanned while the panel is visible and on demand; forwards are
// pushed by main as they start, fail or stop.
import { ExternalLink, Plus, RefreshCw, Square } from 'lucide-react';
import { useCallback, useEffect, useState, type FormEvent } from 'react';

import type { DesktopPortForward, DesktopServerPort, DesktopServerPortsView } from '../shared/contract-server-ports';
import { isConnectionDown, useConnectionLink } from './connection-link-store';
import { desktopConnection } from './desktop-connection';
import { errorMessageText } from './ErrorNotice';
import { t } from './i18n';
import { SidebarPanelAction } from './session-sidebar-sections';
import './settings/settings.css';
import './server-ports.css';

/** How often the server is scanned while the panel is visible. */
export const SERVER_PORTS_POLL_MS = 5_000;

const EMPTY_VIEW: DesktopServerPortsView = { detected: null, forwards: [], suggested: [] };

/** The failure in the user's language; main leads its messages with a code. */
export function serverPortErrorText(reason: unknown): string {
  const message = errorMessageText(reason).replace(/^\w*Error:\s*/, '');
  const code = message.match(/^([a-z-]+):\s*/)?.[1] ?? '';
  const port = message.match(/\b(\d{1,5})\b/)?.[1] ?? '';
  if (code === 'port-privileged') return t('Ports below 1024 on this PC are not used for forwarding.');
  if (code === 'port-busy') return t('Port {{port}} on this PC is already in use.', { port });
  if (code === 'port-invalid') return t('Enter a port between 1 and 65535.');
  if (code === 'port-not-active') return t('This port is not forwarded right now.');
  if (code === 'ssh-unsupported') return t('Port forwarding is only available in server windows.');
  return code ? message.slice(code.length + 1).trim() : message;
}

function forwardStatusText(forward: DesktopPortForward): string {
  if (forward.status === 'active') return t('Forwarding');
  if (forward.status === 'starting') return t('Connecting…');
  return forward.message || t('Forwarding stopped');
}

function useServerPorts(active: boolean, down: boolean) {
  const [view, setView] = useState<DesktopServerPortsView>(EMPTY_VIEW);
  const [scanning, setScanning] = useState(false);
  const scan = useCallback(async () => {
    const api = window.mixdogDesktop;
    if (!api?.listServerPorts) return;
    setScanning(true);
    try {
      setView(await api.listServerPorts(true));
    } catch {
      /* the next scan or push replaces the view */
    } finally {
      setScanning(false);
    }
  }, []);
  useEffect(() => window.mixdogDesktop?.subscribeServerPorts?.((next) => setView(next)) ?? undefined, []);
  useEffect(() => {
    void window.mixdogDesktop
      ?.listServerPorts?.(false)
      .then(setView)
      .catch(() => undefined);
  }, []);
  useEffect(() => {
    if (!active || down) return undefined;
    void scan();
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void scan();
    }, SERVER_PORTS_POLL_MS);
    return () => window.clearInterval(timer);
  }, [active, down, scan]);
  return { view, scan, scanning };
}

function ForwardRow({ forward, onError }: { forward: DesktopPortForward; onError(message: string): void }) {
  const api = window.mixdogDesktop;
  const act = (run: () => Promise<unknown> | undefined) => {
    void Promise.resolve(run()).catch((reason: unknown) => onError(serverPortErrorText(reason)));
  };
  return (
    <div className="conn-row server-port-row server-port-row--forward" data-status={forward.status}>
      <div className="conn-row-text">
        <div className="conn-row-title">
          {/* Server port → port on this PC (127.0.0.1, in the tooltip). */}
          <b title={forward.localPort ? `127.0.0.1:${forward.localPort}` : undefined}>
            {forward.remotePort} → {forward.localPort || '…'}
          </b>
        </div>
        <div className="conn-row-meta" title={forwardStatusText(forward)}>
          <span className={forward.status === 'active' ? 'conn-status--on' : undefined}>
            {forwardStatusText(forward)}
          </span>
        </div>
      </div>
      <div className="conn-row-actions">
        <button
          type="button"
          className="conn-btn conn-btn--sm conn-btn--icon"
          aria-label={t('Open in browser')}
          data-tooltip={t('Open in browser')}
          disabled={forward.status !== 'active'}
          onClick={() => act(() => api?.openServerPortInBrowser?.(forward.remotePort))}
        >
          <ExternalLink size={14} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="conn-btn conn-btn--sm conn-btn--icon"
          aria-label={t('Stop forwarding')}
          data-tooltip={t('Stop forwarding')}
          onClick={() => act(() => api?.stopServerPortForward?.(forward.remotePort))}
        >
          <Square size={12} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}

function DetectedRow({
  port,
  forwarded,
  onForward,
}: {
  port: DesktopServerPort;
  forwarded: boolean;
  onForward(port: number): void;
}) {
  const meta = port.addresses.join(', ');
  return (
    <div className="conn-row server-port-row">
      <span className="conn-tile server-port-number" aria-hidden="true">
        {port.port}
      </span>
      <div className="conn-row-text">
        <div className="conn-row-title">
          <b>{port.process || t('Port {{port}}', { port: port.port })}</b>
        </div>
        <div className="conn-row-meta" title={meta}>
          {meta}
        </div>
      </div>
      <div className="conn-row-actions">
        <button
          type="button"
          className="conn-btn conn-btn--sm"
          disabled={forwarded}
          onClick={() => onForward(port.port)}
        >
          {forwarded ? t('Forwarded') : t('Forward port')}
        </button>
      </div>
    </div>
  );
}

function SuggestedRow({
  port,
  serverName,
  onForward,
  onDismiss,
}: {
  port: number;
  serverName: string;
  onForward(port: number): void;
  onDismiss(port: number): void;
}) {
  return (
    <div className="conn-row server-port-row">
      <span className="conn-tile server-port-number" aria-hidden="true">
        {port}
      </span>
      <div className="conn-row-text">
        <div className="conn-row-title">
          <b>{t('New port on {{name}}', { name: serverName })}</b>
        </div>
        <div className="conn-row-meta">{t('Forward it to open it on this PC.')}</div>
      </div>
      <div className="conn-row-actions">
        <button type="button" className="conn-btn conn-btn--sm conn-btn--primary" onClick={() => onForward(port)}>
          {t('Forward port')}
        </button>
        <button type="button" className="conn-btn conn-btn--sm" onClick={() => onDismiss(port)}>
          {t('Ignore')}
        </button>
      </div>
    </div>
  );
}

function DetectedList({
  view,
  forwarded,
  onForward,
}: {
  view: DesktopServerPortsView;
  forwarded: Set<number>;
  onForward(port: number): void;
}) {
  if (view.scanError) return <p className="conn-field-msg conn-field-msg--error">{view.scanError}</p>;
  if (!view.detected) return <p className="conn-empty">{t('Checking the server’s ports…')}</p>;
  if (view.detected.length === 0) return <p className="conn-empty">{t('Nothing is listening on the server.')}</p>;
  return (
    <div className="conn-list">
      {view.detected.map((port) => (
        <DetectedRow key={port.port} port={port} forwarded={forwarded.has(port.port)} onForward={onForward} />
      ))}
    </div>
  );
}

function ManualForwardForm({ onDone }: { onDone(): void }) {
  const [remote, setRemote] = useState('');
  const [local, setLocal] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const remotePort = Number(remote);
    const localPort = local.trim() ? Number(local) : null;
    setBusy(true);
    setError('');
    void Promise.resolve(window.mixdogDesktop?.forwardServerPort?.(remotePort, localPort))
      .then(() => onDone())
      .catch((reason: unknown) => setError(serverPortErrorText(reason)))
      .finally(() => setBusy(false));
  };
  return (
    <form className="conn-card server-port-form" onSubmit={submit}>
      <label className="conn-field">
        <span>{t('Server port')}</span>
        <input
          className="conn-input"
          inputMode="numeric"
          value={remote}
          onChange={(event) => setRemote(event.target.value.replace(/\D/g, '').slice(0, 5))}
          placeholder="3000"
          // biome-ignore lint/a11y/noAutofocus: the form opens on the user's click to type the port
          autoFocus
        />
      </label>
      <label className="conn-field">
        <span>{t('Port on this PC (optional)')}</span>
        <input
          className="conn-input"
          inputMode="numeric"
          value={local}
          onChange={(event) => setLocal(event.target.value.replace(/\D/g, '').slice(0, 5))}
          placeholder={remote || t('Same as the server')}
        />
      </label>
      {error && <p className="conn-field-msg conn-field-msg--error">{error}</p>}
      <div className="conn-toolbar">
        <button type="button" className="conn-btn conn-btn--sm" onClick={onDone}>
          {t('Cancel')}
        </button>
        <button type="submit" className="conn-btn conn-btn--sm conn-btn--primary" disabled={busy || !remote}>
          {t('Forward port')}
        </button>
      </div>
    </form>
  );
}

export function ServerPortsPanel({ active }: { active: boolean }) {
  const link = useConnectionLink();
  const down = isConnectionDown(link);
  const { view, scan, scanning } = useServerPorts(active, down);
  const [error, setError] = useState('');
  const [adding, setAdding] = useState(false);
  const serverName = desktopConnection()?.name ?? '';
  const forwarded = new Set(view.forwards.map((forward) => forward.remotePort));
  const forward = (port: number) => {
    setError('');
    void Promise.resolve(window.mixdogDesktop?.forwardServerPort?.(port)).catch((reason: unknown) =>
      setError(serverPortErrorText(reason))
    );
  };
  const dismiss = (port: number) => {
    void Promise.resolve(window.mixdogDesktop?.dismissServerPort?.(port)).catch(() => undefined);
  };
  const detected = view.detected ?? [];
  return (
    <div className="server-ports" data-down={down ? 'true' : undefined}>
      <SidebarPanelAction active={active} label={t('Forward a port')} icon={Plus} onClick={() => setAdding(true)} />
      <SidebarPanelAction
        active={active}
        label={t('Check ports again')}
        icon={RefreshCw}
        className={scanning ? 'is-busy' : ''}
        disabled={down}
        onClick={() => void scan()}
      />
      {down && <p className="conn-note">{t('Ports are checked again once the server is connected.')}</p>}
      {adding && <ManualForwardForm onDone={() => setAdding(false)} />}
      {error && (
        <p className="conn-field-msg conn-field-msg--error" role="alert">
          {error}
        </p>
      )}
      {view.suggested.length > 0 && (
        <div className="conn-list server-port-suggestions" role="status">
          {view.suggested.map((port) => (
            <SuggestedRow key={port} port={port} serverName={serverName} onForward={forward} onDismiss={dismiss} />
          ))}
        </div>
      )}
      <section className="conn-group">
        <div className="conn-group-head">
          <h4>
            {t('Forwarded to this PC')}
            <span>{view.forwards.length}</span>
          </h4>
        </div>
        {view.forwards.length ? (
          <div className="conn-list">
            {view.forwards.map((entry) => (
              <ForwardRow key={entry.remotePort} forward={entry} onError={setError} />
            ))}
          </div>
        ) : (
          <p className="conn-empty">{t('No ports are forwarded. Forward one to open it at 127.0.0.1 on this PC.')}</p>
        )}
      </section>
      <section className="conn-group">
        <div className="conn-group-head">
          <h4>
            {t('Listening on {{name}}', { name: serverName })}
            <span>{detected.length}</span>
          </h4>
        </div>
        <DetectedList view={view} forwarded={forwarded} onForward={forward} />
      </section>
    </div>
  );
}
