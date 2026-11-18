import { ErrorNotice } from '../ErrorNotice';
import { isSshConnectionWindow } from '../desktop-connection';
import { t } from '../i18n';
import { record } from '../record-utils';
import { isRemoteHostRenderer } from '../remote-ui-projection';
import { refreshUsageDashboardAfterAuth } from '../usage-dashboard-store';
import { Group, ListEmpty, ToggleRow } from './capability-controls';
import { rows, sectionError, sectionLoaded, type PanelContext } from './capability-data';

// Rendered entirely from the runtime's getDeveloperSettings() payload: new
// sub-categories and options appear here without desktop changes. An option
// carrying a `warning` turns on only after the user confirms that warning; one
// carrying a `provider` re-reads that provider's usage meter once it changes.
// The exception is an option the desktop host confirms itself: main asks its
// human-only warning in this window's confirm dialog and accepts only the
// person's own answer (main/developer-risk-confirm.ts), so no second
// confirmation is asked here.
const HOST_CONFIRMED_OPTIONS: ReadonlySet<string> = new Set(['allowAllActions']);

export function DeveloperPanel({ api, data, pending, run, confirm }: PanelContext) {
  const failure = sectionError(data, 'developer');
  if (failure) return <ErrorNotice error={failure} role="status" />;
  const sections = rows(record(data.developer), 'sections');
  const cannotEnableLocally = isSshConnectionWindow() || isRemoteHostRenderer();
  if (!sections.length) {
    return (
      <ListEmpty
        text={sectionLoaded(data, 'developer') ? t('No developer options available.') : t('Loading developer options…')}
      />
    );
  }
  return (
    <>
      {sections.map((section) => (
        <Group
          key={String(section.id)}
          title={t(String(section.label || section.id))}
          description={section.description ? t(String(section.description)) : undefined}
        >
          {rows(section, 'options').map((option) => {
            const id = String(option.id);
            const label = String(option.label || id);
            const warning = String(option.warning || '');
            const provider = String(option.provider || '');
            const localEnableOnly = HOST_CONFIRMED_OPTIONS.has(id) && cannotEnableLocally;
            const description = option.description ? t(String(option.description)) : undefined;
            const set = (enabled: boolean) =>
              void run('setDeveloperOption', [id, enabled]).then((view) => {
                if (view && provider) void refreshUsageDashboardAfterAuth(api, [provider]).catch(() => {});
              });
            // Not optimistic while a warning applies: the switch must not flip
            // ahead of a confirmation the user may still cancel.
            return (
              <ToggleRow
                key={id}
                title={t(label)}
                description={
                  localEnableOnly
                    ? [description, t('Turn this on in the local desktop window.')].filter(Boolean).join(' ')
                    : description
                }
                showDescription
                checked={option.enabled === true}
                disabled={Boolean(pending) || (localEnableOnly && option.enabled !== true)}
                optimistic={!warning}
                onChange={(enabled) => {
                  if (enabled && localEnableOnly) return;
                  if (!enabled || !warning || HOST_CONFIRMED_OPTIONS.has(id)) {
                    set(enabled);
                    return;
                  }
                  confirm({
                    title: t('Turn on {{name}}', { name: t(label) }),
                    description: t(warning),
                    confirmLabel: t('Accept risk and turn on'),
                    danger: true,
                    onConfirm: () => set(true),
                  });
                }}
              />
            );
          })}
        </Group>
      ))}
    </>
  );
}
