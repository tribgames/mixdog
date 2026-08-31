import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

export interface NativeBrowserImporter {
  executable: string;
  sha256: string;
}

export interface NativeBrowserImporterEnvironment {
  isPackaged: boolean;
  platform: NodeJS.Platform;
  resourcesPath: string;
}

export function nativeBrowserImporterPath(
  environment: NativeBrowserImporterEnvironment & { cwd: string },
): string {
  const fileName = environment.platform === 'win32'
    ? 'mixdog-browser-import.exe'
    : 'mixdog-browser-import';
  if (environment.isPackaged) {
    return join(environment.resourcesPath, 'native-tools', fileName);
  }
  return join(
    environment.cwd,
    'native',
    'mixdog-browser-import',
    'target',
    'release',
    fileName,
  );
}

export async function resolvePackagedBrowserImporter(
  environment: NativeBrowserImporterEnvironment & { requestedPath?: string },
): Promise<NativeBrowserImporter | undefined> {
  if (!environment.isPackaged || environment.platform !== 'win32') return undefined;
  if (!environment.requestedPath) return undefined;
  const expected = resolve(
    environment.resourcesPath,
    'native-tools',
    'mixdog-browser-import.exe',
  );
  if (resolve(environment.requestedPath).toLowerCase() !== expected.toLowerCase()) {
    return undefined;
  }
  if (!existsSync(expected)) return undefined;
  if (!existsSync(join(dirname(expected), 'bitwarden_chromium_import_helper.exe'))) {
    return undefined;
  }
  return {
    executable: expected,
    sha256: createHash('sha256').update(await readFile(expected)).digest('hex'),
  };
}
