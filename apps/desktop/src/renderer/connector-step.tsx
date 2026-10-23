// The live step of a connector sign-in (row line, detail note, chat card):
// the shared row spinner and the words of the current step.
import { connectorById } from '../../../../src/runtime/shared/connector-catalog.mjs';
import type { ConnectorRowView } from './connectors-model';
import { t } from './i18n';
import { ProgressSpinner } from './ProgressSpinner';

// Google's first-time consent screen starts with its access box unchecked, and
// what is unchecked is not granted (a repeat consent shows no box): said
// before and while the page is open.
function browserHint(view: ConnectorRowView, connector: string): string {
  const backend = connectorById(connector)?.backend;
  const google = backend?.kind === 'oauth' && backend.oauthClient === 'google';
  if (!google || (view.step !== 'starting' && view.step !== 'browser')) return '';
  return t('If Google shows a checkbox for the access, check it before Continue — it starts unchecked.');
}

function stepText(view: ConnectorRowView): string {
  if (view.step === 'starting') return t('Opening the browser…');
  if (view.step === 'browser') return t('Sign in in your browser…');
  if (view.step === 'connecting') return t('Connecting…');
  return t('Loading tools…');
}

// The narrow sidebar row: one line; for Google's browser steps the short
// checkbox hint replaces the step text, with the full notice as its tooltip.
export function ConnectorStep({
  view,
  connector = '',
  compact = false,
}: {
  view: ConnectorRowView;
  connector?: string;
  compact?: boolean;
}) {
  const hint = browserHint(view, connector);
  if (compact) {
    const text = hint ? t('Check access, then Continue') : stepText(view);
    return (
      <span className="connectors-row-step" data-compact="true" role="status" title={hint || text}>
        <ProgressSpinner size={12} className="schedules-row-spinner" aria-hidden="true" />
        <span className="connectors-row-step-text">{text}</span>
      </span>
    );
  }
  return (
    <span className="connectors-row-step" role="status">
      <span className="connectors-row-step-line">
        <ProgressSpinner size={12} className="schedules-row-spinner" aria-hidden="true" />
        {stepText(view)}
      </span>
      {hint && <span className="connectors-row-hint">{hint}</span>}
    </span>
  );
}
