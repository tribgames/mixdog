// "다운로드 / 공유" for a Project file shown outside the transcript (editor,
// Explorer, Review, lightbox): a paired device downloads the host's file as
// a `project` source of the conversation that owns the surface. Every action
// takes that session explicitly (MarkdownSessionContext in the transcript,
// DownloadSessionContext in the pane around the other surfaces).
import { createContext } from 'react';
import { showDesktopToast } from './desktop-toasts';
import { explorerAbsolutePath } from './explorer-tree-model';
import { fileDownloadBlockedReason, startFileDownload } from './file-download-panel';
import {
  defaultFileDownloadEnvironment,
  fileDownloadReasonMessage,
  fileDownloadSupport,
} from './file-download-transfer';

/** The conversation that owns the pane's editor, Explorer and Review surfaces. */
export const DownloadSessionContext = createContext('');

/** Why a download of `sessionId` cannot start (or '' when it can). */
async function downloadBlockedReason(sessionId: string): Promise<string> {
  const blocked = fileDownloadBlockedReason(await fileDownloadSupport(defaultFileDownloadEnvironment()));
  if (blocked) return blocked;
  return sessionId ? '' : fileDownloadReasonMessage('unavailable');
}

/** Starts the download of project file `relPath`, or says why it cannot run.
 *  A file granted from outside every project (`grantedFolder` = the folder the
 *  editor reports as its project) is asked for by the path the conversation
 *  showed: the host serves it only when this session references it. */
export async function startProjectFileDownload(
  sessionId: string,
  relPath: string,
  name?: string,
  grantedFolder?: string
): Promise<void> {
  const rel = relPath.replace(/\\/g, '/').replace(/^\.?\//, '');
  const blocked = await downloadBlockedReason(sessionId);
  if (blocked || !rel) {
    showDesktopToast(blocked || fileDownloadReasonMessage('unavailable'), 'error');
    return;
  }
  const label = name || rel.split('/').at(-1) || rel;
  if (grantedFolder) {
    startFileDownload({ kind: 'session', sessionId, path: explorerAbsolutePath(grantedFolder, rel) }, label);
    return;
  }
  startFileDownload({ kind: 'project', sessionId, relPath: rel }, label);
}

/** Starts the zip download of a folder the conversation references. */
export async function startFolderDownload(sessionId: string, path: string, name?: string): Promise<void> {
  const blocked = await downloadBlockedReason(sessionId);
  if (blocked || !path) {
    showDesktopToast(blocked || fileDownloadReasonMessage('unavailable'), 'error');
    return;
  }
  const base =
    path
      .replace(/[\\/]+$/, '')
      .split(/[\\/]/)
      .at(-1) || 'folder';
  startFileDownload({ kind: 'folder', sessionId, path }, name || `${base}.zip`);
}
