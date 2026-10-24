// Which device an action came from. The name is stamped by the host: a local
// call is this machine, a remote call carries the paired client's name that the
// host read from the authenticated connection (remote-methods.ts) — a client
// can never name itself, because the request validators reject the field.
import { hostname } from 'node:os';

import type { DesktopSubmitOptions } from '../shared/contract';

export function hostDeviceName(): string {
  return hostname().trim() || 'Main PC';
}

/** Submit options for the session runtime: the device travels as prompt
 *  transcript metadata, which is persisted with the user row, and so does a
 *  room member turn's bot-to-bot hop (bot-hops.mjs). */
export function submitOptionsWithDevice(options: DesktopSubmitOptions, id: string): Record<string, unknown> {
  const { device, hop, roomRow, ...rest } = options;
  const chained = Number.isSafeInteger(hop) && Number(hop) > 0 ? { hop } : {};
  const shown = roomRow ? { roomRow } : {};
  return { ...rest, id, transcriptMeta: { device: device || hostDeviceName(), ...chained, ...shown } };
}
