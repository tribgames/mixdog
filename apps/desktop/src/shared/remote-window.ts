// What the "Connect to another PC" window tells the relay web app it runs in.

/** Launch argument carrying the host this window shows (main → preload). */
export const REMOTE_HOST_ARGUMENT = '--mixdog-remote-host=';

/** `window.mixdogRemoteWindow`, exposed only by the remote window's preload. It
 *  marks the page as a second PC's Mixdog desktop window: the pairing claim
 *  identifies as a desktop client and the app chrome names the host. It is a
 *  label, not a credential, and gives the page no access to this machine. */
export interface MixdogRemoteWindowInfo {
  hostId: string;
  hostName: string;
}

export function remoteWindowInfo(): MixdogRemoteWindowInfo | null {
  if (typeof window === 'undefined') return null;
  const info = (window as unknown as { mixdogRemoteWindow?: MixdogRemoteWindowInfo }).mixdogRemoteWindow;
  return info && typeof info.hostName === 'string' ? info : null;
}
