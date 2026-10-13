import { desktopConnection } from '../desktop-connection';
import { t } from '../i18n';

/** A server window's Settings: which settings the server keeps and which
 *  follow this PC. */
export function ServerSettingsScope() {
  const server = desktopConnection();
  if (server?.kind !== 'ssh') return null;
  return (
    <p className="conn-field-msg server-settings-scope" role="note">
      {t('Settings here apply to {{name}}. Updates, notifications and model sign-in follow this PC.', {
        name: server.name,
      })}
    </p>
  );
}
