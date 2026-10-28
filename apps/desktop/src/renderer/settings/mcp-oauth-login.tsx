// Explicit MCP server OAuth: the login wait dialog (the provider login's shared
// window) and the connect / disconnect actions the MCP panel hands its editors.
import { useEffect, useState } from 'react';

import { isSshConnectionWindow } from '../desktop-connection';
import { t } from '../i18n';
import { showDesktopToast } from '../notifications';
import { record } from '../record-utils';
import { isRemoteHostRenderer } from '../remote-ui-projection';
import type { PanelContext, RecordValue } from './capability-data';
import { OAuthLoginDialog, pasteErrorText, useOAuthLoginFlow } from './oauth-login-flow';

export function useMcpOAuthLogin({ run, refreshExtensions }: Pick<PanelContext, 'run' | 'refreshExtensions'>) {
  const [name, setName] = useState('');
  // Away from the host the loopback callback is unreachable: the sign-in opens
  // on this device and its final redirect is pasted back.
  const awayFromHost = isRemoteHostRenderer() || isSshConnectionWindow();
  const login = useOAuthLoginFlow({
    run,
    remote: awayFromHost,
    keyId: `mcp-${name}`,
    statusCapability: 'getMcpOAuthLoginStatus',
    cancelCapability: 'cancelMcpOAuthLogin',
    statusError: t('OAuth status could not be checked.'),
    // The status poll reported `complete`: the server list re-reads so its
    // connection state and the editor's connection card follow the sign-in.
    refresh: async () => {
      await refreshExtensions();
      return undefined;
    },
  });
  const { flow, error, mergeFlow, pasteError, setPasteError } = login;
  // A login that never started has no wait dialog to show its error in.
  useEffect(() => {
    if (!flow && error) showDesktopToast(error, 'error');
  }, [flow, error]);
  const connect = (serverName: string) => {
    setName(serverName);
    return login.start((away) =>
      run(
        'beginMcpOAuthLogin',
        // The host must not open a browser nobody is sitting at for a client away from it.
        away ? [serverName, { openBrowser: false }] : [serverName],
        `mcp-oauth-begin-${serverName}`,
        false,
        false,
        'throw'
      )
    );
  };
  const disconnect = (serverName: string) => run('signOutMcpServer', [serverName], `mcp-oauth-signout-${serverName}`);
  const dialog = flow ? (
    <OAuthLoginDialog
      portal
      id={`mcp-${name}`}
      closeLabel={t('Close OAuth login')}
      flow={flow}
      error={error}
      paste={
        login.remote
          ? {
              title: t('Sign-in redirect URL or code'),
              placeholder: t('Paste the final redirect URL or code'),
              ariaLabel: t('Sign-in redirect URL or code'),
              error: pasteError,
              onSubmit: (callbackUrl, form) => {
                setPasteError('');
                void run<RecordValue>(
                  'completeMcpOAuthLogin',
                  [flow.flowId, callbackUrl],
                  `mcp-oauth-complete-${name}`,
                  false,
                  false,
                  'throw'
                )
                  .then((next) => {
                    form.reset();
                    if (next) mergeFlow(record(next));
                    else setPasteError(t('Sign-in could not be completed with this authorization code.'));
                  })
                  .catch((reason) => setPasteError(pasteErrorText(reason)));
              },
            }
          : undefined
      }
      disabled={false}
      onClose={login.close}
    />
  ) : null;
  return { connect, disconnect, dialog };
}
