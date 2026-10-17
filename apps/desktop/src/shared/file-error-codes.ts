// Structured reasons a file call is refused. Callers decide on the `code`,
// never on the message text (which carries file names and is for display).
// Electron drops custom Error properties across `ipcRenderer.invoke`, so a
// failing handler returns the code in an envelope the preload turns back into
// an Error; the remote relay's result frames carry it as `errorCode`.

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

const IPC_ERROR_KEY = '__mixdogIpcError';

/** The structured code an error carries, or undefined for any other `code`. */
export function fileErrorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  if (typeof code !== 'string') return undefined;
  return code === SELECTED_FILE_GRANT_UNAVAILABLE || code === PROJECT_UNAVAILABLE || FILESYSTEM_CODES.has(code)
    ? code
    : undefined;
}

export interface IpcErrorEnvelope {
  [IPC_ERROR_KEY]: { code: string; message: string };
}

/** What an IPC handler returns in place of rejecting, when the rejection
 *  carries a structured code; null for every other error (it rejects as is). */
export function ipcErrorEnvelope(error: unknown): IpcErrorEnvelope | null {
  const code = fileErrorCode(error);
  if (!code) return null;
  return { [IPC_ERROR_KEY]: { code, message: error instanceof Error ? error.message : String(error) } };
}

/** The Error an envelope stands for (same message, same code), or null when
 *  the value is an ordinary result. */
export function ipcErrorFromEnvelope(value: unknown): (Error & { code: string }) | null {
  if (!value || typeof value !== 'object' || !Object.hasOwn(value, IPC_ERROR_KEY)) return null;
  const nested = (value as IpcErrorEnvelope)[IPC_ERROR_KEY];
  if (!nested || typeof nested !== 'object') return null;
  const { code, message } = nested;
  if (typeof code !== 'string' || typeof message !== 'string') return null;
  return Object.assign(new Error(message), { code });
}
