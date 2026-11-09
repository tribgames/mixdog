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

/** `path.resolve` of an absolute path as Node ran it on the desktop (`absoluteLocalPath`): separators unified, `.`/`..` and repeated or
 *  trailing separators removed, the root kept. A drive or UNC path is a Windows host's (`\` separators); anything else is POSIX. */
export function resolveHostPath(text: string): string {
  const windows = /^(?:[A-Za-z]:[\\/]|[\\/]{2})/.test(text);
  const parts = (windows ? text.replace(/\//g, '\\') : text).split(windows ? '\\' : '/');
  let root = windows ? '' : '/';
  if (windows) {
    const unc = text.startsWith('\\\\') || text.startsWith('//');
    // A UNC root is `\\server\share`; a drive root is `X:`. Both are followed by one separator.
    root = unc ? `\\\\${parts[2] ?? ''}\\${parts[3] ?? ''}` : parts[0];
    parts.splice(0, unc ? 4 : 1);
  }
  const kept: string[] = [];
  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..') kept.pop();
    else kept.push(part);
  }
  const sep = windows ? '\\' : '/';
  return `${root}${root.endsWith(sep) ? '' : sep}${kept.join(sep)}`;
}

/** Whether Node's folder-watch registry folds case for this path: it did on a Windows host (`toLocaleLowerCase`). */
export function foldsCase(resolved: string): boolean {
  return /^(?:[A-Za-z]:|\\\\)/.test(resolved);
}