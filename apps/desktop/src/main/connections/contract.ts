// The connection contract: one desktop process holds this PC's daemon plus any
// number of SSH servers, each driven from its own window.
import type { DesktopConnectionIdentity } from '../../shared/contract';

export type ConnectionKind = DesktopConnectionIdentity['kind'];

/** This PC's daemon: always open, never closed through the manager. */
export const LOCAL_CONNECTION_ID = 'local';

export type ConnectionIdentity = DesktopConnectionIdentity;

export interface SshConnectionSpec {
  id: string;
  name: string;
  target: string;
}

export interface ConnectionProgress {
  phase: 'connect' | 'check' | 'install' | 'start' | 'ready';
  detail?: string;
}

export interface ConnectionOpenOptions {
  /** The user confirmed a `daemon-busy-other-version` failure: this open may
   *  stop the server's busy daemon of another version. Ignored when the
   *  server is already attached. */
  forceRestart?: boolean;
}

export interface ConnectionManager {
  /** Connects (bootstrap + tunnel + attach) when needed, then opens or focuses
   *  that server's window. Rejects with the RemoteBootstrapError / SshError
   *  that stopped the connection. */
  open(
    spec: SshConnectionSpec,
    onProgress?: (p: ConnectionProgress) => void,
    options?: ConnectionOpenOptions
  ): Promise<void>;
  /** The server's connection is attached (its window is open or opening). */
  isOpen(id: string): boolean;
  /** The saved model login of an attached server changed: its daemon
   *  restarts in that mode behind the open windows. Nothing when not attached. */
  applyModelLogin?(id: string, modelLogin: 'pc' | 'server'): Promise<void>;
  /** Detaches: closes the window and the tunnel; the remote daemon keeps running. */
  close(id: string): Promise<void>;
}
