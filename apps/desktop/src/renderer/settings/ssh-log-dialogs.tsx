import { useEffect, useState } from 'react';

import { errorMessage } from '../editor-pane-session-errors';
import { t } from '../i18n';
import type { CapabilityApi } from './capability-data';
import { ConnDialog } from './connection-dialogs';

type Mode = 'connection' | 'server';

interface Loaded {
  /** What the dialog shows. */
  text: string;
  /** What Copy puts on the clipboard: the same, with the server's user and host replaced by <server>. */
  copyText: string;
  error: string;
}

/** Loads the log for `mode` (reloading when it changes) and owns the Copy feedback. */
function useSshLog(api: CapabilityApi, reference: string, mode: Mode) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [copied, setCopied] = useState('');

  useEffect(() => {
    let live = true;
    setLoaded(null);
    setCopied('');
    const done = (next: Loaded): void => {
      if (live) setLoaded(next);
    };
    if (mode === 'connection') {
      void Promise.resolve(api.sshDiagnosticsLog?.(reference))
        .then((view) => done({ text: view?.lines.join('\n') ?? '', copyText: view?.copyText ?? '', error: '' }))
        .catch((reason: unknown) => done({ text: '', copyText: '', error: errorMessage(reason) }));
    } else {
      void Promise.resolve(api.sshServerLog?.(reference))
        .then((result) =>
          done(
            result?.ok
              ? { text: result.text, copyText: result.copyText, error: '' }
              : { text: '', copyText: '', error: result?.message ?? '' }
          )
        )
        .catch((reason: unknown) => done({ text: '', copyText: '', error: errorMessage(reason) }));
    }
    return () => {
      live = false;
    };
  }, [api, reference, mode]);

  const copy = (what: string, text: Promise<string> | string): void => {
    void Promise.resolve(text)
      .then((value) => navigator.clipboard.writeText(value))
      .then(() => setCopied(what))
      .catch(() => setCopied(''));
  };

  return { loaded, copied, copy };
}

function logTitle(mode: Mode): string {
  return mode === 'connection' ? t('Connection log') : t('Server log');
}

function LogBody({ loaded, mode }: { loaded: Loaded | null; mode: Mode }) {
  if (loaded === null) {
    return (
      <div className="conn-field-msg conn-field-msg--busy" role="status">
        <span className="conn-spinner" aria-hidden="true" />
        {mode === 'server' ? t('Reading the server log…') : t('Loading…')}
      </div>
    );
  }
  if (loaded.error) {
    return (
      <p className="conn-note conn-note--raw" role="alert">
        {loaded.error}
      </p>
    );
  }
  return (
    // biome-ignore lint/a11y/useSemanticElements: the log must stay a <pre> to keep its whitespace and styling.
    // biome-ignore lint/a11y/noNoninteractiveTabindex: keyboard users need to focus this scrollable region to scroll it.
    <pre className="ssh-log" role="region" tabIndex={0} aria-label={logTitle(mode)}>
      {loaded.text || t('Nothing has been logged yet.')}
    </pre>
  );
}

function copiedMessage(copied: string): string {
  if (copied === 'diagnostics') return t('Diagnostics copied. The server’s name is replaced by <server>.');
  if (copied === 'log') return t('Copied. The server’s name is replaced by <server>.');
  return '\u00a0';
}

/**
 * "View log" for one SSH server: the connection log kept in memory (ssh runs,
 * stderr, results, timings, tunnel restarts) or, on request, the tail of the
 * server's daemon.log. Copy and "Copy diagnostics" put redacted text on the
 * clipboard. `reference` is the server's id or address; a server window passes
 * '' (main answers with that window's own server).
 */
export function SshLogDialog({
  api,
  reference,
  name,
  onClose,
}: {
  api: CapabilityApi;
  reference: string;
  name: string;
  onClose(): void;
}) {
  const [mode, setMode] = useState<Mode>('connection');
  const { loaded, copied, copy } = useSshLog(api, reference, mode);

  return (
    <ConnDialog
      title={logTitle(mode)}
      description={name}
      onEscape={onClose}
      footer={
        <>
          {mode === 'connection' ? (
            <button type="button" className="conn-link" onClick={() => setMode('server')}>
              {t('Fetch server log')}
            </button>
          ) : (
            <button type="button" className="conn-link" onClick={() => setMode('connection')}>
              {t('Connection log')}
            </button>
          )}
          <span className="conn-grow" />
          {mode === 'connection' && (
            <button
              type="button"
              className="conn-btn"
              onClick={() => copy('diagnostics', api.sshDiagnosticsCopy?.(reference) ?? '')}
            >
              {t('Copy diagnostics')}
            </button>
          )}
          <button
            type="button"
            className="conn-btn"
            disabled={!loaded?.copyText}
            onClick={() => copy('log', loaded?.copyText ?? '')}
          >
            {t('Copy')}
          </button>
          <button type="button" className="conn-btn conn-btn--primary" onClick={onClose}>
            {t('Close')}
          </button>
        </>
      }
    >
      <p className="conn-note">
        {t('Server addresses and user names are hidden when you copy. Check the content before sharing.')}
      </p>
      <LogBody loaded={loaded} mode={mode} />
      <div className="conn-field-msg" role="status">
        {copiedMessage(copied)}
      </div>
    </ConnDialog>
  );
}
