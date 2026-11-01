import { type ForegroundLeaseRuntime, koffiForegroundLease } from '../backend/foreground-lock-host';

/** The production lease thread and fallback unlock of the host's foreground lock, for a host the
 *  harness bundles outside the app: koffi resolves from the app the harness
 *  runner names. */
export function harnessForegroundLease(): ForegroundLeaseRuntime {
  const from = process.env.MIXDOG_HARNESS_MODULES_FROM;
  if (!from) throw new Error('MIXDOG_HARNESS_MODULES_FROM is required');
  return koffiForegroundLease(from);
}
