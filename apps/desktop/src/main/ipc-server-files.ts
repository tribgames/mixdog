// The handlers only a server (ssh) window registers: uploads of this PC's
// files into the server's staging folder, "download to this PC", and the
// trash probe its delete confirmation reads. Uploads travel over the window's
// own session connection; a download is this PC's core's (see server-file-access.ts).
import type { Shell } from 'electron';

import { DESKTOP_IPC } from '../shared/contract';
import { launchFile } from './file-launch';
import type { IpcHandle as Handle } from './ipc';
import { requiredString } from './ipc-validation';
import type { ServerFiles, ServerUploads } from './server-file-access';

interface ServerFileIpcOptions {
  handle: Handle;
  server: ServerFiles;
  /** The server connection's one upload coordinator, shared with every other window and the attachment staging. */
  uploads: ServerUploads & { releaseOwner(owner: object): void };
  invokeDesktopOperation: <T>(method: string, args: unknown[]) => Promise<T>;
  /** The editor's own target resolution: a registered project or a grant. */
  fileTarget(projectPath: unknown, relPath: unknown, accessToken: unknown): Promise<{ root: string; rel: string }>;
  projectDirectory(projectPath: string): Promise<string>;
  shell: Pick<Shell, 'openPath'>;
}

/** Returns the window's teardown: its own uploads are cancelled, another window's are not. */
export function registerServerFileIpc({
  handle,
  server,
  uploads,
  invokeDesktopOperation,
  fileTarget,
  projectDirectory,
  shell,
}: ServerFileIpcOptions): () => void {
  // This window's uploads are the coordinator's, named by opaque handles that only this window's owner may use: the
  // coordinator checks offsets, sizes, depth and completion, and paces every chunk against the connection's allowance.
  const owner = {};

  handle(DESKTOP_IPC.serverUploadBegin, (_event, name, size, scope) =>
    uploads.begin(owner, requiredString(name, 'name', 1_024), size as number, requiredString(scope, 'scope', 256))
  );
  handle(DESKTOP_IPC.serverUploadChunk, async (_event, uploadId, offset, bytes) => {
    const id = requiredString(uploadId, 'uploadId', 64);
    if (!(bytes instanceof Uint8Array) || typeof offset !== 'number') throw new TypeError('upload chunk is invalid.');
    await uploads.write(owner, id, offset, bytes);
    return { received: offset + bytes.length };
  });
  handle(DESKTOP_IPC.serverUploadCommit, async (_event, uploadId) => {
    const uploaded = await uploads.commit(owner, requiredString(uploadId, 'uploadId', 64));
    // The staging folder is outside every project: the entry carries a grant.
    return server.grants.entry(uploaded.absolutePath, uploaded);
  });
  handle(DESKTOP_IPC.serverUploadAbort, (_event, uploadId) =>
    uploads.abort(owner, requiredString(uploadId, 'uploadId', 64))
  );
  handle(DESKTOP_IPC.serverDownloadBegin, async (_event, projectPath, relPath, accessToken) => {
    const target = await fileTarget(projectPath, relPath, accessToken);
    return server.downloads.begin(target.root, target.rel);
  });
  handle(DESKTOP_IPC.serverDownloadStep, (_event, downloadId) => server.downloads.step(downloadId));
  handle(DESKTOP_IPC.serverDownloadFinish, (_event, downloadId) => server.downloads.finish(downloadId));
  handle(DESKTOP_IPC.serverDownloadAbort, (_event, downloadId) => server.downloads.abort(downloadId));
  handle(DESKTOP_IPC.openServerDownload, async (_event, path, confirmedPath) =>
    launchFile(await server.downloads.requireDownloaded(path), (file) => shell.openPath(file), confirmedPath)
  );
  handle(DESKTOP_IPC.serverTrashInfo, async (_event, projectPath) =>
    invokeDesktopOperation('serverTrashInfo', [await projectDirectory(requiredString(projectPath, 'projectPath'))])
  );
  return () => uploads.releaseOwner(owner);
}
