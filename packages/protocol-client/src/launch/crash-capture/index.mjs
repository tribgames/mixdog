// V8 prints a fatal error (the heap-limit OOM abort above all) straight to file descriptor 2, below every JS hook, and a
// launcher's stderr pipe stops draining once the launcher detaches or exits; so the launcher gives the child an append
// file descriptor for fd 2 instead of a pipe (./spawn-capture.mjs).
export { daemonDataDir, daemonCrashCaptureDir } from './paths.mjs';
export {
  CRASH_CAPTURE_KEEP_BOOTS,
  daemonCaptureBootState,
  pruneDaemonCrashCaptures,
} from './retention.mjs';
export { beginDaemonSpawnCapture } from './spawn-capture.mjs';
export {
  describeExit,
  findCaptureRecordFor,
  installDaemonExitRecorder,
  reconcileLostDaemonCaptures,
} from './daemon-exit-record.mjs';
