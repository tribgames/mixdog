// The file actions a server (ssh) window offers in place of this PC's shell:
// uploads of this PC's files into the server, "download to this PC and open",
// revealing an entry in the window's own file tree and deleting through the
// server's trash. Running transfers show in one small
// panel with progress and a cancel button per file.
import { useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Download, Upload, X } from 'lucide-react';
import type { DesktopApi, DesktopLocalPathEntry } from '../shared/contract';
import { confirmText } from './confirm-text';
import { showDesktopToast } from './desktop-toasts';
import { errorMessageText } from './ErrorNotice';
import { openConfirmedFile } from './file-launch-confirmation';
import { t } from './i18n';
import {
  downloadServerFile,
  ServerTransferCancelledError,
  uploadFileToServer,
  type ServerDownloadApi,
  type ServerUploadApi,
} from './server-file-transfer';
import { isSshConnectionWindow } from './desktop-connection';
import './server-transfers.css';

interface TransferRow {
  id: number;
  kind: 'upload' | 'download';
  name: string;
  sent: number;
  total: number;
  cancel(): void;
}

let rows: TransferRow[] = [];
let sequence = 0;
let mount: { host: HTMLElement; root: Root } | null = null;

function ServerTransfers({ transfers }: { transfers: TransferRow[] }) {
  return (
    <section className="server-transfers" aria-label={t('Server file transfers')} aria-live="polite">
      {transfers.map((row) => {
        const percent = row.total > 0 ? Math.min(100, Math.floor((row.sent / row.total) * 100)) : 0;
        const Icon = row.kind === 'upload' ? Upload : Download;
        return (
          <div className="server-transfer" key={row.id}>
            <Icon size={14} aria-hidden="true" />
            <span className="server-transfer-label" title={row.name}>
              {row.kind === 'upload'
                ? t('Uploading {{name}} to the server', { name: row.name })
                : t('Downloading {{name}} to this PC', { name: row.name })}
            </span>
            <span className="server-transfer-percent">{percent}%</span>
            <button
              type="button"
              className="server-transfer-cancel"
              aria-label={t('Cancel transfer of {{name}}', { name: row.name })}
              onClick={row.cancel}
            >
              <X size={14} />
            </button>
            <progress value={row.sent} max={Math.max(1, row.total)} />
          </div>
        );
      })}
    </section>
  );
}

function render(): void {
  if (!rows.length) {
    mount?.root.unmount();
    mount?.host.remove();
    mount = null;
    return;
  }
  if (!mount) {
    const host = document.createElement('div');
    document.body.append(host);
    mount = { host, root: createRoot(host) };
  }
  mount.root.render(<ServerTransfers transfers={[...rows]} />);
}

/** One running transfer in the panel; `signal` aborts when the user cancels. */
function trackTransfer(kind: TransferRow['kind'], name: string, total: number) {
  const controller = new AbortController();
  const row: TransferRow = { id: ++sequence, kind, name, sent: 0, total, cancel: () => controller.abort() };
  rows = [...rows, row];
  render();
  return {
    signal: controller.signal,
    progress(sent: number, size: number, label = row.name) {
      Object.assign(row, { sent, total: size, name: label });
      render();
    },
    done() {
      rows = rows.filter((entry) => entry !== row);
      render();
    },
  };
}

function uploadApi(api: DesktopApi | undefined): ServerUploadApi {
  const { serverUploadBegin, serverUploadChunk, serverUploadCommit, serverUploadAbort } = api ?? {};
  if (!serverUploadBegin || !serverUploadChunk || !serverUploadCommit || !serverUploadAbort) {
    throw new Error(t('Uploading to the server is unavailable.'));
  }
  return { serverUploadBegin, serverUploadChunk, serverUploadCommit, serverUploadAbort };
}

function downloadApi(api: DesktopApi | undefined): ServerDownloadApi {
  const { serverDownloadBegin, serverDownloadStep, serverDownloadFinish, serverDownloadAbort } = api ?? {};
  if (!serverDownloadBegin || !serverDownloadStep || !serverDownloadFinish || !serverDownloadAbort) {
    throw new Error(t('Downloading from the server is unavailable.'));
  }
  return { serverDownloadBegin, serverDownloadStep, serverDownloadFinish, serverDownloadAbort };
}

/** Uploads this PC's files into the server's staging folder for `scope`, one
 *  after another. A cancelled file is simply left out; failures come back as
 *  messages. */
