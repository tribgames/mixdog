import { phoneAppUpdateView, useNativeAppUpdate } from '../AppUpdateBanner';
import { t } from '../i18n';
import { ActionButton, Group, ResourceRow } from './capability-controls';

export function PhoneUpdatePanel() {
  const { bridge, state, apply } = useNativeAppUpdate();
  if (!bridge?.call) return null;
  const native = bridge.call;
  const view = phoneAppUpdateView(state, bridge.version);
  const run = (request: Promise<unknown>) => void request.then(apply).catch(() => undefined);
  return (
    <Group title={t('Update (phone app)')} description={view.note || undefined}>
      <ResourceRow title={t('Current version')} meta={view.current || t('unknown')} />
      <ResourceRow
        title={t('Latest version')}
        meta={view.latest || t('unknown')}
        actions={
          <ActionButton disabled={view.busy} onClick={() => run(native('getAppUpdate', { check: true }))}>
            {t('Check now')}
          </ActionButton>
        }
      />
      <ResourceRow
        title={t('Install update')}
        actions={
          <ActionButton
            disabled={!view.install.id}
            onClick={() => run(view.install.id === 'install' ? native('installAppUpdate') : native('startAppUpdate'))}
          >
            {view.install.label}
          </ActionButton>
        }
      />
    </Group>
  );
}
