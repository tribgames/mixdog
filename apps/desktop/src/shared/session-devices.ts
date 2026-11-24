// Device attribution is shown only when a session was actually used from more
// than one device; a single-device session never earns the extra label.

/** The host's refusal of a send from a view that lacks another device's prompt
 *  starts with this text (remote-methods.ts STALE_SESSION_VIEW_MESSAGE). */
export const STALE_SESSION_VIEW_MARKER = 'This conversation changed on another device.';

/** Whether `device` named a device other than the one viewing the transcript.
 *  `viewer` is null until the viewing device's own name is known: nothing is
 *  attributed meanwhile, so the viewer never sees itself named. A viewer that
 *  could not learn its name ('') names every device. */
export function isOtherDevice(device: unknown, viewer: string | null): boolean {
  return typeof device === 'string' && device !== '' && viewer !== null && device !== viewer;
}
