import { t } from '../i18n';
import { rows, providerLabel, type RecordValue } from './capability-data';
import { Group, ListEmpty, ResourceRow } from './capability-controls';

/** Desktop-owned credentials have the same read-only projection in every setup surface. */
export function ClientManagedProviders({ setup }: { setup: RecordValue }) {
  const renderProvider = (provider: RecordValue) => (
    <ResourceRow
      key={String(provider.id)}
      title={providerLabel(provider)}
      status={String(
        provider.status || (provider.usable === true || provider.authenticated === true ? 'Connected' : 'Not connected')
      )}
    />
  );
  return (
    <>
      <p>
        {t('Uses providers from your desktop; manage accounts locally.')}
      </p>
      {setup.unavailable === true ? (
        <ListEmpty text={t('Connect the desktop to view its providers.')} />
      ) : (
        <>
          <Group title={t('OAuth providers')}>{rows(setup.oauth).map(renderProvider)}</Group>
          <Group title={t('API-key providers')}>{rows(setup.api).map(renderProvider)}</Group>
          {rows(setup.local).length > 0 && (
            <Group title={t('Local Provider')}>{rows(setup.local).map(renderProvider)}</Group>
          )}
        </>
      )}
    </>
  );
}
