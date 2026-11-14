/** A secret request's extra one-shot slots (main/secret-input.ts): a sign-in
 *  card's 아이디 and its "save this login" choice ride the request id with
 *  these suffixes; the password (or code) is the bare request id. */
export const SECRET_USERNAME_SUFFIX = '-username';
export const SECRET_SAVE_SUFFIX = '-save';

/** A secret request id as the runtime mints it (a sign-in card's username and save slots ride it with a suffix). The one
 *  definition: the core's slots, the window process's mirror and both renderer adapters check an id and a value with it. */
export const SECRET_REQUEST_ID = /^secret_[A-Za-z0-9-]{8,80}$/;
/** The longest value a secret slot takes (UTF-16 units). */
export const MAX_SECRET_LENGTH = 4_096;
