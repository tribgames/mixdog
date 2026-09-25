import { ErrorNotice } from '../ErrorNotice';
import { t } from '../i18n';
import { record } from '../record-utils';
import { Group, ListEmpty, ToggleRow } from './capability-controls';
import { rows, sectionError, sectionLoaded, type PanelContext } from './capability-data';

// Rendered entirely from the runtime's getDeveloperSettings() payload: new
// sub-categories and options appear here without desktop changes.
export function DeveloperPanel({ data, pending, run }: PanelContext) {
  const failure = sectionError(data, 'developer');
  if (failure) return <ErrorNotice error={failure} role="status" />;
  const sections = rows(record(data.developer), 'sections');
  if (!sections.length) {
    return (
      <ListEmpty
        text={sectionLoaded(data, 'developer') ? 'No developer options available.' : 'Loading developer options…'}
      />
    );
  }
  return (
    <>
      {sections.map((section) => (
        <Group key={String(section.id)} title={String(section.label || section.id)}>
          {rows(section, 'options').map((option) => {
            const id = String(option.id);
            const envForced = option.envForced === true;
            const description = String(option.description || '');
            return (
              <ToggleRow
                key={id}
                title={envForced ? `${String(option.label || id)} (env)` : String(option.label || id)}
                description={
                  envForced
                    ? [description, t('Forced on by {{env}}.', { env: String(option.env || '') })]
                        .filter(Boolean)
                        .join(' ')
                    : description
                }
                checked={option.enabled === true}
                disabled={Boolean(pending) || envForced}
                onChange={(enabled) => void run('setDeveloperOption', [id, enabled])}
              />
            );
          })}
        </Group>
      ))}
    </>
  );
}
