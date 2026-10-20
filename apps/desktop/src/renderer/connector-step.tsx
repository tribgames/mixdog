// The live step of a connector sign-in (row line, detail note, chat card):
// the shared row spinner and the words of the current step.
import { connectorById } from '../../../../src/runtime/shared/connector-catalog.mjs';
import type { ConnectorRowView } from './connectors-model';
import { t } from './i18n';
import { ProgressSpinner } from './ProgressSpinner';

// Mixdog's Google client is published without Google's verification, so its
// sign-in page warns first; the way past it, while that page is open.
function browserHint(view: ConnectorRowView, connector: string): string {
  const backend = connectorById(connector)?.backend;
  if (view.step !== 'browser' || backend?.kind !== 'oauth' || backend.oauthClient !== 'google') return '';
  return t('If Google shows “Google hasn’t verified this app”, choose Advanced → Continue.');
}

function stepText(view: ConnectorRowView): string {
  if (view.step === 'starting') return t('Opening the browser…');
  if (view.step === 'browser') return t('Sign in in your browser…');
  if (view.step === 'connecting') return t('Connecting…');
  return t('Loading tools…');
}

export function ConnectorStep({ view, connector = '' }: { view: ConnectorRowView; connector?: string }) {
  const hint = browserHint(view, connector);
  return (
    <span className="connectors-row-step" role="status">
      <ProgressSpinner size={12} className="schedules-row-spinner" aria-hidden="true" />
      {stepText(view)}
      {hint && <span className="connectors-row-hint"> · {hint}</span>}
    </span>
  );
}
