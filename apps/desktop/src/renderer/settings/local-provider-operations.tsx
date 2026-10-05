import { t } from '../i18n';
import { ErrorNotice } from '../ErrorNotice';
import { record } from '../record-utils';
import type { RecordValue } from './capability-data';
import { ExtensionAction, ExtensionItemList, ExtensionItemRow, ExtensionSection } from './extension-detail';
import { SlotProgress } from './built-in-install-progress';
import { installationActive, installationPercent } from './local-provider-status';
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
  const operations = Array.isArray(status.installations)
    ? status.installations
        .map(record)
        .filter((entry) => ['running', 'cancelling', 'paused', 'failed'].includes(String(entry.state)))
    : [];
  const error = actions.error || String(status.installationCommandError || status.lastUnloadError || '');
  // A failure already shown on its installation row is not repeated on top.
  const rowErrors = new Set(
    operations.filter((operation) => operation.state === 'failed').map((operation) => String(operation.error || ''))
  );
  // GPU memory and server state live in the feature's Info facts; the
  // request counters were operational noise and are gone (user: 불필요한
  // 표면 정리). Only live installations earn a section here.
  return (
    <>
      {error && !rowErrors.has(error) && <ErrorNotice error={error} />}
      {operations.length > 0 && (
        <ExtensionSection title={t('Installation')}>
          <ExtensionItemList>
            {operations.map((operation) => {
              const modelId = String(operation.modelId || '');
              const phase = String(operation.phase);
              const name =
                phase === 'runtime'
                  ? t('Runtime')
                  : String(models.find((model) => model.id === modelId)?.name || modelId);
              const running = installationActive(operation);
              const progressLabel =
                phase === 'verify' ? t('Verifying {{name}}…', { name }) : t('Installing {{name}}…', { name });
              // The row says what is happening; the bar under it carries the
              // percentage. A failure speaks only through its error line.
              let description = t('Paused · downloaded files are kept');
              if (operation.state === 'failed') description = '';
              else if (operation.state === 'cancelling') description = t('Stopping download…');
              else if (running) description = progressLabel;
              return (
                <div className="local-provider-installation" key={String(operation.jobId || `${phase}:${modelId}`)}>
                  <ExtensionItemRow
                    title={name}
                    description={description}
                    control={
                      running ? (
                        <ExtensionAction
                          disabled={actions.busy || operation.state === 'cancelling' || !operation.jobId}
                          onClick={() => actions.cancel(String(operation.jobId))}
                        >
                          {t('Stop download')}
                        </ExtensionAction>
                      ) : (
                        <ExtensionAction disabled={actions.busy} onClick={() => actions.resume(phase, modelId)}>
                          {t('Resume installation')}
                        </ExtensionAction>
                      )
                    }
                  />
                  {running && <SlotProgress percent={installationPercent(operation)} label={progressLabel} />}
                  {operation.state === 'failed' && <ErrorNotice error={operation.error || t('Failed')} />}
                </div>
              );
            })}
          </ExtensionItemList>
        </ExtensionSection>
      )}
    </>
  );
}
