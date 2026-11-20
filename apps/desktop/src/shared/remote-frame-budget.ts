/** Frames one browser may have outstanding on the desktop: each counts from
 *  arrival until its call finishes, and the desktop drops the browser's
 *  connection past this (main/remote-relay-clients.ts `admitFrame`). */
export const REMOTE_CLIENT_PENDING_FRAMES = 256;
