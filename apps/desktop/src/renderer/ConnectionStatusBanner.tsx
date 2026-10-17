// The connection banner of a server window (reconnecting with its attempt and
// countdown, lost with Reconnect / Close window), the notices main sends once
// attached again, and — in this PC's window — the startup reopening of server
// windows. While the link is down the composer takes no input.
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

import type {
  DesktopConnectionLinkView,
  DesktopConnectionNotice,
  DesktopServerRestoreProgress,
} from '../shared/contract';
import {
  isConnectionDown,
  subscribeConnectionNotices,
  subscribeServerRestore,
  useConnectionLink,
} from './connection-link-store';
import { desktopConnection, isSshConnectionWindow } from './desktop-connection';
import { t } from './i18n';
import { OPEN_CONNECTION_SETTINGS_EVENT } from './remote-claim-events';
import { requestConnectionDialog } from './settings/connection-intent';
import { SshLogDialog } from './settings/ssh-log-dialogs';
import './settings/settings.css';
import './connection-status.css';

function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
}

/** Keeps every composer inert while the link is down, including composers
 *  that mount during the outage. */
function useComposerBlocked(blocked: boolean): void {
  useEffect(() => {
    if (!blocked) return undefined;
    const root = document.documentElement;
    root.dataset.connectionDown = 'true';
    const block = (): void => {
      for (const element of document.querySelectorAll<HTMLElement>('.composer')) element.inert = true;
    };
    block();
    const observer = new MutationObserver(block);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      delete root.dataset.connectionDown;
      for (const element of document.querySelectorAll<HTMLElement>('.composer')) element.inert = false;
    };
  }, [blocked]);
}

function lostDetail(state: Extract<DesktopConnectionLinkView['state'], { status: 'lost' }>): string {
  if (state.code === 'auth') return t('You need to sign in again. Reconnect to sign in from this PC’s window.');
  if (state.settingsRequired) {
    return t('This needs your confirmation. Reconnect from Settings → Connection in this PC’s window.');
  }
  if (state.code === 'unreachable') return t('The server stayed unreachable for too long.');
  if (state.code === 'auto-reconnect-off') return t('Automatic reconnection is off for this server.');
  return state.message;
}

