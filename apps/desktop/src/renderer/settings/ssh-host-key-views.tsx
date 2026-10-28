import { Server } from 'lucide-react';
import { useState } from 'react';

import type { DesktopSshConfigSummary, DesktopSshHopKey } from '../../shared/contract-ssh';
import { t } from '../i18n';
import { ConnDialog } from './connection-dialogs';
import { AddressRow } from './pair-code';
import { CancelButton, SummaryRows } from './ssh-connect-views';
import type { View } from './ssh-connect-view';

function hopStatusText(status: DesktopSshHopKey['status']): string {
  if (status === 'trusted') return t('Already trusted');
  if (status === 'pending') return t('Checked after the previous server is trusted');
  return t('Key not readable');
}

/** Every key on the way to the server: each hop's fingerprint next to the server's own. */
function HopList({ hops }: { hops: DesktopSshHopKey[] }) {
  return (
    <ul className="ssh-hops">
      {hops.map((hop) => (
        <li key={`${hop.role}-${hop.name}`} data-status={hop.status}>
          <b>
            {hop.role === 'jump'
              ? t('Jump host {{name}}', { name: hop.name })
              : t('Server {{name}}', { name: hop.name })}
          </b>
          {hop.fingerprint ? (
            <code>
              {hop.fingerprint} · {hop.keyType}
            </code>
          ) : (
            <span>{hopStatusText(hop.status)}</span>
          )}
        </li>
      ))}
    </ul>
  );
}

/** The input and button that replace the changed key, once the server name is typed in full. */
function ReplaceKeyForm({ host, onReplace }: { host: string; onReplace(typedName: string): void }) {
  const [typed, setTyped] = useState('');
  const matches = typed.trim().toLowerCase() === host.toLowerCase();
  return (
    <div className="conn-field">
      <p className="conn-note">
        {t('Replace the key only if you know why it changed. To confirm, type the server name {{host}}.', { host })}
      </p>
      <input
        type="text"
        className="conn-input"
        aria-label={t('Server name')}
        placeholder={host}
        autoComplete="off"
        spellCheck={false}
        value={typed}
        onChange={(event) => setTyped(event.currentTarget.value)}
      />
      <div>
        <button
          type="button"
          className="conn-btn conn-btn--danger"
          disabled={!matches}
          onClick={() => onReplace(typed.trim())}
        >
          {t('Replace key')}
        </button>
      </div>
    </div>
  );
}

/** The old key's removal command, and — behind an explicit step — replacing it
 *  from here, which needs the server's name typed in full. */
function ReplaceKey({
  replace,
  onReplace,
}: {
  replace: { host: string; command: string; replaceable: boolean };
  onReplace(typedName: string): void;
}) {
  const [open, setOpen] = useState(false);
  let action = null;
  if (replace.replaceable && open) {
    action = <ReplaceKeyForm host={replace.host} onReplace={onReplace} />;
  } else if (replace.replaceable) {
    action = (
      <div>
        <button type="button" className="conn-link" onClick={() => setOpen(true)}>
          {t('Advanced · Replace the key')}
        </button>
      </div>
    );
  }
  return (
    <div className="conn-stack">
      <p className="conn-note">{t('To forget the old key yourself, run this command in this PC’s terminal:')}</p>
      <AddressRow address={replace.command} />
      {action}
    </div>
  );
}

/** First connection to a server: its key fingerprint, to confirm before trusting it. */
export function SshTrustDialog({
  view,
  shown,
  summary,
  onConfirm,
  onCancel,
  onClose,
}: {
  view: Extract<View, { kind: 'trust' }>;
  shown: { target: string; name: string };
  summary: DesktopSshConfigSummary | null;
  onConfirm(): void;
  onCancel(): void;
  onClose(): void;
}) {
  return (
    <ConnDialog
      viewKey="trust"
      onEscape={onClose}
      title={t('First time connecting to this server')}
      description={t('Connect only if this is a server you manage.')}
      role="alertdialog"
      scrimCloses={false}
      footer={
        <>
          <span className="conn-grow" />
          <CancelButton onCancel={onCancel} />
          <button type="button" className="conn-btn conn-btn--primary" onClick={onConfirm}>
            {t('Connect')}
          </button>
        </>
      }
    >
      <div className="conn-claim">
        <div className="conn-device">
          <span className="conn-tile conn-tile--lg">
            <Server size={16} aria-hidden="true" />
          </span>
          <div>
            <b>{shown.name}</b>
            <span>{shown.target}</span>
          </div>
        </div>
        <div className="conn-rule" />
        {view.hops ? (
          <HopList hops={view.hops} />
        ) : (
          <dl className="conn-kv">
            <dt>{t('Fingerprint')}</dt>
            <dd>
              <code>{view.fingerprint}</code>
            </dd>
            <dt>{t('Key type')}</dt>
            <dd>{view.keyType}</dd>
          </dl>
        )}
        <SummaryRows summary={summary} />
        <p className="conn-note">
          {t(
            'You can find the fingerprint in the provider’s dashboard or from the server administrator. Once you connect, you won’t be asked again.'
          )}
        </p>
      </div>
    </ConnDialog>
  );
}

/** A server whose key differs from the one on record: the connection is refused. */
export function SshChangedDialog({
  view,
  summary,
  onReplace,
  onClose,
}: {
  view: Extract<View, { kind: 'changed' }>;
  summary: DesktopSshConfigSummary | null;
  onReplace(typedName: string): void;
  onClose(): void;
}) {
  return (
    <ConnDialog
      viewKey="changed"
      onEscape={onClose}
      title={t('The server’s fingerprint has changed')}
      description={t('For your safety, the connection was not made.')}
      role="alertdialog"
      scrimCloses={false}
      footer={
        <>
          <span className="conn-grow" />
          <button type="button" className="conn-btn conn-btn--primary" onClick={onClose}>
            {t('Close')}
          </button>
        </>
      }
    >
      <div className="conn-claim">
        {view.previous && view.current && (
          <dl className="conn-kv">
            <dt>{t('Earlier')}</dt>
            <dd>
              <code>{view.previous}</code>
            </dd>
            <dt>{t('Current')}</dt>
            <dd>
              <code>{view.current}</code>
            </dd>
          </dl>
        )}
        {view.hops && <HopList hops={view.hops} />}
        <SummaryRows summary={summary} />
        <p className="conn-note">
          {t(
            'The server may have been reinstalled, but another computer could be pretending to be the server. Check with the server administrator.'
          )}
        </p>
        {view.replace && <ReplaceKey replace={view.replace} onReplace={onReplace} />}
      </div>
    </ConnDialog>
  );
}
