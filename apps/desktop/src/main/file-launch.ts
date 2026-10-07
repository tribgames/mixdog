import { realpath, stat } from 'node:fs/promises';
import { requiresFileLaunchConfirmation, type FileLaunchConfirmation } from '../shared/local-files';

/** The response is a request for renderer confirmation, never permission to
 *  execute. Re-resolve on acceptance so a changed symlink needs a new answer. */
export async function launchFile(
  file: string,
  openPath: (path: string) => Promise<string>,
  confirmedPath?: unknown
): Promise<FileLaunchConfirmation | undefined> {
  const canonical = await realpath(file);
  const info = await stat(canonical);
  const executable = info.isFile() && process.platform !== 'win32' && (info.mode & 0o111) !== 0;
  if ((executable || requiresFileLaunchConfirmation(canonical)) && confirmedPath !== canonical) {
    return { confirmationPath: canonical };
  }
  const failure = await openPath(canonical);
  if (failure) throw new Error(`Unable to open file: ${failure}`);
}
