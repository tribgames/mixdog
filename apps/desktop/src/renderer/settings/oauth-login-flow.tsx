// Shared OAuth login flow: the begin/poll/cancel state machine and the
// `.settings-oauth-dialog` wait window used by the provider login and the MCP
// server login.
import { Copy, ExternalLink, X } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

import '../desktop/github-device-code.css';
import { ErrorNotice } from '../ErrorNotice';
import { errorMessage } from '../editor-pane-session-errors';
import { t } from '../i18n';
import { localizeOAuthFailure } from '../oauth-failure-copy';
import { scrimDismiss } from '../scrim-dismiss';
import { registerMobileBack } from '../mobile-back';
import { record } from '../record-utils';
import { isRemoteHostRenderer } from '../remote-ui-projection';
import { settingsStatus } from './capability-controls';
import type { PanelContext, RecordValue } from './capability-data';

export function openSignInPage(url: unknown) {
  if (typeof url === 'string' && url) void window.mixdogDesktop?.openExternal?.(url).catch(() => undefined);
}

type OAuthLoginFlowOptions = {
  run: PanelContext['run'];
  /** Names the status/cancel run keys. */
  keyId: string;
  statusCapability: Parameters<PanelContext['run']>[0];
  cancelCapability: Parameters<PanelContext['run']>[0];
  statusError: string;
  /** Runs once when the flow reports `complete`; resolves to an error message
   *  when the refreshed data could not be read, otherwise undefined. */
  refresh(): Promise<string | undefined>;
  /** Runs after a completed flow's dialog closed. */
  onDone?(): void;
  /** Overrides "signs in on another machine" (default: a remote client). */
  remote?: boolean;
};

const STICKY_FLOW_FIELDS = ['url', 'manualUrl', 'userCode'] as const;

/** A status reply replaces the flow, but keeps the sign-in fields it omits. */
function mergeFlowStatus(current: RecordValue | null, next: RecordValue): RecordValue {
  if (!current || String(current.flowId || '') !== String(next.flowId || '')) return next;
  const merged = { ...next };
  for (const field of STICKY_FLOW_FIELDS) {
    if (merged[field] === undefined || merged[field] === null || merged[field] === '') {
      if (current[field] !== undefined) merged[field] = current[field];
    }
  }
  return merged;
}

export function useOAuthLoginFlow(options: OAuthLoginFlowOptions) {
  const [flow, setFlow] = useState<RecordValue | null>(null);
  const [error, setError] = useState('');
  // The paste form's own error: a status poll failure must not replace or clear it.
  const [pasteError, setPasteError] = useState('');
  const completedFlowRef = useRef('');
  const latest = useRef(options);
  latest.current = options;
  const { keyId } = options;
  const flowId = String(flow?.flowId || '');
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new flow starts without the previous paste error.
  useEffect(() => setPasteError(''), [flowId]);
  const flowOpen = Boolean(flow);
  const flowState = String(flow?.state || '');
  // A remote client signs in on its own machine.
  const remote = options.remote ?? isRemoteHostRenderer();
  useEffect(() => {
    if (!flowId || flowState !== 'pending') return undefined;
    let cancelled = false;
    let timer = 0;
    const poll = async () => {
      const next = await latest.current.run<RecordValue>(
        latest.current.statusCapability,
        [flowId],
        `oauth-status-${keyId}`,
        false,
        true
      );
      if (cancelled) return;
      if (!next) {
        setError(latest.current.statusError);
        return;
      }
      const nextFlow = record(next);
      setFlow((current) => mergeFlowStatus(current, nextFlow));
      if (String(nextFlow.state || 'pending') === 'pending') {
        timer = window.setTimeout(() => void poll(), 500);
      }
    };
    timer = window.setTimeout(() => void poll(), 500);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [flowId, flowState, keyId]);
  useEffect(() => {
    if (!flowId || flowState !== 'complete' || completedFlowRef.current === flowId) return;
    completedFlowRef.current = flowId;
    void latest.current.refresh().then((failure) => {
      if (completedFlowRef.current !== flowId) return;
      if (failure) {
        completedFlowRef.current = '';
        setError(failure);
        return;
      }
      setFlow((current) => (String(current?.flowId || '') === flowId ? null : current));
      latest.current.onDone?.();
    });
  }, [flowId, flowState]);
  const start = async (begin: (remote: boolean) => Promise<unknown>) => {
    setError('');
    completedFlowRef.current = '';
    try {
      const next = await begin(remote);
      if (next) {
        const started = record(next);
        setFlow(started);
        if (remote) openSignInPage(started.manualUrl || started.url);
      }
    } catch (reason) {
      setError(errorMessage(reason));
    }
  };
  const close = () => {
    const currentFlowId = String(flow?.flowId || '');
    const currentState = String(flow?.state || '');
    setFlow(null);
    setError('');
    setPasteError('');
    if (currentFlowId && currentState !== 'complete' && currentState !== 'cancelled') {
      void options.run(options.cancelCapability, [currentFlowId], `oauth-cancel-${keyId}`, false);
    }
  };
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    if (!flowOpen) return undefined;
    return registerMobileBack(() => closeRef.current());
  }, [flowOpen]);
  const mergeFlow = (next: RecordValue) => setFlow((current) => mergeFlowStatus(current, next));
  return { flow, setFlow, mergeFlow, error, setError, pasteError, setPasteError, remote, start, close };
}

// The runtime's fixed message for a pasted address that is not the sign-in redirect.
const INVALID_PASTE = /pasted sign-in url is invalid/i;

