// The shell tool's optional `cwd` argument: where one command runs. Omitted,
// the command runs in the session cwd; a relative value resolves against it.
import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

// `~`, `~/x` (and `~\x` on Windows) name the user's home folder.
function expandHome(path) {
  if (path === '~') return homedir();
  if (path.startsWith('~/') || (process.platform === 'win32' && path.startsWith('~\\'))) {
    return resolve(homedir(), path.slice(2));
  }
  return path;
}

/** The directory a shell call runs in: its `cwd` argument resolved against the session cwd. */
export function effectiveShellCwd(args, sessionCwd) {
  const requested = args?.cwd;
  // Trim only decides blank; a name with edge spaces is used as given.
  if (typeof requested !== 'string' || requested.trim() === '') return sessionCwd;
  return resolve(sessionCwd || process.cwd(), expandHome(requested));
}

/** The cwd hooks and approvals see for a tool call: the effective one for shell, the session cwd otherwise. */
export function effectiveToolCwd(toolName, args, sessionCwd) {
  return toolName === 'shell' ? effectiveShellCwd(args, sessionCwd) : sessionCwd;
}

/** An error naming the path when `dir` is not an existing directory, else null. */
export async function shellCwdError(dir) {
  let info;
  try {
    info = await stat(dir);
  } catch {
    return `shell cwd "${dir}" does not exist`;
  }
  return info.isDirectory() ? null : `shell cwd "${dir}" is not a directory`;
}
