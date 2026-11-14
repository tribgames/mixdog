// The file hand-offs of source control that stay in main: reveal, open, and the temporary copy an inline attachment image needs
// before a viewer can open it (handing a file to the operating system is Electron's). The Git and GitHub operations are requests
// of the window's own core connection.
import type { App, Shell } from 'electron';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { DESKTOP_IPC, type DesktopLocalPathEntry } from '../shared/contract';
import { requiredRepositoryCwd } from './git-contract.mjs';
import { attachmentImageBaseName, requiredAttachmentImage, requiredString } from './ipc-validation';
import type { IpcHandle as Handle } from './ipc';
import { launchFile } from './file-launch';
import { putBlobRef } from './core-blob-ref';
import { coreErrorForWindow } from './protocol/core-error';
import type { ProtocolConnection } from './protocol/connection';

interface SourceControlIpcOptions {
  app: Partial<Pick<App, 'getPath'>>;
  handle: Handle;
  shell: Pick<Shell, 'openPath' | 'showItemInFolder'>;
  describeLocalPaths: (paths: unknown) => Promise<DesktopLocalPathEntry[]>;
  grantedFile: (
    accessToken: unknown,
    projectPath: unknown,
    relPath: unknown
  ) => Promise<{ root: string; rel: string; absolute: string }>;
  /** A server window stages an attachment into the server's upload folder,
   *  where its daemon (and the editor of that window) can reach it. */
  stageAttachment?: (dataUrl: unknown, name: unknown) => Promise<DesktopLocalPathEntry>;
  /** This PC's core connection: an attachment opened or staged here is written by its `desktop/attachment/write`; without one that fails. */
  core?: Pick<ProtocolConnection, 'call'> | null;
}

export function registerSourceControlIpc({
  app,
  handle,
  shell,
  grantedFile,
  describeLocalPaths,
  stageAttachment,
  core,
}: SourceControlIpcOptions): void {
  const resolveInsideProject = (cwd: unknown, path: unknown): string => {
    const root = resolve(requiredRepositoryCwd(cwd));
    const absolute = resolve(root, requiredString(path, 'file path', 4_096));
    if (absolute !== root && !absolute.startsWith(root + sep)) {
      throw new TypeError('The file path escapes the project directory.');
    }
    return absolute;
  };
  handle(DESKTOP_IPC.revealFile, async (_event, cwd, path, accessToken) => {
    const absolute =
      typeof accessToken === 'string' && accessToken
        ? (await grantedFile(accessToken, cwd, path)).absolute
        : resolveInsideProject(cwd, path);
    shell.showItemInFolder(absolute);
  });
  handle(DESKTOP_IPC.openFilePath, async (_event, cwd, path, accessToken, confirmedPath) => {
    const absolute =
      typeof accessToken === 'string' && accessToken
        ? (await grantedFile(accessToken, cwd, path)).absolute
        : resolveInsideProject(cwd, path);
    return launchFile(absolute, (file) => shell.openPath(file), confirmedPath);
  });
  handle(DESKTOP_IPC.openAttachmentImage, async (_event, dataUrl, name) => {
    const image = requiredAttachmentImage(dataUrl);
    const temp = typeof app.getPath === 'function' ? app.getPath('temp') : '';
    if (!temp) throw new Error('Unable to open image: no temporary directory.');
    const directory = join(temp, 'mixdog-attachments');
    await mkdir(directory, { recursive: true });
    const digest = createHash('sha256').update(image.bytes).digest('hex').slice(0, 16);
    const file = join(directory, `${attachmentImageBaseName(name)}-${digest}.${image.extension}`);
    await writeFile(file, image.bytes, { mode: 0o600 });
    const failure = await shell.openPath(file);
    if (failure) throw new Error(`Unable to open image: ${failure}`);
  });
  // The core checks the type against the inert-extension allowlist before it touches disk and answers the file's absolute path.
  const writeAttachmentFile = async (dataUrl: unknown, name: unknown): Promise<string> => {
    if (!core) throw new Error('The core connection is not available.');
    try {
      // The data URL travels as a blob: an attachment is larger than one frame; a value that is no string reaches the core as it is, which refuses it.
      const data = typeof dataUrl === 'string' ? await putBlobRef(core, Buffer.from(dataUrl, 'utf8'), 'text') : dataUrl;
      return ((await core.call('desktop/attachment/write', { dataUrl: data, name })) as { path: string }).path;
    } catch (error) {
      throw coreErrorForWindow(error);
    }
  };
  handle(DESKTOP_IPC.openAttachmentFile, async (_event, dataUrl, name) => {
    const file = await writeAttachmentFile(dataUrl, name);
    const failure = await shell.openPath(file);
    if (failure) throw new Error(`Unable to open file: ${failure}`);
  });
  handle(DESKTOP_IPC.stageAttachmentFile, async (_event, dataUrl, name) => {
    if (stageAttachment) return stageAttachment(dataUrl, name);
    const file = await writeAttachmentFile(dataUrl, name);
    const [row] = await describeLocalPaths([file]);
    if (!row) throw new Error('Unable to stage file.');
    return row;
  });
}
