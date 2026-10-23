/** A bootstrap or install step on the server failed with a contract `code`
 *  (the server program's MIXDOG_ERROR code or a desktop-side check). */
export class RemoteBootstrapError extends Error {
  override readonly name = 'RemoteBootstrapError';
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
  }
}

/** Failures only a change on the server (or a user decision) fixes. Re-running
 *  the ssh probe cannot help, so the connection stops until it is reopened. */
export const TERMINAL_BOOTSTRAP_CODES: ReadonlySet<string> = new Set([
  'node-missing',
  'node-too-old',
  'npm-missing',
  'mixdog-missing',
  'daemon-not-proxy',
  'daemon-model-login',
  'protocol-mismatch',
  'unsupported-platform',
  'daemon-busy-other-version',
  'daemon-unmanaged',
  'daemon-data-in-use',
  'install-locked',
  'port-unavailable',
]);
