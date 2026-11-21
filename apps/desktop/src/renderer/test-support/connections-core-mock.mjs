// Import this file first, then import the components dynamically: a module is replaced only for imports made after the mock is installed.
import { mock } from 'node:test';

const NO_CORE = 'This window has no connection to the core.';
const NAMES = [
  'sshListHosts',
  'sshRenameHost',
  'sshForgetHost',
  'sshOpenHost',
  'sshConfigHosts',
  'sshInspectHostKey',
  'sshConnect',
  'sshCancel',
  'sshAskpassReply',
  'sshCleanupHost',
  'sshCleanupTarget',
  'sshUpdateHostSettings',
  'sshServerLogins',
  'sshServerLoginBegin',
  'sshServerLoginStatus',
  'sshServerLoginComplete',
  'sshServerLoginCancel',
  'sshServerLoginSaveKey',
  'sshServerLoginLogout',
  'sshServerLoginRemoveCustom',
  'sshDiagnosticsLog',
  'sshDiagnosticsCopy',
  'sshServerLog',
  'getConnectionLink',
  'retryConnection',
  'retryConnectionNow',
  'getReopenServerWindows',
  'setReopenServerWindows',
  'getServerRestoreProgress',
  'listServerPorts',
  'forwardServerPort',
  'stopServerPortForward',
  'dismissServerPort',
  'openServerPortInBrowser',
  'requestConnectionSignIn',
  'subscribeSshAskpass',
  'subscribeSshProgress',
  'subscribeSshCleanupProgress',
  'subscribeSshServerLoginUpdated',
  'subscribeConnectionLink',
  'subscribeConnectionNotice',
  'subscribeConnectionSignIn',
  'subscribeServerPorts',
  'subscribeServerRestoreProgress',
  'subscribeSshHostsChanged',
];

let current = {};

const unanswered = (name) =>
  name.startsWith('subscribe') ? () => () => undefined : () => Promise.reject(new Error(NO_CORE));

mock.module(new URL('../connections-core-api.ts', import.meta.url).href, {
  namedExports: Object.fromEntries(
    NAMES.map((name) => [
      name,
      (...args) => (typeof current[name] === 'function' ? current[name] : unanswered(name))(...args),
    ])
  ),
});

/** The methods the components' calls answer with from now on (the previous ones are dropped). */
export function useConnectionsCore(api) {
  current = api;
}
