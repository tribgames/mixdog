import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { BrowserWindow } from 'electron';

import type { VisualizeTabView } from '../../shared/visualize';
import { renderPageExport } from './export-render';

/** The bytes of an export of displayed pane `paneIndex`: an HTML page is
 *  rendered whole off screen; a PDF viewer, image or inline render (and a
 *  multi-pane tab) is what the panel shows now (`capture`). */
export async function exportTabBytes(
  capture: () => Promise<Buffer>,
  tab: VisualizeTabView,
  format: 'png' | 'pdf',
  paneIndex: number
): Promise<Buffer> {
  const pane = tab.panes[paneIndex];
  if (pane?.kind === 'html' && (format === 'pdf' || tab.panes.length === 1)) {
    return renderPageExport(pane.url, format, tab.networkAllowed === true);
  }
  if (format === 'pdf') throw new Error('Save as PDF is for HTML pages');
  return capture();
}

/** The OS save dialog for an export: the chosen file path, null on cancel.
 *  `directory` is preferred when it exists, else `fallback`. */
export async function chooseExportPath(
  requireWindow: () => BrowserWindow,
  { directory, fallback, name, format }: { directory: string; fallback: string; name: string; format: 'png' | 'pdf' }
): Promise<string | null> {
  const { dialog } = await import('electron');
  const folder = await stat(directory).then(
    (info) => (info.isDirectory() ? directory : fallback),
    () => fallback
  );
  const result = await dialog.showSaveDialog(requireWindow(), {
    defaultPath: join(folder, name),
    filters: [{ name: format === 'png' ? 'PNG' : 'PDF', extensions: [format] }],
  });
  return result.canceled || !result.filePath ? null : result.filePath;
}
