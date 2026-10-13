// The Ports panel of a server window: TCP ports listening on the server, and
// the ones forwarded to this PC's loopback through ssh.

/** One port something listens on, on the server. */
export interface DesktopServerPort {
  port: number;
  /** Where it listens: `0.0.0.0`, `127.0.0.1`, `::`, `::1`… (several, joined). */
  addresses: string[];
  /** The owning process, when the server lets the daemon read it. */
  process?: string;
  pid?: number;
}

export type DesktopPortForwardStatus = 'starting' | 'active' | 'error';

/** A server port forwarded to 127.0.0.1:`localPort` on this PC. */
export interface DesktopPortForward {
  remotePort: number;
  /** 0 until the first local port is chosen. */
  localPort: number;
  status: DesktopPortForwardStatus;
  /** Why it stopped, for `error`. */
  message?: string;
}

export interface DesktopServerPortsView {
  /** null: the last scan failed (see `scanError`) or none ran yet. */
  detected: DesktopServerPort[] | null;
  scanError?: string;
  forwards: DesktopPortForward[];
  /** Ports that started listening after the panel first looked: offered for forwarding, never forwarded on their own. */
  suggested: number[];
}
