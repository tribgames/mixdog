/** A session id is a filename-safe slug; anything else never addresses a session. */
export const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
