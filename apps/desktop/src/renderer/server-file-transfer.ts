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
  const { uploadId, chunkBytes, inFlightChunks } = await api.serverUploadBegin(file.name || 'attachment', file.size, scope);
  // Up to `inFlightChunks` chunks are submitted and not yet answered (one chunk of memory each); main applies the server's
  // window across every upload of the connection and the server applies the chunks in order, so the acknowledged byte count
  // only grows and the commit follows the last acknowledgement.
  const inFlight = new Set<Promise<void>>();
  // Held in an object: the flights below set it, which the compiler cannot follow through a bare variable.
  const outcome: { failure?: { error: unknown }; ended: boolean; abortRequested: boolean } = {
    ended: false,
    abortRequested: false,
  };
  const requestAbort = (): void => {
    if (outcome.abortRequested) return;
    outcome.abortRequested = true;
    void api.serverUploadAbort(uploadId).catch(() => {});
  };
  // A cancel is acted on at once: the abort goes out and the pump wakes, whatever the chunks in flight are waiting for.
  let onAbort: (() => void) | undefined;
  const cancelled = new Promise<never>((_resolve, reject) => {
    onAbort = () => {
      outcome.ended = true;
      requestAbort();
      reject(new ServerTransferCancelledError());
    };
  });
  cancelled.catch(() => undefined);
  signal?.addEventListener('abort', () => onAbort?.(), { once: true });
  const stopIfCancelledOrFailed = (): void => {
    if (signal?.aborted) throw new ServerTransferCancelledError();
    if (outcome.failure) throw outcome.failure.error;
  };
  let sent = 0;
  let acknowledged = 0;
  try {
    while (sent < file.size || inFlight.size > 0) {
      stopIfCancelledOrFailed();
      if (sent < file.size && inFlight.size < inFlightChunks) {
        const bytes = new Uint8Array(await file.slice(sent, sent + chunkBytes).arrayBuffer());
        // The read took time: a cancel or a failed chunk may have come in meanwhile.
        stopIfCancelledOrFailed();
        if (!bytes.length) throw new Error(t('{{name}}: the file changed while it was uploading.', { name: file.name }));
        const flight: Promise<void> = api.serverUploadChunk(uploadId, sent, bytes).then(
          ({ received }) => {
            inFlight.delete(flight);
            if (outcome.ended) return;
            acknowledged = Math.max(acknowledged, received);
            onProgress?.(acknowledged, file.size);
          },
          (error: unknown) => {
            inFlight.delete(flight);
            // The first failure is the cause: the chunks queued behind it only fail for being out of order.
            if (!outcome.ended) outcome.failure ??= { error };
          }
        );
        inFlight.add(flight);
        sent += bytes.length;
      } else {
        await Promise.race([...inFlight, cancelled]);
      }
    }
    // The last outstanding chunk may be the one that failed: the window is empty, but the upload is not complete.
    stopIfCancelledOrFailed();
    return await api.serverUploadCommit(uploadId);
  } catch (error) {
    outcome.ended = true;
    requestAbort();
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
