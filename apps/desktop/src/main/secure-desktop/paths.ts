import { join } from 'node:path';

export const SERVICE_PIPE_NAME = '\\\\.\\pipe\\mixdog-secure-desktop';

export interface SecureDesktopEnvironment {
  isPackaged: boolean;
  platform: NodeJS.Platform;
  resourcesPath: string;
  cwd: string;
  /** `%ProgramData%`; defaults to the standard location when unset. */
  programData?: string;
}

/** Absolute path of the secure-desktop executable for this environment. */
export function secureDesktopExePath(environment: SecureDesktopEnvironment): string {
  const fileName = 'mixdog-secure-desktop.exe';
  if (environment.isPackaged) {
    return join(environment.resourcesPath, 'native-tools', fileName);
  }
  return join(environment.cwd, 'native', 'mixdog-secure-desktop', 'target', 'release', fileName);
}

/** The ACL-protected install state written by the elevated install step. */
export function stateFilePath(environment: Pick<SecureDesktopEnvironment, 'programData'>): string {
  const programData = environment.programData ?? 'C:\\ProgramData';
  return join(programData, 'Mixdog', 'SecureDesktop', 'state.json');
}
