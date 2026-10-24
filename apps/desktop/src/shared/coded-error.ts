// How a structured error code (file-error-codes.ts, room-error-codes.ts)
// crosses a boundary that drops custom Error properties: Electron's
// `ipcRenderer.invoke` (an envelope the preload turns back into an Error), the
// remote relay (frame fields `errorCode` / `errorParams`) and the daemon wire
// (`code` / `details`). Display code decides on the code and its params, never
// on the message text.
import { appendCodedTrailer, carriedErrorDetails, readCodedTrailer } from './error-trailer';
import { fileErrorCode } from './file-error-codes';
import { remoteErrorCode } from './remote-error-codes';
import { ROOM_CODE_PARAMS, ROOM_CODES, roomErrorCode } from './room-error-codes';
import { SCHEDULE_CODE_PARAMS, SCHEDULE_CODES, scheduleErrorCode } from './schedule-error-codes';

/** The codes a page translates, so the only ones whose message carries a trailer. */
const TRAILER_CODES: ReadonlySet<string> = new Set([...ROOM_CODES, ...SCHEDULE_CODES]);

/** The display params each code declares public: only these codes forward
 *  params, and only these names. Everything else (a file error's path, any
 *  other `details`) stays on its own side of the boundary. A param is shown
 *  to the user and travels in clear, so declare only values already public
 *  to that user (a room member's display name, a schedule's name); nothing
 *  here screens a value for secrets beyond the relay's redaction of the
 *  call's own secrets. */
const CODE_PARAMS: Readonly<Record<string, readonly 'name'[]>> = { ...ROOM_CODE_PARAMS, ...SCHEDULE_CODE_PARAMS };
const MAX_PARAM_LENGTH = 200;

export type CodedErrorParams = Partial<Record<'name', string>>;

/** The string params `value` carries that `code` declares public, or
 *  undefined when there is none. */
export function codedErrorParams(code: unknown, value: unknown): CodedErrorParams | undefined {
  const keys = typeof code === 'string' && Object.hasOwn(CODE_PARAMS, code) ? CODE_PARAMS[code] : [];
  if (!keys.length || !value || typeof value !== 'object') return undefined;
  const params: CodedErrorParams = {};
  for (const key of keys) {
    const param = Object.hasOwn(value, key) ? (value as Record<string, unknown>)[key] : undefined;
    if (typeof param === 'string' && param && param.length <= MAX_PARAM_LENGTH) params[key] = param;
  }
  return Object.keys(params).length ? params : undefined;
}

/** The structured code an error carries (file, room, remote or schedule), or undefined. */
export function codedErrorCode(error: unknown): string | undefined {
  return fileErrorCode(error) ?? roomErrorCode(error) ?? remoteErrorCode(error) ?? scheduleErrorCode(error);
}

/** The params an error carries in `details`, whitelisted. */
export function errorParams(error: unknown): CodedErrorParams | undefined {
  return codedErrorParams(codedErrorCode(error), carriedErrorDetails(error, TRAILER_CODES));
}

const IPC_ERROR_KEY = '__mixdogIpcError';

export interface IpcErrorEnvelope {
  [IPC_ERROR_KEY]: { code: string; message: string; params?: CodedErrorParams };
}

/** What an IPC handler returns in place of rejecting, when the rejection
 *  carries a structured code; null for every other error (it rejects as is). */
export function ipcErrorEnvelope(error: unknown): IpcErrorEnvelope | null {
  const code = codedErrorCode(error);
  if (!code) return null;
  const params = errorParams(error);
  return {
    [IPC_ERROR_KEY]: {
      code,
      message: error instanceof Error ? error.message : String(error),
      ...(params ? { params } : {}),
    },
  };
}

/** The Error an envelope stands for (same message, code and params), or null
 *  when the value is an ordinary result. The page sees it through
 *  `contextBridge`, which keeps only the message: a room or schedule refusal,
 *  which the page translates by its code, also carries that code and its
 *  params in a trailer of the message (error-trailer.ts). */
export function ipcErrorFromEnvelope(value: unknown): (Error & { code: string; details?: CodedErrorParams }) | null {
  if (!value || typeof value !== 'object' || !Object.hasOwn(value, IPC_ERROR_KEY)) return null;
  const nested = (value as IpcErrorEnvelope)[IPC_ERROR_KEY];
  if (!nested || typeof nested !== 'object') return null;
  const { code, message } = nested;
  if (typeof code !== 'string' || typeof message !== 'string') return null;
  const params = codedErrorParams(code, nested.params);
  return Object.assign(
    new Error(TRAILER_CODES.has(code) ? appendCodedTrailer(message, { code, ...(params ? { params } : {}) }) : message),
    { code },
    params ? { details: params } : {}
  );
}

/** The message a page shows for `reason`: without the trailer a room or
 *  schedule refusal carries across `contextBridge`. */
export function displayErrorMessage(reason: unknown): string {
  const trailer = readCodedTrailer(reason, TRAILER_CODES);
  if (trailer) return trailer.message;
  return reason instanceof Error ? reason.message : String(reason);
}

/** `reason` as a page should display it: an Error with such a trailer becomes
 *  the same refusal with its message cleaned (code and params kept); anything
 *  else is returned as it is. */
export function withoutErrorTrailer(reason: unknown): unknown {
  const trailer = readCodedTrailer(reason, TRAILER_CODES);
  if (!trailer) return reason;
  const params = codedErrorParams(trailer.code, trailer.params);
  return Object.assign(new Error(trailer.message), { code: trailer.code }, params ? { details: params } : {});
}
