import { t } from '../i18n';
import { ErrorNotice } from '../ErrorNotice';
import type { RecordValue } from './capability-data';
import { OpenSelect } from '../OpenSelect';
import { ExtensionItemList, ExtensionItemRow, ExtensionNote, ExtensionSection } from './extension-detail';
import type { LocalProviderActions } from './local-provider-actions';
import { LocalProviderTable, localProviderTableRows } from './local-provider-table';

export function localIdleLabel(seconds: number): string {
  if (seconds === 0) return t('Never');
  if (seconds === 3600) return t('After 1 hour');
  if (seconds % 3600 === 0) return t('After {{hours}} hours', { hours: String(seconds / 3600) });
  if (seconds % 60 === 0) return t('After {{minutes}} minutes', { minutes: String(seconds / 60) });
  return t('After {{seconds}} seconds', { seconds: String(seconds) });
}

export function LocalProviderModels({ status, actions }: { status: RecordValue; actions: LocalProviderActions }) {
  const rows = localProviderTableRows(status);
  const ttl = typeof status.idleTtlSeconds === 'number' ? status.idleTtlSeconds : 3600;
  const presets = [...new Set([0, 300, 900, 1800, 3600, ttl])].sort((a, b) => a - b);
  const error = actions.error || String(status.installationCommandError || status.lastUnloadError || '');
  // A failure already shown on its table row is not repeated on top.
  const rowErrors = new Set(rows.map((row) => (row.job?.state === 'failed' ? String(row.job.error || '') : '')));
  return (
    <>
      {error && !rowErrors.has(error) && <ErrorNotice error={error} />}
      <ExtensionSection title={t('Models')} count={rows.filter((row) => row.model).length}>
        {rows.length ? (
          <LocalProviderTable rows={rows} status={status} actions={actions} />
        ) : (
          <ExtensionNote>
            {t('No models installed.')}{' '}
            {t('To add a model, ask in chat. The local-provider skill checks your PC and guides installation.')}
          </ExtensionNote>
        )}
      </ExtensionSection>
      <ExtensionSection title={t('Settings')}>
        <ExtensionItemList>
          <ExtensionItemRow
            title={t('Auto-unload when idle')}
            description={t('Active requests and queued work keep the model loaded.')}
            control={
              <OpenSelect
                className="extensions-select"
                ariaLabel={t('Auto-unload when idle')}
                value={String(ttl)}
                disabled={actions.busy}
                options={presets.map((seconds) => ({ value: String(seconds), label: localIdleLabel(seconds) }))}
                onChange={(value) => actions.setIdleTtl(Number(value))}
              />
            }
          />
        </ExtensionItemList>
      </ExtensionSection>
    </>
  );
}
