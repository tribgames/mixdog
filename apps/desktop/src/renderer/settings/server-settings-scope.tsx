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
        ? t('For {{name}}. Updates & notifications use this PC; server logins.', {
            name: server.name,
          })
        : t('For {{name}}. Updates, notifications, and logins use this PC.', {
            name: server.name,
          })}
    </p>
  );
}
