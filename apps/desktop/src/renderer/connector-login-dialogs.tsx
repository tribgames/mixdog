// The paste-back dialogs of connector sign-ins started away from the host
// (phone, a second PC): the existing MCP OAuth fallback, where the browser
// opens on this device and the final redirect is pasted back. Mounted by
// the 커넥터 tab and by chat connect cards; one mounted host renders them.
import { useEffect, useId, useState, useSyncExternalStore } from 'react';
import { cancelConnectorLogin, completeConnectorLogin, useConnectorLogins } from './connector-connect';
import { t } from './i18n';
import { OAuthLoginDialog, pasteErrorText } from './settings/oauth-login-flow';

const hosts: string[] = [];
const hostListeners = new Set<() => void>();
const firstHost = () => hosts[0] ?? '';
const subscribeHosts = (listener: () => void) => {
  hostListeners.add(listener);
  return () => hostListeners.delete(listener);
};
const notifyHosts = () => {
  for (const listener of hostListeners) listener();
};

export function ConnectorLoginDialogs() {
  const id = useId();
  useEffect(() => {
    hosts.push(id);
    notifyHosts();
    return () => {
      hosts.splice(hosts.indexOf(id), 1);
      notifyHosts();
    };
  }, [id]);
  const owner = useSyncExternalStore(subscribeHosts, firstHost, firstHost) === id;
  const logins = useConnectorLogins();
  const [errors, setErrors] = useState<Record<string, string>>({});
  if (!owner) return null;
  return (
    <>
      {logins
        .filter((login) => login.remote && login.flow && login.phase === 'browser')
        .map((login) => (
          <OAuthLoginDialog
            key={login.name}
            portal
            id={`connector-${login.name}`}
            closeLabel={t('Close OAuth login')}
            flow={login.flow ?? {}}
            error={login.error}
            disabled={false}
            paste={{
              title: t('Sign-in redirect URL or code'),
              placeholder: t('Paste the final redirect URL or code'),
              ariaLabel: t('Sign-in redirect URL or code'),
              error: errors[login.name] || '',
              onSubmit: (callbackUrl, form) => {
                setErrors((current) => ({ ...current, [login.name]: '' }));
                completeConnectorLogin(login.name, callbackUrl)
                  .then(() => form.reset())
                  .catch((reason) => setErrors((current) => ({ ...current, [login.name]: pasteErrorText(reason) })));
              },
            }}
            onClose={() => cancelConnectorLogin(login.name)}
          />
        ))}
    </>
  );
}
