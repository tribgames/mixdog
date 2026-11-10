// The argument checks Node's remote methods ran before a call reached the desktop, with their exact error texts. The phone's
// adapters make the same checks before they send a protocol request, so a bad argument fails the way it did on Node.

export function requiredString(value: unknown, name: string, maximum = 32_768): string {
  if (typeof value !== 'string') throw new TypeError(`${name} must be a string.`);
  const text = value.trim();
  if (!text || text.length > maximum) throw new TypeError(`${name} is invalid.`);
  return text;
}

/** The shape of a path argument (a string, not empty, under 16384 characters, no NUL); whether it is absolute depends on
 *  the host's platform, so the caller decides. */
export function pathText(value: unknown): string {
  if (typeof value !== 'string') throw new TypeError('path must be a string.');
  const text = value.trim();
  if (!text || text.length > 16_384 || text.includes('\0')) throw new TypeError('path is invalid.');
  return text;
}
