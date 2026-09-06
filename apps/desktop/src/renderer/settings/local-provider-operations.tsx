import { t } from '../i18n';
import { ErrorNotice } from '../ErrorNotice';
import { record } from '../record-utils';
import type { RecordValue } from './capability-data';
import { ExtensionAction, ExtensionItemList, ExtensionItemRow, ExtensionSection } from './extension-detail';
import { SlotProgress } from './built-in-install-progress';
import { installationPercent } from './local-provider-status';
import type { useLocalProviderActions } from './local-provider-actions';

export type LocalProviderActions = ReturnType<typeof useLocalProviderActions>;

export function localIdleLabel(seconds: number): string {
  if (seconds === 0) return t('Never');
  if (seconds === 3600) return t('After 1 hour');
  if (seconds % 3600 === 0) return t('After {{hours}} hours', { hours: String(seconds / 3600) });
  if (seconds % 60 === 0) return t('After {{minutes}} minutes', { minutes: String(seconds / 60) });
  return t('After {{seconds}} seconds', { seconds: String(seconds) });
}

export function LocalProviderOperations({ status, actions }: { status: RecordValue; actions: LocalProviderActions }) {
  const models = Array.isArray(status.models) ? status.models.map(record) : [];
  const operations = Array.isArray(status.installations) ? status.installations.map(record)
    .filter((entry) => ['running', 'cancelling', 'paused', 'failed'].includes(String(entry.state))) : [];
  const error = actions.error || String(status.installationCommandError || status.lastUnloadError || '');
  // GPU memory and server state live in the feature's Info facts; the
  // request counters were operational noise and are gone (user: 불필요한
  // 표면 정리). Only live installations earn a section here.
  return <>
    {error && <ErrorNotice error={error} />}
    {operations.length > 0 && <ExtensionSection title={t('Installation')}>
      <ExtensionItemList>
      {operations.map((operation) => {
        const modelId = String(operation.modelId || '');
        const phase = String(operation.phase);
        const name = phase === 'runtime' ? t('Runtime')
          : String(models.find((model) => model.id === modelId)?.name || modelId);
        const running = operation.state === 'running' || operation.state === 'cancelling';
        return <div className="local-provider-installation" key={String(operation.jobId || `${phase}:${modelId}`)}>
          {running && <SlotProgress percent={installationPercent(operation)}
            label={phase === 'verify' ? t('Verifying {{name}}…', { name }) : t('Installing {{name}}…', { name })} />}
          <ExtensionItemRow title={name}
            description={operation.state === 'failed' ? t('Failed')
              : operation.state === 'cancelling' ? t('Stopping download…')
              : running ? '' : t('Paused · downloaded files are kept')}
            control={running
              ? <ExtensionAction disabled={actions.busy || operation.state === 'cancelling' || !operation.jobId}
                  onClick={() => actions.cancel(String(operation.jobId))}>{t('Stop download')}</ExtensionAction>
              : <ExtensionAction disabled={actions.busy}
                  onClick={() => actions.resume(phase, modelId)}>{t('Resume installation')}</ExtensionAction>} />
          {operation.state === 'failed' && <ErrorNotice error={operation.error || t('Failed')} />}
        </div>;
      })}
      </ExtensionItemList>
    </ExtensionSection>}
  </>;
}
