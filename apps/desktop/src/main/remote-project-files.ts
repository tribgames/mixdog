// The paired-device side of the editor's file operations. Each takes the deny
// policy of the process that authorized the request (sensitivePolicy) and
// reaches the file only through openAuthorizedFile: the open file's real
// location must be inside its folder and not secret-bearing, and every byte —
// read or written — goes through that handle, so a path swapped for a link
// between the request's checks and the I/O reaches nothing. They run in the
// desktop operation service, beside the desktop's own writes, so they share
// its per-file mutation claims.
import { basename, join } from 'node:path';

import type { DesktopEditorSettings, DesktopWorkspace, DesktopWorkspaceFolder } from '../shared/contract';
import { localFileMimeTypeForPath } from '../shared/local-files';
import { absoluteLocalPath, MAX_LOCAL_FILE_BYTES } from './local-files';
import { createAuthorizedFile, openAuthorizedFile } from './opened-file-authorization';
import {
  type ProjectTextEncoding,
  type ProjectTextFile,
  projectEntryPathIn,
  readProjectTextFileThrough,
  rewriteFileThrough,
  writeProjectTextFileThrough,
  writeProjectTextFilesThrough,
} from './project-files';
import { requiredSensitivePolicy } from './remote-sensitive-paths';
import {
  scopedEditorSettingsFromText,
  workspaceConfiguration,
  workspaceFilePath,
  workspaceFileText,
} from './workspace-config';

/** Largest settings file a remote settings read takes. */
const MAX_SETTINGS_BYTES = 1_048_576;

const opener = (root: string, policy: unknown) => {
  const valid = requiredSensitivePolicy(policy);
  return async (absolute: string) => (await openAuthorizedFile(absolute, root, valid, 'write')).handle;
};

/** A project (or granted) file's text, read through the authorized handle. */
export async function readProjectTextFileAuthorized(
  root: string,
  relPath: string,
  policy: unknown
): Promise<ProjectTextFile> {
  const file = await openAuthorizedFile(projectEntryPathIn(root, relPath), root, requiredSensitivePolicy(policy));
  try {
    return await readProjectTextFileThrough(file.handle);
  } finally {
    await file.handle.close();
  }
}

/** A save, checked and written through the authorized handle. */
export function writeProjectTextFileAuthorized(
  root: string,
  relPath: string,
  content: string,
  expectedContent: string,
  encoding: ProjectTextEncoding | undefined,
  policy: unknown
): Promise<{ mtimeMs: number }> {
  return writeProjectTextFileThrough(root, relPath, content, expectedContent, encoding, opener(root, policy));
}

/** A multi-file edit, every file checked and written through its handle. */
export function writeProjectTextFilesAuthorized(
  root: string,
  writes: ReadonlyArray<{ relPath: string; content: string; expectedContent: string }>,
  policy: unknown,
  recoveryDataPath?: string
): Promise<void> {
  return writeProjectTextFilesThrough(root, writes, opener(root, policy), recoveryDataPath);
}

/** An attachment's bytes (readLocalFileAbs), read through the authorized
 *  handle of `path` within `within`. */
export async function readLocalFileAuthorized(
  path: unknown,
  within: string,
  policy: unknown
): Promise<{ name: string; size: number; mimeType: string; data: string }> {
  const absolute = absoluteLocalPath(path);
  const file = await openAuthorizedFile(absolute, within, requiredSensitivePolicy(policy));
  try {
    if (file.size > MAX_LOCAL_FILE_BYTES) throw new Error(`${basename(absolute)}: files must be 20 MB or smaller.`);
    const data = await file.handle.readFile();
    return {
      name: basename(absolute),
      size: data.length,
      mimeType: localFileMimeTypeForPath(absolute),
      data: data.toString('base64'),
    };
  } finally {
    await file.handle.close();
  }
}

/** writeWorkspaceFile for a paired device: the file (whose provenance the
 *  caller established within `within`) is opened — or created — and
 *  authorized, its existing configuration read and the new text written
 *  through that one handle. */
export async function writeWorkspaceFileAuthorized(
  workspaceFile: string,
  folders: readonly DesktopWorkspaceFolder[],
  within: string,
  policy: unknown
): Promise<DesktopWorkspace> {
  const valid = requiredSensitivePolicy(policy);
  const path = workspaceFilePath(workspaceFile);
  const file = await openAuthorizedFile(path, within, valid, 'write').catch((error) => {
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
    return createAuthorizedFile(path, within, valid);
  });
  try {
    if (file.size > MAX_SETTINGS_BYTES) throw new Error('The workspace file is too large.');
    const existing = file.size ? await file.handle.readFile('utf8') : null;
    const { text, workspace } = workspaceFileText(path, folders, workspaceConfiguration(existing));
    await rewriteFileThrough(file.handle, Buffer.from(text, 'utf8'));
    return workspace;
  } finally {
    await file.handle.close();
  }
}

/** Text of an authorized settings file; null when it does not exist. */
async function settingsText(absolute: string, within: string, policy: unknown): Promise<string | null> {
  let file: Awaited<ReturnType<typeof openAuthorizedFile>>;
  try {
    file = await openAuthorizedFile(absolute, within, requiredSensitivePolicy(policy));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    throw error;
  }
  try {
    if (file.size > MAX_SETTINGS_BYTES) throw new Error('The settings file is too large.');
    return await file.handle.readFile('utf8');
  } finally {
    await file.handle.close();
  }
}

/** readScopedEditorSettings for a paired device: the project's
 *  `.vscode/settings.json` and the workspace file (whose provenance the
 *  caller established: `within` is the folder it was authorized in) are read
 *  through authorized handles; the app's own user settings as usual. */
export async function readScopedEditorSettingsAuthorized(
  userDataPath: string,
  root: string,
  relPath: string,
  workspace: { path: string; within: string } | null,
  policy: unknown
): Promise<DesktopEditorSettings> {
  const [workspaceText, folderText] = await Promise.all([
    workspace ? settingsText(workspace.path, workspace.within, policy) : null,
    settingsText(join(root, '.vscode', 'settings.json'), root, policy),
  ]);
  return scopedEditorSettingsFromText(userDataPath, relPath, workspaceText, folderText);
}
