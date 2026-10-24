// Structured reasons the host refuses a paired remote client's call. A display
// surface decides on the `code` the error carries (coded-error.ts), never on
// the English message, which is for the model and the logs.

/** Turning on "Allow all actions" is confirmed at the host PC only. */
export const REMOTE_DESKTOP_ONLY = 'REMOTE_DESKTOP_ONLY';

/** The remote-refusal code an error carries, or undefined for any other `code`. */
export function remoteErrorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return code === REMOTE_DESKTOP_ONLY ? code : undefined;
}

export function remoteDesktopOnlyError(message: string): TypeError & { code: string } {
  return Object.assign(new TypeError(message), { code: REMOTE_DESKTOP_ONLY });
}
