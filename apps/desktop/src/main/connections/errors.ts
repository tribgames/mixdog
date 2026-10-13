/** Electron's invoke drops every error property but the message, so the code
 *  leads the message (`remote-picker-required: …`) for the renderer to match. */
export type ConnectionErrorCode =
  | 'connection-route-missing'
  | 'connection-missing'
  | 'ssh-unsupported'
  | 'remote-picker-required'
  | 'connection-closed';

export class ConnectionError extends Error {
  override readonly name = 'ConnectionError';
  constructor(
    readonly code: ConnectionErrorCode,
    message: string
  ) {
    super(`${code}: ${message}`);
  }
}