export async function uploadFilesToServer(
  files: readonly File[],
  scope: string
): Promise<{ uploaded: Map<File, DesktopLocalPathEntry>; errors: string[] }> {
  const uploaded = new Map<File, DesktopLocalPathEntry>();
  const errors: string[] = [];
  let api: ServerUploadApi;
  try {
    api = uploadApi(window.mixdogDesktop);
  } catch (error) {
    return { uploaded, errors: [errorMessageText(error)] };
  }
  for (const file of files) {
    const name = file.name || t('Pasted file');
    const transfer = trackTransfer('upload', name, file.size);
    try {
      uploaded.set(
        file,
        await uploadFileToServer(api, file, scope, {
          signal: transfer.signal,
          onProgress: (sent, total) => transfer.progress(sent, total),
        })
      );
    } catch (error) {
      if (!(error instanceof ServerTransferCancelledError)) {
        errors.push(
          t('{{name}}: the upload to the server failed: {{error}}', { name, error: errorMessageText(error) })
        );
      }
    } finally {
      transfer.done();
    }
  }
  return { uploaded, errors };
}

/** "Download to this PC and open": asks first, copies the server file into
 *  this PC's download folder with progress, then opens it with this PC's app
 *  (risky types still ask before they run). */
export async function downloadAndOpenServerFile(
  projectPath: string,
  relPath: string,
  accessToken?: string
): Promise<void> {
  const api = window.mixdogDesktop;
  const name = relPath.replace(/\\/g, '/').split('/').at(-1) || relPath;
  if (!window.confirm(t('Download {{name}} from the server to this PC and open it?', { name }))) return;
  const transfer = trackTransfer('download', name, 0);
  try {
    const { path } = await downloadServerFile(downloadApi(api), projectPath, relPath, accessToken, {
      signal: transfer.signal,
      onBegin: (label, size) => transfer.progress(0, size, label),
      onProgress: (sent, total) => transfer.progress(sent, total),
    });
    transfer.done();
    showDesktopToast(t('Saved to this PC: {{path}}', { path }), 'success');
    const open = api?.openServerDownload;
    if (!open) return;
    await openConfirmedFile((confirmedPath) => (confirmedPath ? open(path, confirmedPath) : open(path)));
  } catch (error) {
    if (error instanceof ServerTransferCancelledError) return;
    showDesktopToast(t('Unable to download the file: {{error}}', { error: errorMessageText(error) }), 'error');
  } finally {
    transfer.done();
  }
}

export const SERVER_FILE_REVEAL_EVENT = 'mixdog:reveal-in-files';

/** Reveal in the window's own file tree: a server window has no file manager
 *  on this PC to show a server path in. */
function requestServerFileReveal(projectPath: string, relPath: string): void {
  window.dispatchEvent(
    new CustomEvent(SERVER_FILE_REVEAL_EVENT, { detail: { project: projectPath, rel: relPath.replace(/\\/g, '/') } })
  );
}

/** "Reveal": this PC's file manager in a local window, the window's own file
 *  tree in a server window. */
export function revealFileFromWindow(projectPath: string, relPath: string, accessToken?: string): Promise<void> {
  if (isSshConnectionWindow()) {
    requestServerFileReveal(projectPath, relPath);
    return Promise.resolve();
  }
  return window.mixdogDesktop?.revealFile?.(projectPath, relPath, accessToken) ?? Promise.resolve();
}

/** The app root answers reveal requests by opening its Files tree on the entry. */
export function useServerFileReveal(reveal: (project: string, rel: string) => void): void {
  useEffect(() => {
    const receive = (event: Event) => {
      const detail = (event as CustomEvent<{ project?: unknown; rel?: unknown }>).detail;
      if (typeof detail?.project === 'string' && typeof detail.rel === 'string') reveal(detail.project, detail.rel);
    };
    window.addEventListener(SERVER_FILE_REVEAL_EVENT, receive);
    return () => window.removeEventListener(SERVER_FILE_REVEAL_EVENT, receive);
  }, [reveal]);
}

/** The delete confirmation of a server window: the server's trash when this
 *  folder has one, else an explicit permanent delete. Null when declined. */
export async function confirmServerDelete(
  api: DesktopApi | undefined,
  projectPath: string,
  label: string
): Promise<{ permanent: boolean } | null> {
  const trash = await Promise.resolve(api?.serverTrashInfo?.(projectPath)).catch(() => null);
  if (trash?.available) {
    return window.confirm(
      t('Move {{name}} to the server trash ({{path}})?', { name: confirmText(label), path: confirmText(trash.path) })
    )
      ? { permanent: false }
      : null;
  }
  return window.confirm(
    t('The server has no trash for this folder. Permanently delete {{name}}? This cannot be undone.', {
      name: label,
    })
  )
    ? { permanent: true }
    : null;
}
