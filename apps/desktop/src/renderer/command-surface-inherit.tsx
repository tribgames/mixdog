import { useEffect, useMemo, useState } from 'react';
import type { DesktopModelSelection } from '../shared/contract';
import type { Snapshot } from './desktop-types';
import { t } from './i18n';
import { ErrorNotice } from './ErrorNotice';
import { filterConfiguredModels } from './model-catalog';
import { ModelRouteEditor } from './ModelRouteEditor';
import { normalizeModelOptions } from './provider-display';
import { record } from './record-utils';
import { inheritancePreflight, sessionModelSelection, type InheritanceFit } from './session-inheritance';
import { type SidebarReferenceKey, useSidebarReferences } from './sidebar-reference-cache';

const INHERIT_REFERENCE_KEYS = [
  'quickProviderModels',
  'providerSetup',
] as const satisfies readonly SidebarReferenceKey[];

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
  onInherit?: (sourceSessionId: string, route: DesktopModelSelection, options?: { compact: boolean }) => Promise<void>;
  onClose?: () => void;
}) {
  const [running, setRunning] = useState(false);
  const [failure, setFailure] = useState('');
  // The heir's route starts as the session's own and is the user's to change.
  const [picked, setPicked] = useState<{ sessionId: string; route: DesktopModelSelection } | null>(null);
  const [chosenMode, setChosenMode] = useState<'original' | 'compact'>('original');
  const { values } = useSidebarReferences(window.mixdogDesktop, INHERIT_REFERENCE_KEYS, true);
  // Configured providers only, built exactly like the Schedules editor.
  const models = useMemo(
    () => filterConfiguredModels(normalizeModelOptions(values.quickProviderModels), values.providerSetup),
    [values.quickProviderModels, values.providerSetup]
  );
  const shell = record(snapshot);
  const items = Array.isArray(shell.items) ? shell.items : [];
  const spoken = items.filter((item) => {
    const kind = String(record(item).kind || '');
    return kind === 'user' || kind === 'assistant';
  }).length;
  const route = (picked?.sessionId === sessionId ? picked.route : null) ?? sessionModelSelection(shell as Snapshot);
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
  // A conversation the chosen model cannot hold has no "as it is" option.
  const originalDisabled = Boolean(fit?.known && !fit.fits);
  const mode = originalDisabled ? 'compact' : chosenMode;
  const percent = fit?.percent;
  let tone: 'danger' | 'warn' | undefined;
  if (percent != null && percent > 100) tone = 'danger';
  else if (percent != null && percent > 80) tone = 'warn';
  let actionLabel = mode === 'compact' ? t('Compact then inherit') : t('Original inheritance');
  if (running) actionLabel = t('Inheriting…');
  return (
    <div className="inherit-surface">
      <div className="inherit-surface-body">
        <p className="inherit-surface-lede">
          {t('The conversation is copied into a new session. This session stays exactly as it is.')}
        </p>
        <dl className="command-surface-facts">
          <div>
            <dt>{t('Model')}</dt>
            <dd className="command-surface-facts-control">
              {route ? (
                <ModelRouteEditor
                  models={models}
                  value={route}
                  disabled={running}
                  ariaLabel={t('Inherit model')}
                  catalogLoaded={models.length > 0}
                  onChange={(selection) => {
                    setFailure('');
                    setPicked({ sessionId, route: selection });
                  }}
                />
              ) : (
                t('Unknown')
              )}
            </dd>
          </div>
          <div>
            <dt>{t('Messages')}</dt>
            <dd>{spoken}</dd>
          </div>
          <div>
            <dt>{t('Context')}</dt>
            <dd data-tone={tone}>{percent == null ? '—' : `${percent}%`}</dd>
          </div>
        </dl>
        <div className="inherit-surface-choices" role="radiogroup" aria-label={t('Carry mode')}>
          <label className="inherit-surface-choice" data-disabled={originalDisabled ? 'true' : undefined}>
            <input
              type="radio"
              name="inherit-mode"
              value="original"
              checked={mode === 'original'}
              disabled={originalDisabled || running}
              onChange={() => setChosenMode('original')}
            />
            <span className="inherit-surface-radio" aria-hidden="true" />
            <span className="inherit-surface-choice-text">
              <b>{t('Original inheritance')}</b>
              <span>{t('The whole conversation is carried over as it is.')}</span>
              {originalDisabled && (
                <span className="inherit-surface-choice-why">
                  {t('The whole conversation does not fit this model.')}
                </span>
              )}
            </span>
          </label>
          <label className="inherit-surface-choice">
            <input
              type="radio"
              name="inherit-mode"
              value="compact"
              checked={mode === 'compact'}
              disabled={running}
              onChange={() => setChosenMode('compact')}
            />
            <span className="inherit-surface-radio" aria-hidden="true" />
            <span className="inherit-surface-choice-text">
              <b>{t('Compact then inherit')}</b>
              <span>
                {t(
                  'The conversation is summarized first. The new session starts lighter, but some detail is condensed.'
                )}
              </span>
            </span>
          </label>
        </div>
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
            void onInherit(sessionId, route, { compact: mode === 'compact' })
              .catch((reason) => {
                setFailure(reason instanceof Error ? reason.message : String(reason));
              })
              .finally(() => setRunning(false));
          }}
        >
          {actionLabel}
        </button>
      </footer>
    </div>
  );
}
