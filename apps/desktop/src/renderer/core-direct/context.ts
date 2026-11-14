// What every composed renderer API (createSessionsApi, createFilesApi, ...) is built over: this window connection to the
// core, the identity the core gave it, and the one place a request is sent from.
import { directWindow, pcCoreClient, type CoreWindowInfo } from './client.ts';
import type { RendererConnection, Sender } from './renderer-connection.ts';

export interface DirectContext {
  /** The connection the shared lanes run against. */
  readonly connection: RendererConnection;
  /** The window as the core initialize reply names it; undefined before the client opens or on a core without Window scope. */
  window(): CoreWindowInfo | undefined;
  /** This PC core client (see pcCoreClient). */
  pcClient: typeof pcCoreClient;
  /** One request to the core, through the sender; the connection maps its failure as the IPC path did. */
  call(method: string, params?: unknown): Promise<unknown>;
  /** Replaces how a request leaves (the size-aware sender, sized-call). */
  setSender(send: Sender): void;
}

export function createDirectContext(connection: RendererConnection): DirectContext {
  return {
    connection,
    window: directWindow,
    pcClient: pcCoreClient,
    call: (method, params = {}) => connection.call(method, params),
    setSender: (send) => connection.setSender(send),
  };
}
