// The handlers only a server (ssh) window registers: uploads of this PC's
// files into the server's staging folder, "download to this PC", and the
// trash probe its delete confirmation reads. Every byte travels over the
// window's own session connection (see server-file-access.ts).
import type { Shell } from 'electron';

import { DESKTOP_IPC } from '../shared/contract';
import { launchFile } from './file-launch';
import type { IpcHandle as Handle } from './ipc';
import { requiredString } from './ipc-validation';
import {
  SERVER_UPLOAD_CHUNK_BYTES,
  serverUploadAck,
  serverUploadBegun,
  serverUploadedEntry,
  serverUploadId,
  type ServerFiles,
} from './server-file-access';

/** Renderer uploads this window tracks at once (each holds two numbers). */
const MAX_TRACKED_UPLOADS = 64;

interface ServerFileIpcOptions {
  handle: Handle;
  server: ServerFiles;
  invokeDesktopOperation: <T>(method: string, args: unknown[]) => Promise<T>;
  /** The editor's own target resolution: a registered project or a grant. */
  fileTarget(projectPath: unknown, relPath: unknown, accessToken: unknown): Promise<{ root: string; rel: string }>;
  projectDirectory(projectPath: string): Promise<string>;
  shell: Pick<Shell, 'openPath'>;
}

function uploadChunkBytes(value: unknown): Buffer {
  if (!(value instanceof Uint8Array) || value.length === 0 || value.length > SERVER_UPLOAD_CHUNK_BYTES) {
    throw new TypeError('upload chunk is invalid.');
  }
  return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
}

export function registerServerFileIpc({
  handle,
  server,
  invokeDesktopOperation,
  fileTarget,
  projectDirectory,
  shell,
}: ServerFileIpcOptions): void {
  // Every server answer is checked against what this PC sent: the declared
  // size, and the exact bytes each chunk carried (so an upload always advances
  // or fails). A violation aborts the upload on the server.
  const uploads = new Map<string, { size: number }>();
  const tracked = (uploadId: unknown) => {
    const id = requiredString(uploadId, 'uploadId', 64);
    const upload = uploads.get(id);
    if (!upload) throw new Error('The upload is gone: it was cancelled or failed.');
    return { id, upload };
  };
  const violated = async (id: string, error: unknown): Promise<never> => {
    uploads.delete(id);
    await invokeDesktopOperation('serverUploadAbort', [id]).catch(() => {});
    throw error;
  };

  handle(DESKTOP_IPC.serverUploadBegin, async (_event, name, size, scope) => {
    const answer = await invokeDesktopOperation('serverUploadBegin', [
      requiredString(name, 'name', 1_024),
      size,
      scope,
    ]);
    const uploadId = serverUploadId(answer);
    let begun: ReturnType<typeof serverUploadBegun>;
    try {
      begun = serverUploadBegun(answer);
    } catch (error) {
      return violated(uploadId, error);
    }
    // The daemon refused any size that is not a positive integer within its limit.
    uploads.set(begun.uploadId, { size: Number(size) });
    while (uploads.size > MAX_TRACKED_UPLOADS) {
      const oldest = uploads.keys().next().value;
      if (oldest === undefined) break;
      uploads.delete(oldest);
    }
    return begun;
  });
  handle(DESKTOP_IPC.serverUploadChunk, async (_event, uploadId, offset, bytes) => {
    const { id, upload } = tracked(uploadId);
    const chunk = uploadChunkBytes(bytes);
    if (
      typeof offset !== 'number' ||
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      offset + chunk.length > upload.size
    ) {
      throw new TypeError('upload offset is invalid.');
    }
    const ack = await invokeDesktopOperation('serverUploadChunk', [id, offset, chunk.toString('base64')]);
    try {
      return serverUploadAck(ack, offset, chunk.length);
    } catch (error) {
      return violated(id, error);
    }
  });
  handle(DESKTOP_IPC.serverUploadCommit, async (_event, uploadId) => {
    const { id, upload } = tracked(uploadId);
    const committed = await invokeDesktopOperation('serverUploadCommit', [id]);
    uploads.delete(id);
    let uploaded: ReturnType<typeof serverUploadedEntry>;
    try {
      uploaded = serverUploadedEntry(committed, upload.size);
    } catch (error) {
      return violated(id, error);
    }
    // The staging folder is outside every project: the entry carries a grant.
    return server.grants.entry(uploaded.absolutePath, uploaded);
  });
  handle(DESKTOP_IPC.serverUploadAbort, (_event, uploadId) => {
    const id = requiredString(uploadId, 'uploadId', 64);
    uploads.delete(id);
    return invokeDesktopOperation('serverUploadAbort', [id]);
  });
  handle(DESKTOP_IPC.serverDownloadBegin, async (_event, projectPath, relPath, accessToken) => {
    const target = await fileTarget(projectPath, relPath, accessToken);
    return server.downloads.begin(target.root, target.rel);
  });
  handle(DESKTOP_IPC.serverDownloadStep, (_event, downloadId) => server.downloads.step(downloadId));
  handle(DESKTOP_IPC.serverDownloadFinish, (_event, downloadId) => server.downloads.finish(downloadId));
  handle(DESKTOP_IPC.serverDownloadAbort, (_event, downloadId) => server.downloads.abort(downloadId));
  handle(DESKTOP_IPC.openServerDownload, (_event, path, confirmedPath) =>
    launchFile(server.downloads.requireDownloaded(path), (file) => shell.openPath(file), confirmedPath)
  );
  handle(DESKTOP_IPC.serverTrashInfo, async (_event, projectPath) =>
    invokeDesktopOperation('serverTrashInfo', [await projectDirectory(requiredString(projectPath, 'projectPath'))])
  );
}
