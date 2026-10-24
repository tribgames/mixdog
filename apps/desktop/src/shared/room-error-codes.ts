// Structured reasons a group-room call is refused. A display surface decides
// on the `code` and the `name` parameter the error carries (coded-error.ts),
// never on the English message, which is for the model and the logs.
import { carriedErrorCode } from './error-trailer';

/** A message names a room member whose bot is switched off (param: `name`). */
export const ROOM_MEMBER_SWITCHED_OFF = 'ROOM_MEMBER_SWITCHED_OFF';

export const ROOM_CODES: ReadonlySet<string> = new Set([ROOM_MEMBER_SWITCHED_OFF]);

/** The display params these codes declare public: a member's display name. */
export const ROOM_CODE_PARAMS: Readonly<Record<string, readonly 'name'[]>> = {
  [ROOM_MEMBER_SWITCHED_OFF]: ['name'],
};

/** The room code an error carries, or undefined for any other `code`. */
export function roomErrorCode(error: unknown): string | undefined {
  const code = carriedErrorCode(error, ROOM_CODES);
  return typeof code === 'string' && ROOM_CODES.has(code) ? code : undefined;
}

export function roomMemberSwitchedOffError(name: string): Error & { code: string; details: { name: string } } {
  return Object.assign(new Error(`"${name}" is switched off.`), { code: ROOM_MEMBER_SWITCHED_OFF, details: { name } });
}
