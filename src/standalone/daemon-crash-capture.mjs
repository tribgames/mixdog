// Crash and lifecycle capture for the machine-global daemon's launchers.
//
// A V8 fatal error — the heap-limit OOM abort above all — is printed by the
// runtime itself straight to FILE DESCRIPTOR 2, below every JS hook: the
// daemon's own stream/console redirect (daemon-log.mjs) never sees it, and the
// launcher's stderr PIPE stops being drained the moment the launcher detaches
// or exits. That is how a detached daemon can disappear with no fatal text and
// no exit record anywhere on disk.
//
// So the launcher hands the child an APPEND FILE DESCRIPTOR for fd 2 instead of
// a pipe (./daemon-crash-capture/spawn-capture.mjs). The kernel keeps that
// descriptor open for the daemon's whole life, independent of the parent, so
// native fatal output lands in a file even when the launcher is long gone. A
// JSON sidecar records the correlated lifecycle as far as the launcher can
// observe it; the record carries no environment, argument or credential
// material — only the heap flags that explain an OOM. Retention of completed
// boots lives in ./daemon-crash-capture/retention.mjs.
export { daemonDataDir, daemonCrashCaptureDir } from './daemon-crash-capture/paths.mjs';
export {
  CRASH_CAPTURE_KEEP_BOOTS,
  daemonCaptureBootState,
  pruneDaemonCrashCaptures,
} from './daemon-crash-capture/retention.mjs';
export { beginDaemonSpawnCapture } from './daemon-crash-capture/spawn-capture.mjs';
