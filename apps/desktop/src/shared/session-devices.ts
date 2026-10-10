// Device attribution is shown only when a session was actually used from more
// than one device; a single-device session never earns the extra label.

/** The host's refusal of a send from a view that lacks another device's prompt
 *  starts with this text (remote-methods.ts STALE_SESSION_VIEW_MESSAGE). */
export const STALE_SESSION_VIEW_MARKER = 'This conversation changed on another device.';

/** Distinct device names on the user rows of a transcript, plus `extra`. */
export function transcriptDevices(items: readonly unknown[] | null | undefined, extra: readonly string[] = []): Set<string> {
  const devices = new Set<string>();
  for (const item of items ?? []) {
    const row = item as { kind?: unknown; device?: unknown } | null;
    if (row?.kind === 'user' && typeof row.device === 'string' && row.device) devices.add(row.device);
  }
  for (const device of extra) if (device) devices.add(device);
  return devices;
}

export function sessionUsesMultipleDevices(
  items: readonly unknown[] | null | undefined,
  extra: readonly string[] = []
): boolean {
  return transcriptDevices(items, extra).size > 1;
}
