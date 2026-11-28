import { useSyncExternalStore } from 'react';
import {
  isRemoteHostOpenAccess,
  remoteHostName,
  subscribeRemoteHostName,
  subscribeRemoteHostOpenAccess,
} from './remote-host-access-state';

export { isRemoteHostOpenAccess, setRemoteHostName, setRemoteHostOpenAccess } from './remote-host-access-state';

/** Re-renders when the connected PC's name is learned; '' until then. */
export function useRemoteHostName(): string {
  return useSyncExternalStore(subscribeRemoteHostName, remoteHostName, () => '');
}

/** Re-renders when the connected host's access level is learned or changes. */
export function useRemoteHostOpenAccess(): boolean {
  return useSyncExternalStore(subscribeRemoteHostOpenAccess, isRemoteHostOpenAccess, () => false);
}