function LinkBanner({ view, serverName }: { view: DesktopConnectionLinkView; serverName: string }) {
  const { state } = view;
  const counting = state.status === 'reconnecting' && state.nextRetryAt !== null;
  const now = useNow(counting);
  const api = window.mixdogDesktop;
  const [logOpen, setLogOpen] = useState(false);
  if (state.status !== 'reconnecting' && state.status !== 'lost') return null;
  const reconnecting = state.status === 'reconnecting';
  let sub: string;
  if (state.status === 'lost') sub = lostDetail(state);
  else if (state.nextRetryAt === null) sub = t('Trying now…');
  else sub = t('Next try in {{seconds}}s', { seconds: Math.max(0, Math.ceil((state.nextRetryAt - now) / 1000)) });
  return (
    <div className="mx-toast conn-link-banner" role={reconnecting ? 'status' : 'alert'} data-state={state.status}>
      <div className="conn-link-copy">
        <b>
          {reconnecting && <span className="conn-spinner" aria-hidden="true" />}
          {reconnecting
            ? t('Reconnecting to {{name}} (attempt {{attempt}})', { name: serverName, attempt: state.attempt })
            : t('Connection to {{name}} lost', { name: serverName })}
        </b>
        <span className="conn-link-sub">{sub}</span>
      </div>
      <div className="conn-link-actions">
        {api?.sshDiagnosticsLog ? (
          <button type="button" className="conn-btn conn-btn--sm" onClick={() => setLogOpen(true)}>
            {t('View log')}
          </button>
        ) : (
          <span className="conn-link-log-slot" />
        )}
        {logOpen &&
          createPortal(
            <SshLogDialog api={api ?? {}} reference="" name={serverName} onClose={() => setLogOpen(false)} />,
            document.body
          )}
        {counting && api?.retryConnectionNow && (
          <button
            type="button"
            className="conn-btn conn-btn--sm conn-btn--primary"
            onClick={() => void api.retryConnectionNow?.()}
          >
            {t('Reconnect now')}
          </button>
        )}
        {state.status === 'lost' && (
          <>
            <button type="button" className="conn-btn conn-btn--sm" onClick={() => void api?.closeConnectionWindow?.()}>
              {t('Close window')}
            </button>
            <button
              type="button"
              className="conn-btn conn-btn--sm conn-btn--primary"
              onClick={() => void api?.retryConnection?.()}
            >
              {t('Reconnect')}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function noticeText(
  notice: DesktopConnectionNotice,
  serverName: string
): { title: string; lines: string[]; tone: string } | null {
  if (notice.kind === 'model-sign-in') {
    return {
      title: t('This PC’s model sign-in has expired'),
      lines: [
        t('The server’s turn uses this PC’s sign-in. Sign in again under Settings → Models in this PC’s window.'),
      ],
      tone: 'error',
    };
  }
  if (notice.kind !== 'reattached') return null;
  const lines: string[] = [];
  if (notice.finished.length) {
    lines.push(t('Finished on the server while away: {{titles}}', { titles: notice.finished.join(', ') }));
  }
  if (notice.continued.length) {
    lines.push(t('Still running on the server: {{titles}}', { titles: notice.continued.join(', ') }));
  }
  if (notice.interruptedModelCalls) lines.push(t('A model call in progress was interrupted. It was not retried.'));
  return { title: t('Reconnected to {{name}}', { name: serverName }), lines, tone: 'success' };
}

function Notices({ serverName }: { serverName: string }) {
  const [notices, setNotices] = useState<Array<{ id: number; notice: DesktopConnectionNotice }>>([]);
  useEffect(() => {
    let next = 0;
    return subscribeConnectionNotices((notice) => {
      if (!noticeText(notice, serverName)) return;
      next += 1;
      const id = next;
      setNotices((current) => [...current.filter((entry) => entry.notice.kind !== notice.kind), { id, notice }]);
    });
  }, [serverName]);
  return (
    <>
      {notices.map(({ id, notice }) => {
        const text = noticeText(notice, serverName);
        if (!text) return null;
        return (
          <div key={id} className="mx-toast conn-link-notice" role="status" data-tone={text.tone}>
            <div className="conn-link-copy">
              <b>{text.title}</b>
              {text.lines.map((line) => (
                <span key={line} className="conn-link-sub">
                  {line}
                </span>
              ))}
            </div>
            <button
              type="button"
              className="mx-toast-close"
              aria-label={t('Dismiss')}
              onClick={() => setNotices((current) => current.filter((entry) => entry.id !== id))}
            >
              ×
            </button>
          </div>
        );
      })}
    </>
  );
}

function ServerWindowStatus() {
  const view = useConnectionLink();
  const serverName = desktopConnection()?.name ?? '';
  useComposerBlocked(isConnectionDown(view));
  return createPortal(
    <div className="conn-link-stack">
      {view && <LinkBanner view={view} serverName={serverName} />}
      <Notices serverName={serverName} />
    </div>,
    document.body
  );
}

const RESTORE_PHASE_LABELS: Record<Exclude<DesktopServerRestoreProgress['phase'], 'ready' | 'failed'>, () => string> = {
  connect: () => t('Reach the server'),
  check: () => t('Check the server'),
  install: () => t('Install Mixdog'),
  start: () => t('Connect'),
};

/** This PC's window: server windows reopening at launch, and the ones that
 *  could not be reopened. */
function ServerRestoreStatus() {
  const [entries, setEntries] = useState<DesktopServerRestoreProgress[]>([]);
  // A server window's Reconnect needs the user (sign in, confirm a key): the
  // connect dialog here runs that attempt and reopens the server in place.
  useEffect(
    () =>
      window.mixdogDesktop?.subscribeConnectionSignIn?.((server) => {
        requestConnectionDialog('ssh-host', server);
        window.dispatchEvent(new Event(OPEN_CONNECTION_SETTINGS_EVENT));
      }) ?? undefined,
    []
  );
  useEffect(() => {
    // Reopening starts with the launch, often before this window listens:
    // what was reported already comes first, live updates replace it.
    const heard = new Set<string>();
    const unsubscribe = subscribeServerRestore((progress) => {
      heard.add(progress.id);
      setEntries((current) => {
        const others = current.filter((entry) => entry.id !== progress.id);
        return progress.phase === 'ready' ? others : [...others, progress];
      });
    });
    void window.mixdogDesktop
      ?.getServerRestoreProgress?.()
      .then((earlier) => {
        const missed = earlier.filter((entry) => !heard.has(entry.id));
        if (missed.length) setEntries((current) => [...missed, ...current]);
      })
      .catch(() => undefined);
    return unsubscribe;
  }, []);
  if (!entries.length) return null;
  return createPortal(
    <div className="conn-link-stack">
      {entries.map((entry) => {
        const failed = entry.phase === 'failed';
        return (
          <div
            key={entry.id}
            className="mx-toast conn-link-banner"
            role={failed ? 'alert' : 'status'}
            data-state={failed ? 'lost' : 'reconnecting'}
          >
            <div className="conn-link-copy">
              <b>
                {!failed && <span className="conn-spinner" aria-hidden="true" />}
                {failed
                  ? t('Couldn’t reopen {{name}}', { name: entry.name })
                  : t('Reopening {{name}}…', { name: entry.name })}
              </b>
              <span className="conn-link-sub">
                {entry.phase === 'failed'
                  ? (entry.message ?? '')
                  : RESTORE_PHASE_LABELS[entry.phase as keyof typeof RESTORE_PHASE_LABELS]?.()}
              </span>
            </div>
            {failed && (
              <div className="conn-link-actions">
                <button
                  type="button"
                  className="conn-btn conn-btn--sm"
                  onClick={() => window.dispatchEvent(new Event(OPEN_CONNECTION_SETTINGS_EVENT))}
                >
                  {t('Open Settings → Connection')}
                </button>
                <button
                  type="button"
                  className="conn-btn conn-btn--sm"
                  onClick={() => setEntries((current) => current.filter((item) => item.id !== entry.id))}
                >
                  {t('Dismiss')}
                </button>
              </div>
            )}
          </div>
        );
      })}
    </div>,
    document.body
  );
}

export function ConnectionStatusBanner() {
  const connection = desktopConnection();
  if (!connection) return null;
  return isSshConnectionWindow() ? <ServerWindowStatus /> : <ServerRestoreStatus />;
}
