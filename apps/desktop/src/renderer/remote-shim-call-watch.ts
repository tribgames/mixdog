// What Node does to a call from the moment it is on the wire (remote-shim-calls.ts:239-268), shared by the router's calls and the view sync's
// request: the call's own deadline, and a probe of the leg when nothing at all has arrived for a while after the send -- a socket that died
// silently still reads as open, so its calls would otherwise wait out their full deadline.
import { armRemoteCallDeadline } from './remote-call-deadline';

/** A call on the wire this long with nothing arriving from the relay probes the leg. */
export const SILENT_CALL_PROBE_MS = 5_000;

/** Arms both for call `id` (which `pending` holds until it settles); returns the cancel for a settled call. */
export function armCallWatch(
  pending: Pick<Map<number, unknown>, 'has' | 'delete'>,
  id: number,
  reject: (error: Error) => void,
  probe: () => void,
  silentSince: (since: number) => boolean,
  timers: Pick<Window, 'setTimeout' | 'clearTimeout'> = window
): () => void {
  const cancelDeadline = armRemoteCallDeadline(pending, id, reject, probe, timers);
  const sentAt = Date.now();
  // One probe at a time; any frame since the send proves the leg.
  const silence = timers.setTimeout(() => {
    if (pending.has(id) && silentSince(sentAt)) probe();
  }, SILENT_CALL_PROBE_MS);
  return () => {
    cancelDeadline();
    timers.clearTimeout(silence);
  };
}