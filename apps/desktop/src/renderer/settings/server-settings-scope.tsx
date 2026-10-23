import { useConnectionLink } from '../connection-link-store';
import { desktopConnection } from '../desktop-connection';
import { t } from '../i18n';

/** A server window's Settings: which settings the server keeps and which
 *  follow this PC. With server accounts, model sign-in is the server's own. */
export function ServerSettingsScope() {
  const server = desktopConnection();
  const serverAccounts = useConnectionLink()?.modelLogin === 'server';
  if (server?.kind !== 'ssh') return null;
  return (
    <p className="conn-field-msg server-settings-scope" role="note">
      {serverAccounts
        ? t(
            'Settings here apply to {{name}}. Updates and notifications follow this PC; model logins are the server’s own.',
            {
              name: server.name,
            }
          )
        : t('Settings here apply to {{name}}. Updates, notifications and model sign-in follow this PC.', {
            name: server.name,
          })}
    </p>
  );
}
