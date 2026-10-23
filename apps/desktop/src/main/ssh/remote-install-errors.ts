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
  // This PC's own runtime payload is missing or unusable: nothing was sent to
  // the server, and redialing cannot restore a local file.
  'local-payload',
]);

const LOCAL_FILESYSTEM_CODES: ReadonlySet<string> = new Set(['ENOENT', 'EACCES', 'EPERM', 'EISDIR', 'ENOTDIR']);

/** A Node file error from reading this PC's own files (the daemon bundle, the
 *  payload sources). A failed ssh spawn (`syscall: spawn …`) is not one. */
export function isLocalFilesystemError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const { code, syscall } = error as NodeJS.ErrnoException;
  return typeof code === 'string' && LOCAL_FILESYSTEM_CODES.has(code) && !(syscall ?? '').startsWith('spawn');
}
