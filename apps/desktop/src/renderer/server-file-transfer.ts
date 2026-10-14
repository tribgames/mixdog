// A server (ssh) window's file transfers, driven from the renderer so progress
// and cancel stay with the UI: an upload streams one chunk per call into the
// server's staging folder, a download pulls one ranged read per call into
// this PC's download folder. Main validates and forwards each call over the
// window's own connection.
import type { DesktopApi, DesktopLocalPathEntry } from '../shared/contract';
import { SERVER_UPLOAD_MAX_BYTES } from '../shared/server-files';
import { t } from './i18n';

export type ServerUploadApi = Required<
  Pick<DesktopApi, 'serverUploadBegin' | 'serverUploadChunk' | 'serverUploadCommit' | 'serverUploadAbort'>
>;
export type ServerDownloadApi = Required<
  Pick<DesktopApi, 'serverDownloadBegin' | 'serverDownloadStep' | 'serverDownloadFinish' | 'serverDownloadAbort'>
>;

/** The user stopped the transfer; nothing is left behind on either side. */
export class ServerTransferCancelledError extends Error {
  constructor() {
    super('The transfer was cancelled.');
    this.name = 'ServerTransferCancelledError';
  }
}

interface TransferOptions {
  signal?: AbortSignal;
  onProgress?(sent: number, total: number): void;
}

const MB = 1024 * 1024;

export { serverUploadScope } from '../shared/server-files';

/** Why `file` cannot be uploaded, or '' when it can. */
export function serverUploadRefusal(file: Pick<File, 'name' | 'size'>): string {
  const name = file.name || t('Pasted file');
  if (file.size === 0) return t('{{name}}: the file is empty.', { name });
  if (file.size > SERVER_UPLOAD_MAX_BYTES) {
    return t('{{name}}: only files up to {{limit}} MB can be uploaded to the server.', {
      name,
      limit: SERVER_UPLOAD_MAX_BYTES / MB,
    });
  }
  return '';
}

/** Streams `file` into the server's staging folder; resolves with its entry
 *  there (server path plus the grant the editor and previews use). */
export async function uploadFileToServer(
  api: ServerUploadApi,
  file: File,
  scope: string,
  { signal, onProgress }: TransferOptions = {}
): Promise<DesktopLocalPathEntry> {
  const refusal = serverUploadRefusal(file);
  if (refusal) throw new Error(refusal);
  if (signal?.aborted) throw new ServerTransferCancelledError();
  const { uploadId, chunkBytes } = await api.serverUploadBegin(file.name || 'attachment', file.size, scope);
  try {
    let sent = 0;
    while (sent < file.size) {
      if (signal?.aborted) throw new ServerTransferCancelledError();
      const bytes = new Uint8Array(await file.slice(sent, sent + chunkBytes).arrayBuffer());
      if (!bytes.length) throw new Error(t('{{name}}: the file changed while it was uploading.', { name: file.name }));
      sent = (await api.serverUploadChunk(uploadId, sent, bytes)).received;
      onProgress?.(sent, file.size);
    }
    if (signal?.aborted) throw new ServerTransferCancelledError();
    return await api.serverUploadCommit(uploadId);
  } catch (error) {
    await api.serverUploadAbort(uploadId).catch(() => {});
    throw signal?.aborted ? new ServerTransferCancelledError() : error;
  }
}

/** Copies one server file into this PC's download folder; resolves with the
 *  local path. `onBegin` learns the name and size before the first byte. */
export async function downloadServerFile(
  api: ServerDownloadApi,
  projectPath: string,
  relPath: string,
  accessToken: string | undefined,
  { signal, onProgress, onBegin }: TransferOptions & { onBegin?(name: string, size: number): void } = {}
): Promise<{ path: string }> {
  if (signal?.aborted) throw new ServerTransferCancelledError();
  const begun = await api.serverDownloadBegin(projectPath, relPath, accessToken);
  onBegin?.(begun.name, begun.size);
  try {
    for (;;) {
      if (signal?.aborted) throw new ServerTransferCancelledError();
      const step = await api.serverDownloadStep(begun.downloadId);
      onProgress?.(step.received, step.size);
      if (step.done) break;
    }
    if (signal?.aborted) throw new ServerTransferCancelledError();
    return await api.serverDownloadFinish(begun.downloadId);
  } catch (error) {
    await api.serverDownloadAbort(begun.downloadId).catch(() => {});
    throw signal?.aborted ? new ServerTransferCancelledError() : error;
  }
}