/** The text shown under the paste field for a failed completion. */
export function pasteErrorText(reason: unknown): string {
  const message = errorMessage(reason);
  const failure = localizeOAuthFailure(message);
  if (failure) return `${failure.summary} ${failure.recovery}`;
  return INVALID_PASTE.test(message)
    ? t('Invalid sign-in address. Paste the full address you were redirected to after signing in.')
    : message;
}

function loginHost(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

export type OAuthPaste = {
  title: string;
  placeholder: string;
  ariaLabel: string;
  error: string;
  onSubmit(value: string, form: HTMLFormElement): void;
};

export function OAuthLoginDialog({
  id,
  closeLabel,
  flow,
  error,
  paste,
  disabled,
  onClose,
  portal = false,
  children,
}: {
  id: string;
  closeLabel: string;
  flow: RecordValue;
  error: string;
  /** Away from the host (or a manual-code provider): the final address or code is pasted back. */
  paste?: OAuthPaste;
  disabled: boolean;
  onClose(): void;
  /** Render into document.body above the Extensions cards (a sidebar host
   *  clips fixed layers, and its cards paint over the settings scrim). Then
   *  Escape closes it here, as no settings dialog owns the key. */
  portal?: boolean;
  /** Provider-only steps (verification) after the waiting line. */
  children?: ReactNode;
}) {
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef(0);
  useEffect(() => () => window.clearTimeout(copyTimer.current), []);
  const status = settingsStatus(String(flow.state || '') || 'pending');
  const url = String(flow.manualUrl || flow.url || '');
  const pending = !flow.state || flow.state === 'pending';
  const copyLink = () => {
    void navigator.clipboard?.writeText(url).then(
      () => {
        setCopied(true);
        window.clearTimeout(copyTimer.current);
        copyTimer.current = window.setTimeout(() => setCopied(false), 1500);
      },
      () => undefined
    );
  };
  const layer = (
    // biome-ignore lint/a11y/noStaticElementInteractions: scrim click-to-dismiss; keyboard dismissal is the dialog's close button and Escape.
    <div
      className="settings-oauth-layer"
      data-over-dialog={portal ? '' : undefined}
      {...scrimDismiss(onClose)}
      onKeyDown={
        portal
          ? (event) => {
              if (event.key !== 'Escape') return;
              event.preventDefault();
              event.stopPropagation();
              onClose();
            }
          : undefined
      }
    >
      <section
        className="settings-oauth-dialog"
        role="dialog"
        aria-modal="true"
        data-settings-nested-dialog
        aria-labelledby={`settings-oauth-title-${id}`}
      >
        <header>
          <div>
            <h3 id={`settings-oauth-title-${id}`}>{t('Sign in')}</h3>
          </div>
          <button
            type="button"
            aria-label={closeLabel}
            data-settings-nested-close
            // biome-ignore lint/a11y/noAutofocus: the dialog's close button takes focus on open.
            autoFocus
            onClick={onClose}
          >
            <X aria-hidden="true" size={16} />
          </button>
        </header>
        <div className="settings-oauth-body">
          {Boolean(url) && (
            <div className="settings-oauth-domain">
              <div>
                <span className="settings-oauth-host">{loginHost(url)}</span>
                <span className="settings-oauth-hint">{t('Sign in in the browser')}</span>
              </div>
              <div className="settings-oauth-domain-actions">
                <button
                  type="button"
                  aria-label={t('Open again')}
                  data-tooltip={t('Open again')}
                  title={t('Open again')}
                  onClick={() => openSignInPage(url)}
                >
                  <ExternalLink size={14} aria-hidden="true" />
                </button>
                <button
                  type="button"
                  aria-label={copied ? t('Copied') : t('Copy link')}
                  data-tooltip={copied ? t('Copied') : t('Copy link')}
                  title={copied ? t('Copied') : t('Copy link')}
                  onClick={copyLink}
                >
                  <Copy size={14} aria-hidden="true" />
                </button>
              </div>
            </div>
          )}
          {Boolean(flow.userCode) && flow.state !== 'complete' && (
            <label className="settings-oauth-url">
              {t('Enter this code on the sign-in page')}
              <input readOnly value={String(flow.userCode)} />
            </label>
          )}
          {paste && flow.state !== 'complete' && (
            <form
              className="settings-oauth-code"
              onSubmit={(event) => {
                event.preventDefault();
                const form = event.currentTarget;
                paste.onSubmit(String(new FormData(form).get('code') ?? ''), form);
              }}
            >
              <b>{paste.title}</b>
              <div className="settings-oauth-code-row">
                <input
                  name="code"
                  placeholder={paste.placeholder}
                  aria-label={paste.ariaLabel}
                  aria-invalid={paste.error ? true : undefined}
                  required
                />
                <button type="submit" className="primary" disabled={disabled}>
                  {t('Complete')}
                </button>
              </div>
              {Boolean(paste.error) && (
                <p className="settings-oauth-paste-error" role="alert">
                  {paste.error}
                </p>
              )}
            </form>
          )}
          <div className="settings-oauth-wait" role="status">
            {pending ? (
              <>
                <span className="github-device-code-spinner" aria-hidden="true" />
                {t('Waiting…')}
              </>
            ) : (
              <span className={`tone-${status.tone}`}>{t(status.label)}</span>
            )}
          </div>
          {children}
          <ErrorNotice errors={[flow.error, error]} />
        </div>
        <footer>
          <button type="button" disabled={disabled} onClick={onClose}>
            {flow.state === 'pending' ? t('Cancel') : t('Close')}
          </button>
        </footer>
      </section>
    </div>
  );
  return portal ? createPortal(layer, document.body) : layer;
}
