import { remoteCapabilityBlocked } from '../../shared/remote-blocked-capabilities';
import { REMOTE_DESKTOP_ONLY, remoteErrorCode } from '../../shared/remote-error-codes';
import { t } from '../i18n';
import { isRemoteHostOpenAccess } from '../remote-host-access';
import { isRemoteHostRenderer } from '../remote-ui-projection';

// Lanes an older host still refuses to every paired client. A current host
// announces `remoteOpenAccess` in its handshake and serves them all.
const LEGACY_HOST_BLOCKED_CAPABILITIES: ReadonlySet<string> = new Set([
  'saveProviderApiKey',
  'saveCustomProvider',
  'saveCustomProviderKey',
  'removeCustomProvider',
  'updateCustomProviderModel',
  'testCustomProvider',
  'checkCustomProviderKeyEnv',
  'discoverCustomProviderModels',
  'authenticateProvider',
  'saveOpenAIUsageSessionKey',
  'loginOAuthProvider',
  'beginOAuthProviderLogin',
  'getOAuthProviderLoginStatus',
  'completeOAuthProviderLogin',
  'cancelOAuthProviderLogin',
  'beginMcpOAuthLogin',
  'getMcpOAuthLoginStatus',
  'completeMcpOAuthLogin',
  'cancelMcpOAuthLogin',
  'signOutMcpServer',
  'probeMcpServerAuth',
  'getMcpServerConfig',
  'saveMcpServer',
  'setDeveloperOption',
  'forgetProviderAuth',
]);

/** True when this surface drives a remote host that refuses `capability`:
 *  host-internal items always, the legacy lanes only on an older host. Callers
 *  that must react to the host's level subscribe with `useRemoteHostOpenAccess`. */
export function capabilityBlockedRemotely(capability: string): boolean {
  if (!isRemoteHostRenderer()) return false;
  return (
    remoteCapabilityBlocked(capability) ||
    (!isRemoteHostOpenAccess() && LEGACY_HOST_BLOCKED_CAPABILITIES.has(capability))
  );
}

/** Short note shown next to controls that only work on the host computer. */
export function manageOnHostNote(): string {
  return t('Manage on the host computer');
}

const BLOCKED_MESSAGE = /capability \S+ is not available over remote access\.?/;

/** Replaces the host's raw "capability X is not available over remote
 *  access." rejection with a friendly message; other errors pass through. */
export function friendlyCapabilityError(reason: unknown): unknown {
  if (remoteErrorCode(reason) === REMOTE_DESKTOP_ONLY) return new Error(t('Turn this on in the desktop app.'));
  const message = reason instanceof Error ? reason.message : String(reason);
  return BLOCKED_MESSAGE.test(message) ? new Error(t('This can only be managed on the host computer.')) : reason;
}
