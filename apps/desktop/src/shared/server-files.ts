// Limits of a server (ssh) window's file transfers, shared by the renderer
// (early refusal, chunking), main (validation) and the daemon (enforcement).

/** Largest file one upload into the server's staging folder may carry. */
export const SERVER_UPLOAD_MAX_BYTES = 512 * 1024 * 1024;
/** The most encoded (base64) upload bytes this PC lets stay unacknowledged on one server connection, whatever the server
 *  offers: the server's connection budget (`queueBytes`) is the largest it states, and a larger offer is clamped to this. */
export const SERVER_UPLOAD_ALLOWANCE_MAX_BYTES = 8 * 1024 * 1024;
/** Largest server file "download to this PC" accepts. */
export const SERVER_DOWNLOAD_MAX_BYTES = 2 * 1024 * 1024 * 1024;
/** A staging folder no live session owns is swept once nothing in it changed for this long. */
export const SERVER_UPLOAD_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** The staging folder name for a composer's scope (its session, or a draft).
 *  The daemon derives the same name from a deleted session's id. */
export function serverUploadScope(scope: string): string {
  const clean = String(scope || '')
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^[._]+/, '')
    .slice(0, 128);
  return clean || 'draft';
}
