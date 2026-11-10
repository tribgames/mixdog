// What Node does to a call from the moment it is on the wire (remote-shim-calls.ts:239-268), shared by the router's calls and the view sync's
// request: a bounded send phase, then -- once the frame has left -- a restarted deadline and a probe of the leg when nothing at all has arrived
// for a while after the send (a socket that died silently still reads as open, so its calls would otherwise wait out their full deadline).
import { armRemoteCallDeadline } from './remote-call-deadline';

/** A call on the wire this long with nothing arriving from the relay probes the leg. */
export const SILENT_CALL_PROBE_MS = 5_000;

export interface CallWatch {
  /** The frame has left this page: the deadline restarts and the silence is measured from now. */
  transmitted(): void;
  /** The call settled. */
  cancel(): void;
}

/** Arms the send-phase deadline for call `id` (which `pending` holds until it settles). */
export function armCallWatch(
  pending: Pick<Map<number, unknown>, 'has' | 'delete'>,
  id: number,
  reject: (error: Error) => void,
  probe: () => void,
  silentSince: (since: number) => boolean,
  timers: Pick<Window, 'setTimeout' | 'clearTimeout'> = window
): CallWatch {
  let cancelDeadline = armRemoteCallDeadline(pending, id, reject, probe, timers);
  let silence: number | undefined;
  return {
    transmitted() {
      if (!pending.has(id)) return;
      cancelDeadline();
      cancelDeadline = armRemoteCallDeadline(pending, id, reject, probe, timers);
      const sentAt = Date.now();
      silence = timers.setTimeout(() => {
        // One probe at a time; any frame since the send proves the leg.
        if (pending.has(id) && silentSince(sentAt)) probe();
      }, SILENT_CALL_PROBE_MS);
    },
    cancel() {
      cancelDeadline();
      if (silence !== undefined) timers.clearTimeout(silence);
    },
  };
}