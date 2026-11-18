// The workspace folders a dialog hands the host, resolved against this process's working folder. Main process only: it needs
// `node:path`, which the phone's page (which shares ipc-validation.ts) does not have.
import * as nodePath from 'node:path';
import type { DesktopWorkspaceFolder } from '../shared/contract';
import { requiredString } from '../shared/scm-input';

export function requiredWorkspaceFolders(value: unknown): DesktopWorkspaceFolder[] {
  if (!Array.isArray(value) || value.length > 64) {
    throw new TypeError('Workspace folders are invalid.');
  }
  const seen = new Set<string>();
  return value.map((row) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      throw new TypeError('Workspace folder is invalid.');
    }
    const record = row as Record<string, unknown>;
    const path = nodePath.resolve(requiredString(record.path, 'workspace folder path', 16_384));
    if (!nodePath.isAbsolute(path)) throw new TypeError('Workspace folder path must be absolute.');
    const key = process.platform === 'win32' ? path.toLocaleLowerCase() : path;
    if (seen.has(key)) throw new TypeError('Workspace folders must be unique.');
    seen.add(key);
    return {
      path,
      ...(typeof record.name === 'string' && record.name.trim() ? { name: record.name.trim().slice(0, 200) } : {}),
    };
  });
}
