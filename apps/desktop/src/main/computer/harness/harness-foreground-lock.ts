import { dirname } from 'node:path';
import { micaLibraryPath } from '../../window-mica';
import { type ForegroundLeaseRuntime, loadLeaseNative, nativeForegroundLease } from '../backend/foreground-lock-host';

/** The production lease thread and fallback unlock of the host's foreground lock, for a host the
 *  harness bundles outside the app: the dev build of mixdog_window.node next to the app the
 *  harness runner names. */
export function harnessForegroundLease(): ForegroundLeaseRuntime {
  const from = process.env.MIXDOG_HARNESS_MODULES_FROM;
  if (!from) throw new Error('MIXDOG_HARNESS_MODULES_FROM is required');
  const library = micaLibraryPath({ isPackaged: false, resourcesPath: '', appPath: dirname(from) });
  return nativeForegroundLease(() => loadLeaseNative(library));
}
