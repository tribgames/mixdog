/** Frames one browser may have outstanding on the desktop: each counts from
 *  arrival until its call finishes, and the desktop drops the browser's
 *  connection past this (main/remote-relay-clients.ts `admitFrame`). */
export const REMOTE_CLIENT_PENDING_FRAMES = 256;

/** Calls a browser keeps on the wire at once. Half the desktop's budget: the
 *  rest is headroom for fire-and-forget frames and frames still waiting in the
 *  desktop's ordered decode queue, so a burst of calls released together (the
 *  app's reads waiting on a view sync) can never cost the connection. */
export const REMOTE_CLIENT_CALL_WINDOW = REMOTE_CLIENT_PENDING_FRAMES / 2;

/** Part of the window only priority calls (the view sync, an abort, an
 *  approval) may use, so ordinary reads filling it can never hold them out. */
export const REMOTE_CLIENT_PRIORITY_RESERVE = 8;
