import { useEffect, useState } from 'react';
import type { DesktopModelSelection } from '../shared/contract';
import type { Snapshot } from './desktop-types';
import { t } from './i18n';
import { ErrorNotice } from './ErrorNotice';
import { record } from './record-utils';
import { inheritancePreflight, sessionModelSelection, type InheritanceFit } from './session-inheritance';

export function resolveInheritBlockedReason({
  sessionId,
  busy,
  spoken,
  onInheritAvailable,
  hasRoute,
  fit,
}: {
  sessionId: string;
  busy?: boolean;
  spoken: number;
  onInheritAvailable: boolean;
  hasRoute: boolean;
  fit: InheritanceFit | null;
}): string {
  if (!sessionId) return t('This task has not started a session yet.');
  if (busy === true) return t('Wait for the current turn to finish.');
  if (spoken === 0) return t('There is no conversation to carry over yet.');
  if (!onInheritAvailable) return t('Inheritance is unavailable on this surface.');
  if (!hasRoute) return t('Unknown');
  if (fit?.known && !fit.fits && !fit.willCompact) {
    return t('This conversation no longer fits the model context. Run /compact first.');
  }
  return '';
}

/**
 * /inherit — one decision surface: what carries over, where it lands, and
 * whether it can happen at all. The heir is a NEW session on the currently
 * selected model holding this conversation; the source is left untouched.
 */
export function InheritBody({
  snapshot,
  sessionId,
  loading,
  onInherit,
  onClose,
}: {
  snapshot?: unknown;
  sessionId: string;
  /** The surface payload is still in flight; the decision stays locked. */
  loading?: boolean;
  onInherit?: (sourceSessionId: string, route: DesktopModelSelection) => Promise<void>;
  onClose?: () => void;
}) {
  const [running, setRunning] = useState(false);
  const [failure, setFailure] = useState('');
  const shell = record(snapshot);
  const items = Array.isArray(shell.items) ? shell.items : [];
  const spoken = items.filter((item) => {
    const kind = String(record(item).kind || '');
    return kind === 'user' || kind === 'assistant';
  }).length;
  const route = sessionModelSelection(shell as Snapshot);
  const provider = String(route?.provider || '').trim();
  const model = String(route?.model || '').trim();
  // The reading that decides this surface belongs to the HEIR, not to the
  // session on screen: the same conversation is priced differently on the
  // route it is carried to. It comes from the runtime that performs the carry,
  // which is also the one that would refuse it.
  const [fit, setFit] = useState<InheritanceFit | null>(null);
  const [checking, setChecking] = useState(true);
  useEffect(() => {
    if (!sessionId || !provider || !model) {
      setFit(null);
      setChecking(false);
      return undefined;
    }
    let cancelled = false;
    setChecking(true);
    void inheritancePreflight(sessionId, { provider, model }).then((value) => {
      if (cancelled) return;
      setFit(value);
      setChecking(false);
    });
    return () => {
      cancelled = true;
    };
  }, [sessionId, provider, model]);

  // ONE reason at a time, in the order the user would hit them.
  const blocked = resolveInheritBlockedReason({
    sessionId,
    busy: shell.busy === true,
    spoken,
    onInheritAvailable: Boolean(onInherit),
    hasRoute: Boolean(route),
    fit,
  });

  // The dialog frame IS this surface's card: the header already names it, the
  // readings fill the body, and the decision owns its own band under one
  // hairline (user: 세션승계창 이상하다 — the old boxed group repeated the
  // title and pushed its button straight through the card's bottom edge).
  const waiting = checking || Boolean(loading);
  return (
    <div className="inherit-surface">
      <div className="inherit-surface-body">
        <p className="inherit-surface-lede">
          {t(
            'The conversation is copied into a new session that runs on the current model. This session stays exactly as it is.'
          )}
        </p>
        {fit?.willCompact && (
          <p className="inherit-surface-lede">
            {t('This conversation is compacted for the new model before it carries over.')}
          </p>
        )}
        <dl className="command-surface-facts">
          <div>
            <dt>{t('Messages')}</dt>
            <dd>{spoken}</dd>
          </div>
          <div>
            <dt>{t('Model')}</dt>
            <dd title={model ? `${provider}/${model}` : undefined}>{model ? `${provider}/${model}` : t('Unknown')}</dd>
          </div>
          <div>
            <dt>{t('Context')}</dt>
            <dd>{fit?.percent == null ? '—' : `${fit.percent}%`}</dd>
          </div>
        </dl>
        {(blocked || failure) && <ErrorNotice error={failure || blocked} role="status" />}
      </div>
      <footer className="inherit-surface-actions">
        {onClose && (
          <button type="button" className="inherit-surface-cancel" disabled={running} onClick={onClose}>
            {t('Cancel')}
          </button>
        )}
        <button
          type="button"
          disabled={Boolean(blocked) || waiting || running}
          onClick={() => {
            if (blocked || !onInherit || !route || running) return;
            setFailure('');
            setRunning(true);
            void onInherit(sessionId, route)
              .catch((reason) => {
                setFailure(reason instanceof Error ? reason.message : String(reason));
              })
              .finally(() => setRunning(false));
          }}
        >
          {running ? t('Inheriting…') : t('Inherit')}
        </button>
      </footer>
    </div>
  );
}
