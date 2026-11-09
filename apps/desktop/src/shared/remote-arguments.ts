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

/** The path rules of the machine the files are on, which the host reports (`initialize`'s `platformOs`), never the spelling of a path:
 *  `/tmp/x` is a rooted path on a Windows host and an ordinary one on a POSIX host. */
export type HostPlatform = 'windows' | 'posix';

export const hostPlatformOf = (platformOs: unknown): HostPlatform => (platformOs === 'windows' ? 'windows' : 'posix');

/** The device of a Windows path in `\` spelling, as Node's `path.win32.resolve` reads it: `X:` before a separator, or a `\\server\share`
 *  with both parts; anything else (`\dir`, `\\server`) has none and takes the working directory's. */
const windowsRoot = (text: string): { device: string | null; rest: string } => {
  if (/^[A-Za-z]:\\/.test(text)) return { device: text.slice(0, 2), rest: text.slice(2) };
  const unc = /^\\\\([^\\]+)\\+([^\\]+)/.exec(text);
  return unc ? { device: `\\\\${unc[1]}\\${unc[2]}`, rest: text.slice(unc[0].length) } : { device: null, rest: text };
};

/** `path.isAbsolute` of the host: on Windows a rooted path (`\dir`, `/dir`, `//server`) counts as well as `X:\` and a UNC share. */
export function isAbsoluteOn(platform: HostPlatform, text: string): boolean {
  return platform === 'windows' ? /^(?:[\\/]|[A-Za-z]:[\\/])/.test(text) : text.startsWith('/');
}

/** Whether `resolveOn` needs the device of the host's working directory: a rooted Windows path names none. */
export const needsHostDevice = (platform: HostPlatform, text: string): boolean =>
  platform === 'windows' && windowsRoot(text.replace(/\//g, '\\')).device === null;

/** `path.resolve` of an absolute path on the host (Node's `absoluteLocalPath`): separators unified, `.`/`..` and repeated or trailing
 *  separators removed, the root kept. `hostDevice` is the working directory's device (`D:`, `\\server\share`) for a path without one. */
export function resolveOn(platform: HostPlatform, text: string, hostDevice: string): string {
  const windows = platform === 'windows';
  const spelled = windows ? text.replace(/\//g, '\\') : text;
  const { device, rest } = windows ? windowsRoot(spelled) : { device: '', rest: spelled };
  const kept: string[] = [];
  for (const part of rest.split(windows ? '\\' : '/')) {
    if (!part || part === '.') continue;
    if (part === '..') kept.pop();
    else kept.push(part);
  }
  const sep = windows ? '\\' : '/';
  return `${device ?? hostDevice}${sep}${kept.join(sep)}`;
}

/** Whether Node's folder-watch registry folds case: it did on a Windows host (`toLocaleLowerCase`). */
export const foldsCaseOn = (platform: HostPlatform): boolean => platform === 'windows';