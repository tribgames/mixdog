// PNG / PDF export on a paired remote device: the host renders the pane into
// a temp file and answers with a one-device download source, which the
// device's own download path redeems (progress row, save or share).
import { startFileDownload } from './file-download-panel';

/** Whether this surface can export PNG / PDF as a download. */
export const visualizeRemoteExportAvailable = (): boolean =>
  typeof window !== 'undefined' && typeof window.mixdogDesktop?.visualizeExport === 'function';

export async function downloadVisualizeExport(
  sessionId: string,
  tabId: string,
  format: 'png' | 'pdf',
  pane: number
): Promise<void> {
  const exportPane = window.mixdogDesktop?.visualizeExport;
  if (!exportPane) throw new Error('This export is only available in the desktop window.');
  const exported = await exportPane(sessionId, tabId, format, pane);
  startFileDownload(exported.source, exported.name);
}
