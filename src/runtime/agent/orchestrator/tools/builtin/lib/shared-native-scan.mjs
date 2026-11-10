// Shares only identical in-flight native scans (no persistent result). The
// existing single-flight layer isolates subscriber cancellation and detaches
// a scan after a mutation without interrupting its current readers.
import { runResultCacheInFlight } from '../cache-layers.mjs';

export function runSharedNativeScan(runWindowedLines, { cwd, argv, window, scopes, signal }) {
  return runResultCacheInFlight(
    `grep-path-scan:${JSON.stringify([cwd, argv, window])}`,
    ({ signal: sharedSignal }) => runWindowedLines(argv, { cwd, signal: sharedSignal }, window),
    { signal, scopes }
  );
}
