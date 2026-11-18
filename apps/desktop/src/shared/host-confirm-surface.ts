// The confirm surface the main process owns (main/developer-risk-confirm.ts): a modal child window of the asking window
// with its own static page (main/host-confirm-page.ts) and preload (preload/host-confirm.ts). Only that preload talks
// on this channel, and main listens on the surface's own webContents only.
export const HOST_CONFIRM_SURFACE_IPC = 'mixdog:host-confirm-surface';

/** What the surface's preload reports: its card's height once laid out, then the person's answer. */
export type HostConfirmSurfaceMessage = { type: 'size'; height: number } | { type: 'answer'; accepted: boolean };

/** The page's controls the preload binds (ids in the static page). */
export const HOST_CONFIRM_SURFACE_IDS = { card: 'card', accept: 'accept', cancel: 'cancel' } as const;
