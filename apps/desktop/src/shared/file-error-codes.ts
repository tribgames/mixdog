// Structured reasons a file call is refused. Callers decide on the `code`,
// never on the message text (which carries file names and is for display).
// How a code crosses IPC and the relay is in coded-error.ts.

/** A held one-file access token names no live grant. */
export const SELECTED_FILE_GRANT_UNAVAILABLE = 'SELECTED_FILE_GRANT_UNAVAILABLE';
/** The Project is not registered (or its registration is gone). */
export const PROJECT_UNAVAILABLE = 'PROJECT_UNAVAILABLE';

const FILESYSTEM_CODES: ReadonlySet<string> = new Set([
  'ENOENT',
  'ENOTDIR',
  'EACCES',
  'EPERM',
  'EISDIR',
  'ELOOP',
  'ENAMETOOLONG',
  'EBUSY',
  'EIO',
  'EMFILE',
]);

/** The structured code an error carries, or undefined for any other `code`. */
export function fileErrorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  if (typeof code !== 'string') return undefined;
  return code === SELECTED_FILE_GRANT_UNAVAILABLE || code === PROJECT_UNAVAILABLE || FILESYSTEM_CODES.has(code)
    ? code
    : undefined;
}
