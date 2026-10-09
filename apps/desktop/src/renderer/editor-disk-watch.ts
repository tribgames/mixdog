import { startVisibleRefreshCadence } from './visible-refresh-cadence';

export const EDITOR_DISK_POLL_MS = 2_500;

/** Disk-change polling for an active editor. A hidden window owns no timer;
 *  returning to it checks the file once and resumes the cadence. */
export function startEditorDiskWatch(win: Window, check: () => void): () => void {
  return startVisibleRefreshCadence({ win, intervalMs: EDITOR_DISK_POLL_MS, refresh: check });
}
