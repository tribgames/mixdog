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

/** The remote window's PC switcher talks to the main process over these. */
export const REMOTE_WINDOW_IPC = {
  list: 'mixdog:remote-window-hosts',
  open: 'mixdog:remote-window-open-host',
  manage: 'mixdog:remote-window-manage',
} as const;

/** One saved PC as the switcher in a remote window shows it. */
export interface RemoteWindowHostEntry {
  id: string;
  name: string;
  /** Null when the relay could not be asked. */
  online: boolean | null;
  lastConnectedAt: number | null;
  current: boolean;
}

/** What the remote window's preload adds for the top-bar switcher. */
export interface RemoteWindowSwitcherBridge {
  listHosts(): Promise<RemoteWindowHostEntry[]>;
  openHost(id: string): Promise<boolean>;
  /** Shows this machine's Settings → Connection → Connect to another PC. */
  manageConnections(): Promise<boolean>;
}

export function remoteWindowSwitcher(): RemoteWindowSwitcherBridge | null {
  if (typeof window === 'undefined') return null;
  const bridge = (window as unknown as { mixdogRemoteWindowSwitcher?: RemoteWindowSwitcherBridge })
    .mixdogRemoteWindowSwitcher;
  return bridge && typeof bridge.listHosts === 'function' ? bridge : null;
}

export function remoteWindowInfo(): MixdogRemoteWindowInfo | null {
  if (typeof window === 'undefined') return null;
  const info = (window as unknown as { mixdogRemoteWindow?: MixdogRemoteWindowInfo }).mixdogRemoteWindow;
  return info && typeof info.hostName === 'string' ? info : null;
}
